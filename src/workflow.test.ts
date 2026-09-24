import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createWorktree } from "./createWorktree.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import {
  inspectWorkflow,
  runWorkflow,
  type WorkflowProject,
  type WorkflowTask,
} from "./workflow.js";

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
    git(root, "add", "README.md");
    git(root, "commit", "-m", "fixture");
    const worktree = await createWorktree({
      cwd: root,
      branchStrategy: { type: "branch", branch: "workflow-test" },
    });
    let invocations = 0;
    const sandbox = createBindMountSandboxProvider({
      name: "workflow-fixture",
      create: async ({ worktreePath }) => ({
        worktreePath,
        exec: async (command, options) => {
          const cwd = options?.cwd ?? worktreePath;
          if (command.startsWith("claude ")) {
            invocations++;
            await mkdir(join(worktreePath, "src"), { recursive: true });
            await writeFile(
              join(worktreePath, "src", `${invocations}.txt`),
              "work\n",
            );
            git(worktreePath, "add", "src");
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
    const project: WorkflowProject = {
      root,
      capabilities: ["checks"],
      getTask: async (id) => tasks.get(id),
      reserve: async () => async () => {
        released = true;
      },
      prompt: (_, role) => `Perform ${role}`,
      check: async () => ({
        status: "failed",
        evidence: ["fixture check"],
        reason: "project check failed",
      }),
      accept: async () => {
        accepted = true;
        return { status: "accepted", evidence: [] };
      },
    };
    const policy = {
      iterations: 1,
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
    } finally {
      await worktree.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
