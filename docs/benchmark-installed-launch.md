# Launch from an installed consumer

Install a candidate archive into a separate consumer before relying on its
benchmark commands. The source build and package version cannot prove what
that consumer can launch. No public release is needed for this check.

```sh
# In the Sandcastle checkout. Keep the archive outside the checkout.
pnpm run build
pnpm pack --out /absolute/path/to/candidate.tgz

# In the unrelated consumer, with its own package.json.
pnpm add --ignore-scripts /absolute/path/to/candidate.tgz
pnpm exec sandcastle --help
pnpm exec sandcastle benchmark --help
pnpm exec sandcastle benchmark-status --help
pnpm exec sandcastle benchmark-cancel --help
pnpm exec sandcastle benchmark-resume --help
pnpm exec sandcastle benchmark-report --help
```

Inspect `node_modules/@ai-hero/sandcastle/package.json`: its `bin.sandcastle`
must resolve to an existing `dist/main.js`. Inspect the actual project scripts
and files as well. A project script referring to an absent entry file is a
launch blocker even when the installed CLI has the right commands. Keep this
installation unchanged until its runs settle; resume verifies the frozen
installed runner bytes.

## Select the project and instructions

From the consumer, select any Git project explicitly. Local task and contract
paths resolve against that project's root. `--base` freezes the starting commit.

```sh
pnpm exec sandcastle benchmark --project /absolute/project --base <commit> --ticket tasks/example.md --dry-run
pnpm exec sandcastle benchmark --project /absolute/project --base <commit> --repository owner/repo --ticket 7 --dry-run
pnpm exec sandcastle benchmark --project /absolute/project --base <commit> --prompt 'Exact task instructions' --dry-run
pnpm exec sandcastle benchmark --project /absolute/project --base <commit> --ticket missing.md --prompt 'Explicit fallback instructions' --dry-run
```

Issue URLs must match the selected repository. Resolution freezes the issue,
comments and dependencies. Open or unresolved prerequisites block readiness.
A confirmed missing issue can use an explicit fallback; access and network
errors cannot. No task or prompt means no launch, and no backlog task is
selected automatically.

The default implementation arms are Astra `medium`, `high`, `xhigh` and `max`.
The independent judge defaults to `gpt-6.1-sol:xhigh`. Change either separately:

```sh
pnpm exec sandcastle benchmark --project /absolute/project --ticket tasks/example.md --arm gpt-6.1-sol:high --arm gpt-6-luna:max --judge gpt-6-astra:high --dry-run
```

All arms share the frozen base, task instructions, governing instructions,
checks and rubric. Requested models and efforts must be present in the actual
worker catalog, including hidden entries. `ExtraHigh` normalizes to `xhigh`;
other valid efforts remain catalog strings.

## Establish readiness, then launch within an allowance

The host needs Git, Node.js, pnpm, Docker and an existing worker image. The worker
needs Codex with subscription authentication, available usage, the requested
implementation and judge capabilities, and the launch contract's tools. GitHub
inputs also need authenticated host `gh` access. Check free bytes and inodes.
The controller does not build or pull the worker image automatically.

Declare project-owned checks, allowed edits, readiness probes, prerequisites
and rubric in a version 1 launch contract. Runtime tasks also need a tracked,
self-contained adapter module and any required frozen references. See the
[adapter contract and reference fixtures](benchmark-project-adapters.md).

The Chromium reference requires Linux user systemd, Node.js 22 or newer,
Chromium/Chrome and curl. The native reference requires Linux x86_64, KVM,
the Android SDK's API 35 x86_64 image and build tools 35.0.0, Java, host GPU
access and a free private device lane. Set `adapter.config.sdk` to the owning
SDK. These references demonstrate specific supported profiles; other projects
own their build rules, services, network policy and adapters.

```sh
pnpm exec sandcastle benchmark --project /absolute/project --base <commit> --ticket tasks/example.md --contract launch.json --image project-worker --prepare 'pnpm install --frozen-lockfile' --check 'pnpm run typecheck' --max-minutes 60 --max-new-slots 1 --preflight
```

Preflight observes the actual worker without inference and prints readiness
and blockers. Scheduling with `--dry-run` cannot certify worker readiness.
A required runtime without its frozen adapter remains blocked. After readiness
passes, an operator can explicitly launch the supplied task by removing
`--preflight` and adding `--output /absolute/empty-evidence`.

Worker readiness includes a real Codex read-only sandbox probe: it must read a
canary and deny an attempted write without changing its bytes. The frozen Docker
profile uses `seccomp=unconfined` and `label=disable` to permit Bubblewrap inside
the nonroot worker. The preflight and execution use the same profile. On the
tested SELinux host, seccomp alone allowed namespace creation but still blocked
the private devpts mount. A completed activation turn also needs the successful
shell-command receipt before task work can start, including after resume.

