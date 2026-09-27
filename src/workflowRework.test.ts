import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  claudeCode,
  codex,
  checkpointStopWorkflow,
  createBindMountSandboxProvider,
  createWorktree,
  processWorkflowResponses,
  recoverDurableWorkflow,
  requestWorkflowRework,
  respondWorkflow,
  resumeDurableWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type DurableWorkflowOptions,
  type WorkflowCandidate,
  type WorkflowRequest,
  type WorkflowTask,
  type Worktree,
} from "./index.js";
import { claudeSandboxSessionPath } from "./SessionStore.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const fixture = async (
  ids: readonly string[],
  commitOnCall: (taskId: string, call: number) => boolean,
  provider: "claude" | "codex" = "claude",
  pause?: { taskId: string; call: number },
) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-rework-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const worktrees: Record<string, Worktree> = Object.fromEntries(
    await Promise.all(
      ids.map(async (id) => [
        id,
        await createWorktree({
          cwd: root,
          branchStrategy: { type: "branch", branch: `candidate-${id}` },
        }),
      ]),
    ),
  );
  const byPath = new Map(
    Object.entries(worktrees).map(([id, worktree]) => [
      worktree.worktreePath,
      id,
    ]),
  );
  const hostProjectsDir = join(root, "host-sessions");
  const sandboxProjectsDir = join(root, "sandbox-sessions");
  const hostCodexSessionsDir = join(root, "host-codex-sessions");
  const sandboxCodexSessionsDir = join(root, "sandbox-codex-sessions");
  const calls: { taskId: string; command: string }[] = [];
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finishPending: (() => void) | undefined;
  const sandbox = createBindMountSandboxProvider({
    name: "controlled-workflow-agent",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, args) => {
        if (!command.startsWith(`${provider} `)) {
          const result = spawnSync(command, {
            cwd: args?.cwd ?? worktreePath,
            shell: true,
            encoding: "utf8",
          });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status ?? 1,
          };
        }
        const taskId = byPath.get(worktreePath)!;
        const call = calls.filter((item) => item.taskId === taskId).length + 1;
        calls.push({ taskId, command });
        if (commitOnCall(taskId, call)) {
          await writeFile(
            join(worktreePath, `${taskId}.txt`),
            `candidate ${call}\n`,
          );
          git(worktreePath, "add", `${taskId}.txt`);
          git(worktreePath, "commit", "-m", `candidate ${call}`);
        }
        const sessionId = `${taskId}-${call}`;
        const sessionFile =
          provider === "claude"
            ? claudeSandboxSessionPath(
                worktreePath,
                sessionId,
                sandboxProjectsDir,
              )
            : join(
                sandboxCodexSessionsDir,
                "2026/09/27",
                `rollout-test-${sessionId}.jsonl`,
              );
        await mkdir(dirname(sessionFile), { recursive: true });
        await writeFile(
          sessionFile,
          provider === "claude"
            ? '{"session":true}\n'
            : `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: worktreePath } })}\n`,
        );
        const init = JSON.stringify(
          provider === "claude"
            ? { type: "system", subtype: "init", session_id: sessionId }
            : { type: "thread.started", thread_id: sessionId },
        );
        const result = JSON.stringify(
          provider === "claude"
            ? { type: "result", result: "<promise>COMPLETE</promise>" }
            : {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: "<promise>COMPLETE</promise>",
                },
              },
        );
        args?.onLine?.(init);
        if (pause?.taskId === taskId && pause.call === call) {
          entered();
          return new Promise((resolve) => {
            finishPending = () =>
              resolve({ stdout: init, stderr: "", exitCode: 130 });
          });
        }
        args?.onLine?.(result);
        return { stdout: `${init}\n${result}`, stderr: "", exitCode: 0 };
      },
      copyFileIn: async (from, to) => {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      },
      copyFileOut: async (from, to) => {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      },
      close: async () => {
        finishPending?.();
      },
    }),
  });
  const agent =
    provider === "claude"
      ? claudeCode("test", {
          sessionStorage: { hostProjectsDir, sandboxProjectsDir },
        })
      : codex("gpt-6-sol", {
          effort: "high",
          serviceTier: "default",
          sessionStorage: {
            hostSessionsDir: hostCodexSessionsDir,
            sandboxSessionsDir: sandboxCodexSessionsDir,
          },
        });
  let retained = false;
  let releases = 0;
  const reservation = {
    reserve: async (request: { resumeId?: string }) => {
      if (request.resumeId && request.resumeId !== "reservation")
        throw new Error("Reservation identity changed");
      return {
        id: "reservation",
        retain: () => {
          retained = true;
        },
        release: () => {
          retained = false;
          releases++;
        },
      };
    },
    recover: async (id: string) => {
      if (id !== "reservation" || !retained)
        throw new Error("Original reservation is missing");
    },
    get retained() {
      return retained;
    },
    get releases() {
      return releases;
    },
  };
  return {
    root,
    directory: join(root, "control"),
    worktrees,
    sandbox,
    agent,
    calls,
    paused,
    reservation,
    close: async () => {
      for (const worktree of Object.values(worktrees)) await worktree.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

const question = async (root: string, taskId: string, candidate: string) => {
  const path = join(root, `evidence-${taskId}-${candidate}.txt`);
  await writeFile(path, `${taskId}/${candidate}\n`);
  return {
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
};

const waitingAcceptance = async (
  root: string,
  candidate: WorkflowCandidate,
) => {
  const evidence = await question(root, candidate.task.id, candidate.head);
  return {
    status: "waiting" as const,
    evidence: [evidence.path],
    request: {
      owner: "owner",
      phase: "acceptance",
      target: "main",
      question: "Approve?",
      contract: "contract",
      manifest: "manifest",
      checkpoint: candidate.head,
      evidence: [evidence],
      display: {
        questionId: `question-${candidate.head}`,
        sourceRef: "host",
        route: "host" as const,
      },
    },
  };
};

const route = (originalText: string) => ({
  authenticate: async (_event: unknown, request: WorkflowRequest) => ({
    owner: request.owner,
    questionId: request.display.questionId,
    sourceRef: request.display.sourceRef,
    eventId: `${request.id}-${originalText}`,
    originalText,
  }),
});

it("resumes rejected work once with its feedback and fresh candidate decisions", async () => {
  const f = await fixture(["a"], (_task, call) => call % 2 === 1);
  const task: WorkflowTask = {
    id: "a",
    reference: "issue:a",
    state: "ready",
    dependencies: [],
    scope: ["a.txt"],
    requiredRoles: ["review"],
    requiredCapabilities: ["recovery"],
  };
  const prompts: (string | undefined)[] = [];
  const checked: string[] = [];
  const project: DurableWorkflowOptions["project"] = {
    root: f.root,
    capabilities: ["recovery"],
    getTask: async () => task,
    reserve: f.reservation.reserve,
    prompt: (_task, role, context) => {
      if (role === "implementation") prompts.push(context?.rejectionFeedback);
      return `Run ${role}`;
    },
    check: async (candidate) => {
      checked.push(candidate.head);
      const evidence = await question(f.root, "a", candidate.head);
      return { status: "passed", evidence: [evidence.path] };
    },
    accept: (candidate) => waitingAcceptance(f.root, candidate),
    validateHumanRequest: async () => true,
  };
  const options: DurableWorkflowOptions = {
    directory: f.directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime",
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: f.worktrees,
    project,
    recoverReservation: f.reservation.recover,
    policy: {
      iterations: 2,
      roles: {
        implementation: { agent: f.agent, sandbox: f.sandbox },
        review: { agent: f.agent, sandbox: f.sandbox },
      },
    },
  };
  try {
    const first = await runDurableWorkflow(options);
    expect(first.tasks.a).toMatchObject({ status: "waiting", remaining: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.reservation.retained).toBe(true);
    const firstRequest = first.requests[0]!;
    await respondWorkflow({
      directory: f.directory,
      requestId: firstRequest.id,
      responseId: "reject-1",
      sourceEvent: {},
      route: route("Reject: fix the missing case"),
    });
    const rejected = await processWorkflowResponses(
      f.directory,
      project.validateHumanRequest,
    );
    expect(rejected.tasks.a?.reason).toContain("missing case");
    expect(rejected.tasks.a?.status).toBe("rejected");
    expect((await recoverDurableWorkflow(options)).tasks.a?.status).toBe(
      "rejected",
    );
    expect(f.calls).toHaveLength(2);
    const requested = await requestWorkflowRework(f.directory, "a");
    expect(requested.resources.reservationId).toBe("reservation");
    expect(requested.resources.retained).toBe(true);
    expect(f.calls).toHaveLength(2);
    const second = await resumeDurableWorkflow(options);
    expect(second.tasks.a).toMatchObject({ status: "waiting", remaining: 0 });
    expect(f.calls).toHaveLength(4);
    expect(f.calls[2]?.command).toContain("--resume");
    expect(prompts).toEqual([undefined, "Reject: fix the missing case"]);
    expect(checked).toHaveLength(2);
    expect(checked[1]).not.toBe(checked[0]);
    expect(second.checksPassed?.a?.candidate).toBe(checked[1]);
    expect(second.requests).toHaveLength(2);
    expect(second.requests[0]?.status).toBe("applied");
    expect(second.requests[1]?.candidate).toBe(checked[1]);
    expect(second.responses[0]?.originalText).toBe(
      "Reject: fix the missing case",
    );
    expect(
      (
        await respondWorkflow({
          directory: f.directory,
          requestId: firstRequest.id,
          responseId: "reject-1",
          sourceEvent: {},
          route: route("Reject: fix the missing case"),
        })
      ).status,
    ).toBe("applied");
    await respondWorkflow({
      directory: f.directory,
      requestId: second.requests[1]!.id,
      responseId: "approve-2",
      sourceEvent: {},
      route: route("Approve"),
    });
    expect(
      (
        await processWorkflowResponses(
          f.directory,
          project.validateHumanRequest,
        )
      ).tasks.a?.status,
    ).toBe("accepted");
    const settled = await resumeDurableWorkflow(options);
    expect(settled.tasks.a).toMatchObject({ status: "accepted", remaining: 0 });
    expect(settled.responses).toHaveLength(2);
    expect(f.calls).toHaveLength(4);
    expect(f.reservation.retained).toBe(false);
    expect(f.reservation.releases).toBe(1);
    await expect(requestWorkflowRework(f.directory, "a")).rejects.toThrow(
      "no remaining rework allowance",
    );
  } finally {
    await f.close();
  }
}, 30_000);

it("keeps a rejected candidate when its required review allowance is spent", async () => {
  const f = await fixture(["a"], (_task, call) => call === 1, "codex");
  const task: WorkflowTask = {
    id: "a",
    reference: "issue:a",
    state: "ready",
    dependencies: [],
    scope: ["a.txt"],
    requiredRoles: ["review"],
    requiredCapabilities: ["recovery"],
  };
  const project: DurableWorkflowOptions["project"] = {
    root: f.root,
    capabilities: ["recovery"],
    getTask: async () => task,
    reserve: f.reservation.reserve,
    prompt: () => "Run selected role",
    check: async (candidate) => {
      const evidence = await question(f.root, "a", candidate.head);
      return { status: "passed", evidence: [evidence.path] };
    },
    accept: (candidate) => waitingAcceptance(f.root, candidate),
    validateHumanRequest: async () => true,
  };
  const now = Date.now();
  const options: DurableWorkflowOptions = {
    directory: f.directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime",
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: f.worktrees,
    project,
    recoverReservation: f.reservation.recover,
    policy: {
      iterations: 2,
      roles: {
        implementation: { agent: f.agent, sandbox: f.sandbox },
        review: { agent: f.agent, sandbox: f.sandbox },
      },
    },
    usage: {
      policyId: "guarded",
      activity: "library-proof",
      listModels: async () => ({
        data: [
          {
            model: "gpt-6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
      }),
      readAccount: async () => ({
        accountId: "account",
        observedAt: Date.now(),
        denied: false,
        windows: {
          weekly: {
            usedPercent: 10,
            resetsAt: now + 7 * 24 * 60 * 60_000,
          },
        },
      }),
    },
  };
  try {
    const first = await runDurableWorkflow(options);
    expect(first.tasks.a?.status).toBe("waiting");
    expect(first.usage?.remaining.a).toMatchObject({
      implementation: 1,
      review: 0,
    });
    await respondWorkflow({
      directory: f.directory,
      requestId: first.requests[0]!.id,
      responseId: "reject-1",
      sourceEvent: {},
      route: route("Reject: fix it"),
    });
    await processWorkflowResponses(f.directory, project.validateHumanRequest);
    await requestWorkflowRework(f.directory, "a");
    const blocked = await resumeDurableWorkflow(options);
    expect(blocked.tasks.a).toMatchObject({
      status: "blocked",
      remaining: 1,
      reason: "No reserved invocation remains for a/review",
    });
    expect(blocked.resources).toMatchObject({
      reservationId: "reservation",
      retained: true,
    });
    expect(blocked.usage?.remaining.a).toMatchObject({
      implementation: 1,
      review: 0,
    });
    expect(git(f.worktrees.a!.worktreePath, "rev-parse", "HEAD")).toBe(
      first.requests[0]?.candidate,
    );
    expect(f.calls).toHaveLength(2);
    expect((await resumeDurableWorkflow(options)).tasks.a?.status).toBe(
      "blocked",
    );
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30_000);

it("retains the same reservation when the last rework attempt is interrupted", async () => {
  const f = await fixture(["a"], (_task, call) => call === 1, "claude", {
    taskId: "a",
    call: 2,
  });
  const task: WorkflowTask = {
    id: "a",
    reference: "issue:a",
    state: "ready",
    dependencies: [],
    scope: ["a.txt"],
    requiredRoles: [],
    requiredCapabilities: ["recovery"],
  };
  const project: DurableWorkflowOptions["project"] = {
    root: f.root,
    capabilities: ["recovery"],
    getTask: async () => task,
    reserve: f.reservation.reserve,
    prompt: () => "Implement selected task",
    check: async (candidate) => {
      const evidence = await question(f.root, "a", candidate.head);
      return { status: "passed", evidence: [evidence.path] };
    },
    accept: (candidate) => waitingAcceptance(f.root, candidate),
    validateHumanRequest: async () => true,
  };
  const options: DurableWorkflowOptions = {
    directory: f.directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime",
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: f.worktrees,
    project,
    recoverReservation: f.reservation.recover,
    policy: {
      iterations: 2,
      roles: { implementation: { agent: f.agent, sandbox: f.sandbox } },
    },
  };
  try {
    const first = await runDurableWorkflow(options);
    await respondWorkflow({
      directory: f.directory,
      requestId: first.requests[0]!.id,
      responseId: "reject-1",
      sourceEvent: {},
      route: route("Reject: repair it"),
    });
    await processWorkflowResponses(f.directory, project.validateHumanRequest);
    expect(
      (await requestWorkflowRework(f.directory, "a")).resources.retained,
    ).toBe(true);
    const execution = resumeDurableWorkflow(options);
    await f.paused;
    const active = await workflowStatus(f.directory);
    expect(active.tasks.a?.status).toBe("active");
    expect(active.resources).toMatchObject({
      reservationId: "reservation",
      retained: true,
    });
    const stopped = await checkpointStopWorkflow(f.directory);
    expect((await execution).revision).toBe(stopped.revision);
    expect(stopped.tasks.a).toMatchObject({ status: "paused", remaining: 0 });
    expect(stopped.resources.retained).toBe(true);
    const blocked = await resumeDurableWorkflow(options);
    expect(blocked.tasks.a).toMatchObject({
      status: "blocked",
      remaining: 0,
      reason: "No implementation allowance remains for interrupted work",
    });
    expect(blocked.resources.retained).toBe(true);
    expect(f.reservation.releases).toBe(0);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30_000);

it("reconsiders only a dependency blocker after its prerequisite is approved", async () => {
  const ids = ["parent", "child", "grandchild", "other"];
  const f = await fixture(ids, () => true);
  const tasks: WorkflowTask[] = ids.map((id) => ({
    id,
    reference: `issue:${id}`,
    state: "ready",
    dependencies:
      id === "child" ? ["parent"] : id === "grandchild" ? ["child"] : [],
    scope: [`${id}.txt`],
    requiredRoles: [],
    requiredCapabilities: ["recovery"],
  }));
  const project: DurableWorkflowOptions["project"] = {
    root: f.root,
    capabilities: ["recovery"],
    getTask: async (id) => tasks.find((task) => task.id === id),
    reserve: f.reservation.reserve,
    prompt: () => "Implement selected task",
    check: async (candidate) =>
      candidate.task.id === "other"
        ? { status: "failed", evidence: [], reason: "Other check failed" }
        : { status: "passed", evidence: [] },
    accept: (candidate) => waitingAcceptance(f.root, candidate),
    validateHumanRequest: async () => true,
  };
  const options: DurableWorkflowOptions = {
    directory: f.directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime",
    selected: tasks.map((task) => ({ id: task.id, reference: task.reference })),
    worktrees: f.worktrees,
    project,
    recoverReservation: f.reservation.recover,
    policy: {
      iterations: 1,
      roles: { implementation: { agent: f.agent, sandbox: f.sandbox } },
    },
  };
  try {
    const first = await runDurableWorkflow(options);
    expect(first.tasks.parent?.status).toBe("waiting");
    expect(first.tasks.child?.reason).toBe(
      "Selected dependency has not been accepted",
    );
    expect(first.tasks.grandchild?.status).toBe("blocked");
    expect(first.tasks.other?.reason).toBe("Other check failed");
    expect(f.calls.map((call) => call.taskId)).toEqual(["parent", "other"]);
    expect(f.reservation.retained).toBe(true);
    const request = first.requests[0]!;
    await respondWorkflow({
      directory: f.directory,
      requestId: request.id,
      responseId: "approve-parent",
      sourceEvent: {},
      route: route("Approve"),
    });
    expect(
      (
        await processWorkflowResponses(
          f.directory,
          project.validateHumanRequest,
        )
      ).tasks.parent?.status,
    ).toBe("accepted");
    const second = await resumeDurableWorkflow(options);
    expect(second.tasks.parent?.status).toBe("accepted");
    expect(second.tasks.child?.status).toBe("waiting");
    expect(second.tasks.grandchild?.reason).toBe(
      "Selected dependency has not been accepted",
    );
    expect(second.tasks.other?.reason).toBe("Other check failed");
    expect(f.calls.map((call) => call.taskId)).toEqual([
      "parent",
      "other",
      "child",
    ]);
    expect((await workflowStatus(f.directory)).resources.retained).toBe(true);
    expect((await resumeDurableWorkflow(options)).tasks.child?.status).toBe(
      "waiting",
    );
    expect(f.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 30_000);
