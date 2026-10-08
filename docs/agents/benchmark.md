# Benchmark and native proof guidance

## Installed-run readiness

- Verify the consumer's installed CLI commands and actual entrypoint files before claiming benchmark readiness. A release number, package script, or guide can refer to commands absent from that installation.
- For installed-run applicability, compare package metadata against pnpm's packed `package.json`, which can differ from the source file.
- Keep installed fixture proof output outside any pnpm workspace. Its temporary consumer inherits the nearest workspace configuration and lockfile otherwise, so an output under the repository's `artifacts/` is unsuitable.
- Benchmark guides and ADRs must describe the delivered runtime adapter and current readiness blockers; completed ticket numbers are not permanent missing-runtime gates.
- If full-suite validation hits benchmark/CLI timeouts or cleanup `ENOTEMPTY` under default file parallelism, check the failing cases in isolation and rerun the full suite with `pnpm test --maxWorkers=2` before changing runtime behavior.
- Verify actual Codex sandbox reading and denied writing, not just a completed model turn. The tested SELinux Docker host needs the frozen `seccomp=unconfined`, `label=disable` profile for Bubblewrap namespaces and devpts; use the same options for preflight and execution.

Use the [installed consumer guide](../benchmark-installed-launch.md) for readiness checks and launch/recovery commands.

## Frozen benchmark inputs

- Codex model IDs can contain dots, such as `gpt-6.1-sol`; retain dotted identifiers in benchmark arm validation.
- Benchmark reasoning efforts are open-ended worker catalog strings. Validate capabilities against model/list, including hidden entries, instead of a fixed effort allowlist.
- Use NUL-separated Git path discovery for frozen benchmark inputs; line-oriented Git output quotes Unicode filenames and can silently omit protected checks.
- **CRITICAL**: Fixed benchmark task scopes must include `.changeset`; historical candidates follow this repository's changeset rule, and a `src`-only scope rejects them after reviews.
- Freeze visual applicability per selected benchmark task; a scoped visual criterion must not waive another task's nonvisual requirements.
- New contracts default to no individual implementation cap; earlier arms can consume the overall budget. Frozen numeric caps remain binding, so change the contract and launch a fresh run to remove them. When equal time is required, calibrate a common implementation allowance for the selected ticket before comparison. Prove known-bad and known-good protected-check controls; reserve checks separately and preserve a timed-out implementation status when checking its safely sealed partial candidate.

## Evidence, reporting and accounting

- **CRITICAL**: Native proof receipts and applicability records are bound by byte hashes. Preserve exported evidence JSON exactly; formatting changes invalidate their recorded hashes.
- Implementation `finishedAt` precedes independent judging and cleanup. Report end-to-end duration from retained `settledAt`; older ledgers without it must remain unknown.
- Interrupted-source recovery can seal under `candidates/<attempt-id>-recovered-<UUID>/` without creating a retry. Inspection must use the exact retained worktree and patch paths rather than reconstructing them from the slot ID.
- Generate final benchmark exports after the terminal controller snapshot is persisted and before releasing its ownership lock; closing progress changes the ledger hash.
- Never regenerate reports inside retained candidate worktrees or evidence subdirectories. The report API must reject these destinations and export aliases before writes; fixed export filenames alone do not preserve sealed source. Create temporary exports exclusively so a pre-existing symlink cannot redirect the write.
- In-flight benchmark activities reserve their maximum time in `budget.json`; the ledger replaces that reservation with elapsed time when the activity finishes.
- Retain `progress-inputs/` with the event journal. Its immutable candidate inventories are shared by compact checkpoints and are required for recovery.
- Missing terminal scores are unavailable, active grading is pending, and an assessed zero is a valid score. Show implementation, check and judge failures together and distinguish wall-clock time from reserved admission allowance.

Use the [benchmark report guide](../benchmark-reports.md) for result interpretation.

## Issue #26 historical pilots

- **CRITICAL**: Issue #26's protected historical grader must commit its isolated shadow before focused tests that exercise Git worktrees; an archive without `.git` makes known corrections fail preflight.
- **CRITICAL**: Historical grading may replace worker-installed `node_modules` when pnpm store paths differ. Permit the noninteractive purge during the grader install or it aborts before protected tests.
- **CRITICAL**: Issue #26's frozen worker configuration must come from a private snapshot. The live Codex configuration can change during calibration; a runtime-identity mismatch must stop that attempt before preflight.
- **CRITICAL**: Issue #26's review prompts must include the exact task instructions. A reviewer asked to verify requirements without them can reject calibration even when the candidate is correct.
- **CRITICAL**: Issue #26's pilot may stop on a failed required review before using its second permitted implementation iteration. Retain that slot as incomplete; do not infer that another iteration ran or replace the frozen case.

Read the [bounded pilot record](../proofs/issue-26-bounded-pilot.md) for the retained attempts and their dispositions.

## Browser and Android runtime adapters

- Linux Unix sockets have short pathname limits. Bind benchmark inspection sockets through a directory descriptor and connect from their parent directory with a relative socket path.
- Android Emulator can fall back to legacy guest networking when a private netsim transport is unavailable. Verify the fixture's required network state rather than inferring isolation from netsim launch flags.
- Android radio preferences can retain enabled values in airplane mode, and its transition can restore Wi-Fi. Apply the offline policy after cellular radio-off and verify the live services.

Use the [project adapter guide](../benchmark-project-adapters.md) for the adapter API, resource ownership and fixture requirements.
