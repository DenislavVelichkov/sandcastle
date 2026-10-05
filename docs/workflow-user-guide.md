# Workflow user guide

This guide covers the maintained `@ai-hero/sandcastle` release and its independent library and web consumers. The [API reference](workflow.md) describes the project callbacks and public functions in detail. The workflow is opt-in. Each project still owns its tasks, prompts, checks, reviews, human decisions, and Git target.

## Contents

- [Workflow user guide](#workflow-user-guide)
  - [Contents](#contents)
  - [Install the published release](#install-the-published-release)
  - [Run the first library task](#run-the-first-library-task)
  - [Verify the web fixture](#verify-the-web-fixture)
  - [Use the daily controls](#use-the-daily-controls)
  - [Check evidence and limits](#check-evidence-and-limits)
  - [Run the bounded benchmark](#run-the-bounded-benchmark)
  - [Review the routing decision](#review-the-routing-decision)
  - [Open and interpret the benchmark report](#open-and-interpret-the-benchmark-report)
  - [Prepare the native diagnostic](#prepare-the-native-diagnostic)
  - [Change an installation](#change-an-installation)
  - [Troubleshoot](#troubleshoot)

## Install the published release

The current [immutable `v0.12.0-dv8.23.0` release](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.23.0) contains the bounded benchmark, policy-admission checks, local browser report, and tracked ignored-file fixture export repair. Its source commit is `c784396c038ed9a41f4634df4e926e21e71ac5da`, and its archive SHA-256 is `ed63d1161f232321df28b804e4d0174633ce34b35f0bbe9cf73cb2b5974960ae`. GitHub's release and asset attestations verify, and the downloaded archive matches the sealed file byte for byte. The earlier benchmark [release `v0.12.0-dv8.22.0`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.22.0) has source commit `b56bd6c26039e99946f0bafaaee1b334b4c11f5d` and archive SHA-256 `6f0991b8c18cbaac63115ca67c1df04575483a53b0b2f273852e0d93922373e9`. The earlier native-capable [release `v0.12.0-dv8.21.0`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.21.0) has source commit `46aae5d7278be702f395c3f2c0f2631dfda19c13` and archive SHA-256 `f3e3801822a171a15ebed9be4b972cfa2c3545cbe87bd12261ad613b711f8cb2`. Renovio's native proof branch pins that earlier release URL and integrity in its manifest and lockfile.

The earlier [immutable release `v0.12.0-dv8.16.0-r2`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.16.0-r2) contains the exact archive from the library recovery proof. Its tag points to source `0df2ba5c91afca41294ea026a95f9e21a7ba6d73`; the archive SHA-256 is `eca2e0116d09ac920b9ccf2e6e8d6896124c9533a83d9945066079ecead83164`. The release also carries `SHA256SUMS`. GitHub's release and asset attestations verify, and a downloaded asset matches the sealed archive byte for byte. Keep each release URL, checksum, source commit and package-manager lockfile together.

The earlier npm library and pnpm web repositories pin the `r2` release URL in their manifests and lockfiles. Check those published bytes directly:

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
| Resume work             | `resumeDurableWorkflow(options)`                                            | Reuses the same reservation and allowances; dispatches requested rework and dependencies cleared by an applied approval.     |
| Request a repair        | `requestWorkflowRework(directory, taskId)`                                  | Records intent after a rejection with remaining allowance. The next explicit resume checks the session and required roles.   |
| Queue an owner answer   | `respondWorkflow({ directory, requestId, responseId, sourceEvent, route })` | A durable `queued` receipt. The trusted host route authenticates the original owner event and displayed question.            |
| Apply while stopped     | `processWorkflowResponses(directory, project.validateHumanRequest)`         | An applied or stale receipt without an agent call.                                                                           |
| Integrate accepted work | `integrateWorkflowTask(options, taskId)`                                    | A checked Git effect recorded once, or a blocked reason. It requires a stopped verified workflow and project target lock.    |

Show the exact question, candidate commit, manifest and evidence hashes to the owner. `Approve` binds only that request. `Reject: feedback` retains the feedback and requires an explicit rework request within the remaining allowance. The project receives that feedback in its implementation prompt callback on resume and must include it in the repair prompt. A closed prompt or missing reply is no answer. Keep the target branch unchanged during the human wait. After integration, the project still performs its own completion gates; integration does not close a ticket or promote a visual baseline.

## Check evidence and limits

The host state distinguishes checks passed, waiting, accepted and integrated. Read the candidate commit, protected grader output and both review results before asking for approval. Evidence reuse belongs to the project validator and needs a fresh applicability check against source, build, worker, fixture and proof policy. An old screenshot, report or checksum by itself grants no acceptance.

Guarded Codex work records requested model and effort separately from observed effective settings. It reserves each call before dispatch and keeps spent calls and active time across resume and account resets. The library proof ceiling is four calls and 45 active minutes, with two implementation attempts. An unavailable model, stale account reading, denied usage, less than 20% remaining, a five percentage-point increase, or an exhausted deadline blocks a new call and asks for a checkpoint. Unknown token coverage stays unknown. The workflow does not buy credits, redeem resets or switch billing modes. See [Guarded Codex usage](workflow.md#guarded-codex-usage) for the exact callback contract.

Browser and Android checks are project capabilities. The web fixture establishes browser isolation for its no-backend counter and the tested Playwright image. Other web projects must declare their own browser versions, contexts, ports and backend reservations. Native work uses that project's existing device and proof controller; no native capability was exercised here. Browser comparison and fixture approval do not grant production acceptance or promote a baseline. The seven-configuration benchmark, browser report and adaptive policy are separate later activities; these distribution checks report no savings or model ranking.

The [issue #18 release adoption report](proofs/issue-18-release-adoption.md) records the exact distribution, consumer, sandbox and browser evidence.

## Run the bounded benchmark

Use the installed `sandcastle benchmark` command to select and freeze an implementation benchmark. `--project` selects the project independently of the directory containing the runner. `--ticket` accepts an exact local file, GitHub issue URL or issue number. Local paths and `--contract` are relative to the selected project root. Issue numbers use that project's GitHub origin or explicit `--repository owner/repo`; URLs must match the intended repository. Repeat `--ticket` for an explicit multi-task plan. No input selects another backlog task automatically.

```sh
sandcastle benchmark --project /path/to/project --ticket tickets/example.md --dry-run
sandcastle benchmark --project /path/to/project --repository owner/repo --ticket 94 --judge gpt-6-astra:high --dry-run
sandcastle benchmark --project /path/to/project --prompt 'Implement this exact task' --dry-run
sandcastle benchmark --project /path/to/project --ticket missing.md --prompt 'Explicit fallback instructions' --dry-run
sandcastle benchmark --project /path/to/project --ticket tickets/example.md --image project-worker --prepare 'pnpm install --frozen-lockfile' --check 'pnpm run typecheck' --preflight
```

A missing local file or a confirmed missing GitHub issue can use the explicitly supplied `--prompt`. Authentication, network, repository-access and permission failures remain failures. Empty files are unusable, and path patterns require selection of an exact file. GitHub input freezes the issue title, body and every comment, plus declared dependencies and their current instructions/state. Dependencies come from GitHub's [issue dependency API](https://docs.github.com/en/rest/issues/issue-dependencies) and `Blocked by`, `Dependencies` or `Prerequisites` sections in task text and comments. An open or unresolved prerequisite blocks readiness. A local prerequisite document is satisfied only with YAML frontmatter containing explicit `status: closed`, `status: done` or `status: completed`; otherwise it remains unknown. A closed issue does not certify its project's other acceptance gates. Declare any additional gates through the project readiness probe.

The default arms are `gpt-6-astra:medium`, `gpt-6-astra:high`, `gpt-6-astra:xhigh` and `gpt-6-astra:max`, in that order. Repeated `--arm model:effort` values replace these defaults. Dotted model IDs are preserved. `ExtraHigh`, `extra-high` and `extra_high` canonicalize to `xhigh`; invalid or duplicate arms are rejected. `--judge model:effort` configures an independent judge, defaulting to `gpt-6.1-sol:xhigh`, without altering the implementation arms. Effort values come from the actual worker catalog, including hidden entries, rather than a fixed host allowlist. A syntactically valid effort remains unverified during scheduling until that catalog check runs. The fixed service tier is `default`. Catalog availability never stands in for observed per-response identities.

`--dry-run` makes no worker or model call. It prints a version-two frozen plan with `workerStatus: unchecked`, unless known prerequisites already block it. `--preflight` makes no model call but creates a disposable private checkout of the selected base and an isolated Docker worker. It checks subscription authentication and included-usage availability through that worker's Codex app server, every catalog page, requested model/effort pairs for both roles, tool availability, host and worker free bytes/inodes, the project's check or explicit adapter readiness command, and each requested environment probe. It verifies authentication with a model-free subscription-service request, copies authentication privately and never exports credentials or account details. Denied, exhausted or unavailable usage capacity blocks readiness. Preparation and grading probes each have a 60-second cap; environment probes have a 30-second cap, and the worker probe has a four-minute cap. Cleanup removes the private checkout and owned container; failures name the owned container requiring cleanup. No image is pulled automatically.

A preflight exports only allowlisted observations and actionable blockers. `workerStatus` distinguishes passed worker checks from overall readiness, and `implementationReady` identifies a passed preflight for implementation. `executionReady` and `status: ready` require successful preflight and no missing runtime evidence consumer. Nonvisual code assessment is connected. Declared visual tasks retain an execution blocker for runtime collection in #50, while their implementation/code assessment path can expose that evidence gap. A blocked preflight exits with code 1 after printing its plan. The retained version-one runner and historical fixed/adaptive protocols remain separate.

Run without either planning flag to perform preflight and then bounded implementation/check/judge attempts:

```sh
sandcastle benchmark --project /path/to/project --ticket tickets/example.md --image project-worker --prepare 'pnpm install --frozen-lockfile' --check 'pnpm run typecheck' --max-new-slots 1
```

The controller imports only the selected base into private Git storage, then creates a separate private worktree, Git object store and Docker runtime for each arm. It does not stash, reset, merge, create host branches or alter the host checkout. Dirty host files are preserved. Workers receive their own installation, build outputs and writable home; the host repository, other arms, Docker socket, host devices and active services are not mounted. The worker image is pinned to the preflight digest and its Codex/Node versions must match. Each container has two CPU cores, 4 GiB of memory and a 512-process limit. Native or browser requirements must work inside these owned runtimes; an unavailable required environment is an explicit outcome.

Each admitted attempt permits one implementation invocation. After stopping its runtime, the controller seals the relevant candidate in a new inspectable private Git worktree before checking it. It includes tracked files and untracked files not ignored by the frozen base, including relevant uncommitted edits. Worker changes to ignore rules cannot conceal those files. Candidate transport preserves working bytes; repository Git attributes cannot normalize them. Ignored installations and build outputs are disposable; tracked ignored files remain candidate inputs. A separate checker starts from the sealed candidate, restores frozen grading files, prepares its own dependencies and executes the frozen check. It verifies protected grading bytes/modes and relevant source bytes after preparation and after checking; a changed input invalidates the check result. Checker installations and ignored build outputs remain disposable. No worker installation or background process carries into checking. Candidate commits and completion messages do not establish check success.

`manifest.json` retains the frozen launch plan. `execution.json` records outcomes, phase timings/reservations, call counts, requested and captured identities, raw provider usage, check results and owned cleanup. Stream/provenance files, available sanitized Codex sessions, check logs and binary patches retain compact evidence. Session identities remain unknown where the provider does not expose them; observed substitutions are reported. Private worktrees under `candidates/` retain the sealed code and source fingerprint. A fresh judge inspects a separate read-only worktree before its disposable environment is removed. `report.json` retains scores, coverage, assessment applicability, comparisons and incomplete outcomes; `report.html` gives a compact summary. They do not establish project acceptance. Infrastructure failures, failed checks, timeout, cancellation, interruption, no candidate, missing checks, unavailable environments, scope violations and cleanup failures remain distinct. Existing executions use the explicit recovery entry below. Retained historical pilots are untouched.

Select an empty external output directory. Other retained files also block execution, preserving historical manifests and reports byte for byte.

### Observe, cancel and resume a benchmark

These commands operate on the original external directory of a new version-two implementation run:

```sh
sandcastle benchmark-status --directory /path/to/evidence
sandcastle benchmark-status --directory /path/to/evidence --after 42 --watch
sandcastle benchmark-status --directory /path/to/evidence --log-attempt ticket-1-arm-1-attempt-1 --log-role implementation
sandcastle benchmark-cancel --directory /path/to/evidence --reason 'Stop this run for inspection'
sandcastle benchmark-resume --directory /path/to/evidence --max-new-slots 1
sandcastle benchmark-resume --directory /path/to/evidence --retry-attempt ticket-1-arm-1-attempt-1 --max-new-slots 1
```

`benchmark-status` returns JSON with the complete snapshot, ordered events, the next `cursor`, and `hasMore`. Pass the last cursor as `--after` to reconnect. A cursor belongs to its `runId`; retain both identities. Paginated reads return at most 500 events by default. Continue from the returned cursor while `hasMore` is true. `--watch` prints new JSON observations until ownership ends or the observer disconnects. Ctrl-C in the observing process stops only that observer. These operations cannot alter task instructions, invoke an agent, change execution ownership or steer workers. An active Luna chat uses the same read-only records and interfaces as the CLI.

Updates require an active observer or a separately authorized follow-up mechanism. Durable records alone do not promise notifications while the app is closed. Disconnecting a chat leaves an independently running controller active. If closing the app also stops its execution process, inspect the saved state and use explicit recovery.

`events.jsonl` holds version-one event headers and complete controller checkpoints. The controller commits each newline-terminated record before atomically replacing `status.json` and `execution.json`. Reads reconcile against that journal if a crash left a snapshot behind. A torn final record remains uncommitted and recovery trims only that tail. Earlier committed events retain their sequence numbers. Each event carries run, plan, attempt, slot and arm identities, its timestamp and phase. The snapshot includes arm/judge configuration, outcomes, check and judge states, usage coverage, evidence references, resource ownership, cancellation and recovery guidance. Judge preparation, inspection and completion use the same durable journal. `lastJudgeEvent`, `judgeCalls`, `judgeCompleted`, judge usage and assessment summaries describe that separate activity. `graded` counts original slots with current complete assessments; linked retries do not increase it. Passive terminal status reads invalidate summaries when bound source or evidence changes.

The controller heartbeat updates every two seconds and is separate from the last parsed implementation or judge event. A fresh heartbeat establishes controller activity, not model progress. The current phase, pending assessment and explicit failure reason explain what is known without interpreting silence as a stalled model. Raw sanitized implementation/judge streams and check logs stay in private files. Ordinary observations contain event kinds and counters, without worker narrative or tool arguments. `--log-attempt` explicitly reads a bounded private tail, 4 KiB by default. The library's `readBenchmarkLog` permits at most 16 KiB.

`scheduled` counts original slots. `attempted` counts distinct original slots admitted; `completed` counts original attempts with durable finished checks, whether those checks passed or failed. `attempts` includes linked retries and `retries` counts them separately. `implementationCalls` and `implementationCompleted` include all invocations, including retries and failed work. Unknown usage stays `null`. A completed check is not a judge assessment or project acceptance. Explicit retries therefore cannot increase the independent repetition denominator.

Cancellation saves its reason before the controller stops new admission. A passive read exposes `pendingCancellation` until the owner commits that request to its snapshot; recovery retains it even if the original controller never consumed it. The controller polls requests every 100 milliseconds. Cancellation and execution signals also stop an active recovery owner, preserving its reason and preventing replacement dispatch. An interrupted operation has at most the frozen cleanup allowance to settle, followed by bounded runtime stopping, evidence sealing and owned removal. Cleanup must pass before ownership is released; failures retain the exact resource identities and require reconciliation. Partial candidates after a failed runtime stop retain their protected base until recovery can stop the resource and seal them. Credentials have a controller-owned temporary seed outside the worker mount, so recovery can redact partial evidence. That seed and disposable installations are removed with their owned runtime directory.

`benchmark-resume` reads the saved manifest directly. It does not resolve a new task, refresh worker instructions or reset allowances. It verifies the frozen plan and current installed runner bytes, refuses a still-running original owner, reconciles only this run's recorded resources, preserves available partial candidates, and then continues unrun slots. Process start and boot identities distinguish stale ownership from PID reuse. Docker reconciliation verifies the run label and confirms removal. Custom runtime executors must supply their original resource recovery adapter. Failed or unverified cleanup prevents replacement execution. A recovery operation that ignores its deadline retains `recoveryOwner`; that process must stop before another reconciliation can start. An interrupted recovery owner also has to be proven stale.

The original overall clock continues across disconnection, crashes and idle time between dispatches. Spent calls and pending judge reservations remain charged. Exhausted allowance leaves work unrun. Completed implementation invocations are never replayed. Interrupted attempts retain their outcome and evidence; `--retry-attempt` explicitly admits one new attempt linked through `retryOf`, with separate evidence and one new implementation call. It uses the same frozen task, arm and remaining allowance. A previous cancellation remains in history; explicit resume acknowledges it for a new ownership period. A changed manifest, runner or output location requires a new launch instead of resuming this run. Historical version-one runs and older evidence without this journal retain their original recovery rules.

Library hosts can use `readBenchmarkProgress`, `watchBenchmarkProgress`, `readBenchmarkLog`, `cancelBenchmark` and `resumeTicketBenchmark` from the package entry. Only cancellation and resume are control operations. The observer APIs provide no implementation or judge instruction channel.

### Inspect candidate assessments

Every usable candidate gets a fresh judge session with its own private Git storage and read-only candidate/reference mounts. The judge defaults to `gpt-6.1-sol:xhigh`; the frozen `--judge` choice applies to every candidate. It reads relevant files and surrounding code against the exact task, governing instructions, frozen references and protected check outcomes. Candidate-authored instructions remain evidence, and automatic project-instruction loading is disabled for the judge. The judge receives a random candidate identity without implementation model/effort, cost or execution order. Repository content, task text, Git history and caller-chosen paths can still disclose identity; assessments record these blinding limitations.

The controller validates each requirement verdict and citation before calculating a score. Verdicts are `met`, `partial`, `not_met`, `not_assessed` and `not_applicable`. Weights and partial-credit fractions come from the frozen rubric. Missing evidence contributes no assessed weight. `score.value` describes only the assessed requirements; `score.coverage` states their share of applicable weight, and `score.range` includes the possible contribution of missing evidence. With no assessed requirements, the value is `null`. Visual criteria are inapplicable for a frozen nonvisual task. Required visual evidence remains unassessed until the runtime consumer in #50 supplies it. A failed mandatory check stays failed, and neither a score nor a comparison grants project or human acceptance.

`assessments/<id>.json` retains concise observations, explanations, deviations, requirement verdicts, cited evidence, candidate/protocol identities, requested and observed judge identity or an explicit unknown, usage and stream/session provenance. Final assessment files are immutable and byte-hashed. The durable journal commits their expected bytes before atomic export, so recovery can finish an interrupted export without another judge call or changes to an existing file. Code, check and future visual references use the exported `BenchmarkEvidenceReference` contract with a kind, content hash, candidate commit/tree/source identity, locator and optional runtime build/adapter/profile identity. Judge streams are private logs, available explicitly through `benchmark-status --log-attempt <attempt-id> --log-role judge`. Status separates implementation/judge usage, events and completed-call counts; a heartbeat does not imply judge activity.

The public `readBenchmarkAssessments(directory)` API passively verifies the frozen manifest, assessment bytes, candidate source and cited evidence. `compareBenchmarkCandidates(plan, result.assessments)` uses those verified results and reports a closest-to-spec candidate, a tie, or an inconclusive outcome per task. Every scheduled candidate needs a current complete assessment under the same protocol for a comparison. Scores and applicability are also retained in `report.json`; the richer interactive report belongs to #51. A changed candidate invalidates its assessment without rewriting historical files or starting a new call.

Cancellation, timeouts, malformed output, failed judge startup and observed identity mismatches retain an incomplete assessment and available spending. Unknown observed identity stays explicit; required evidence gaps retain partial coverage. Resume reconciles owned resources before continuing and never replays a completed or interrupted judge call. Rejudge an existing assessment explicitly with a reason:

```sh
sandcastle benchmark-resume --directory /path/to/evidence --rejudge-assessment <assessment-id> --reason 'Verify the initial assessment'
```

Rejudging creates a new linked assessment, consumes remaining frozen time/calls and leaves the prior record intact. It dispatches no implementation or unrun arm. Reserve extra calls through `maxCalls` at launch if rejudging may be needed. A changed judge or rubric requires a new launch and protocol identity; it cannot silently amend a saved run. Rejudging and `--retry-attempt` are separate operations.

### Configure the frozen launch contract

Every plan binds the exact task and prerequisite text, base commit, committed project governing instructions, allowed edits, setup/check commands, dependency manifests/lockfiles, installed runner files/version and source commit when available, worker configuration, observed image/Codex/catalog identities or explicit unknowns, project adapter, rate inputs or unknowns, phase/call allowances, common judge prompt, criterion IDs, weights, applicability, partial-credit rules and evidence policy. The plan ID hashes those inputs. Task documents are read exactly as selected, while project instructions/dependencies come from `--base`, which defaults to HEAD. Dirty host files remain untouched. Extra governing files and base-relative reference files can be declared explicitly through `instructions` and `references`. Reference bytes and hashes are frozen and mounted read-only for inspection. `visualRequired` declares whether runtime visual evidence is required for all selected tasks. Omission freezes applicability separately for each selected task from its scoped rubric evidence types. An optional one-based `task` on a criterion scopes it to that selected task; omitted values apply to every task. `--output` selects an evidence directory outside the project; planning prints the plan without creating a run directory. Redirect stdout to retain it.

Without a custom rubric, acceptance-list items become equally weighted criteria with stable task/criterion IDs, applicability `always`, code/check evidence and partial credit of 0.5. A task without an acceptance list becomes one criterion containing its complete instructions. This coarse default is frozen before inspection and does not establish project acceptance. Supply a precise rubric and required environment probes for tasks needing more specific applicability or visual evidence.

Use `--contract launch.json` for a strict version-one JSON contract. Unknown fields, duplicate criterion IDs or environment names, task scopes outside the selected tasks, empty task rubrics and nonfinite weight totals are rejected. This example declares a browser dependency and an independent grading readiness entry:

```json
{
  "version": 1,
  "allowedEdits": ["src/**", ".changeset/**"],
  "instructions": ["docs/task-guidance.md"],
  "tools": ["pnpm"],
  "prerequisites": ["93"],
  "adapter": {
    "id": "project-browser-v1",
    "readiness": "pnpm run verify:grading-readiness"
  },
  "environments": [
    { "name": "browser", "probe": "pnpm run verify:browser-readiness" }
  ],
  "rubric": [
    {
      "id": "required-behavior",
      "requirement": "The requested behavior works in the candidate application.",
      "weight": 1,
      "applicability": "always",
      "partialCredit": 0.5,
      "evidence": ["code", "check", "visual"]
    }
  ]
}
```

Contract fields are optional except `version`. Omitted allowed edits permit project files via `**`; the executor checks the frozen scope against the sealed candidate patch. Required tools always include `sh`, `node`, `git`, `codex` and `timeout`, plus `pnpm` for a pnpm project. The default adapter is `sandcastle-code-check-v1`, using the configured check on the frozen base as its readiness probe. A baseline that should fail needs a project-owned adapter probe that establishes grading readiness independently. Preparation/check configuration belongs in `--prepare` and `--check`. Minimum capacity defaults to 1 GiB and 10,000 free inodes; a filesystem that reports no inode accounting records that dimension as unavailable. Optional `minimumFreeBytes`, `minimumFreeInodes`, `implementationMinutes` and `judgeMinutes` override those values. `rateCard` accepts `{ "source": "dated source", "date": "YYYY-MM-DD", "inputs": {} }`; omission remains explicitly unknown and does not imply zero cost. `protectedFiles` adds exact base-relative grading dependencies to the automatically frozen tests/specs, scripts, check/verify files, configuration, governing files, dependency manifests and files named in the check command. The project must declare every additional indirect grading dependency; the controller cannot infer arbitrary shell-command dependencies. Protected files must exist in the frozen base. Their bytes, executable modes and symlink targets are restored in the checker; new files matching those grading patterns are excluded. The retained candidate keeps the worker's actual edits for judge inspection.

Optional `controls` accepts `{ "knownBad": "base-ref", "knownGood": "correction-ref" }`. References resolve to exact commits at launch. Before implementation, both controls use private worktrees, the frozen grading files and the configured check. A declared bad control must fail and a good control must pass. Failed or unavailable controls block measurement. When no controls are supplied, the execution records `controls.status: absent`; no calibration is inferred. Optional `maxCalls` caps implementation and judge calls, including reserved calls and explicit rejudging. Zero is allowed and admits no implementation.

The default overall allowance is 60 minutes, changed by `--max-minutes`. Each slot reserves one implementation call with 15 minutes and one judge call with 10 minutes, plus five minutes each for setup/checks and one minute each for sealing/cleanup. Initial base preparation has a five-minute allowance, with one additional minute held for final protected-base cleanup. Each supplied control reserves eleven minutes for its setup, check and cleanup. These are maximum admission allowances; phase records replace active reservations with elapsed time. Judge preparation and inspection share the frozen judge allowance, with one additional minute each reserved for judge evidence sealing and cleanup. Judge time/calls remain reserved until assessment starts, then actual elapsed time and calls replace those reservations. The controller admits a slot only when remaining time and calls cover its full required operation, then preserves unrun slots when the budget cannot cover another. Cancellation stops model work and retains an applicable partial candidate; bounded sealing/cleanup can finish after cancellation. `--max-new-slots` freezes an optional positive slot limit per dispatch. No time or call reservation is spent by planning.

The previous five-arm, 40-slot study used the protected repository entry `.sandcastle/benchmark.mjs`. Its v3–v5 evidence remains historical. The older fixed and adaptive APIs retain their original selection, account, grading and held-out rules. The [one-ticket three-model pilot](proofs/issue-31-three-model-pilot/findings.md) used its original three arms and validates that historical command on that task only; it establishes no four-Astra result, model ranking or subscription savings. Historical byte-bound manifests, receipts and exports remain unchanged.

The original adaptive protocol below remains available to hosts that supply its own protected entry.

The original adaptive benchmark is a project API. A host entry supplies the task, grader, required reviews, acceptance functions, actual worker model catalog, account readings and installed package identity. Use the [bounded benchmark API](workflow.md#bounded-benchmark) to bind those functions. The four historical base and reference commits are in `benchmarkFixtures`; do not replace them after seeing outcomes. A protected grader and the reference patch stay outside each agent worktree. Exporting and preflighting these real fixtures starts the original pilot's four-hour clock, so the deterministic tests in this repository do not do that work.

Before inference, complete [the benchmark manifest template](benchmark-manifest.template.json) in protected host state with the exact installed release, worker CLI and image, account, prompts, tools, cache and role configurations. Replace every `null` and fill the maps with the applicable hashes and measurements. Use `sha256sum <completed-manifest.json>` to obtain the `conditionsHash` passed to every evaluation; retain the file beside the host ledger. Run the six-call measurement exercise within 15 active minutes, under the same pilot budget and account baseline. After calibration, use `withBenchmarkActivity()` around host preflight, preparation, report and cleanup work so their active time is charged to the shared four-hour budget. `benchmarkSlots` gives the declared order. For each slot, start a fresh answer-free worktree and session, then call `runBenchmarkEvaluation()` once with its slot ID. The operation uses the installed durable controller and writes the attempt to the host-only `benchmark.json`. A stopped or incomplete attempt remains counted; inspect its checkpoint and budget before an explicit recovery. Do not substitute an unrun slot or reset its allowance.

After 28 fixed development evaluations, call `freezeBenchmarkPair()`. A returned `null` keeps Sol High fixed. A returned pair fixes the start, fallback and independent-failure rule before any held-out result is exposed. Run the remaining declared slots sequentially on an otherwise quiet account. The protected first-iteration check may authorize one second implementation call only for an actionable implementation defect; the other failure classes stop without escalation. Call `assessBenchmarkPromotion()` after all 64 slots. `admitted` supports `admitBenchmarkPolicy()` for the tested independently gradable task classes and the separate owner policy decision; `fixed-policy` leaves Sol High in place. `readBenchmark()` gives the JSON ledger for the later browser report. Do not treat an unchanged coarse account percentage as zero cost, or a synthetic pass as measured model savings.

## Review the routing decision

**Retain fixed Sol High.** The [seventh pilot](proofs/issue-26-v7-report/findings.md) attempted one development slot, which remained incomplete after specification review. Its other 63 slots are unrun. There is no qualified development pair, held-out comparison or attributable subscription-savings result. The [separate fixed study's v3 run](proofs/issue-31-v3-report/findings.md) stopped after nine development slots: six accepted, two failed, one incomplete and 31 unrun. Its credit comparison cannot replace the original adaptive protocol's subscription evidence. Neither study authorizes a project policy change.

To check the retained adaptive evidence without modifying it, run this from the Sandcastle source checkout:

```sh
pnpm exec tsx --eval 'import { admitBenchmarkPolicy } from "./src/index.ts"; import { resolve } from "node:path"; admitBenchmarkPolicy(resolve("docs/proofs/issue-26-v7-report"), "issue26-seven-arm-v7", "independently-gradable-regression").then(console.log, error => { console.error(error.message); process.exitCode = 1; });'
```

The expected result is exit code 1 and `Benchmark evidence does not admit this task class`. Leave the project's current policy, required roles, acceptance contract and unfinished runs in place. Preserve the original reports and recovery ownership. Unused evaluations do not authorize tuning, replacement cases or another pilot.

For a future qualifying study, the source admission checks bind the development selection and held-out assessment to their recorded inputs. The receipt contains `version`, `policyId`, `policyHash`, `protocolHash`, `conditionsHash`, `evidenceHash`, `taskClass` and the frozen `pair`. Changed evidence, missing role costs, unknown acceptance or an unsupported task class denies admission. Older assessment flags without these bindings cannot be upgraded by adding hashes after held-out exposure. These stricter checks are in the source candidate for issue #27; the published `v0.12.0-dv8.23.0` archive is unchanged.

A receipt is evidence for a separate explicit owner request naming one project, the policy version/hash and the tested task classes. Before any activation, match its conditions hash to the exact artifact/configuration/acceptance manifest and verify the selected project's required roles and contract. Record the receipt in the new run's project-owned policy/runtime identity. Activation applies only to new runs through a separately verified project binding. There is no live adaptive activation from this incomplete evidence. Existing unfinished runs keep their original runtime, policy, sessions and spent allowances; migration needs a separate tested request. Weakly gradable, unfamiliar, security-sensitive, architectural and visual tasks retain the project-selected fixed assessment.

The [capability evidence index](workflow-evidence.md) distinguishes these deterministic checks from live recovery, measured savings and policy activation.

## Open and interpret the benchmark report

After the pilot's measurement step has created its shared budget, set `PILOT` to its protected absolute host directory, `POLICY_ID` to the frozen policy identity, and `MANIFEST` to the completed manifest whose exact bytes supplied `conditionsHash`. Keep the output outside candidate worktrees. Generate the report with the installed package's command:

```sh
sandcastle benchmark-report --directory "$PILOT" --policy-id "$POLICY_ID" --manifest "$MANIFEST" --output "$PILOT/report"
xdg-open "$PILOT/report/report.html"
```

The command reads `benchmark.json`, the shared `budget.json` and the manifest. It rejects a changed manifest hash or policy identity; before the first recorded evaluation, it labels a supplied manifest as unverified because no host conditions hash exists yet. Its five-minute active-time reservation uses the same four-hour pilot budget; the controller records actual report time after generation. If less than five minutes remain, report generation blocks until the owner resolves the budget. It makes no model call. The HTML opens as a local file without a web server, including after the pilot stops early. The report shows the ledger's frozen pair and recorded promotion result; when there is no assessment or the result is inconclusive, keep fixed Sol High. This display does not activate a policy or approve a project candidate.

Start with the development and held-out comparison table. Its denominator is every scheduled slot, so an unrun evaluation does not look successful. Each bar counts accepted outcomes; the text separates technical checks and first-iteration success. The usage table gives lower and upper percentage-point intervals for each account window and labels partial coverage. An unchanged coarse reading, a missing interval, an overlapping token counter or a reset remains uncertain. Open an evaluation row for its fixture commits, requested and effective configuration, session lineage, protected preflight, account readings, token sources, review and failure reason. Human waiting is shown as not measured because the benchmark ledger has no wait-duration field; do not subtract it from active time or infer savings from it.

Keep `report.html`, `report.json` and `evaluations.csv` together. The HTML links to both exports. JSON retains the source ledger, pilot budget, manifest, ledger hash and the rows used by the CSV. CSV has one row per scheduled slot and declared account window, including explicit `unrun` rows, incomplete evaluations and unknown values. It prefixes a leading spreadsheet formula character in a text field with an apostrophe; JSON keeps the original value. Inspect `report.json` if a source field is missing from a table; an empty CSV value means unknown, not zero. A report generated before all slots finish remains a partial report. Re-run the command after the source changes to capture a new snapshot; use the ledger hash to identify which source bytes produced a copy.

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

The per-project installation record, prior release archive and update journal remain on the host after rollout. If a root fails during apply, inspect its journal and use `node "$SCRIPT" rollback --root "$PROJECT"` only when the selected-project owner confirms the retained bytes. A concurrent edit blocks rollback. `verify --root "$PROJECT" --adapter "$PROJECT/.sandcastle/update-owner.mjs"` checks the actual host and worker package again. Installation verification does not establish controller, browser, native or human-response readiness. The earlier `r2` release cannot be registered through this path. The [two-release disposable proof](proofs/issue-25-compatible-updates.md) covers `v0.12.0-dv8.21.0` to `v0.12.0-dv8.22.0`, including deferred work, rollback and partial rollout; the older live library, web and native receipts do not certify the new runtime bytes.

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
| Benchmark report says manifest changed      | Use the exact completed manifest whose bytes supplied `conditionsHash`; do not reformat or reconstruct it.                                                                |
| Benchmark report shows unknown usage        | Open the affected evaluation and inspect account readings, reset continuity, token coverage and source paths. Do not replace unknown with zero.                           |
| Benchmark report command exceeds budget     | Keep the partial ledger. The owner must resolve the remaining pilot allowance before another metered report run.                                                          |
| Integration says recovery required          | Inspect the target's actual Git effect under its lock. Do not repeat the merge on an uncertain result.                                                                    |
| Integration check cannot reproduce evidence | Keep the frozen evidence and blocked intent. Make the project check output stable before a new authorized run; do not edit the recorded answer or state to force a merge. |
