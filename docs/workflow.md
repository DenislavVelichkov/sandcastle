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

Existing `run()`, provider imports, and generated templates continue to work as before. This first entry supports bounded implementation and model-free fixture checks. Live recovery requires later work.

## Durable human answers

Use `runDurableWorkflow()` when a project has an owner-verified host response route. Supply stable `projectId` and `invocationId`, a host-only state directory outside every agent sandbox, and one named worktree per selected task. The project reservation must return `{ id, retain, release }`: `retain()` keeps the logical scope reservation while a request waits. The project also supplies `validateHumanRequest(request)` to recheck its current acceptance contract, build, and evidence before an answer is applied. An agent's output or filesystem access never authenticates an answer.

The project's `accept()` may return `waiting` with a `request`. It must include the owner, phase, target, exact question, contract and source/build/environment manifest digests, checkpoint identity, hashed evidence files, and the trusted host route's persisted displayed-question ID and source reference. The controller binds these to the project, invocation, task, branch, candidate commit, and generated request ID. Keep the candidate and evidence frozen while waiting. A changed commit, dirty worktree, evidence file, or project contract makes a queued answer stale.

The supported host route calls `workflowStatus(directory)` to show the last complete snapshot. `liveness: "last-known"` means its observation is old or the controller is stopped. To relay an actual owner reply, it calls `respondWorkflow({ directory, requestId, responseId, sourceEvent, route })`. The route's `authenticate(sourceEvent, request)` must verify the real human owner and return the original reply, event identity, and displayed-question mapping. The reply is exactly `Approve` or `Reject: feedback`. A returned `queued` receipt means the inbox file is durable; it does not mean the decision has affected work. The applied or stale receipt appears in `workflowStatus().responses` after the controller processes it. The same response ID and content returns its original receipt; conflicting reuse fails.

The running controller processes the inbox while a permitted independent task runs. A stopped controller leaves answers queued until `processWorkflowResponses(directory, project.validateHumanRequest)` is called by the host as a control-only operation. It dispatches no model. `cancelWorkflowTask()` invalidates a stopped task's unanswered request. Rejection retains the original feedback and remaining iteration allowance; `requestWorkflowRework()` records explicit intent only when allowance remains. It does not dispatch work. Session recovery and resumed execution belong to the later recovery path.

Codex chat answer delivery remains disabled until an authenticated Desktop round trip is proved. The supported fallback is the project's existing owner-verified host route. Do not pass the state directory or route credentials into an agent sandbox. A closed dialog, selected default, model statement, or command permission is not a human answer.
