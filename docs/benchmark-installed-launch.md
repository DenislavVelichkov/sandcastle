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

`--max-minutes` bounds the whole run, including setup, checks, judging and
cleanup. Admission reserves each phase's maximum, so an allowance smaller than
those reservations can leave every slot unrun. `--max-new-slots` limits dispatch,
not the frozen comparison denominator. The contract can bound implementation
and judge minutes and total calls. A real benchmark needs a supplied task and
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

Judgment, rendering and fixture success grant no project or human acceptance.
Task-specific reviews, frozen visual references, human approval and baseline
promotion remain the selected project's gates.

Keep the evidence at its frozen location. Candidate worktrees under `candidates/`
are retained evidence needed for current assessment verification. Remove only
verified disposable worker installations, runtime/device data and source
fixtures after their owned processes stop and compact proof is sealed. A
cleanup failure is actionable, not permission to delete the directory. Preserve
existing historical pilots and byte-bound receipts without reformatting them.

## Reproduce installed-path fixture proof

After building the stable candidate, run the repository's focused proof:

Choose an empty output directory outside any pnpm workspace. The proof creates
its temporary consumer there; pnpm otherwise inherits the surrounding
workspace's configuration and lockfile.

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
