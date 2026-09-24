import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  createWorktree,
  integrateWorkflowTask,
  processWorkflowResponses,
  recoverDurableWorkflow,
  respondWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type DurableWorkflowOptions,
  type Worktree,
} from "./index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const fixture = async (human = false, file = "a.txt") => {
  const base = await mkdtemp(join(tmpdir(), "sandcastle-integration-"));
  const root = join(base, "repo");
  await mkdir(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, ".gitignore"), ".sandcastle/\n");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "base");
  const worktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "candidate" },
  });
  const evidence = join(base, "evidence.txt");
  await writeFile(evidence, "reviewed\n");
  const evidenceHash = createHash("sha256")
    .update(await readFile(evidence))
    .digest("hex");
  const directory = join(base, "control");
  const task = {
    id: "a",
    reference: "issue:a",
    state: "ready" as const,
    dependencies: [],
    scope: [file],
    requiredRoles: [],
    requiredCapabilities: [],
  };
  let review = "review-v1";
  let humanValid = true;
  let lockCalls = 0;
  const mock: Worktree = {
    ...worktree,
    run: async () => {
      await writeFile(join(worktree.worktreePath, file), "candidate\n");
      git(worktree.worktreePath, "add", file);
      git(worktree.worktreePath, "commit", "-m", "candidate");
      return {
        iterations: [{}],
        commits: [{ sha: git(worktree.worktreePath, "rev-parse", "HEAD") }],
      } as never;
    },
  };
  const project: DurableWorkflowOptions["project"] = {
    root,
    capabilities: [],
    getTask: async () => task,
    reserve: async () => ({
      id: "reservation",
      retain: () => {},
      release: () => {},
    }),
    prompt: () => "fixture",
    check: async () => ({
      status: "passed",
      evidence: [evidence],
      reason: review,
    }),
    accept: async () =>
      human
        ? {
            status: "waiting",
            evidence: [evidence],
            request: {
              owner: "owner",
              phase: "acceptance",
              target: "main",
              question: "Approve?",
              contract: "contract-v1",
              manifest: "manifest-v1",
              checkpoint: "checkpoint-v1",
              evidence: [{ path: evidence, sha256: evidenceHash }],
              display: {
                questionId: "question",
                sourceRef: "host",
                route: "host",
              },
            },
          }
        : { status: "accepted", evidence: [evidence] },
    validateHumanRequest: async () => humanValid,
    withTargetLock: async (_branch, action) => {
      lockCalls++;
      const lock = join(base, "target.lock");
      await mkdir(lock);
      try {
        return await action();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    },
    validateIntegration: async () => ({
      status: "passed",
      evidence: [evidence],
    }),
  };
  const options: DurableWorkflowOptions = {
    directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime-v1",
    project,
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: { a: mock },
    recoverReservation: async (id) => {
      expect(id).toBe("reservation");
    },
    policy: {
      iterations: 1,
      roles: {
        implementation: {
          agent: {
            buildPrintCommand: () => ({}),
            parseStreamLine: () => [],
          } as never,
          sandbox: { tag: "none", create: () => ({}) } as never,
        },
      },
    },
  };
  return {
    base,
    root,
    directory,
    evidence,
    task,
    options,
    worktree,
    setReview: (value: string) => {
      review = value;
    },
    setHumanValid: (value: boolean) => {
      humanValid = value;
    },
    lockCalls: () => lockCalls,
    close: async () => {
      await worktree.close();
      await rm(base, { recursive: true, force: true });
    },
  };
};