New runs have no individual implementation deadline by default. Omit
`implementationMinutes` or set it to `null` to let each worker use the remaining
`--max-minutes` budget, excluding reserves for candidate sealing, protected
checks, judging and cleanup. The worker receives the effective UTC deadline in
its task prompt. Earlier arms can consume the budget and leave later arms unrun;
this mode does not promise equal implementation time or a complete comparison.

To use an equal per-arm cap, set a positive integer `implementationMinutes`.
Calibrate that allowance against the selected ticket in a separate run before
freezing the comparison. Increasing only `--max-minutes` never overrides an
explicit implementation cap. Existing frozen manifests retain their deadlines;
changing this policy requires a new run, not a resume of the old one.

Every applicable rubric criterion requiring `check` evidence must list its
required `checkCases`. Define each case with a unique ID, a command, frozen
test files and its own `controls.knownBad` and `controls.knownGood` Git refs.
Admission blocks missing mappings and controls even when worker preflight passes.
The controller executes each case against both calibration commits before any
implementation or judge call. A broken reference must fail; a working reference
must pass. These controls consume the overall budget without model calls.

```json
{
  "version": 1,
  "checkCases": [
    {
      "id": "employee-csv",
      "command": "pnpm exec vitest run tests/acceptance/employee-csv.test.ts",
      "files": ["tests/acceptance/employee-csv.test.ts"],
      "controls": {
        "knownBad": "csv-broken-reference",
        "knownGood": "employee-working-reference"
      }
    }
  ],
  "rubric": [
    {
      "id": "csv",
      "requirement": "Employee CSV imports preserve valid records and reject invalid rows",
      "weight": 1,
      "partialCredit": 0.5,
      "applicability": "always",
      "evidence": ["code", "check"],
      "checkCases": ["employee-csv"]
    }
  ]
}
```

The project owns the criterion-to-case mapping and the assertions. Choose a
targeted broken implementation for each behavior, not an unrelated regression.
List every grading dependency in case `files` or `protectedFiles`. A case
command must reject skipped, deselected or zero executed acceptance tests.
Database tests must
run against an owned disposable database and fail readiness when it is absent;
a skipped PostgreSQL suite does not prove transaction correctness. Candidate-added
tests are excluded from the protected checker, so freeze independent acceptance
tests in the base before launching.

The controller runs the generic `--check` and each applicable case separately
within `checksMinutes`, retaining candidate-bound commands, exit codes and
hashed logs. Judges must cite every required `check-case:<id>` receipt for a
criterion. A generic `configured-check` citation or another criterion's case
cannot supply that coverage. Failed cases remain evidence for negative findings
and fail mandatory checks; missing receipts leave the criterion unassessed.
Declare code-only criteria explicitly when runtime evidence is not required.
The generated default rubric requires check evidence and remains blocked until
an explicit contract supplies mappings. Global `controls` still calibrate the
generic check and do not replace case controls.

Historical reports and sealed candidates retain their original protocol.
Changing tests or rubric mappings requires a new evaluation identity; upgrading
the runner or resuming a completed run cannot repair its historical grades.

`--max-minutes` bounds the whole run, including setup, checks, judging and
cleanup. Admission reserves the verification phases and any explicit implementation cap,
so an allowance smaller than those reservations can leave every slot unrun. `--max-new-slots` limits dispatch,
not the frozen comparison denominator. The contract can bound implementation
and judge minutes, independent `checksMinutes` (default five minutes), and total
calls. A safely sealed timed-out candidate still runs the protected check within
its reserved check allowance and can be judged; its implementation remains
timed out. Cancellation skips further checks. A real benchmark needs a supplied task and
an explicit bounded allowance; the fixture proofs below do not launch one.

## Observe and recover through the installed command

An active Luna chat can read the saved status and summarize phase, counts,
usage coverage and blockers. Save both the run ID and returned cursor:

```sh
pnpm exec sandcastle benchmark-status --directory /absolute/evidence
pnpm exec sandcastle benchmark-status --directory /absolute/evidence --after 42 --watch
pnpm exec sandcastle benchmark-cancel --directory /absolute/evidence --reason 'Operator stop'
pnpm exec sandcastle benchmark-resume --directory /absolute/evidence --max-new-slots 1
```

Disconnecting the observer stops observation only. Reconnect using the last
cursor, drain pages while `hasMore` is true, and keep the cursor with its run ID.
Closing a chat does not promise notifications or stop the controller. The
observer cannot change worker instructions. Use cancellation explicitly when
the run should stop.

