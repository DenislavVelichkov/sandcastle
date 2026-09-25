# Workflow user guide

This guide covers the maintained `@ai-hero/sandcastle` release and its independent library and web consumers. The [API reference](workflow.md) describes the project callbacks and public functions in detail. The workflow is opt-in. Each project still owns its tasks, prompts, checks, reviews, human decisions, and Git target.

## Contents

1. [Install the published release](#install-the-published-release)
2. [Run the first library task](#run-the-first-library-task)
3. [Verify the web fixture](#verify-the-web-fixture)
4. [Use the daily controls](#use-the-daily-controls)
5. [Check evidence and limits](#check-evidence-and-limits)
6. [Run the bounded benchmark](#run-the-bounded-benchmark)
7. [Prepare the native diagnostic](#prepare-the-native-diagnostic)
8. [Change an installation](#change-an-installation)
9. [Troubleshoot](#troubleshoot)

## Install the published release

The current native-capable maintained release is [immutable `v0.12.0-dv8.21.0`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.21.0). Its source commit is `46aae5d7278be702f395c3f2c0f2631dfda19c13`, and the archive SHA-256 is `f3e3801822a171a15ebed9be4b972cfa2c3545cbe87bd12261ad613b711f8cb2`. GitHub's release and asset attestations verify, and the downloaded archive matches the sealed file byte for byte. Renovio's native proof branch pins that exact release URL and integrity in its manifest and lockfile.

The earlier [immutable release `v0.12.0-dv8.16.0-r2`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.16.0-r2) contains the exact archive from the library recovery proof. Its tag points to source `0df2ba5c91afca41294ea026a95f9e21a7ba6d73`; the archive SHA-256 is `eca2e0116d09ac920b9ccf2e6e8d6896124c9533a83d9945066079ecead83164`. The release also carries `SHA256SUMS`. GitHub's release and asset attestations verify, and a downloaded asset matches the sealed archive byte for byte. Keep each release URL, checksum, source commit and package-manager lockfile together.

The npm library and pnpm web repositories pin this exact release URL in their manifests and lockfiles. Check the published bytes directly:

```sh
curl --fail --location --output /tmp/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz https://github.com/DenislavVelichkov/sandcastle/releases/download/v0.12.0-dv8.16.0-r2/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz
sha256sum /tmp/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz
gh release verify v0.12.0-dv8.16.0-r2
gh release verify-asset v0.12.0-dv8.16.0-r2 /tmp/ai-hero-sandcastle-0.12.0-dv8.16.0.tgz
```

Use Linux, Docker, and Node 24. The library proof used npm 11.17.0 in a Node-only image. The web proof used pnpm 11.19.0 and Playwright 1.63.0. For live Codex recovery, the actual worker also needs Codex CLI 0.156.1, an authenticated account, the tested image and the personal integration's isolated Codex Home. Keep host workflow state and the response route outside agent worktrees. A CLI `--help` check does not start a workflow.

From a clean checkout of the independent npm library consumer, run:

```sh
cd ../limit-items-release-consumer
npm ci
npm test
npm run typecheck
npm run verify:install
docker build -t sandcastle:limit-items-release -f Dockerfile.library .
npm run proof
npm run verify:evidence
```

`npm ci` rejects a missing or inconsistent lockfile. `verify:install` checks the release URL, integrity, installed metadata, public exports and resolution. `proof` repeats those checks, tests, typecheck and CLI inside a Sandcastle-created Node-only Docker sandbox, removes it, then exports and reopens `evidence/issue-18-library-r2.json`. The historical library recovery proof still belongs to [issue #17](proofs/issue-17-live-attempt.md); this clean npm consumer proves distribution. The personal setup preserves unrelated project inputs and owns installation inspection.

## Run the first library task

The independent fixture's `TASK.md` asks for a zero-limit correction. Its starting test intentionally fails on zero. The separate owner directory holds the protected grader, known correction, interruption barrier and answer route; it stays outside the candidate worktree and sandbox.

1. Use the project's exact task reference and create a named branch worktree. Keep the target branch and host state directory separate. The project callback must return the task ID, reference, dependencies, allowed edit scope, required Standards and specification review roles, and required capabilities.
2. Build the `WorkflowProject` callbacks against the project's existing tracker and protected grader. `prompt()` uses the project's task and role prompts. `check()` runs the project tests and owner grader. `accept()` binds the candidate and evidence to a human question. `reserve()` retains the scope during a wait. See [Run a selected task](workflow.md#run-a-selected-task) for the shape.
3. Prepare a fixed role policy with two implementation attempts and one call for each review role. The owner supplies fresh model and account reads from the actual worker through `usage`. For this library proof, the initial implementation is Sol High at Standard service tier. Do not start if a required model, account guard, role, proof tool or review is unavailable.
4. Call `inspectWorkflow()` with the exact selection and project options. Resolve every blocked reason before `runDurableWorkflow()`. Use the project's copied thin entry, which imports only the installed public package. Record the admission, checkpoint, review, answer, and integration receipts for each attempt.

The live recovery proof has a defined stop point. The owner barrier waits for recoverable source bytes and a genuine provider session before asking the controller to stop. Verify the saved-and-stopped receipt, remove the actual sandbox, restore a new sandbox and resume the recorded session within the second reserved implementation call. Finish the protected grader and both fresh reviews on the frozen candidate.

The first September 25, 2026 live attempt proved recovery and owner response but failed at integration because the fixture wrote timing-dependent test output into frozen check evidence. Its blocked state remains intact. After the fixture check was made stable, a fresh authorized attempt used the same sealed `0.12.0-dv8.16.0` package and actual Docker/Codex worker. It verified interruption, sandbox removal, session continuation, the protected grader, both reviews, a new exact-candidate owner answer, and one merge into a disposable target within four calls. The controller returned the same Git effect on a second integration call. A separate deterministic fixture proved answer application while independent Task B was active. See the [issue #17 receipt report](proofs/issue-17-live-attempt.md) for identities, hashes, limits, and remaining support boundaries.

## Verify the web fixture

From a clean checkout of the independent pnpm web project, run:

```sh
cd ../counter-web-workflow-fixture
pnpm install --frozen-lockfile
docker build -t sandcastle:counter-web-proof -f Dockerfile.browser .
pnpm run proof
pnpm run verify:evidence -- --self-test
```

The app has no backend. Reset sets the displayed counter to zero and removes `counter-value-v1` from that browser context's local storage. The project-owned proof starts two actual Sandcastle Docker sandboxes together. Each installs the release from the lockfile, checks the public import and CLI, runs Playwright increment/reload/Reset/reload behavior, and saves screenshots. It records Playwright 1.63.0, Chromium 153.0.8010.12, locale, timezone, viewport, image ID, package identity and source hashes. It exports `evidence/issue-18-r3/`, removes both containers and worktrees, and reopens the exported files. The validator rejects controlled wrong-build, changed-fixture, missing-browser and stale-capture records. An existing evidence directory is not overwritten; use `verify:evidence` to reassess it.

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

Browser and Android checks are project capabilities. The web fixture establishes browser isolation for its no-backend counter and the tested Playwright image. Other web projects must declare their own browser versions, contexts, ports and backend reservations. Native work uses that project's existing device and proof controller; no native capability was exercised here. Browser comparison and fixture approval do not grant production acceptance or promote a baseline. The seven-configuration benchmark, browser report and adaptive policy are separate later activities; these distribution checks report no savings or model ranking.

The [issue #18 release adoption report](proofs/issue-18-release-adoption.md) records the exact distribution, consumer, sandbox and browser evidence.

## Run the bounded benchmark

The public benchmark functions are project calls, not `sandcastle` CLI commands. An owner-approved host entry supplies the project's existing task, grader, required reviews, acceptance functions, actual worker model catalog, account readings and installed package identity. Use the [bounded benchmark API](workflow.md#bounded-benchmark) to bind those functions. The four historical base and reference commits are in `benchmarkFixtures`; do not replace them after seeing outcomes. A protected grader and the reference patch stay outside each agent worktree. Exporting and preflighting these real fixtures starts the later pilot's four-hour clock, so the deterministic tests in this repository do not do that work.

Before inference, freeze the exact installed release, worker CLI and image, account, prompts, tools, cache and role configurations. Run the six-call measurement exercise within 15 active minutes, under the same pilot budget and account baseline. `benchmarkSlots` gives the declared order. For each slot, start a fresh answer-free worktree and session, then call `runBenchmarkEvaluation()` once with its slot ID. The operation uses the installed durable controller and writes the attempt to the host-only `benchmark.json`. A stopped or incomplete attempt remains counted; inspect its checkpoint and budget before an explicit recovery. Do not substitute an unrun slot or reset its allowance.

After 28 fixed development evaluations, call `freezeBenchmarkPair()`. A returned `null` keeps Sol High fixed. A returned pair fixes the start, fallback and independent-failure rule before any held-out result is exposed. Run the remaining declared slots sequentially on an otherwise quiet account. The protected first-iteration check may authorize one second implementation call only for an actionable implementation defect; the other failure classes stop without escalation. Call `assessBenchmarkPromotion()` after all 64 slots. `admitted` supports `admitBenchmarkPolicy()` for the tested independently gradable task classes and the separate owner policy decision; `fixed-policy` leaves Sol High in place. `readBenchmark()` gives the JSON ledger for the later browser report. Do not treat an unchanged coarse account percentage as zero cost, or a synthetic pass as measured model savings.

## Prepare the native diagnostic

The `v0.12.0-dv8.21.0` release includes `runNativeProof()` and Renovio's native proof branch pins it for the project check at `scripts/sandcastle-native-proof-check.mjs`. The diagnostic runs only on the host; the worker receives no ADB or Docker socket.

In a clean Renovio candidate checkout with that release installed, prepare the project's canonical P1, P2 and P3 devices, matching installed APK, Metro on port 18081, and the existing Maestro runner. Inspect device, port, fixture and output ownership before starting. The check obtains Sandcastle's host reservation before Renovio's project proof lease, then invokes the fixed owner entry with a 20 minute deadline:

```sh
node scripts/sandcastle-native-proof-check.mjs --serials=P1=<P1-serial>,P2=<P2-serial>,P3=<P3-serial> --timeout-ms=1200000
```

For a workflow task, the Renovio host binding calls `checkNativeLanding(candidate, { worktree, serials, timeoutMs, signal })` from its `project.check`. The helper creates `tmp/pilot-dev-proof/exercises/<operation-id>/`. Renovio's owner checks the signed-out Landing behavior on all three profiles with at most two profiles active, retains screenshots and behavior logs, records a matching P1 control and a synthetic mismatch control, then writes `receipt.json`. Its validator freshly checks source, APK, Metro, device and profile identity, artifact hashes and current Landing hierarchy and writes a separate applicability record. Both controls are diagnostic fixture data with `productAcceptance: false`.

If readiness, comparison or current observation fails, treat the result as blocked. Failed capture keeps the host reservation and evidence. Inspect the retained owner and native processes before explicit host recovery; start a new operation and revalidate rather than treating the old capture as current. A human wait releases live resources only after the owner confirms they stopped. The [issue #22 native diagnostic report](proofs/issue-22-native-isolation.md) records a live P1/P2/P3 capture, queued cross-project request, cancellation, durable checkpoint, worker removal, restoration and a new P1/P2/P3 check after recovery. Restoring the checkpoint changed Metro configuration file timestamps, so the saved capture could not pass the owner's exact Metro-process binding after a restart; the continued check captured fresh evidence. The diagnostic does not establish TalkBack focus, product visual approval or baseline promotion. The earlier public P1/P2 exercise proves only its two-profile run.

## Change an installation

Keep the release URL, checksum, lockfile, installed resolution, image ID and runtime identity together. Do not replace a package while a checkpoint, pending answer or unfinished invocation depends on its old bytes. The immutable `v0.12.0-dv8.16.0-r2` release has no managed update admission. The native-capable release carries the installation inspection exports; the personal updater still must inspect a selected root before registration. Corrections to a published archive require a new tag and package version.

The personal integration keeps one inventory and lock under `XDG_STATE_HOME/sandcastle/installations` or `~/.local/state/sandcastle/installations`, outside Codex configuration. Selected-project setup registers a root only after it verifies the installed package, worker image and model choices. To add an older managed root, inspect that exact root first, then import it. A missing inventory is an unknown registration state. It is no reason to scan saved Codex projects or assume an installation is absent.

Set `PLUGIN_ROOT` to the maintained personal plugin directory, `PROJECT` to one selected package workspace, and `RELEASE` to an exact published compatible release tag. The project-owned `.sandcastle/update-owner.mjs` supplies the actual worker observations. These are the implemented entry commands:

```sh
SCRIPT="$PLUGIN_ROOT/skills/quality/sandcastle-personal-setup/scripts/update.mjs"
node "$SCRIPT" list
node "$SCRIPT" inspect --root "$PROJECT" --offline
node "$SCRIPT" import --root "$PROJECT"
node "$SCRIPT" rollout --root "$PROJECT" --tag "$RELEASE"
node "$SCRIPT" rollout --root "$PROJECT" --root "$OTHER_PROJECT" --tag "$RELEASE"
node "$SCRIPT" rollout --all-registered --tag "$RELEASE"
```

Use `import` only for a root that `inspect` reports as current. `rollout` freezes one verified release and accepts only registered canonical roots. It checks each root's installation, project, worktree and package workspace identity, then uses the same selected-project admission and update transaction. Results say `updated`, `current`, `deferred` or `failed` per root, with last verified readiness and its time, rollback availability and the selected project's recovery ownership. A busy or unfinished root defers. A missing, moved or conflicting root fails without changing other roots. A successful update remains installed when another root defers or fails; the result never claims that every selected project updated.

The per-project installation record, prior release archive and update journal remain on the host after rollout. If a root fails during apply, inspect its journal and use `node "$SCRIPT" rollback --root "$PROJECT"` only when the selected-project owner confirms the retained bytes. A concurrent edit blocks rollback. `verify --root "$PROJECT" --adapter "$PROJECT/.sandcastle/update-owner.mjs"` checks the actual host and worker package again. Installation verification does not establish controller, browser, native or human-response readiness. The current `r2` release cannot be registered through this path, and real two-release distribution proof remains separate from the disposable fixture checks.

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
