import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  checkpointStopWorkflow,
  createWorktree,
  recoverDurableWorkflow,
  resumeDurableWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type DurableWorkflowOptions,
  type Worktree,
} from "./index.js";

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
  const sessionFile = join(root, "session.jsonl");
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let retained = 0;
  let calls = 0;
  let resumedSession: string | undefined;
  const task = {
    id: "a",
    reference: "issue:a",
    state: "ready" as const,
    dependencies: [],
    scope: ["README.md", "new.txt"],
    requiredRoles: [],
    requiredCapabilities: ["recovery"],
  };
  const mock: Worktree = {
    ...worktree,
    run: async ({ signal, onSessionCaptured, resumeSession }) => {
      calls++;
      if (calls === 2) {
        resumedSession = resumeSession;
        git(worktree.worktreePath, "add", "README.md", "new.txt");
        git(worktree.worktreePath, "commit", "-m", "finish");
        return {
          iterations: [
            { sessionId: "session-1", sessionFilePath: sessionFile },
          ],
          commits: [{ sha: git(worktree.worktreePath, "rev-parse", "HEAD") }],
        } as never;
      }
      await writeFile(join(worktree.worktreePath, "README.md"), "unfinished\n");
      await writeFile(join(worktree.worktreePath, "new.txt"), "untracked\n");
      started();
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      await writeFile(sessionFile, '{"session":true}\n');
      await onSessionCaptured?.({
        sessionId: "session-1",
        sessionFilePath: sessionFile,
      });
      throw signal?.reason;
    },
  };
  const options: DurableWorkflowOptions = {
    directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime-v1",
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: { a: mock },
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
          agent: {
            captureSessions: true,
            sessionStorage: {},
            buildPrintCommand: () => ({}),
            parseStreamLine: () => [],
          } as never,
          sandbox: { tag: "bind-mount", create: () => ({}) } as never,
        },
      },
    },
  };
  try {
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
    expect((await recoverDurableWorkflow(options)).lifecycle).toBe("stopped");
    expect((await workflowStatus(directory)).tasks.a?.remaining).toBe(1);
    const resumed = await resumeDurableWorkflow(options);
    expect(resumedSession).toBe("session-1");
    expect(resumed.tasks.a).toMatchObject({ status: "accepted", remaining: 0 });
    expect(calls).toBe(2);
  } finally {
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
  const sessionFile = join(root, "session.jsonl");
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const options: DurableWorkflowOptions = {
    directory,
    projectId: "project",
    invocationId: "invocation",
    runtimeIdentity: "runtime-v1",
    selected: [{ id: "a", reference: "issue:a" }],
    worktrees: {
      a: {
        ...worktree,
        run: async ({ signal, onSessionCaptured, onCleanupFailure }) => {
          calls++;
          if (calls === 1) {
            await writeFile(
              join(worktree.worktreePath, "draft.txt"),
              "keep me\n",
            );
            git(worktree.worktreePath, "add", "draft.txt");
            git(worktree.worktreePath, "commit", "-m", "implementation");
            await writeFile(sessionFile, '{"session":true}\n');
            await onSessionCaptured?.({
              sessionId: "implementation-session",
              sessionFilePath: sessionFile,
            });
            return {
              iterations: [
                {
                  sessionId: "implementation-session",
                  sessionFilePath: sessionFile,
                },
              ],
              commits: [
                { sha: git(worktree.worktreePath, "rev-parse", "HEAD") },
              ],
            } as never;
          }
          started();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          if (cleanupFails) {
            await onSessionCaptured?.({
              sessionId: "review-session",
              sessionFilePath: sessionFile,
            });
            await onCleanupFailure?.(new Error("close failed"));
          }
          throw signal?.reason;
        },
      },
    },
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
      prompt: () => "fixture",
      check: async () => ({ status: "passed", evidence: [] }),
      accept: async () => ({ status: "accepted", evidence: [] }),
      validateHumanRequest: async () => true,
    },
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent: {
            captureSessions: true,
            sessionStorage: {},
            buildPrintCommand: () => ({}),
            parseStreamLine: () => [],
          } as never,
          sandbox: { tag: "bind-mount", create: () => ({}) } as never,
        },
        review: {
          agent: {
            captureSessions: true,
            sessionStorage: {},
            buildPrintCommand: () => ({}),
            parseStreamLine: () => [],
          } as never,
          sandbox: { tag: "bind-mount", create: () => ({}) } as never,
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
