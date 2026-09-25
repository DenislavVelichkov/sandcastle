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

## Project-owned native proof

`runNativeProof()` is a host-side helper for a project's `check(candidate)` callback. It queues one native operation across projects under the host user's `XDG_STATE_HOME/sandcastle/native-proof` (or `~/.local/state/sandcastle/native-proof`), then calls only the trusted `run`, `validate`, and `stopped` functions supplied by that project. The project still owns its device profiles, ports, fixtures, captures, comparisons and acceptance. Keep the same state root for every project on the host; do not put it in an agent worktree or mount host ADB or Docker sockets into a worker.

Pass the clean worktree, exact candidate commit, a unique operation ID, an ignored evidence root, a finite timeout and the workflow cancellation signal. The helper creates one new evidence directory, checks the candidate before and after proof, and requires the project validator to return a passed decision containing its receipt path. The `validate` function must independently observe current source, installed build, Metro, devices, profile settings and fixture state through the project's existing verifier. It must reject stale or altered captures. A successful process exit alone cannot pass.

The project callback confirms all owned processes and resources stopped before a successful reservation is released. Failed or interrupted proof retains the lock and evidence. After inspecting the old process, device, ports and fixture, a trusted host operator can call `recoverNativeProofReservation(stateRoot, inspectStopped)`. Recovery removes only that verified old lock; the next operation receives a new ID and must revalidate current state. Human waiting also requires stopped live resources, while durable logical task reservations remain project-owned.

The Renovio diagnostic binding is `scripts/sandcastle-native-proof-check.mjs` in its project checkout. It calls the fixed `scripts/pilot-dev-proof.mjs` entry, rejects candidate edits to the verifier's `scripts` tree, and returns Renovio's own receipt and fresh applicability record. Its signed-out Landing exercise uses P1/P2/P3 and remains separate from Renovio product acceptance. The earlier `exercise-public` measurement covers P1/P2 only.

## Guarded Codex usage

Set `usage` on `runDurableWorkflow()` to opt into account and invocation guards. Supply a stable `policyId`, `runtimeIdentity`, one of `library-proof`, `pilot`, or `measurement`, and host callbacks for `readAccount()` and `listModels(cursor)`. Run the latter through the actual isolated worker's Codex app server and account; return every `model/list` page with its `nextCursor`. The project must configure every required role with an explicit Codex model, reasoning effort, and `serviceTier: "default"`. Availability is checked at each new run and resume, and the selected agent is checked against the persisted request again before dispatch. A changed configuration stops without consuming an attempt. A catalog result proves availability, not the effective per-response setting. For `measurement` and `pilot`, also supply the same `pilot: { id, directory }` for every invocation in the study. The absolute directory must be host-only and outside agent worktrees.

The host reads every non-null account window reported by the worker before each provider invocation and at least every 60 seconds while an evaluation is active. A null optional window is not applicable; losing or gaining a window after the baseline blocks admission. It records one final reading after a non-pilot task and observes a pilot evaluation for up to two minutes after its result. A reading over 120 seconds old, denied usage, changed account or reset window, a 5 percentage-point rise from the current guard baseline, or less than 20% remaining stops dispatch and requests a checkpoint. The original baseline, guard baseline, account reading history, elapsed active time, and per-role reservations live in host-only `usage.json` and the workflow checkpoint. An explicit `resumeDurableWorkflow()` may clear a transient denied or stale reading after a fresh passing reading; spent time and attempts remain. A reset crossing remains stopped until the owner supplies `usage.resetContinuation: { id, reason }` on resume or the next pilot invocation. The reading must belong to the same account and pass all current guards. Sandcastle records the decision and starts a new guard interval while retaining the original baseline, consumed resources, and evidence that the account intervals are not directly comparable. A spent limit cannot be cleared this way.

The bounded activities allow at most two implementation attempts per task and one call for each required role. Library proof allows four calls and 45 active minutes overall. A pilot allows up to 64 evaluations, 30 active minutes each, and four cumulative active hours across separate durable invocations. Its `measurement` exercise must complete before scored evaluations and permits six calls and 15 active minutes within the same four-hour clock and frozen account baseline. Sandcastle keeps these totals in `<pilot.directory>/budget.json`, blocks concurrent or unfinished pilot invocations, and retains spent resources across resumes. Each provider call has a 15-minute deadline; the implementation phase has 30 active minutes and each other role has 15. Preparation, recovery, and cleanup accrue active time. Human waiting between stopped and resumed runs does not.

