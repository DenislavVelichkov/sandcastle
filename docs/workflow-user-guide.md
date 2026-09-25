# Workflow user guide

This guide covers the maintained `@ai-hero/sandcastle` workflow package and the first independent library fixture. The [API reference](workflow.md) describes the project callbacks and public functions in detail. The workflow is opt-in. Each project still owns its tasks, prompts, checks, reviews, human decisions, and Git target.

## Contents

1. [Prepare an exact package](#prepare-an-exact-package)
2. [Run the first library task](#run-the-first-library-task)
3. [Use the daily controls](#use-the-daily-controls)
4. [Check evidence and limits](#check-evidence-and-limits)
5. [Change an installation](#change-an-installation)
6. [Troubleshoot](#troubleshoot)

## Prepare an exact package

You need Git, Node 24 or newer, pnpm 11.19.0, and Docker for the selected Linux/Docker/Codex proof. The actual worker needs the Codex binary, an authenticated ChatGPT account, the selected image, and the personal integration's isolated Codex Home. Keep the host workflow state and response route outside agent worktrees. `pnpm exec sandcastle --help` checks the installed CLI; it does not start a workflow.

From a clean committed maintained Sandcastle source checkout, make a local archive and receipt:

```sh
pnpm run seal -- /absolute/output-directory
pnpm run verify:seal -- /absolute/output-directory/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz.receipt.json
```

`seal` refuses a dirty source tree. It builds JavaScript, public types and templates, records the source commit and workflow API/configuration/state versions, packs the license, and writes the archive SHA-256 receipt. `verify:seal` compares those bytes and metadata, installs into a fresh directory without a source checkout or plugin cache, checks actual package resolution and public exports, runs the CLI help command, and typechecks a public import. A checksum, source, version or contract mismatch stops preparation. Rebuild after any source change and keep the new receipt with the new archive. This local archive is prepublication evidence. It has no GitHub release identity or distribution attestation.

The selected project pins that exact archive in its package manifest and pnpm lockfile. In the independent fixture, the owner keeps the archive outside the candidate repository and runs:

```sh
cd /absolute/limit-items-workflow-fixture
pnpm add --save-dev file:/absolute/output-directory/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz
CI=true pnpm install --frozen-lockfile
pnpm exec sandcastle --help
```

Record the archive and receipt paths, source commit, package resolution, lockfile integrity, worker image ID, Codex binary, isolated Codex Home and consumer commit before a proof run. Repeat package resolution and metadata checks inside the actual worker. A matching host package alone does not establish worker identity. If the package differs, stop before dispatch; do not fall back to the public npm package. The personal setup owns this installation and inspection step. It preserves unrelated dependencies, project prompts and hooks, host defaults and disabled skills.

## Run the first library task

The independent fixture's `TASK.md` asks for a zero-limit correction. Its starting test intentionally fails on zero. The separate owner directory holds the protected grader, known correction, interruption barrier and answer route; it stays outside the candidate worktree and sandbox.

1. Use the project's exact task reference and create a named branch worktree. Keep the target branch and host state directory separate. The project callback must return the task ID, reference, dependencies, allowed edit scope, required Standards and specification review roles, and required capabilities.
2. Build the `WorkflowProject` callbacks against the project's existing tracker and protected grader. `prompt()` uses the project's task and role prompts. `check()` runs the project tests and owner grader. `accept()` binds the candidate and evidence to a human question. `reserve()` retains the scope during a wait. See [Run a selected task](workflow.md#run-a-selected-task) for the shape.
3. Prepare a fixed role policy with two implementation attempts and one call for each review role. The owner supplies fresh model and account reads from the actual worker through `usage`. For this library proof, the initial implementation is Sol High at Standard service tier. Do not start if a required model, account guard, role, proof tool or review is unavailable.
4. Call `inspectWorkflow()` with the exact selection and project options. Resolve every blocked reason before `runDurableWorkflow()`. Use the project's copied thin entry, which imports only the installed public package. Record the admission, checkpoint, review, answer, and integration receipts for each attempt.

The live recovery proof has a defined stop point. The owner barrier waits for recoverable source bytes and a genuine provider session before asking the controller to stop. Verify the saved-and-stopped receipt, remove the actual sandbox, restore a new sandbox and resume the recorded session within the second reserved implementation call. Finish the protected grader and both fresh reviews on the frozen candidate.

The September 25, 2026 attempt used the sealed `0.12.0-dv8.16.0` archive from source commit `0df2ba5` and Docker/Codex. It verified the first saved-and-stopped checkpoint, sandbox removal, a new sandbox and resumed provider session, the one-line candidate `86fbb04`, the protected grader, both fresh reviews, and a genuine host owner `Approve` answer applied while stopped. It consumed exactly four model calls. A separate deterministic fixture applied its answer while an independent task remained active. **The live lifecycle is incomplete:** the first integration check failed because the fixture callback tried to rewrite its frozen grade artifact with timing-dependent test output. The controller retained a blocked integration intent and left the disposable target unchanged. The deterministic fixture's successful merge does not establish a live merge. See [issue #17](https://github.com/DenislavVelichkov/sandcastle/issues/17) for the attempt receipts and current status.

## Use the daily controls

The project entry calls these public functions. There is no workflow CLI command hidden behind `sandcastle`:

| Need                    | Public call                                                                 | Expected result                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Read progress           | `workflowStatus(directory)`                                                 | Complete last snapshot, revision, liveness and pending requests; `last-known` means it may be stale.                         |
| Stop safely             | `checkpointStopWorkflow(directory)`                                         | A `stopped` snapshot with verified source/session restoration and a checkpoint. Keep all work and state until this succeeds. |
| Recover after restart   | `recoverDurableWorkflow(options)`                                           | Inspects retained source, session, process ownership, runtime and Git effects. A mismatch reports recovery required.         |
| Resume work             | `resumeDurableWorkflow(options)`                                            | Reuses the same identities and remaining allowances; it does not restart waiting or rejected tasks on its own.               |
| Queue an owner answer   | `respondWorkflow({ directory, requestId, responseId, sourceEvent, route })` | A durable `queued` receipt. The trusted host route authenticates the original owner event and displayed question.            |
| Apply while stopped     | `processWorkflowResponses(directory, project.validateHumanRequest)`         | An applied or stale receipt without an agent call.                                                                           |
| Integrate accepted work | `integrateWorkflowTask(options, taskId)`                                    | A checked Git effect recorded once, or a blocked reason. It requires a stopped verified workflow and project target lock.    |

Show the exact question, candidate commit, manifest and evidence hashes to the owner. `Approve` binds only that request. `Reject: feedback` retains the feedback and requires an explicit rework request within the remaining allowance. A closed prompt or missing reply is no answer. Keep the target branch unchanged during the human wait. After integration, the project still performs its own completion gates; integration does not close a ticket or promote a visual baseline.

## Check evidence and limits

The host state distinguishes checks passed, waiting, accepted and integrated. Read the candidate commit, protected grader output and both review results before asking for approval. Evidence reuse belongs to the project validator and needs a fresh applicability check against source, build, worker, fixture and proof policy. An old screenshot, report or checksum by itself grants no acceptance.

Guarded Codex work records requested model and effort separately from observed effective settings. It reserves each call before dispatch and keeps spent calls and active time across resume and account resets. The library proof ceiling is four calls and 45 active minutes, with two implementation attempts. An unavailable model, stale account reading, denied usage, less than 20% remaining, a five percentage-point increase, or an exhausted deadline blocks a new call and asks for a checkpoint. Unknown token coverage stays unknown. The workflow does not buy credits, redeem resets or switch billing modes. See [Guarded Codex usage](workflow.md#guarded-codex-usage) for the exact callback contract.

Browser and Android checks are project capabilities. Prepare isolated browser contexts and reserved backend fixtures only for a project that declares them. Native work uses that project's existing device and proof controller. Neither capability is established by the library fixture. The seven-configuration benchmark, browser report and adaptive policy are separate later activities; this local package check reports no savings or model ranking.

## Change an installation

Keep the archive receipt, package pin, lockfile, installed resolution, image ID and runtime identity together. Do not replace a package while a checkpoint, pending answer or unfinished invocation depends on its old bytes. The planned managed update and rollback commands are **not available in this prepublication stage**. Later rollout must inspect each explicitly selected project, preserve its customized fields and runtime state, and report partial outcomes. A local sealed archive is not an immutable GitHub release receipt.

## Troubleshoot

| Symptom                                     | Action                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Seal from a clean recorded source commit`  | Commit the intended candidate, then seal again. Preserve unrelated changes.                                                                                               |
| Archive checksum or metadata mismatch       | Discard that archive for proof, rebuild from a clean recorded commit and verify the new receipt.                                                                          |
| Installed path points outside the consumer  | Remove the stale dependency or link, reinstall from the pinned archive and rerun `verify:seal`.                                                                           |
| Worker identity differs from host           | Stop admission. Inspect the worker lockfile, mounts and installed package before another run.                                                                             |
| `last-known` status                         | Inspect the recorded process and call recovery with the original options; do not assume work is still running.                                                            |
| No saved-and-stopped receipt                | Keep the worktree, sandbox and host state. Repair checkpoint or cleanup failure before quitting.                                                                          |
| Stale answer or changed candidate           | Recheck the current evidence and present a new exact request. Do not reuse the old approval.                                                                              |
| Account or model guard blocks               | Refresh observations in the same worker. Preserve spent allowances; use the documented reset-continuation decision only for a verified reset.                             |
| Integration says recovery required          | Inspect the target's actual Git effect under its lock. Do not repeat the merge on an uncertain result.                                                                    |
| Integration check cannot reproduce evidence | Keep the frozen evidence and blocked intent. Make the project check output stable before a new authorized run; do not edit the recorded answer or state to force a merge. |
