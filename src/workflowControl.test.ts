import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createWorktree,
  codex,
  cancelWorkflowTask,
  processWorkflowResponses,
  requestWorkflowRework,
  respondWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type WorkflowProject,
  type WorkflowTask,
  type WorkflowRequest,
  type Worktree,
} from "./index.js";
import { beginPilotInvocation, settlePilotInvocation } from "./pilotBudget.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("settles a completed protected-check failure and releases its pilot reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-pilot-failed-"));
  const directory = join(root, "state");
  const pilot = join(root, "pilot");
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "README.md"), "base\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "base");
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "failed-case" },
    });
    const now = Date.now();
    const account = {
      accountId: "account",
      observedAt: now,
      denied: false,
      windows: {
        weekly: { usedPercent: 10, resetsAt: now + 7 * 24 * 60 * 60_000 },
      },
    };
    const usage = {
      policyId: "failed-case",
      pilot: { id: "pilot", directory: pilot },
      readAccount: async () => ({ ...account, observedAt: Date.now() }),
      listModels: async () => ({
        data: [
          {
            model: "gpt-6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
      }),
    };
    const calibration = beginPilotInvocation(
      undefined,
      { ...usage, activity: "measurement" },
      "calibration",
      "runtime",
      account,
      [{ id: "calibration", requiredRoles: [] }],
      1,
      {
        implementation: {
          model: "gpt-6-sol",
          effort: "high",
          serviceTier: "default",
        },
      },
      now,
      now,
    );
    await mkdir(pilot);
    await writeFile(
      join(pilot, "budget.json"),
      JSON.stringify(
        settlePilotInvocation(
          calibration.budget,
          "calibration",
          calibration.usage,
          true,
        ),
      ),
    );
    let released = 0;
    const agent = codex("gpt-6-sol", {
      effort: "high",
      serviceTier: "default",
    });
    const task: WorkflowTask = {
      id: "case",
      reference: "case",
      state: "ready",
      dependencies: [],
      scope: ["result.txt"],
      requiredRoles: [],
      requiredCapabilities: [],
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let done = false;
    const pending = runDurableWorkflow({
      directory,
      projectId: "project",
      invocationId: "failed-case",
      runtimeIdentity: "runtime",
      selected: [{ id: task.id, reference: task.reference }],
      worktrees: {
        case: {
          ...worktree,
          run: async (options) => {
            await options.onIterationStart?.(1);
            await writeFile(
              join(worktree.worktreePath, "result.txt"),
              "candidate\n",
            );
            git(worktree.worktreePath, "add", "result.txt");
            git(worktree.worktreePath, "commit", "-m", "candidate");
            const iteration = {
              sessionId: "failed-session",
              sessionFilePath: join(root, "failed-session.jsonl"),
            };
            await writeFile(iteration.sessionFilePath, "{}\n");
            await options.onSessionCaptured?.(iteration);
            await options.onIterationComplete?.(1, iteration);
            return {
              iterations: [iteration],
              commits: [
                { sha: git(worktree.worktreePath, "rev-parse", "HEAD") },
              ],
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
          release: async () => {
            released++;
          },
        }),
        prompt: () => "Implement the case",
        check: async () => ({
          status: "failed",
          evidence: ["protected check failed"],
          reason: "Protected check failed",
        }),
        accept: async () => {
          throw new Error("Failed checks must not be accepted");
        },
        validateHumanRequest: async () => false,
      },
      policy: {
        iterations: 1,
        roles: {
          implementation: {
            agent,
            sandbox: { tag: "none", create: async () => ({}) } as never,
          },
        },
      },
      usage: { ...usage, activity: "pilot" },
    }).finally(() => {
      done = true;
    });
    for (let attempt = 0; attempt < 600 && !done; attempt++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(done).toBe(true);
    const result = await pending;
    expect(result.tasks.case?.status).toBe("failed");
    expect(result.resources.retained).toBe(false);
    expect(released).toBe(1);
    const budget = JSON.parse(
      await readFile(join(pilot, "budget.json"), "utf8"),
    );
    expect(budget.activeInvocationId).toBeUndefined();
    expect(budget.episodes["failed-case"].complete).toBe(true);
    expect(budget.evaluations).toBe(1);
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("queues an authenticated answer under the execution lock and applies it while independent work runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-answers-"));
  const directory = join(root, "control");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const a = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "task-a" },
  });
  const b = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "task-b" },
  });
  const evidence = join(root, "evidence.txt");
  await writeFile(evidence, "verified evidence\n");
  const evidenceHash = createHash("sha256")
    .update(await readFile(evidence))
    .digest("hex");
  const task = (id: string): WorkflowTask => ({
    id,
    reference: `issue:${id}`,
    state: "ready",
    dependencies: [],
    scope: [`${id}.txt`],
    requiredRoles: [],
    requiredCapabilities: [],
  });
  let finishB!: () => void;
  const bGate = new Promise<void>((resolve) => {
    finishB = resolve;
  });
  let bStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bStarted = resolve;
  });
  const invocations: string[] = [];
  const mockWorktree = (real: Worktree, id: string): Worktree => ({
    ...real,
    run: async () => {
      invocations.push(id);
      if (id === "b") {
        bStarted();
        await bGate;
      }
      await writeFile(
        join(real.worktreePath, `${id}.txt`),
        `${id}-${invocations.length}\n`,
      );
      git(real.worktreePath, "add", `${id}.txt`);
      git(real.worktreePath, "commit", "-m", id);
      return {
        iterations: [{}],
        commits: [{ sha: git(real.worktreePath, "rev-parse", "HEAD") }],
      } as never;
    },
  });
  let released = 0;
  let retained = 0;
  let waitForB = false;
  const project: WorkflowProject & {
    validateHumanRequest(request: WorkflowRequest): Promise<boolean>;
  } = {
    root,
    capabilities: [],
    getTask: async (id) => (id === "a" || id === "b" ? task(id) : undefined),
    reserve: async () => ({
      id: "reservation-1",
      release: () => {
        released++;
      },
      retain: () => {
        retained++;
      },
    }),
    prompt: () => "fixture prompt",
    check: async () => ({ status: "passed", evidence: [evidence] }),
    accept: async (candidate) =>
      candidate.task.id === "a" || waitForB
        ? {
            status: "waiting",
            evidence: [evidence],
            request: {
              owner: "owner-1",
              phase: "acceptance",
              target: "main",
              question: "Approve this candidate?",
              contract: "contract-1",
              manifest: "manifest-1",
              checkpoint: "checkpoint-1",
              evidence: [{ path: evidence, sha256: evidenceHash }],
              display: {
                questionId: "question-1",
                sourceRef: "host-question-1",
                route: "host",
              },
            },
          }
        : { status: "accepted", evidence: [evidence] },
    validateHumanRequest: async () => true,
  };
  const options = {
    directory,
    projectId: "project-1",
    invocationId: "invocation-1",
    project,
    selected: [
      { id: "a", reference: "issue:a" },
      { id: "b", reference: "issue:b" },
    ],
    worktrees: { a: mockWorktree(a, "a"), b: mockWorktree(b, "b") },
    policy: {
      iterations: 1,
      roles: {
        implementation: {
          agent: {
            buildPrintCommand: () => ({}),
            parseStreamLine: () => ({}),
          } as never,
          sandbox: { tag: "none", create: () => ({}) } as never,
        },
      },
    },
  };
  try {
    const running = runDurableWorkflow(options);
    await started;
    const status = await workflowStatus(directory);
    expect(status.liveness).toBe("live");
    expect(status.active).toEqual(["b"]);
    expect(status.tasks.a?.status).toBe("waiting");
    expect(status.requests).toHaveLength(1);
    const requestId = status.requests[0]!.id;
    const separate = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { workflowStatus } from './src/index.ts'; console.log((await workflowStatus(${JSON.stringify(directory)})).requests[0].id)`,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ).trim();
    expect(separate).toBe(requestId);
    const route = {
      authenticate: async () => ({
        owner: "owner-1",
        questionId: "question-1",
        sourceRef: "host-question-1",
        eventId: "human-event-1",
        originalText: "Approve",
      }),
    };
    const delivered = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { respondWorkflow } from './src/index.ts'; console.log(JSON.stringify(await respondWorkflow({ directory: ${JSON.stringify(directory)}, requestId: ${JSON.stringify(requestId)}, responseId: 'response-1', sourceEvent: {}, route: { authenticate: async () => ({ owner: 'owner-1', questionId: 'question-1', sourceRef: 'host-question-1', eventId: 'human-event-1', originalText: 'Approve' }) } })))`,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      ),
    ) as { status: string; responseId: string };
    expect(delivered.status).toBe("queued");
    expect(
      JSON.parse(
        await readFile(join(directory, "inbox", `${requestId}.json`), "utf8"),
      ).version,
    ).toBe(1);
    expect(
      await respondWorkflow({
        directory,
        requestId,
        responseId: "response-1",
        sourceEvent: {},
        route,
      }),
    ).toEqual(delivered);
    await expect(
      processWorkflowResponses(directory, project.validateHumanRequest),
    ).rejects.toThrow();
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await workflowStatus(directory)).tasks.a?.status === "accepted")
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await workflowStatus(directory)).tasks.a?.status).toBe("accepted");
    finishB();
    const final = await running;
    expect(final.tasks.b?.status).toBe("accepted");
    expect(final.responses[0]?.status).toBe("applied");
    expect(final.responses[0]).toMatchObject({
      owner: "owner-1",
      sourceRef: "host-question-1",
      eventId: "human-event-1",
      originalText: "Approve",
    });
    expect(invocations).toEqual(["a", "b"]);
    expect(released).toBe(1);
    expect(retained).toBe(0);
    expect(
      (
        await respondWorkflow({
          directory,
          requestId,
          responseId: "response-1",
          sourceEvent: {},
          route,
        })
      ).receipt,
    ).toEqual(final.responses[0]);
    await expect(
      respondWorkflow({
        directory,
        requestId,
        responseId: "response-1",
        sourceEvent: {},
        route: {
          authenticate: async () => ({
            ...(await route.authenticate()),
            originalText: "Reject: changed",
          }),
        },
      }),
    ).rejects.toThrow("Conflicting response identity");

    waitForB = true;
    const secondDirectory = join(root, "second-control");
    const second = await runDurableWorkflow({
      ...options,
      directory: secondDirectory,
      invocationId: "invocation-2",
    });
    const firstRequest = second.requests.find((item) => item.taskId === "a")!;
    const secondRequest = second.requests.find((item) => item.taskId === "b")!;
    expect(
      (
        await respondWorkflow({
          directory: secondDirectory,
          requestId: firstRequest.id,
          responseId: "shared-id",
          sourceEvent: {},
          route,
        })
      ).status,
    ).toBe("queued");
    await expect(
      respondWorkflow({
        directory: secondDirectory,
        requestId: secondRequest.id,
        responseId: "shared-id",
        sourceEvent: {},
        route,
      }),
    ).rejects.toThrow("Conflicting response identity");
    expect(
      (
        await respondWorkflow({
          directory: secondDirectory,
          requestId: secondRequest.id,
          responseId: "second-id",
          sourceEvent: {},
          route,
        })
      ).status,
    ).toBe("queued");
    const processed = await processWorkflowResponses(
      secondDirectory,
      project.validateHumanRequest,
    );
    expect(processed.responses).toHaveLength(2);
    expect(processed.tasks.a?.status).toBe("accepted");
    expect(processed.tasks.b?.status).toBe("accepted");
  } finally {
    finishB();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it("retains rejection feedback and allowance, and rejects stale evidence after a stopped delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-stopped-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const worktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "review" },
  });
  const evidence = join(root, "evidence.txt");
  await writeFile(evidence, "original\n");
  const sha256 = createHash("sha256")
    .update(await readFile(evidence))
    .digest("hex");
  let calls = 0;
  let retained = 0;
  const project: WorkflowProject & {
    validateHumanRequest(request: WorkflowRequest): Promise<boolean>;
  } = {
    root,
    capabilities: [],
    getTask: async () => ({
      id: "a",
      reference: "issue:a",
      state: "ready",
      dependencies: [],
      scope: ["a.txt"],
      requiredRoles: [],
      requiredCapabilities: [],
    }),
    reserve: async () => ({
      id: "reservation",
      release: () => {},
      retain: () => {
        retained++;
      },
    }),
    prompt: () => "fixture",
    check: async () => ({ status: "passed", evidence: [evidence] }),
    accept: async () => ({
      status: "waiting",
      evidence: [evidence],
      request: {
        owner: "owner",
        phase: "acceptance",
        target: "main",
        question: "Approve?",
        contract: "contract",
        manifest: "manifest",
        checkpoint: "checkpoint",
        evidence: [{ path: evidence, sha256 }],
        display: {
          questionId: "question",
          sourceRef: "host-event",
          route: "host",
        },
      },
    }),
    validateHumanRequest: async () => true,
  };
  const routed = (originalText: string, owner = "owner") => ({
    authenticate: async () => ({
      originalText,
      owner,
      questionId: "question",
      sourceRef: "host-event",
      eventId: "human-1",
    }),
  });
  const options = (directory: string, invocationId: string) => ({
    directory,
    invocationId,
    projectId: "project",
    project,
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: {
      a: {
        ...worktree,
        run: async () => {
          calls++;
          await writeFile(
            join(worktree.worktreePath, "a.txt"),
            `version ${calls}\n`,
          );
          git(worktree.worktreePath, "add", "a.txt");
          git(worktree.worktreePath, "commit", "-m", `version ${calls}`);
          return {
            iterations: [{}],
            commits: [{ sha: git(worktree.worktreePath, "rev-parse", "HEAD") }],
          } as never;
        },
      },
    },
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent: {
            buildPrintCommand: () => ({}),
            parseStreamLine: () => ({}),
          } as never,
          sandbox: { tag: "none", create: () => ({}) } as never,
        },
      },
    },
  });
  try {
    const directory = join(root, "first-control");
    const stopped = await runDurableWorkflow(options(directory, "first"));
    expect(stopped.lifecycle).toBe("stopped");
    expect(stopped.tasks.a?.remaining).toBe(1);
    expect(retained).toBe(1);
    const requestId = stopped.requests[0]!.id;
    await expect(
      respondWorkflow({
        directory,
        requestId,
        responseId: "bad-owner",
        sourceEvent: {},
        route: routed("Approve", "impostor"),
      }),
    ).rejects.toThrow("not authenticated");
    expect(
      (
        await respondWorkflow({
          directory,
          requestId,
          responseId: "reject",
          sourceEvent: {},
          route: routed("Reject: fix the missing case"),
        })
      ).status,
    ).toBe("queued");
    await expect(
      respondWorkflow({
        directory,
        requestId,
        responseId: "approve",
        sourceEvent: {},
        route: routed("Approve"),
      }),
    ).rejects.toThrow("Conflicting response identity");
    const rejected = await processWorkflowResponses(
      directory,
      project.validateHumanRequest,
    );
    expect(rejected.tasks.a?.status).toBe("rejected");
    expect(rejected.tasks.a?.reason).toContain("missing case");
    expect(calls).toBe(1);
    expect((await requestWorkflowRework(directory, "a")).tasks.a?.status).toBe(
      "rework-requested",
    );
    expect(calls).toBe(1);
    await cancelWorkflowTask(directory, "a");
    expect((await workflowStatus(directory)).tasks.a?.status).toBe("cancelled");

    const staleDirectory = join(root, "second-control");
    const pending = await runDurableWorkflow(options(staleDirectory, "second"));
    const staleRequestId = pending.requests[0]!.id;
    await respondWorkflow({
      directory: staleDirectory,
      requestId: staleRequestId,
      responseId: "stale",
      sourceEvent: {},
      route: routed("Approve"),
    });
    await writeFile(evidence, "changed\n");
    const stale = await processWorkflowResponses(
      staleDirectory,
      project.validateHumanRequest,
    );
    expect(stale.responses[0]?.status).toBe("stale");
    expect(stale.requests[0]?.status).toBe("stale");
    expect(stale.tasks.a?.status).toBe("blocked");
    expect(calls).toBe(2);

    await writeFile(evidence, "original\n");
    const changedDirectory = join(root, "changed-control");
    const changed = await runDurableWorkflow(
      options(changedDirectory, "changed"),
    );
    await respondWorkflow({
      directory: changedDirectory,
      requestId: changed.requests[0]!.id,
      responseId: "changed",
      sourceEvent: {},
      route: routed("Approve"),
    });
    await writeFile(join(worktree.worktreePath, "other.txt"), "new commit\n");
    git(worktree.worktreePath, "add", "other.txt");
    git(worktree.worktreePath, "commit", "-m", "change candidate");
    const changedResult = await processWorkflowResponses(
      changedDirectory,
      project.validateHumanRequest,
    );
    expect(changedResult.responses[0]?.status).toBe("stale");
    expect(changedResult.tasks.a?.status).toBe("blocked");

    const cancelledDirectory = join(root, "cancelled-control");
    const cancellable = await runDurableWorkflow(
      options(cancelledDirectory, "cancelled"),
    );
    await respondWorkflow({
      directory: cancelledDirectory,
      requestId: cancellable.requests[0]!.id,
      responseId: "cancelled",
      sourceEvent: {},
      route: routed("Approve"),
    });
    await cancelWorkflowTask(cancelledDirectory, "a");
    const cancelled = await processWorkflowResponses(
      cancelledDirectory,
      project.validateHumanRequest,
    );
    expect(cancelled.responses[0]?.status).toBe("stale");
    expect(cancelled.tasks.a?.status).toBe("cancelled");
    expect(calls).toBe(4);
  } finally {
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});
