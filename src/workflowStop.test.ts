import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  checkpointStopWorkflow,
  claudeCode,
  createBindMountSandboxProvider,
  createWorktree,
  recoverDurableWorkflow,
  integrateWorkflowTask,
  processWorkflowResponses,
  respondWorkflow,
  resumeDurableWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type DurableWorkflowOptions,
} from "./index.js";
import { claudeSandboxSessionPath } from "./SessionStore.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("stops an active workflow after session capture and restores its exact saved state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-stop-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const worktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "active" },
  });
  const directory = join(root, "control");
  const hostProjectsDir = join(root, "host-sessions");
  const sandboxProjectsDir = join(root, "sandbox-sessions");
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let retained = 0;
  let calls = 0;
  let resumedSession: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const task = {
    id: "a",
    reference: "issue:a",
    state: "ready" as const,
    dependencies: [],
    scope: ["README.md", "new.txt"],
    requiredRoles: ["review"],
    requiredCapabilities: ["recovery"],
  };
  let finishPending: (() => void) | undefined;
  const sandbox = createBindMountSandboxProvider({
    name: "controlled-agent",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, args) => {
        if (!command.startsWith("claude ")) {
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
        calls++;
        const sessionId = calls === 3 ? "review-session" : "session-1";
        const init = JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: sessionId,
        });
        args?.onLine?.(init);
        if (calls > 1) {
          if (calls === 2) {
            resumedSession = command.includes("--resume")
              ? "session-1"
              : undefined;
            git(worktreePath, "add", "README.md", "new.txt");
            git(worktreePath, "commit", "-m", "finish");
          } else {
            const sessionFile = claudeSandboxSessionPath(
              worktreePath,
              sessionId,
              sandboxProjectsDir,
            );
            await mkdir(dirname(sessionFile), { recursive: true });
            await writeFile(sessionFile, '{"session":true}\n');
          }
          const result = JSON.stringify({
            type: "result",
            result: "<promise>COMPLETE</promise>",
          });
          args?.onLine?.(result);
          return { stdout: `${init}\n${result}`, stderr: "", exitCode: 0 };
        }
        await writeFile(join(worktreePath, "README.md"), "unfinished\n");
        await writeFile(join(worktreePath, "new.txt"), "untracked\n");
        const sessionFile = claudeSandboxSessionPath(
          worktreePath,
          "session-1",
          sandboxProjectsDir,
        );
        await mkdir(dirname(sessionFile), { recursive: true });
        await writeFile(sessionFile, '{"session":true}\n');
        started();
        return new Promise((resolve) => {
          finishPending = () =>
            resolve({ stdout: init, stderr: "", exitCode: 130 });
        });
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
  const options: DurableWorkflowOptions = {
    directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime-v1",
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: { a: worktree },
    project: {
      root,
      capabilities: ["recovery"],
      getTask: async () => task,
      reserve: async () => ({
        id: "reservation-1",
        retain: () => {
          retained++;
        },
        release: () => {},
      }),
      prompt: () => "fixture",
      check: async () => ({ status: "passed", evidence: [] }),
      accept: async () => ({ status: "accepted", evidence: [] }),
      validateHumanRequest: async () => true,
    },
    recoverReservation: async (id) => {
      expect(id).toBe("reservation-1");
    },
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent: claudeCode("test", {
            sessionStorage: { hostProjectsDir, sandboxProjectsDir },
          }),
          sandbox,
        },
        review: {
          agent: claudeCode("test", {
            sessionStorage: { hostProjectsDir, sandboxProjectsDir },
          }),
          sandbox,
        },
      },
    },
  };
  try {
    const exposed = join(worktree.worktreePath, "host-state");
    await expect(
      runDurableWorkflow({ ...options, directory: exposed }),
    ).rejects.toThrow("outside agent worktrees");
    await rm(exposed, { recursive: true, force: true });
    const execution = runDurableWorkflow(options);
    await running;
    await expect(recoverDurableWorkflow(options)).rejects.toThrow(
      "Workflow owner is still running",
    );
    const receipt = await checkpointStopWorkflow(directory);
    expect((await execution).revision).toBe(receipt.revision);
    expect(receipt.lifecycle).toBe("stopped");
    expect(receipt.sourceRestoration).toBe("verified");
    expect(receipt.sessionRestoration).toBe("verified");
    expect(receipt.tasks.a).toMatchObject({ status: "paused", remaining: 1 });
    expect(retained).toBe(1);
    expect(await readFile(join(worktree.worktreePath, "new.txt"), "utf8")).toBe(
      "untracked\n",
    );
    await expect(
      recoverDurableWorkflow({
        ...options,
        policy: { ...options.policy, iterations: 3 },
      }),
    ).rejects.toThrow("iteration allowance changed");
    const stateFile = join(directory, "state.json");
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const processStat = await readFile(`/proc/${child.pid}/stat`, "utf8");
    const childStart =
      processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
    const interrupted = {
      ...receipt,
      lifecycle: "running",
      owner: { ...receipt.owner, start: "expired" },
      processes: [{ pid: child.pid, start: childStart }],
    };
    await writeFile(stateFile, JSON.stringify(interrupted));
    await expect(recoverDurableWorkflow(options)).rejects.toThrow(
      "Owned descendant survived",
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;
    await writeFile(
      stateFile,
      JSON.stringify({ ...interrupted, processes: [] }),
    );
    expect((await recoverDurableWorkflow(options)).lifecycle).toBe("stopped");
    expect((await workflowStatus(directory)).tasks.a?.remaining).toBe(1);
    const resumed = await resumeDurableWorkflow(options);
    expect(resumedSession).toBe("session-1");
    expect(resumed.tasks.a).toMatchObject({ status: "accepted", remaining: 0 });
    expect(resumed.sessions?.a).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "review", id: "review-session" }),
      ]),
    );
    expect(calls).toBe(3);
    const checkpointDir = join(
      directory,
      "checkpoints",
      resumed.checkpoint!.id,
    );
    const manifest = JSON.parse(
      await readFile(join(checkpointDir, "manifest.json"), "utf8"),
    ) as { worktrees: { a: { files: { sha256?: string }[] } } };
    const sha256 = manifest.worktrees.a.files.find(
      (file) => file.sha256,
    )?.sha256;
    await writeFile(join(checkpointDir, "blobs", sha256!), "corrupt\n");
    await expect(recoverDurableWorkflow(options)).rejects.toThrow(
      "blob changed",
    );
    expect((await workflowStatus(directory)).lifecycle).toBe(
      "recovery-required",
    );
  } finally {
    child?.kill("SIGKILL");
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "check",
  "acceptance",
  "uncertain-acceptance",
  "failed-acceptance",
] as const)(
  "handles interrupted %s without another agent call",
  async (barrierPhase) => {
    const base = await mkdtemp(join(tmpdir(), "sandcastle-check-stop-"));
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
    const directory = join(base, "control");
    const evidence = join(base, "evidence.txt");
    await writeFile(evidence, "reviewed\n");
    const evidenceHash = createHash("sha256")
      .update(await readFile(evidence))
      .digest("hex");
    const hostProjectsDir = join(base, "host-sessions");
    const sandboxProjectsDir = join(base, "sandbox-sessions");
    let calls = 0;
    let checks = 0;
    let acceptances = 0;
    let checkStarted!: () => void;
    const checking = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    let finishCheck!: () => void;
    const checkBarrier = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const sandbox = createBindMountSandboxProvider({
      name: "controlled-agent",
      create: async ({ worktreePath }) => ({
        worktreePath,
        exec: async (command, args) => {
          if (!command.startsWith("claude ")) {
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
          calls++;
          const sessionId = `session-${calls}`;
          const init = JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: sessionId,
          });
          args?.onLine?.(init);
          if (calls === 1) {
            await writeFile(join(worktreePath, "candidate.txt"), "candidate\n");
            git(worktreePath, "add", "candidate.txt");
            git(worktreePath, "commit", "-m", "candidate");
          }
          const sessionFile = claudeSandboxSessionPath(
            worktreePath,
            sessionId,
            sandboxProjectsDir,
          );
          await mkdir(dirname(sessionFile), { recursive: true });
          await writeFile(sessionFile, '{"session":true}\n');
          const result = JSON.stringify({
            type: "result",
            result: "<promise>COMPLETE</promise>",
          });
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
        close: async () => {},
      }),
    });
    const task = {
      id: "a",
      reference: "issue:a",
      state: "ready" as const,
      dependencies: [],
      scope: ["candidate.txt"],
      requiredRoles: ["review"],
      requiredCapabilities: ["recovery"],
    };
    const options: DurableWorkflowOptions = {
      directory,
      projectId: "project",
      invocationId: "invocation",
      runtimeIdentity: "runtime-v1",
      selected: [{ id: task.id, reference: task.reference }],
      worktrees: { a: worktree },
      project: {
        root,
        capabilities: ["recovery"],
        getTask: async () => task,
        reserve: async () => ({
          id: "reservation",
          retain: () => {},
          release: () => {},
        }),
        prompt: () => "fixture",
        check: async () => {
          checks++;
          if (checks === 1 && barrierPhase === "check") {
            checkStarted();
            await checkBarrier;
          }
          return { status: "passed", evidence: [evidence] };
        },
        accept: async () => {
          acceptances++;
          if (acceptances === 1 && barrierPhase !== "check") {
            checkStarted();
            await checkBarrier;
          }
          if (
            barrierPhase === "uncertain-acceptance" ||
            barrierPhase === "failed-acceptance"
          )
            throw new Error("host answer outcome was lost");
          return {
            status: "waiting",
            evidence: [evidence],
            request: {
              owner: "owner",
              phase: "acceptance",
              target: "main",
              question: "Approve?",
              contract: "contract",
              manifest: "manifest",
              checkpoint: "project-checkpoint",
              evidence: [{ path: evidence, sha256: evidenceHash }],
              display: {
                questionId: "question",
                sourceRef: "host",
                route: "host",
              },
            },
          };
        },
        validateHumanRequest: async () => true,
        withTargetLock: async (_branch, action) => action(),
        validateIntegration: async () => ({
          status: "passed",
          evidence: [evidence],
        }),
      },
      recoverReservation: async (id) => {
        expect(id).toBe("reservation");
      },
      policy: {
        iterations: 1,
        roles: {
          implementation: {
            agent: claudeCode("test", {
              sessionStorage: { hostProjectsDir, sandboxProjectsDir },
            }),
            sandbox,
          },
          review: {
            agent: claudeCode("test", {
              sessionStorage: { hostProjectsDir, sandboxProjectsDir },
            }),
            sandbox,
          },
        },
      },
    };
    try {
      const execution = runDurableWorkflow(options);
      if (
        barrierPhase === "uncertain-acceptance" ||
        barrierPhase === "failed-acceptance"
      )
        void execution.catch(() => {});
      await checking;
      expect((await workflowStatus(directory)).unfinished.a?.phase).toBe(
        barrierPhase === "check" ? "verification" : "acceptance",
      );
      const candidate = git(worktree.worktreePath, "rev-parse", "HEAD");
      const stopping =
        barrierPhase === "failed-acceptance"
          ? undefined
          : checkpointStopWorkflow(directory);
      if (stopping)
        await expect
          .poll(async () => (await workflowStatus(directory)).lifecycle)
          .toBe("stopping");
      finishCheck();
      if (
        barrierPhase === "uncertain-acceptance" ||
        barrierPhase === "failed-acceptance"
      ) {
        if (stopping)
          await expect(stopping).rejects.toThrow(
            "Acceptance outcome is uncertain",
          );
        await expect(execution).rejects.toThrow(
          "Acceptance outcome is uncertain",
        );
        const status = await workflowStatus(directory);
        expect(status.lifecycle).toBe("recovery-required");
        expect(status.tasks.a?.status).toBe("blocked");
        expect(status.tasks.a?.reason).toContain(
          "Acceptance outcome is uncertain",
        );
        expect(status.resources.retained).toBe(true);
        await expect(resumeDurableWorkflow(options)).rejects.toThrow(
          "Acceptance outcome is uncertain",
        );
        expect(acceptances).toBe(1);
        expect(calls).toBe(2);
        return;
      }
      const stopped = await stopping!;
      expect((await execution).revision).toBe(stopped.revision);
      expect(stopped.tasks.a?.remaining).toBe(0);
      if (barrierPhase === "check") {
        expect(stopped.tasks.a?.status).toBe("paused");
        expect((await workflowStatus(directory)).unfinished?.a?.phase).toBe(
          "verification",
        );
        expect(acceptances).toBe(0);
      } else {
        expect(stopped.tasks.a?.status).toBe("waiting");
        expect(stopped.requests).toHaveLength(1);
        expect(acceptances).toBe(1);
      }
      expect(calls).toBe(2);

      await writeFile(
        join(worktree.worktreePath, "candidate.txt"),
        "changed\n",
      );
      git(worktree.worktreePath, "add", "candidate.txt");
      git(worktree.worktreePath, "commit", "-m", "changed candidate");
      await expect(resumeDurableWorkflow(options)).rejects.toThrow();
      expect((await workflowStatus(directory)).lifecycle).toBe(
        "recovery-required",
      );
      git(worktree.worktreePath, "reset", "--hard", candidate);
      if (barrierPhase === "check") {
        const records = await Promise.all(
          (await readdir(join(directory, "roles"))).map(async (name) => ({
            path: join(directory, "roles", name),
            text: await readFile(join(directory, "roles", name), "utf8"),
          })),
        );
        const review = records.find(
          (record) =>
            (JSON.parse(record.text) as { role: string }).role === "review",
        )!;
        await writeFile(
          review.path,
          JSON.stringify({ taskId: "a", role: "review" }),
        );
        expect(
          (await workflowStatus(directory)).unfinished.a?.blocker,
        ).toContain("candidate-bound proof");
        await expect(resumeDurableWorkflow(options)).rejects.toThrow(
          "candidate-bound completed-role proof",
        );
        expect((await workflowStatus(directory)).resources.retained).toBe(true);
        await writeFile(review.path, review.text);
      }

      const waiting = await resumeDurableWorkflow(options);
      expect(waiting.tasks.a?.status).toBe("waiting");
      expect(waiting.requests).toHaveLength(1);
      expect(waiting.checksPassed?.a?.candidate).toBe(candidate);
      expect(checks).toBe(barrierPhase === "check" ? 2 : 1);
      expect(acceptances).toBe(1);
      expect(calls).toBe(2);
      const repeated = await resumeDurableWorkflow(options);
      expect(repeated.requests[0]?.id).toBe(waiting.requests[0]?.id);
      expect(acceptances).toBe(1);
      expect(calls).toBe(2);

      await respondWorkflow({
        directory,
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
      const approved = await processWorkflowResponses(
        directory,
        options.project.validateHumanRequest,
      );
      expect(approved.tasks.a?.status).toBe("accepted");
      const integrated = await integrateWorkflowTask(options, "a");
      expect(integrated.tasks.a?.status).toBe("integrated");
      expect(
        (await integrateWorkflowTask(options, "a")).integrations?.a?.commit,
      ).toBe(integrated.integrations?.a?.commit);
      expect(calls).toBe(2);
    } finally {
      finishCheck();
      await worktree.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30_000,
);

it.each([
  { name: "session capture fails", cleanupFails: false },
  { name: "sandbox cleanup fails", cleanupFails: true },
])("withholds the stopped receipt when $name", async ({ cleanupFails }) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-missing-session-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  const worktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "unfinished" },
  });
  const directory = join(root, "control");
  const hostProjectsDir = join(root, "host-sessions");
  const sandboxProjectsDir = join(root, "sandbox-sessions");
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finishPending: (() => void) | undefined;
  const sandbox = createBindMountSandboxProvider({
    name: "controlled-agent",
    create: async ({ worktreePath }) => {
      let role = "";
      return {
        worktreePath,
        exec: async (command, args) => {
          if (!command.startsWith("claude ")) {
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
          role = args?.stdin ?? "";
          const sessionId =
            role === "implementation"
              ? "implementation-session"
              : "review-session";
          const init = JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: sessionId,
          });
          args?.onLine?.(init);
          if (role === "implementation") {
            await writeFile(join(worktreePath, "draft.txt"), "keep me\n");
            git(worktreePath, "add", "draft.txt");
            git(worktreePath, "commit", "-m", "implementation");
            const sessionFile = claudeSandboxSessionPath(
              worktreePath,
              sessionId,
              sandboxProjectsDir,
            );
            await mkdir(dirname(sessionFile), { recursive: true });
            await writeFile(sessionFile, '{"session":true}\n');
            const result = JSON.stringify({
              type: "result",
              result: "<promise>COMPLETE</promise>",
            });
            args?.onLine?.(result);
            return { stdout: `${init}\n${result}`, stderr: "", exitCode: 0 };
          }
          if (cleanupFails) {
            const sessionFile = claudeSandboxSessionPath(
              worktreePath,
              sessionId,
              sandboxProjectsDir,
            );
            await mkdir(dirname(sessionFile), { recursive: true });
            await writeFile(sessionFile, '{"session":true}\n');
          }
          started();
          return new Promise((resolve) => {
            finishPending = () =>
              resolve({ stdout: init, stderr: "", exitCode: 130 });
          });
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
          if (cleanupFails && role === "review")
            throw new Error("close failed");
        },
      };
    },
  });
  const options: DurableWorkflowOptions = {
    directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime-v1",
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: { a: worktree },
    project: {
      root,
      capabilities: ["recovery"],
      getTask: async () => ({
        id: "a",
        reference: "issue:a",
        state: "ready",
        dependencies: [],
        scope: ["draft.txt"],
        requiredRoles: ["review"],
        requiredCapabilities: ["recovery"],
      }),
      reserve: async () => ({
        id: "reservation",
        retain: () => {},
        release: () => {},
      }),
      prompt: (_task, role) => role,
      check: async () => ({ status: "passed", evidence: [] }),
      accept: async () => ({ status: "accepted", evidence: [] }),
      validateHumanRequest: async () => true,
    },
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent: claudeCode("test", {
            sessionStorage: { hostProjectsDir, sandboxProjectsDir },
          }),
          sandbox,
        },
        review: {
          agent: claudeCode("test", {
            sessionStorage: { hostProjectsDir, sandboxProjectsDir },
          }),
          sandbox,
        },
      },
    },
  };
  try {
    const execution = runDurableWorkflow(options).catch(
      (error: unknown) => error,
    );
    await running;
    const reason = cleanupFails
      ? "Sandbox cleanup failed"
      : "Required agent session";
    await expect(checkpointStopWorkflow(directory)).rejects.toThrow(reason);
    expect(String(await execution)).toContain(reason);
    expect((await workflowStatus(directory)).lifecycle).toBe(
      "recovery-required",
    );
    expect(
      await readFile(join(worktree.worktreePath, "draft.txt"), "utf8"),
    ).toBe("keep me\n");
  } finally {
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});
