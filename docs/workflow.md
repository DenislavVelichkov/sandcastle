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

## Guarded Codex usage

Set `usage` on `runDurableWorkflow()` to opt into account and invocation guards. Supply a stable `policyId`, `runtimeIdentity`, one of `library-proof`, `pilot`, or `measurement`, and host callbacks for `readAccount()` and `listModels(cursor)`. Run the latter through the actual isolated worker's Codex app server and account; return every `model/list` page with its `nextCursor`. The project must configure every required role with an explicit Codex model, reasoning effort, and `serviceTier: "default"`. Availability is checked at each new run and resume. A catalog result proves availability, not the effective per-response setting.

The host reads both applicable account windows before each provider invocation and at least every 60 seconds while one is active. A reading over 120 seconds old, denied usage, changed account or reset window, a 5 percentage-point rise from the frozen baseline, or less than 20% remaining stops dispatch and requests a checkpoint. The frozen baseline, elapsed active time, and per-role reservations live in host-only `usage.json` and the workflow checkpoint. An explicit `resumeDurableWorkflow()` may clear a transient denied or stale reading after a fresh passing reading; spent time, attempts, and baseline remain. A reset crossing or exhausted limit requires a new invocation and policy decision.

The bounded activities allow at most two implementation attempts per task and one call for each required role. Library proof allows four calls and 45 active minutes overall; a pilot allows up to 64 evaluations, 30 active minutes each, and four active hours overall; measurement allows six calls and 15 active minutes overall. Each provider call has a 15-minute deadline; the implementation phase has 30 active minutes and each other role has 15. Cleanup after a stop still accrues active time. Human waiting between stopped and resumed runs does not.

`workflowStatus().usage` separates requested configuration, unavailable effective/observed proof, account windows, reservations, elapsed time, and tokens. `IterationResult.usage` is recorded under `tokens.estimates` as a nullable last snapshot. Supply `readTokenCounters()` only when the host can verify cumulative counter identities and coverage for every required descendant. Return `complete: true` only with that proof. `tokens.deltas` includes verified same-counter increments; missing or overlapping coverage appears in `tokens.unknown` and does not alone block a guarded fixed iteration. The workflow does not buy credits, redeem resets, switch to API billing, or infer savings from incomplete coverage.

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

## Integrate an accepted candidate

To opt into Git integration, supply `project.withTargetLock(branch, action)`, `project.validateIntegration(intent)`, and `recoverReservation(id)` in the durable workflow options. The project lock must exclude every other writer to the target branch while `action` runs. `validateIntegration()` must recheck the project's current reviews, acceptance, and completion prerequisites for the intent's candidate and target, then return a `passed` or `failed` decision with absolute evidence file paths. The workflow also reruns `check()`, compares its result with the accepted result, verifies evidence bytes, and revalidates an applied human answer. Keep the target working tree clean and the host state directory outside it.

`runDurableWorkflow()` records the candidate's passed check in `checksPassed`, then records an integration intent when project acceptance succeeds. A waiting human request records the intent only when the owner answer is applied. The workflow retains the project reservation while integration is outstanding. After the workflow has stopped and its checkpoint is verified, call `integrateWorkflowTask(options, taskId)`. Its returned snapshot has separate `accepted` and `integrated` task states. An integrated intent records the Git commit and tree. A second call returns that same effect without merging again. Integration does not close the task or promote visual baselines; the project still applies its own completion gates.

```ts
import { integrateWorkflowTask } from "@ai-hero/sandcastle";

const state = await integrateWorkflowTask(options, "a");
console.log(state.tasks.a.status, state.integrations?.a?.commit);
// integrated <merge commit SHA>
```

The controller checks the exact candidate, target branch and commit, review result, evidence and project gate while the project target lock is held. It preflights conflicts, records `applying` durably, then creates a merge commit with a stable `Sandcastle-Effect` identity. If the controller stops between the Git change and its receipt, call `recoverDurableWorkflow(options)` before any retry. Recovery verifies the merge commit's identity, parents, tree and clean target, then records the original effect. An unchanged target after an `applying` intent, a conflict, changed candidate, changed review or stale answer requires owner repair; the controller does not guess whether to merge again. An explicit checkpoint stop also prohibits integration until the workflow is resumed.

Codex chat answer delivery remains disabled until an authenticated Desktop round trip is proved. The supported fallback is the project's existing owner-verified host route. Do not pass the state directory or route credentials into an agent sandbox. A closed dialog, selected default, model statement, or command permission is not a human answer.
