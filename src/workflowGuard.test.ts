import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  codex,
  createWorktree,
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
  const now = Date.now();
  const usage = {
    policyId: "sol-high-fixed",
    activity: "library-proof" as const,
    readAccount: async () => ({
      accountId: "account-a",
      observedAt: Date.now(),
      denied: false,
      windows: {
        short: { usedPercent: 20, resetsAt: now + 1_000_000 },
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
  } finally {
    await real.close();
    await rm(root, { recursive: true, force: true });
  }
});
