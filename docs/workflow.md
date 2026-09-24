# Run a selected task

`runWorkflow()` is an opt-in entry for a project that already has a task tracker, prompts, reservations, checks, and acceptance rules. It runs exact selected task identities on an existing named-branch worktree. It does not merge the branch or decide project acceptance from agent output or commits.

```ts
import {
  createWorktree,
  runWorkflow,
  codex,
  type WorkflowProject,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const project: WorkflowProject = {
  root: process.cwd(),
  capabilities: ["checks", "review"],
  getTask: async (id) => tracker.getTask(id),
  reserve: async (request) => reservations.reserve(request),
  prompt: (task, role) => prompts.forTask(task, role),
  check: async (candidate) => checks.run(candidate),
  accept: async (candidate, check) => acceptance.decide(candidate, check),
};

const worktree = await createWorktree({
  cwd: project.root,
  branchStrategy: { type: "branch", branch: "task-11" },
});

try {
  const result = await runWorkflow({
    project,
    worktree,
    selected: [{ id: "11", reference: "issue:11" }],
    policy: {
      iterations: 2,
      roles: {
        implementation: { agent: codex("gpt-6-sol"), sandbox: docker() },
        review: { agent: codex("gpt-6-astra"), sandbox: docker() },
      },
    },
  });
  console.log(result.status, result.reason);
} finally {
  await worktree.close();
}
```

Before the first task, implement the six project functions against the project's existing tracker and proof controller. `getTask()` must return the exact `id`, `reference`, `state`, `dependencies`, repository-relative `scope`, `requiredRoles`, and `requiredCapabilities`. An external dependency must have state `complete`; selected dependencies must appear before their consumers. Overlapping scopes block admission. `reserve()` receives the selected tasks, branch, fixed iteration count, and every required role, and returns a release function. It must reject unavailable reservations. The workflow calls it before dispatch and releases it afterward. `prompt()` may return inline text or existing `promptFile`, `promptArgs`, and `hooks` run options. Create the worktree with `copyToWorktree` if the project needs copied inputs.

`check()` returns `passed` or `failed` with evidence; `accept()` returns `accepted` or `blocked` with evidence. These are project decisions about the exact candidate head and completed roles. The workflow stops on a failed check or blocked acceptance. The implementation allowance is a maximum; an agent completion signal ends it early. Declare capabilities such as `human-acceptance` or `recovery` only when the project can actually provide them. A task requiring an undeclared capability blocks before dispatch.

For the first task:

1. Select its exact tracker identity and reference. Check its dependencies, allowed paths, required roles, and capabilities in the tracker record.
2. Create a named-branch worktree and supply the project's ordinary functions as shown above.
3. Call `inspectWorkflow()` with the same options. Its reasons, selected tasks, capabilities, and worktree head/clean state are read-only; resolve a blocked result before running.
4. Call `runWorkflow()`. A returned `accepted` status means the project's checks and acceptance approved the candidate head. A `blocked` status includes the reason. Review the worktree and evidence before any separate integration step.

Existing `run()`, provider imports, and generated templates continue to work as before. This first entry supports bounded implementation and model-free fixture checks. Live recovery and authenticated human-response routing require later work.