Status distinguishes `wallClockRemainingMs` from `reservedMs`; `remainingMs` is
the allowance still available for admission after those reservations. Each
attempt exposes a `scoreLabel` and `failures`. A terminal missing grade is
"Score unavailable", active grading is "Score pending", and an assessed zero
is "Score 0%". Implementation, check and judge failures remain visible together.
Activity events store compact deltas; periodic checkpoints share immutable
candidate inventories under `progress-inputs/`. Keep that directory with the
journal for cursor replay and recovery.

Recovery verifies the unchanged manifest/runner, remaining time/calls and the
recorded owner before dispatch. Completed implementations are not replayed.
Failed cleanup remains a failure with owned resources retained; stop and verify
those exact resources before retrying recovery. An explicit implementation retry
or rejudge consumes remaining allowance and retains its original record.
See [detailed recovery rules](workflow-user-guide.md#observe-cancel-and-resume-a-benchmark).

## Read the result and preserve its evidence

The ordinary launch writes a self-contained `report.html`, `report.json` and
`evaluations.csv`. Open the HTML directly or regenerate passively:

```sh
pnpm exec sandcastle benchmark-report --directory /absolute/evidence --output /absolute/report
xdg-open /absolute/report/report.html
```

The graph shows judge-derived specification adherence for each implementation
arm. A check failure remains separate from a positive score. Missing costs,
grades and usage remain explicit. Freeze dated model-specific rates for both
implementation and judge. API-equivalent dollars and Codex Standard credits are
estimates, not subscription spending. Observer and other grading costs remain
separate; failed/interrupted calls still contribute recorded usage. See
[cost assumptions and judge interpretation](benchmark-reports.md).

Follow the canonical [post-run inspection guide](benchmark-reports.md#locate-generated-code-and-evidence)
for the artifact map, exact original/retry paths and each candidate's five
task-specific inspection actions. The percentage remains the weighted judge
score; the human guide records no sign-off.

Judgment, rendering and fixture success grant no project or human acceptance.
Task-specific reviews, frozen visual references, human approval and baseline
promotion remain the selected project's gates.

Keep the evidence at its frozen location. Candidate worktrees under `candidates/`
are retained evidence needed for current assessment verification. Remove only
verified disposable worker installations, runtime/device data and source
fixtures after their owned processes stop and compact proof is sealed. A
cleanup failure is actionable, not permission to delete the directory. Retain
`progress-inputs/` as part of the journal's evidence. Preserve
existing historical pilots and byte-bound receipts without reformatting them.

## Reproduce installed-path fixture proof

After building the stable candidate, run the repository's focused proof:

Choose an empty output directory outside any pnpm workspace. The proof creates
its temporary consumer there; pnpm otherwise inherits the surrounding
workspace's configuration and lockfile.
The install uses pnpm's offline cache. If a dependency tarball is missing, fill
that cache from a disposable consumer outside the workspace before rerunning;
the proof stops before benchmark execution in this case.

```sh
pnpm exec node scripts/prove-installed-benchmark.mjs /absolute/empty-proof
pnpm exec node scripts/prove-installed-benchmark.mjs /absolute/another-empty-proof both
pnpm exec node scripts/prove-offline-benchmark-report.mjs /absolute/empty-proof/report.html /absolute/offline-proof
```

The first command packs and installs the real archive in an unrelated consumer.
It proves local/GitHub/prompt/fallback routes, defaults and overrides, isolation,
protected checks, direct code judging, observer reconnection, cancellation,
failed-stop recovery, usage retention and model-free report regeneration.
`both` also launches the packaged browser and headless Android reference
projects through the installed CLI. Use `browser` or `android` for one profile.
The offline proof opens only the HTML with external requests blocked, checks
wide/narrow layout and keyboard/accessibility behavior, and verifies downloaded
JSON/CSV against embedded data.

GitHub and Docker/Codex responses use deterministic external fixtures; runtime
adapters run actual owned applications. Reports disclose fixture instructions,
synthetic rates and judgments. These are orchestration proofs, not model
performance measurements or official prices. No live model call, public
publication or Renovio pilot runs. Successful proofs seal compact evidence and
remove disposable consumers, archives, tools, source projects and verified
runtime data. Failures retain their directory and ownership evidence for
inspection. Do not delete it while an owned process or resource remains active.

The [issue 52 proof record](proofs/issue-52-installed-benchmark.md) records the
installed candidate, final checks, real runtime observations, offline browser
downloads and verified removal receipts.