it("integrates a checked candidate once and blocks changed reviews and conflicts", async () => {
  const accepted = await fixture();
  const changed = await fixture();
  const conflicting = await fixture(false, "README.md");
  try {
    const start = await runDurableWorkflow(accepted.options);
    expect(start.tasks.a?.status).toBe("accepted");
    expect(start.integrations?.a?.status).toBe("ready");
    expect(git(accepted.root, "rev-parse", "HEAD")).toBe(start.targetHead);
    const integrated = await integrateWorkflowTask(accepted.options, "a");
    expect(integrated.tasks.a?.status).toBe("integrated");
    expect(integrated.integrations?.a?.commit).toBe(
      git(accepted.root, "rev-parse", "HEAD"),
    );
    expect(await readFile(join(accepted.root, "a.txt"), "utf8")).toBe(
      "candidate\n",
    );
    expect(
      (await integrateWorkflowTask(accepted.options, "a")).integrations?.a
        ?.commit,
    ).toBe(integrated.integrations?.a?.commit);
    expect(accepted.lockCalls()).toBe(1);

    await runDurableWorkflow(changed.options);
    changed.setReview("review-v2");
    await expect(integrateWorkflowTask(changed.options, "a")).rejects.toThrow(
      "reviewed result changed",
    );
    expect((await workflowStatus(changed.directory)).tasks.a?.status).toBe(
      "blocked",
    );
    expect(git(changed.root, "rev-parse", "HEAD")).not.toBe(
      git(changed.worktree.worktreePath, "rev-parse", "HEAD"),
    );

    await writeFile(join(conflicting.root, "README.md"), "target\n");
    git(conflicting.root, "add", "README.md");
    git(conflicting.root, "commit", "-m", "target");
    await runDurableWorkflow(conflicting.options);
    await expect(
      integrateWorkflowTask(conflicting.options, "a"),
    ).rejects.toThrow("conflicts");
    expect(git(conflicting.root, "status", "--porcelain")).toBe("");
    expect(await readFile(join(conflicting.root, "README.md"), "utf8")).toBe(
      "target\n",
    );
  } finally {
    await accepted.close();
    await changed.close();
    await conflicting.close();
  }
}, 30_000);

it("binds an owner answer to the accepted candidate and applies one effect", async () => {
  const f = await fixture(true);
  const route = {
    authenticate: async () => ({
      owner: "owner",
      questionId: "question",
      sourceRef: "host",
      eventId: "event",
      originalText: "Approve",
    }),
  };
  try {
    const waiting = await runDurableWorkflow(f.options);
    expect(waiting.tasks.a?.status).toBe("waiting");
    expect(waiting.integrations?.a).toBeUndefined();
    expect(f.lockCalls()).toBe(0);
    const requestId = waiting.requests[0]!.id;
    await respondWorkflow({
      directory: f.directory,
      requestId,
      responseId: "reply",
      sourceEvent: {},
      route,
    });
    const approved = await processWorkflowResponses(
      f.directory,
      f.options.project.validateHumanRequest,
    );
    expect(approved.tasks.a?.status).toBe("accepted");
    expect(approved.integrations?.a?.responseId).toBe("reply");
    const done = await integrateWorkflowTask(f.options, "a");
    expect(done.tasks.a?.status).toBe("integrated");
    expect(
      (
        await respondWorkflow({
          directory: f.directory,
          requestId,
          responseId: "reply",
          sourceEvent: {},
          route,
        })
      ).receipt?.status,
    ).toBe("applied");
    expect(
      (await recoverDurableWorkflow(f.options)).integrations?.a?.commit,
    ).toBe(done.integrations?.a?.commit);
  } finally {
    await f.close();
  }
}, 20_000);

