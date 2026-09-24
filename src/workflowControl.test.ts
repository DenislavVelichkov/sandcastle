import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorktree, type Worktree } from "./createWorktree.js";
import type { WorkflowProject, WorkflowTask } from "./workflow.js";
import {
  cancelWorkflowTask,
  processWorkflowResponses,
  requestWorkflowRework,
  respondWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type WorkflowRequest,
} from "./workflowControl.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

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
      await writeFile(join(real.worktreePath, `${id}.txt`), `${id}\n`);
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
      candidate.task.id === "a"
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
        `import { workflowStatus } from './src/workflowControl.ts'; console.log((await workflowStatus(${JSON.stringify(directory)})).requests[0].id)`,
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
    const delivered = await respondWorkflow({
      directory,
      requestId,
      responseId: "response-1",
      sourceEvent: {},
      route,
    });
    expect(delivered.status).toBe("queued");
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
  } finally {
    finishB();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
  } finally {
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});
