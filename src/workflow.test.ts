import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createWorktree } from "./createWorktree.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import {
  Output,
  inspectWorkflow,
  runWorkflow,
  type WorkflowProject,
  type WorkflowTask,
} from "./index.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const task = (id: string, scope: string[] = ["src"]): WorkflowTask => ({
  id,
  reference: `issue:${id}`,
  state: "ready",
  dependencies: [],
  scope,
  requiredRoles: ["review"],
  requiredCapabilities: ["checks"],
});

describe("public workflow", () => {
  it("validates selection, invokes required roles and leaves failed checks unaccepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-workflow-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "README.md"), "fixture\n");
    await writeFile(join(root, "prompt.md"), "Task {{TASK}}\n");
    git(root, "add", "README.md", "prompt.md");
    git(root, "commit", "-m", "fixture");
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "workflow-test" },
    });
    let invocations = 0;
    let editFolder = "src";
    const sandbox = createBindMountSandboxProvider({
      name: "workflow-fixture",
      create: async ({ worktreePath }) => ({
        worktreePath,
        exec: async (command, options) => {
          const cwd = options?.cwd ?? worktreePath;
          if (command.startsWith("claude ")) {
            expect(options?.stdin).toMatch(/Task [12]/);
            invocations++;
            await mkdir(join(worktreePath, editFolder), { recursive: true });
            await writeFile(
              join(worktreePath, editFolder, `${invocations}.txt`),
              "work\n",
            );
            git(worktreePath, "add", editFolder);
            git(worktreePath, "commit", "-m", `role ${invocations}`);
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: {
                  content: [
                    { type: "text", text: "<promise>COMPLETE</promise>" },
                  ],
                },
              }),
              JSON.stringify({
                type: "result",
                result: "<promise>COMPLETE</promise>",
              }),
            ];
            for (const line of lines) options?.onLine?.(line);
            return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
          }
          return {
            stdout: execSync(command, { cwd, encoding: "utf8" }),
            stderr: "",
            exitCode: 0,
          };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });
    const tasks = new Map([
      ["1", task("1")],
      ["2", task("2", ["docs"])],
    ]);
    let released = false;
    let accepted = false;
    let acceptanceCalls = 0;
    const project: WorkflowProject = {
      root,
      capabilities: ["checks"],
      getTask: async (id) => tasks.get(id),
      reserve: async () => async () => {
        released = true;
      },
      prompt: (selectedTask) => ({
        promptFile: join(root, "prompt.md"),
        promptArgs: { TASK: selectedTask.id },
      }),
      check: async () => ({
        status: "failed",
        evidence: ["fixture check"],
        reason: "project check failed",
      }),
      accept: async () => {
        accepted = true;
        acceptanceCalls++;
        return { status: "accepted", evidence: [] };
      },
    };
    const policy = {
      iterations: 2,
      roles: {
        implementation: { agent: claudeCode("test"), sandbox },
        review: { agent: claudeCode("test"), sandbox },
      },
    };
    const options = {
      project,
      worktree,
      selected: [{ id: "1", reference: "issue:1" }],
      policy,
    };
    try {
      expect((await inspectWorkflow(options)).worktreeState).toMatchObject({
        branch: "workflow-test",
        clean: true,
      });
      const mergeWorktree = await createWorktree({
        cwd: root,
        branchStrategy: { type: "merge-to-head" },
      });
      try {
        const rejected = await inspectWorkflow({
          ...options,
          worktree: mergeWorktree,
        });
        expect(rejected.reasons).toContain(
          "Selected worktree must use the branch strategy",
        );
        expect(
          (await runWorkflow({ ...options, worktree: mergeWorktree })).status,
        ).toBe("blocked");
        expect(invocations).toBe(0);
      } finally {
        await mergeWorktree.close();
      }
      expect(
        (
          await inspectWorkflow({
            ...options,
            project: { ...project, reserve: undefined as never },
          })
        ).reasons,
      ).toContain(
        "Project tracker, reservation, prompt, check and acceptance functions are required",
      );
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [{ id: "1", reference: "wrong" }],
          })
        ).status,
      ).toBe("blocked");
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [
              { id: "1", reference: "issue:1" },
              { id: "2", reference: "issue:2" },
            ],
          })
        ).status,
      ).toBe("ready");
      tasks.set("2", task("2"));
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [
              { id: "1", reference: "issue:1" },
              { id: "2", reference: "issue:2" },
            ],
          })
        ).reasons,
      ).toContain("Tasks 1 and 2 have overlapping edit scopes");
      tasks.set("2", { ...task("2", ["docs"]), dependencies: ["missing"] });
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [{ id: "2", reference: "issue:2" }],
          })
        ).reasons,
      ).toContain("Task 2 has unfinished dependency missing");
      tasks.set("2", { ...task("2", ["docs"]), dependencies: ["1"] });
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [
              { id: "2", reference: "issue:2" },
              { id: "1", reference: "issue:1" },
            ],
          })
        ).reasons,
      ).toContain("Task 2 must follow dependency 1");
      expect(
        (
          await inspectWorkflow({
            ...options,
            policy: { ...policy, iterations: 0 },
          })
        ).status,
      ).toBe("blocked");
      tasks.set("2", {
        ...task("2", ["docs"]),
        requiredCapabilities: ["human-acceptance"],
      });
      expect(
        (
          await inspectWorkflow({
            ...options,
            selected: [{ id: "2", reference: "issue:2" }],
          })
        ).reasons,
      ).toContain("Task 2 requires unsupported capability: human-acceptance");
      expect(invocations).toBe(0);
      const changedIterations = {
        iterations: policy.iterations,
        roles: { ...policy.roles },
      };
      const iterationDrift = await runWorkflow({
        ...options,
        policy: changedIterations,
        project: {
          ...project,
          reserve: async () => {
            changedIterations.iterations++;
            return () => {};
          },
        },
      });
      expect(iterationDrift.reason).toBe(
        "Fixed policy changed during reservation",
      );
      const changedRoles = {
        iterations: policy.iterations,
        roles: { ...policy.roles },
      };
      const roleDrift = await runWorkflow({
        ...options,
        policy: changedRoles,
        project: {
          ...project,
          reserve: async () => {
            changedRoles.roles.review = {
              agent: claudeCode("changed"),
              sandbox,
            };
            return () => {};
          },
        },
      });
      expect(roleDrift.reason).toBe("Fixed policy changed during reservation");
      expect(invocations).toBe(0);
      for (const hidden of [
        { output: Output.string({ tag: "result", maxRetries: 1 }) },
        { agent: claudeCode("unrequested-model") },
      ]) {
        await expect(
          runWorkflow({
            ...options,
            project: {
              ...project,
              prompt: () => ({ prompt: "Task 1 <result>", ...hidden }),
            },
          }),
        ).rejects.toThrow(/Unsupported workflow prompt option/);
        expect(invocations).toBe(0);
      }
      const result = await runWorkflow(options);
      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("project check failed");
      expect(result.completed[0]?.candidate.completedRoles).toEqual([
        "implementation",
        "review",
      ]);
      expect(result.completed[0]?.candidate.commits).toHaveLength(2);
      expect(invocations).toBe(2);
      expect(accepted).toBe(false);
      expect(released).toBe(true);
      const passingProject: WorkflowProject = {
        ...project,
        check: async () => ({ status: "passed", evidence: ["fixture check"] }),
      };
      const acceptedResult = await runWorkflow({
        ...options,
        project: passingProject,
      });
      expect(acceptedResult.status).toBe("accepted");
      expect(acceptedResult.completed[0]?.acceptance?.status).toBe("accepted");
      expect(accepted).toBe(true);
      tasks.set("2", task("2", ["docs"]));
      const outside = await runWorkflow({
        ...options,
        selected: [{ id: "2", reference: "issue:2" }],
      });
      expect(outside.reason).toContain("edited outside its scope");
      editFolder = " src";
      const whitespacePath = await runWorkflow({
        ...options,
        project: passingProject,
      });
      expect(whitespacePath.reason).toContain("edited outside its scope");
      editFolder = "src";
      const mutatingProject: WorkflowProject = {
        ...passingProject,
        check: async () => {
          await writeFile(
            join(worktree.worktreePath, "src", "check.txt"),
            "drift",
          );
          return { status: "passed", evidence: ["stale check"] };
        },
      };
      const changedDuringCheck = await runWorkflow({
        ...options,
        project: mutatingProject,
      });
      expect(changedDuringCheck.reason).toContain(
        "changed during its project check",
      );
      expect(acceptanceCalls).toBe(1);
    } finally {
      await worktree.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