`workflowStatus().usage` separates requested configuration, unavailable effective/observed proof, account windows, reservations, elapsed time, and tokens. `IterationResult.usage` is recorded under `tokens.estimates` as a nullable last snapshot. Captured Codex rollouts provide cumulative root and descendant counters by default. Forked or inherited history and compacted sessions remain unknown because their cumulative totals may include copied history or omit compaction work. Other hosts may supply `readTokenCounters()` when they can verify every required descendant. For `complete: true`, return `requiredSessionIds` containing the root and every descendant; give each counter its owning `sessionId`, `parentSessionId` for descendants, and a host-verifiable `rawSource`. Missing or inconsistent lineage remains unknown even if the callback claims completeness. An active invocation is unknown from the moment its allowance is reserved, so an interrupted process cannot expose a complete token total. `tokens.invocations` records settled roles, sessions, timestamps and failure outcomes. `tokens.deltas` includes verified same-counter increments; `tokens.attributableTotal` is null whenever any invocation or coverage is incomplete or overlapping. Checkpoints include captured host rollout sources. Unknown costs do not alone block a guarded fixed iteration. The workflow does not buy credits, redeem resets, switch to API billing, or infer savings from incomplete coverage.

## Bounded benchmark

`benchmarkFixtures` fixes the four historical base and reference commits and their grading focus. `benchmarkSlots` declares the 64 slots in order: 28 fixed development, 28 fixed held-out, then eight adaptive. Repetition two reverses the seven fixed configurations. Sol High is arm 5 and the fixed reference. The public `benchmarkProtocolHash` binds the fixture definitions, schedule and seven Standard-tier settings. The host must freeze the installed release, account, worker CLI and image, prompts, tools, cache conditions, required roles, acceptance contract and protected grader before starting the later live pilot. A catalog page alone does not prove effective worker settings.

The explicit entry is `runBenchmarkEvaluation({ directory, slotId, options, protectedGrader, fixture, conditionsHash, accountResolution, windowDurationMs, settled, effective, fallbackEffective, probe, reviewPassed })`. `options` is the ordinary `DurableWorkflowOptions` for one fresh answer-free fixture worktree and one task. Its `usage` has activity `pilot`, the shared pilot directory and policy identity. The operation checks the next declared slot, clean one-commit fixture, external grader and host state, frozen requested and effective worker configurations, then calls `runDurableWorkflow()`. The existing controller verifies worker availability and guards the four-hour, 64-evaluation, two-implementation, per-role and account allowances. A failed run remains in `benchmark.json` with its reason and available usage. An unfinished pilot invocation retains its budget and must be recovered, not replaced with an extra slot.

`probe` is a trusted project-owned independent check of the first candidate. Return `passed` to finish implementation after one call, `implementation-failure` with a reason and evidence to use the second reserved call, or `environment-failure` to stop without escalating. A fixed arm uses the same model on both calls. An adaptive arm uses its frozen fallback only for that actionable failure. The second call resumes the first session when available; a verified clean candidate permits a recorded diagnostic handoff if the session is absent. The project still runs its ordinary final check, required roles and acceptance through the controller. The host must keep the protected grader, reference and controller outside candidate edit scope. `exportBenchmarkFixture()` exports a historical base as a one-commit repository, verifies base failure and known-correction success through the supplied protected grade callback, and returns it to the answer-free base. Invoke it only inside the later pilot's active-time accounting.

After all 28 fixed development slots, call `freezeBenchmarkPair(directory, policyId)`. The operation requires four accepted development evaluations per qualified configuration, Sol High qualification, complete cost coverage and at least 20% conservative savings in every account window for the starting arm. It ranks upper consumption by shorter then longer windows, picks a distinct qualified fallback by first-iteration success then usage, and uses Sol High then declared arm order for ties. Missing proof records fixed-policy retention. The pair and failure-only rule are frozen before held-out evaluations can run. Call `assessBenchmarkPromotion(directory, policyId)` only after all 64 slots. It admits the frozen pair only if all four held-out adaptive evaluations pass the project gates, none lose a matched Sol High case, every account window saves at least 20% under uncertainty, both repetitions save in the same direction, and attributable token coverage is complete. Otherwise it records fixed-policy retention. `readBenchmark()` returns the machine-readable ledger for the separate report renderer and policy-admission decision. Neither a synthetic result nor an admitted assessment changes a project's live policy without its explicit owner action.

The ledger keeps raw account readings beside conservative lower and upper percentage-point consumption. The caller must predeclare each window's reading resolution and duration, and establish whether delayed readings are bounded; `settled: false`, a reset crossing, missing window, zero reference lower bound, unknown token coverage or incomplete case cannot support promotion. The controller's usage state retains token estimates, verified deltas, incomplete invocations and reset history separately. Its budgets count preparation, checks, supervision, report generation and cleanup in the later live pilot. Human-only waiting is separate. Do not infer credit or dollar savings from token totals.

