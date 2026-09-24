import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  codex,
  createWorktree,
  recoverDurableWorkflow,
  resumeDurableWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type WorkflowTask,
} from "./index.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("guards ordinary durable dispatch with worker catalog and account readings", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-guard-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const real = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "guard-task" },
  });
  const task: WorkflowTask = {
    id: "one",
    reference: "issue:one",
    state: "ready",
    dependencies: [],
    scope: ["result.txt"],
    requiredRoles: [],
    requiredCapabilities: [],
  };
  let dispatched = 0;
  let pages = 0;
  let accountReads = 0;
  const now = Date.now();
  const usage = {
    policyId: "sol-high-fixed",
    activity: "library-proof" as const,
    readAccount: async () => ({
      accountId: "account-a",
      observedAt: Date.now(),
      denied: false,
      windows: {
        short: {
          usedPercent: 20 + (accountReads++ === 2 ? 1 : 0),
          resetsAt: now + 1_000_000,
        },
        weekly: { usedPercent: 30, resetsAt: now + 2_000_000 },
      },
    }),
    readTokenCounters: async (
      _taskId: string,
      _role: string,
      sessionId?: string,
    ) => ({
      counters: sessionId
        ? [
            {
              counterId: sessionId,
              coverageId: sessionId,
              usage: {
                inputTokens: 10,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                outputTokens: 2,
              },
            },
          ]
        : [],
      complete: true,
    }),
    listModels: async (cursor?: string) => {
      pages++;
      return cursor
        ? {
            data: [
              {
                model: "gpt-6-sol",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
          }
        : { data: [], nextCursor: "second" };
    },
  };
  const options = {
    directory: join(root, "state"),
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "worker-image-cli-home",
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: {
      one: {
        ...real,
        run: async (runOptions: Parameters<typeof real.run>[0]) => {
          await runOptions.onIterationStart?.(1);
          dispatched++;
          await writeFile(
            join(real.worktreePath, "result.txt"),
            `done ${dispatched}\n`,
          );
          git(real.worktreePath, "add", "result.txt");
          git(real.worktreePath, "commit", "-m", "result");
          const sessionFilePath = join(root, "session.jsonl");
          await writeFile(sessionFilePath, "{}\n");
          const iteration = {
            sessionId: "session-1",
            sessionFilePath,
            usage: {
              inputTokens: 10,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              outputTokens: 2,
            },
          };
          await runOptions.onSessionCaptured?.(iteration);
          await runOptions.onIterationComplete?.(1, iteration);
          return {
            iterations: [iteration],
            commits: [{ sha: git(real.worktreePath, "rev-parse", "HEAD") }],
          } as never;
        },
      },
    },
    project: {
      root,
      capabilities: [],
      getTask: async () => task,
      reserve: async () => ({
        id: "reservation",
        retain: async () => {},
        release: async () => {},
      }),
      prompt: () => "test",
      check: async () => ({ status: "passed" as const, evidence: [] }),
      accept: async () => ({ status: "accepted" as const, evidence: [] }),
      validateHumanRequest: async () => true,
    },
    recoverReservation: async () => {},
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent: codex("gpt-6-sol", { effort: "high", serviceTier: "default" }),
          sandbox: { tag: "none" as const, create: async () => ({}) } as never,
        },
      },
    },
    usage,
  };
  try {
    const completed = await runDurableWorkflow(options);
    expect(completed.tasks.one?.status).toBe("accepted");
    expect(completed.usage?.remaining.one?.implementation).toBe(1);
    expect(completed.usage?.tokens.deltas["session-1"]?.inputTokens).toBe(10);
    expect(
      completed.usage?.accountHistory.at(-1)?.reading.windows.short
        ?.usedPercent,
    ).toBe(21);
    expect(pages).toBe(2);
    expect(dispatched).toBe(1);
    let reads = 0;
    const second = {
      ...options,
      directory: join(root, "denied-state"),
      invocationId: "denied",
      usage: {
        ...usage,
        readAccount: async () => ({
          accountId: "account-a",
          observedAt: Date.now(),
          denied: ++reads >= 2,
          windows: {
            short: { usedPercent: 20, resetsAt: now + 1_000_000 },
            weekly: { usedPercent: 30, resetsAt: now + 2_000_000 },
          },
        }),
      },
    };
    const stopped = await runDurableWorkflow(second);
    expect(stopped.lifecycle).toBe("stopped");
    expect(stopped.tasks.one?.status).toBe("blocked");
    expect(stopped.tasks.one?.remaining).toBe(2);
    expect(dispatched).toBe(1);
    expect((await workflowStatus(second.directory)).usage?.stopReason).toMatch(
      /denied/,
    );
    const resumed = await resumeDurableWorkflow({ ...second, usage });
    expect(resumed.tasks.one?.status, JSON.stringify(resumed.tasks.one)).toBe(
      "accepted",
    );
    expect(resumed.usage?.baseline.windows.short?.usedPercent).toBe(20);
    expect(resumed.usage?.remaining.one?.implementation).toBe(1);
    expect(dispatched).toBe(2);
    let resetReads = 0;
    const resetAccount = async () => ({
      accountId: "account-a",
      observedAt: Date.now(),
      denied: false,
      windows: {
        short: {
          usedPercent: ++resetReads === 1 ? 20 : 1,
          resetsAt: now + (resetReads === 1 ? 1_000_000 : 3_000_000),
        },
        weekly: { usedPercent: 30, resetsAt: now + 2_000_000 },
      },
    });
    const resetOptions = {
      ...options,
      directory: join(root, "reset-state"),
      invocationId: "reset",
      usage: { ...usage, readAccount: resetAccount },
    };
    const resetStopped = await runDurableWorkflow(resetOptions);
    expect(resetStopped.usage?.stopReason).toMatch(/changed/);
    expect(dispatched).toBe(2);
    const resetResumed = await resumeDurableWorkflow({
      ...resetOptions,
      project: {
        ...resetOptions.project,
        getTask: async () => {
          await new Promise((resolve) => setTimeout(resolve, 75));
          return task;
        },
      },
      usage: {
        ...resetOptions.usage,
        resetContinuation: {
          id: "owner-reset-1",
          reason: "Continue after recorded account reset",
        },
      },
    });
    expect(resetResumed.tasks.one?.status).toBe("accepted");
    expect(resetResumed.usage?.baseline.windows.short?.usedPercent).toBe(20);
    expect(resetResumed.usage?.guardBaseline.windows.short?.usedPercent).toBe(
      1,
    );
    expect(resetResumed.usage?.resetContinuations).toHaveLength(1);
    expect(resetResumed.usage?.remaining.one?.implementation).toBe(1);
    expect(
      (resetResumed.usage?.activeMs ?? 0) - (resetStopped.usage?.activeMs ?? 0),
    ).toBeGreaterThanOrEqual(75);
    expect(dispatched).toBe(3);

    const failed = {
      ...options,
      directory: join(root, "failed-state"),
      invocationId: "failed",
      worktrees: {
        one: {
          ...real,
          run: async (runOptions: Parameters<typeof real.run>[0]) => {
            await runOptions.onIterationStart?.(1);
            throw new Error("Provider failed after dispatch");
          },
        },
      },
    };
    const failedResult = await runDurableWorkflow(failed);
    expect(failedResult.tasks.one?.status).toBe("blocked");
    const failedUsage = (await workflowStatus(failed.directory)).usage;
    expect(failedUsage?.remaining.one?.implementation).toBe(1);
    expect(failedUsage?.tokens.unknown).toHaveLength(1);
    expect(Object.values(failedUsage?.tokens.estimates ?? {})).toEqual([null]);
  } finally {
    await real.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it("shares a pilot budget across measurement and scored durable invocations", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-pilot-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const measurementWorktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "measurement" },
  });
  const scoredWorktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "scored" },
  });
  const pilotDirectory = join(root, "pilot-budget");
  const now = Date.now();
  const dispatched: string[] = [];
  const task = (id: string, state: WorkflowTask["state"]): WorkflowTask => ({
    id,
    reference: `issue:${id}`,
    state,
    dependencies: id === "scored" ? ["measurement"] : [],
    scope: [`${id}.txt`],
    requiredRoles: [],
    requiredCapabilities: [],
  });
  let measurementAccepted = false;
  const project = {
    root,
    capabilities: [],
    getTask: async (id: string) =>
      id === "measurement"
        ? task(id, measurementAccepted ? "complete" : "ready")
        : id === "scored"
          ? task(id, "ready")
          : undefined,
    reserve: async () => ({
      id: "reservation",
      retain: async () => {},
      release: async () => {},
    }),
    prompt: () => "test",
    check: async () => ({ status: "passed" as const, evidence: [] }),
    accept: async () => ({ status: "accepted" as const, evidence: [] }),
    validateHumanRequest: async () => true,
  };
  const wrapped = (id: string, worktree: typeof measurementWorktree) => ({
    ...worktree,
    run: async (runOptions: Parameters<typeof worktree.run>[0]) => {
      await runOptions.onIterationStart?.(1);
      dispatched.push(id);
      const file = `${id}.txt`;
      await writeFile(join(worktree.worktreePath, file), `${id}\n`);
      git(worktree.worktreePath, "add", file);
      git(worktree.worktreePath, "commit", "-m", id);
      const iteration = {};
      await runOptions.onIterationComplete?.(1, iteration);
      return {
        iterations: [iteration],
        commits: [{ sha: git(worktree.worktreePath, "rev-parse", "HEAD") }],
      } as never;
    },
  });
  const usage = (activity: "measurement" | "pilot") => ({
    policyId: "pilot-policy",
    activity,
    pilot: { id: "pilot-1", directory: pilotDirectory },
    listModels: async () => ({
      data: [
        {
          model: "gpt-6-sol",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
    }),
    readAccount: async () => ({
      accountId: "account-a",
      observedAt: Date.now(),
      denied: false,
      windows: {
        short: {
          usedPercent: dispatched.length === 2 ? 25 : 20,
          resetsAt: now + 5 * 60 * 60_000,
        },
        weekly: { usedPercent: 30, resetsAt: now + 7 * 24 * 60 * 60_000 },
      },
    }),
  });
  const policy = {
    iterations: 2,
    roles: {
      implementation: {
        agent: codex("gpt-6-sol", {
          effort: "high",
          serviceTier: "default",
        }),
        sandbox: { tag: "none" as const, create: async () => ({}) } as never,
      },
    },
  };
  const runOptions = (
    id: string,
    activity: "measurement" | "pilot",
    worktree: typeof measurementWorktree,
  ) => ({
    directory: join(root, `${id}-state`),
    projectId: "project",
    invocationId: id,
    runtimeIdentity: "worker-image-cli-home-account",
    selected: [{ id, reference: `issue:${id}` }],
    worktrees: { [id]: wrapped(id, worktree) },
    project,
    recoverReservation: async () => {},
    policy,
    usage: usage(activity),
  });
  try {
    const measurementOptions = runOptions(
      "measurement",
      "measurement",
      measurementWorktree,
    );
    const first = await runDurableWorkflow(measurementOptions);
    expect(first.tasks.measurement?.status).toBe("accepted");
    await mkdir(join(pilotDirectory, "execution.lock"));
    await writeFile(
      join(pilotDirectory, "execution.lock", "owner.json"),
      JSON.stringify({ pid: 999999, start: "0" }),
    );
    const recovered = await recoverDurableWorkflow(measurementOptions);
    expect(recovered.lifecycle).toBe("stopped");
    measurementAccepted = true;
    const second = await runDurableWorkflow(
      runOptions("scored", "pilot", scoredWorktree),
    );
    expect(dispatched).toEqual(["measurement", "scored"]);
    expect(second.tasks.scored?.status).toBe("blocked");
    expect(second.usage?.stopReason).toMatch(/5 percentage points/);
    expect(second.usage?.baseline.windows.short?.usedPercent).toBe(20);
    const budget = JSON.parse(
      await readFile(join(pilotDirectory, "budget.json"), "utf8"),
    );
    expect(budget.measurementCalls).toBe(1);
    expect(budget.evaluations).toBe(1);
    expect(budget.episodes.measurement.complete).toBe(true);
    expect(budget.activeMs).toBeGreaterThan(0);
  } finally {
    await measurementWorktree.close();
    await scoredWorktree.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