it("blocks a changed candidate and an expired owner answer", async () => {
  const changed = await fixture();
  const stale = await fixture(true);
  const moved = await fixture(true);
  try {
    await runDurableWorkflow(changed.options);
    await writeFile(
      join(changed.worktree.worktreePath, "a.txt"),
      "later candidate\n",
    );
    git(changed.worktree.worktreePath, "add", "a.txt");
    git(changed.worktree.worktreePath, "commit", "-m", "later candidate");
    await expect(integrateWorkflowTask(changed.options, "a")).rejects.toThrow(
      "candidate or evidence changed",
    );
    expect((await workflowStatus(changed.directory)).tasks.a?.status).toBe(
      "blocked",
    );

    const waiting = await runDurableWorkflow(stale.options);
    await respondWorkflow({
      directory: stale.directory,
      requestId: waiting.requests[0]!.id,
      responseId: "reply",
      sourceEvent: {},
      route: {
        authenticate: async () => ({
          owner: "owner",
          questionId: "question",
          sourceRef: "host",
          eventId: "event",
          originalText: "Approve",
        }),
      },
    });
    await processWorkflowResponses(
      stale.directory,
      stale.options.project.validateHumanRequest,
    );
    stale.setHumanValid(false);
    await expect(integrateWorkflowTask(stale.options, "a")).rejects.toThrow(
      "human acceptance is stale",
    );
    expect((await workflowStatus(stale.directory)).tasks.a?.status).toBe(
      "blocked",
    );
    expect(git(stale.root, "rev-parse", "HEAD")).not.toBe(
      git(stale.worktree.worktreePath, "rev-parse", "HEAD"),
    );

    const waitingOnTarget = await runDurableWorkflow(moved.options);
    await writeFile(join(moved.root, "target.txt"), "new target\n");
    git(moved.root, "add", "target.txt");
    git(moved.root, "commit", "-m", "move target");
    await respondWorkflow({
      directory: moved.directory,
      requestId: waitingOnTarget.requests[0]!.id,
      responseId: "reply",
      sourceEvent: {},
      route: {
        authenticate: async () => ({
          owner: "owner",
          questionId: "question",
          sourceRef: "host",
          eventId: "event",
          originalText: "Approve",
        }),
      },
    });
    const staleTarget = await processWorkflowResponses(
      moved.directory,
      moved.options.project.validateHumanRequest,
    );
    expect(staleTarget.responses[0]?.status).toBe("stale");
    expect(staleTarget.integrations?.a).toBeUndefined();
  } finally {
    await changed.close();
    await stale.close();
    await moved.close();
  }
}, 20_000);

it("reconciles a killed controller after Git changes the target but before its receipt", async () => {
  const f = await fixture();
  try {
    await runDurableWorkflow(f.options);
    const hook = resolve(
      f.root,
      git(f.root, "rev-parse", "--git-path", "hooks/post-merge"),
    );
    await writeFile(
      hook,
      '#!/bin/sh\nkill -KILL "$SANDCASTLE_TEST_CONTROLLER_PID"\n',
    );
    await chmod(hook, 0o755);
    const entry = pathToFileURL(join(process.cwd(), "src/index.ts")).href;
    const script = join(f.base, "integrate.mjs");
    await writeFile(
      script,
      `
      import { integrateWorkflowTask } from ${JSON.stringify(entry)};
      process.env.SANDCASTLE_TEST_CONTROLLER_PID = String(process.pid);
      const evidence = ${JSON.stringify(f.evidence)};
      const task = ${JSON.stringify(f.task)};
      await integrateWorkflowTask({
        directory: ${JSON.stringify(f.directory)},
        projectId: "project", invocationId: "invocation", runtimeIdentity: "runtime-v1",
        selected: [{ id: "a", reference: "issue:a" }],
        worktrees: { a: { worktreePath: ${JSON.stringify(f.worktree.worktreePath)} } },
        policy: { iterations: 1, roles: {} },
        recoverReservation: async () => {},
        project: {
          root: ${JSON.stringify(f.root)}, getTask: async () => task,
          check: async () => ({ status: "passed", evidence: [evidence], reason: "review-v1" }),
          validateHumanRequest: async () => true,
          validateIntegration: async () => ({ status: "passed", evidence: [evidence] }),
          withTargetLock: async (_branch, action) => action(),
        },
      }, "a");
    `,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    const [code, signal] = await once(child, "exit");
    expect([code, signal]).toContain("SIGKILL");
    const afterMerge = git(f.root, "rev-parse", "HEAD");
    expect((await workflowStatus(f.directory)).integrations?.a?.status).toBe(
      "applying",
    );
    const recovered = await recoverDurableWorkflow(f.options);
    expect(recovered.integrations?.a?.status).toBe("integrated");
    expect(recovered.integrations?.a?.commit).toBe(afterMerge);
    expect(
      (await integrateWorkflowTask(f.options, "a")).integrations?.a?.commit,
    ).toBe(afterMerge);
    expect(git(f.root, "rev-parse", "HEAD")).toBe(afterMerge);
  } finally {
    await f.close();
  }
}, 30_000);