## Managed installation admission

`runDurableWorkflow()` registers its host state directory before admission under a host installation lock. `inspectWorkflowInstallation(root)` lists the registered run directories for that project. A personal updater uses `withWorkflowInstallationLock(root, action)` to inspect them and change package inputs without racing a new start. Both operations use `workflowInstallationDirectory(root)`, under `XDG_STATE_HOME` or `~/.local/state`. If an update leaves `activation-block.json` there, new-run admission fails until the updater verifies the old or new installation. Keep the run inventory and block file for recovery. Status and owner-response operations continue to read their own state.

## Durable human answers

Use `runDurableWorkflow()` when a project has an owner-verified host response route. Supply stable `projectId` and `invocationId`, an absolute host-only state directory outside every agent sandbox, and one named worktree per selected task. The project reservation receives every task's `branches` mapping and must return `{ id, retain, release }`: `retain()` keeps the logical scope reservation while a request waits. The project also supplies `validateHumanRequest(request)` to recheck its current acceptance contract, build, and evidence before an answer is applied. An agent's output or filesystem access never authenticates an answer.

The project's `accept()` may return `waiting` with a `request`. It must include the owner, phase, target, exact question, contract and source/build/environment manifest digests, checkpoint identity, hashed evidence files, and the trusted host route's persisted displayed-question ID and source reference. The controller binds these to the project, invocation, task, branch, candidate commit, and generated request ID. Keep the candidate and evidence frozen while waiting. A changed commit, dirty worktree, evidence file, or project contract makes a queued answer stale.

The supported host route calls `workflowStatus(directory)` to show the last complete snapshot. `liveness: "last-known"` means its observation is old or the controller is stopped. To relay an actual owner reply, it calls `respondWorkflow({ directory, requestId, responseId, sourceEvent, route })`. The route's `authenticate(sourceEvent, request)` must verify the real human owner and return the original reply, event identity, and displayed-question mapping. The reply is exactly `Approve` or `Reject: feedback`. A returned `queued` receipt means the inbox file is durable; it does not mean the decision has affected work. The applied or stale receipt appears in `workflowStatus().responses` after the controller processes it. The first queued answer for a request wins. Use a unique response ID per human event across the invocation. Repeating its response ID and content returns the original receipt; using that ID for another request or answer conflicts.

The running controller processes the inbox while a permitted independent task runs. A stopped controller leaves answers queued until `processWorkflowResponses(directory, project.validateHumanRequest)` is called by the host as a control-only operation. It dispatches no model. The applied receipt retains the original reply and source event. A `recovery-required` state blocks answer application until its owner repairs the failed run. `cancelWorkflowTask()` invalidates a stopped task's unanswered request. Rejection retains the original feedback and remaining iteration allowance; `requestWorkflowRework()` records explicit intent only when allowance remains. It does not dispatch work.

## Checkpoint and recovery

For a task that requires session recovery, declare the `recovery` capability and supply a stable `runtimeIdentity` that identifies the selected provider, model, sandbox image and project contract. Its roles must use a bind-mounted sandbox and a provider with host session capture. Pass `requiredIgnoredArtifacts` for project evidence that Git ignores. The state directory must remain outside agent access. On resume, `reserve()` receives `resumeId` and must return the same durable reservation identity. `recoverReservation(id)` must verify that the original logical reservation still exists before recovery claims it. The project reservation owns time and usage balances; both operations must preserve the original debits and limits.

Call `checkpointStopWorkflow(directory)` from the host when the operator asks to stop. It records stop intent before the controller aborts the active operation. A returned snapshot with `lifecycle: "stopped"`, `sourceRestoration: "verified"`, `sessionRestoration: "verified"`, and a `checkpoint` is the safe-to-quit receipt. The checkpoint stores tracked edits, deletions, untracked files, required ignored artifacts, referenced evidence and captured host session files with hashes. Keep the worktrees and state directory until recovery succeeds.

After a restart, call `recoverDurableWorkflow(options)` with the original project, task, worktree and runtime identities. It verifies checkpoint bytes, the target branch and commit, process start identities, the retained reservation and the current source inventory. It restores only into a matching clean worktree or leaves an already matching retained worktree intact. Codex session resume restores captured descendant rollouts with the root so cumulative counters can be checked again. A different dirty worktree, changed artifact, live owner, surviving child process, missing session or corrupt checkpoint blocks recovery. `workflowStatus(directory)` reports `recovery-required` and its reason when the controller has recorded such a failure. Repair the retained work or reservation before retrying; never delete the only work copy to clear the error.

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
