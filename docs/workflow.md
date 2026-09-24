# Run a selected task

`runWorkflow()` is an opt-in entry for a project that already has a task tracker, prompts, reservations, checks, and acceptance rules. It runs exact selected task identities on an existing branch-strategy worktree. It rejects merge-to-head worktrees, so project checks and acceptance run before any separate integration step.

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
2. Create a branch-strategy worktree and supply the project's ordinary functions as shown above.
3. Call `inspectWorkflow()` with the same options. Its reasons, selected tasks, capabilities, and worktree head/clean state are read-only; resolve a blocked result before running.
4. Call `runWorkflow()`. A returned `accepted` status means the project's checks and acceptance approved the candidate head. A `blocked` status includes the reason. Review the worktree and evidence before any separate integration step.

Existing `run()`, provider imports, and generated templates continue to work as before. This first entry supports bounded implementation and model-free fixture checks. Live recovery requires later work.

## Durable human answers

Use `runDurableWorkflow()` when a project has an owner-verified host response route. Supply stable `projectId` and `invocationId`, an absolute host-only state directory outside every agent sandbox, and one named worktree per selected task. The project reservation receives every task's `branches` mapping and must return `{ id, retain, release }`: `retain()` keeps the logical scope reservation while a request waits. The project also supplies `validateHumanRequest(request)` to recheck its current acceptance contract, build, and evidence before an answer is applied. An agent's output or filesystem access never authenticates an answer.

The project's `accept()` may return `waiting` with a `request`. It must include the owner, phase, target, exact question, contract and source/build/environment manifest digests, checkpoint identity, hashed evidence files, and the trusted host route's persisted displayed-question ID and source reference. The controller binds these to the project, invocation, task, branch, candidate commit, and generated request ID. Keep the candidate and evidence frozen while waiting. A changed commit, dirty worktree, evidence file, or project contract makes a queued answer stale.

The supported host route calls `workflowStatus(directory)` to show the last complete snapshot. `liveness: "last-known"` means its observation is old or the controller is stopped. To relay an actual owner reply, it calls `respondWorkflow({ directory, requestId, responseId, sourceEvent, route })`. The route's `authenticate(sourceEvent, request)` must verify the real human owner and return the original reply, event identity, and displayed-question mapping. The reply is exactly `Approve` or `Reject: feedback`. A returned `queued` receipt means the inbox file is durable; it does not mean the decision has affected work. The applied or stale receipt appears in `workflowStatus().responses` after the controller processes it. The first queued answer for a request wins. Use a unique response ID per human event across the invocation. Repeating its response ID and content returns the original receipt; using that ID for another request or answer conflicts.

The running controller processes the inbox while a permitted independent task runs. A stopped controller leaves answers queued until `processWorkflowResponses(directory, project.validateHumanRequest)` is called by the host as a control-only operation. It dispatches no model. The applied receipt retains the original reply and source event. A `recovery-required` state blocks answer application until its owner repairs the failed run. `cancelWorkflowTask()` invalidates a stopped task's unanswered request. Rejection retains the original feedback and remaining iteration allowance; `requestWorkflowRework()` records explicit intent only when allowance remains. It does not dispatch work.

## Checkpoint and recovery

For a task that requires session recovery, declare the `recovery` capability and supply a stable `runtimeIdentity` that identifies the selected provider, model, sandbox image and project contract. Its roles must use a bind-mounted sandbox and a provider with host session capture. Pass `requiredIgnoredArtifacts` for project evidence that Git ignores. The state directory must remain outside agent access. On resume, `reserve()` receives `resumeId` and must return the same durable reservation identity. `recoverReservation(id)` must verify that the original logical reservation still exists before recovery claims it. The project reservation owns time and usage balances; both operations must preserve the original debits and limits.

Call `checkpointStopWorkflow(directory)` from the host when the operator asks to stop. It records stop intent before the controller aborts the active operation. A returned snapshot with `lifecycle: "stopped"`, `sourceRestoration: "verified"`, `sessionRestoration: "verified"`, and a `checkpoint` is the safe-to-quit receipt. The checkpoint stores tracked edits, deletions, untracked files, required ignored artifacts, referenced evidence and captured host session files with hashes. Keep the worktrees and state directory until recovery succeeds.

After a restart, call `recoverDurableWorkflow(options)` with the original project, task, worktree and runtime identities. It verifies checkpoint bytes, the target branch and commit, process start identities, the retained reservation and the current source inventory. It restores only into a matching clean worktree or leaves an already matching retained worktree intact. A different dirty worktree, changed artifact, live owner, surviving child process, missing session or corrupt checkpoint blocks recovery. `workflowStatus(directory)` reports `recovery-required` and its reason when the controller has recorded such a failure. Repair the retained work or reservation before retrying; never delete the only work copy to clear the error.

Call `resumeDurableWorkflow(options)` explicitly to continue eligible ready or paused tasks. It first runs the recovery checks and applies queued answers, then uses the captured session and remaining iteration allowance for a paused role. Accepted, waiting, rejected, capped and cancelled work does not restart on its own. `cancelWorkflowTask()` invalidates unanswered requests for a stopped task. A later answer cannot integrate cancelled work. Automatic app-close shutdown remains disabled; use the explicit stop operation until the actual app launch chain is proved.

Codex chat answer delivery remains disabled until an authenticated Desktop round trip is proved. The supported fallback is the project's existing owner-verified host route. Do not pass the state directory or route credentials into an agent sandbox. A closed dialog, selected default, model statement, or command permission is not a human answer.
