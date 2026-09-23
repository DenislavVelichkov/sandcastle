# Approval, checkpoint and recovery decision

Resolved design question for [issue #5](https://github.com/DenislavVelichkov/sandcastle/issues/5), selected by the owner on 2026-09-23. This is a planning artifact and throwaway prototype, not a shipped controller or production acceptance.

## Human selection

The owner selected both options after presentation of [the behavior prototype](./approval-recovery.html):

- Process answers while permitted independent work continues.
- Accept explicit checkpoint-and-stop for the first version, retaining a mandatory proof gate before claiming automatic app-close support.

The answers arrived through `request_user_input_async`, call `call_UOCyBhdTtooJbPp8I2DTPkvj`, items 0 and 1. This records the origin of this design selection. It does not prove a production authenticated Desktop-to-controller response channel. The synthetic visual comparison is not a production reference or approved product candidate.

[Issue #2](https://github.com/DenislavVelichkov/sandcastle/issues/2) remains open. This decision specifies controller behavior independently of whether that controller becomes an end-user Sandcastle export or a maintained extension. Packaging and the project integration boundary still belong to #2; resolving #5 does not authorize implementing or bypassing that prerequisite.

## State ownership and operations

One host controller owns the authoritative, versioned invocation state under the selected project's `.sandcastle/` directory. Codex presents progress and collects answers; it does not infer state from its conversation, a Goal, a summary or a completion signal. Project-owned validators remain the authority for correctness and acceptance. Sandcastle remains responsible for agent execution and its existing resource handles.

Choose these operations for the future controller. They are contracts, not claims about commands already installed:

| Operation | Contract |
| --- | --- |
| `status` | Read the last atomically published snapshot without acquiring the execution lock. Include revision, observation time, controller liveness, active work, pending requests, retained resources, checkpoint receipts and remaining allowances. An old snapshot is labelled last-known, never presented as live progress. |
| `respond` | Authenticate the submitting channel, validate a versioned response envelope, and atomically publish it to a host response inbox. Return a durable queued receipt. Do not mutate controller state or start an agent. |
| Process inbox | The single state writer validates the current request and commits its decision receipt and next state together. Run between short state mutations even while independent agent calls are in flight; do not wait for every task to finish. |
| `checkpoint-stop` | Persist the stopping intent, prevent further dispatch and integration, cancel active calls, await settlement, verify recovery artifacts and close safe resources. Return a verified stopped receipt only after these steps succeed. |
| `resume` | Reacquire ownership, verify recovery and consume any valid pending responses before admitting eligible work. Retain all counters. Waiting, rejected, capped and cancelled work does not restart simply because the app reopened. |
| `cancel` | Cancel the chosen task or invocation explicitly. Preserve recoverable work, invalidate its unanswered requests, and prohibit later integration. Cancellation is separate from a resumable checkpoint-and-stop. |

The existing setup template acquires its invocation lock before `status` and `respond`. That arrangement must change: reads and inbox publication do not take that lock. Only one controller may apply responses or write authoritative state. If the controller is stopped, delivery remains queued until a control operation or explicit resume acquires ownership. A control-only operation must not dispatch agents. No daemon or new dashboard is required.

Atomic publication uses a fully written, file-synced temporary file, atomic rename for a snapshot, then directory sync. Inbox publication must not overwrite an existing response ID. A queued receipt follows durable inbox publication; an applied receipt follows durable state publication. Retain the inbox item until the applied receipt is durable, so a lost acknowledgement can be retried. A read may see the old or new whole snapshot, never a partial write.

## Exact identities and response provenance

Use opaque, persisted identifiers for the project, invocation, task, request, response and external effect. A restart keeps them. A replaced candidate, changed acceptance contract or changed evidence gets a fresh request; do not recycle an old request ID or approve a branch name alone.

The pending request binds these fields before presentation:

- Project identity and canonical root, invocation ID, task ID and phase, source branch, intended target, request ID, authorized human owner and acceptance scope.
- An immutable candidate manifest. Include commit SHA, a content manifest for any uncommitted recovery state, built artifact digest when applicable, and the evidence bundle digest. A candidate awaiting acceptance is frozen against writers.
- The applicable project contract revision, required checks and reviewer evidence, selected baseline ID and environment details needed to interpret the evidence, such as browser viewport or Android device configuration.
- The exact question, permitted decisions, evidence links, checkpoint receipt and configured response route.

An answer envelope carries its own response ID, the exact request and candidate binding, explicit `Approve` or `Reject`, optional rejection feedback, authenticated actor/channel, source event reference and original answer. Delivery time is audit metadata, not identity. A response never replenishes allowances.

Codex stores a mapping from each displayed question item to that immutable request. On an actual human reply, the trusted host supervisor relays the mapped envelope through the project owner's `authorizeAnswer` boundary. It records the originating task/question item and human reply reference, not a paraphrase from task history. The response is durable only once the controller returns its receipt, which Codex can display or recover through `status`.

Authentication belongs to the project-bound host response route, not a payload field named `owner`, the model's opinion, file ownership shared with an agent, or runtime permission to run a command. Sandboxed agents cannot be allowed to impersonate that route. If the chosen Desktop interface cannot supply verifiable human provenance and an authenticated relay, chat-based acceptance stays disabled; use the existing owner-verified human host response path. The actual project binding must pass the round-trip proof below. Do not invent a human reply when a dialog closes, times out, defaults to a selected option, or a turn is interrupted.

## Duplicate, stale and conflicting answers

For each response ID, store a canonical payload digest and a stable receipt. Redelivery of identical content returns that receipt and causes no new transition, model attempt or integration. Reuse of the same ID with different content is a conflict. The first valid decision for a request is authoritative; a different response ID cannot overwrite it. Reversing a decision requires a new explicit project operation and, where appropriate, a new request.

Before applying a queued answer, verify the owner, invocation, request, candidate, evidence, contract and checkpoint against current state. A rejected, cancelled, superseded or changed request cannot accept an old reply. Keep a stale/conflict receipt and the original request for audit; do not retarget the answer to a new candidate. Rejection retains feedback and artifacts, blocks integration, and requires explicit rework with any remaining allowance. It is not an automatic retry instruction.

Commit the response ledger, next task state and any effect intent in one atomic state publication. This provides one durable decision despite duplicate delivery. External effects need their own reconciliation: reserve a stable integration effect ID, freeze the accepted SHA, take the project's serial target lock, verify the expected target and all current gates, then record the resulting Git commit and target receipt. After a crash between Git mutation and receipt, inspect the target and operation evidence before retrying. If completion cannot be established, enter recovery-required instead of merging again. This prototype simulates integration; it does not prove exactly-once Git or arbitrary external API effects.

Human approval applies only to its named scope. It cannot replace mandatory reviews or other project gates, authorize merging a later commit, or promote a visual baseline implicitly. Changed candidate/evidence/contract invalidates affected checks and acceptance. A target change must pass the project's integration checks; if it changes the reviewed result, request fresh acceptance.

## Outcomes and independent work

| Task outcome | Meaning and next permitted step |
| --- | --- |
| Implementing / verifying | An attempt was reserved before dispatch. An active agent or check owns its resources. |
| Checks passed | Recorded project checks and mandatory review passed for this candidate. Human acceptance may still be absent. |
| Waiting for a person | A verified checkpoint and exact pending request exist. No agent retries the blocked phase. |
| Rejected | The human rejected this candidate. Keep feedback and evidence; explicit rework requires allowance and a new candidate/request. |
| Environment blocked | A dependency, tool, credential or execution condition prevents verification. Preserve the reason; never count it as passing. Resume only after the condition is resolved. |
| Capped | A recorded allowance is exhausted or cannot safely fund another attempt. Approval, restart and bookkeeping do not reset it. |
| Cancelled | An explicit cancellation ended this task or invocation. No automatic restart or integration. |
| Accepted | Every required gate, including exact-candidate human acceptance when required, passed. Integration is still pending. |
| Integrated | The accepted candidate reached the bound target and integration postconditions passed. Ticket closure still requires all project completion gates. |

Controller lifecycle is separate: running, stopping, stopped or recovery-required. A stopped controller can still have a waiting, accepted or incomplete task. A lost process does not prove cancellation, successful cleanup or integration.

While Task A waits, independent Task B may continue only within the project's existing concurrency and delegation rules, dependency graph and allowances. Retain A's durable scope reservation so other work cannot modify its frozen candidate, overlapping edit scope, visual slice or required evidence. Keep task dependencies blocked at the project's required outcome, never at checks-passed alone. Unknown overlap is serialized. This decision grants no permission to spawn agents where project rules require separate authorization.

Release expensive sandboxes, browser sessions and emulator leases only after their required work/evidence/session artifacts are checkpointed and verified and the process has actually stopped. Durable reservations and retained artifacts remain. A device lease can be released after capture without allowing someone to rewrite the accepted evidence. Global target integration stays serial and is not held throughout a human wait. If a project requires a wider exclusive lease, honor it, even when that leaves no independent work available. Status reads and response delivery remain available in either case.

## Checkpoint, stop and recovery

Reserve attempts before dispatch and persist the reservation. A checkpoint contains the selected scope, policy/contract revisions, phase and outcome for every task, request/response/effect ledgers, branch/HEAD/target, worktree and provider identity, process ownership and resource reservations. Preserve log/evidence locations, session ID and storage path where available, limits, consumed/reserved attempts, wall-time accounting and unknown or pending usage reconciliation. Resuming restores remaining allowances, never defaults. Account subscription windows, raw token counters and estimates remain distinct; interrupted or cumulative provider usage can be unknown.

The artifact manifest covers committed work, tracked edits, untracked recovery files, deletions and any project-required ignored artifacts; a Git diff alone is insufficient. Verify content hashes and required file inventory on the host before discarding the sandbox. Preserve provider-supported session files as opaque artifacts. Missing session identity or an interrupted session capture must be reported as unavailable, separately from preserved source files. A waiting request that requires session resumption cannot discard its only runtime without that session proof.

Graceful stop ordering is fixed:

1. Durably record stop intent and deny new dispatch/integration. Answer delivery may continue to the inbox, but cannot restart work.
2. Relay cancellation to active operations and hooks through their AbortSignal; drain all affected calls and stop writers. A late completion cannot bypass stopping state.
3. Capture a consistent artifact inventory, sessions where available, evidence and remaining allowances. Sync and verify the checkpoint on the host.
4. Close resources that are safe to discard, verify that workers stopped, and release only the appropriate live leases. Retain logical pending-task reservations.
5. Publish the final stopped receipt with checkpoint ID, artifact hashes, outcomes, incomplete work and any session limitations. Only this receipt means it is safe to quit using the explicit fallback.

If cancellation, checkpointing or cleanup fails, retain the only work copy and its reservation, report recovery-required, and withhold the saved-and-stopped receipt. A timeout or repeated interrupt is not permission to erase artifacts or clear ownership. Forced termination is an explicit recovery event.

After abrupt termination, use only the last verified durable snapshot and artifacts. Ignore incomplete temporary publications, preserve inbox deliveries and inspect any additional work left behind. Verify the controller identity, process start identity, surviving descendants, contract version, manifest and branch state before recovering a lease. A PID alone is insufficient evidence that the old owner is gone. Never replace intervening dirty work. Restore into a matching clean worktree or reuse a fully matching retained inventory; otherwise block for owner-directed repair. Reconcile in-flight effects and reserved attempts before explicit resume.

## What the launch proof establishes

Inspected versions: Sandcastle `e99f832f26dc9d245c019a9ddd19fa5dee792427`; maintained setup plugin `7db11edb78f0bc20e70a9da811e89ef0ab9b6b0e`.

On this host, read-only process ancestry for a command in the current Codex task was `ChatGPT -> codex -> bash -> python3`. The disposable proof uses that command execution path to launch a Node test process, the real setup supervisor and a deterministic worker. It establishes the supervisor-to-worker part of the chain, not Desktop-to-supervisor signal delivery.

The proof sent SIGINT and SIGTERM directly to the disposable supervisor and separately disconnected its Node IPC parent. Each case produced and verified the worker's durable stop receipt before the supervisor exited, with exit codes 130, 143 and 143 respectively. No app window was closed, no Codex task was stopped, and no production controller or sandbox ran. The proof cannot establish that ordinary terminal EOF produces Node IPC disconnection.

The current [supervisor](https://github.com/DenislavVelichkov/dv8-codex/blob/7db11edb78f0bc20e70a9da811e89ef0ab9b6b0e/custom/skills/quality/sandcastle-personal-setup/scripts/supervise.mjs) detaches its worker on POSIX and relays IPC cancellation. Sandcastle's [shutdown registry](https://github.com/DenislavVelichkov/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/shutdownRegistry.ts) exits after synchronous teardown; an asynchronous handler in that same process is not a checkpoint guarantee. [ADR 0004](../adr/0004-abort-signal-on-run-and-interactive.md) gives operation cancellation to AbortSignal, separately from handle cleanup. This decision preserves [ADR 0007](../adr/0007-worktree-locking.md) and the provider-owned session limits in [ADR 0016](../adr/0016-resume-requires-filesystem-backed-sessions.md).

Official [integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal) and [app-server](https://learn.chatgpt.com/docs/app-server) documentation, and [the prior Desktop research](https://github.com/DenislavVelichkov/sandcastle/blob/8b90b792280b5659216894bec175158e4329f71a/docs/research/codex-desktop-handoff.md), do not establish a tested app-close signal path for this installation. The owner therefore chose explicit checkpoint-and-stop followed by the verified receipt before quitting. Automatic close handling stays disabled until the exact supported launch chain is demonstrated; app shutdown cannot be inferred from a Goal, transport disconnect or window disappearance.

## Runnable proof and implementation gates

Open `approval-recovery.html` directly. Its Accept, Reject, Stop and return, and Abrupt death walkthroughs exercise the selected interaction. The page is memory-only and authenticates no human. The single Node proof uses that same model and scratch files; it needs no installed dependencies:

```sh
node docs/prototypes/approval-recovery-proof.mjs
node docs/prototypes/approval-recovery-proof.mjs /path/to/sandcastle-personal-setup/scripts/supervise.mjs
```

Observed on Linux with Node 24.19.0: both commands passed. The second also exercised the actual inspected supervisor. Model checks covered wrong identity/provenance fields, stale approval after rejection/replacement, duplicate and conflicting delivery, one simulated integration, cancellation, caps and both answer policies. Separate processes read status and submitted duplicate responses while a dummy execution lock existed. Disk reload preserved decisions and allowances. SIGKILL during a temporary snapshot write left the preceding complete snapshot and fixture work/session files intact. This proves the proposed transport shape is feasible; it does not repair the existing template's lock placement or prove power-loss durability.

Before unattended production execution relies on this contract, the implementation must pass the smallest end-to-end exercise in a disposable project through its actual generated entry and selected provider, using deterministic agent output:

1. Hold independent Task B open. Publish A's verified pending comparison; read status and send a genuine owner answer through the chosen Codex or verified host route. Restart after delivery and before application, then after application and before acknowledgement. Verify exact source binding, one durable decision and no extra attempt. Reject wrong-owner, stale, changed-evidence and conflicting replies.
2. Include tracked/untracked incomplete work, required ignored evidence and a real provider-supported session. Checkpoint, actually remove the disposable sandbox, restore, and verify hashes, evidence, session resumability and unchanged allowances. Inject checkpoint/cleanup failure and preserve the only work copy. Missing session capture remains an explicit limitation, not claimed recovery.
3. Stop during execution through the actual supervisor. Verify denied new dispatch/integration, worker settlement, final receipt and retained reservations. Kill a disposable worker during publication; inspect surviving resources, recover only verified state and reconcile reserved attempts. A second launcher must not steal or remove an active owner's lock.
4. Kill between integration and its receipt in a disposable Git target. Recovery must establish the original effect or block; repeated delivery must not integrate twice. No request can approve a changed candidate or promote a baseline implicitly.
5. Separately exercise Codex task Stop, terminal/transport loss, window close and full app quit with that launch chain. Capture observed events, process relationships, checkpoint completion, cleanup and restart results. Enable automatic app-close checkpointing only for events that demonstrably reach and finish the controller protocol. Until then the selected explicit fallback is the supported procedure.

No public API or user-facing production behavior changed, so README and changesets need no update. The runnable Node proof is the relevant validation; TypeScript sources are unchanged. No paid agent, emulator, product task or real visual acceptance ran.
