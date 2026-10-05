**How to use this file**:
The role of this file is to describe common mistakes, critical rules (the correct syntax is `- **CRITICAL**:`<the_rule>) and confusion points that you might encounter as you work in this project. If you ever encounter something in the project that surprises you, please alert the user and keep track of it in this file to help prevent repetative behaviours and achieve better results.
---

Use `pnpm run typecheck` for type checking.
Codex model IDs can contain dots, such as `gpt-6.1-sol`; retain dotted identifiers in benchmark arm validation.
Verify the consumer's installed CLI commands and actual entrypoint files before claiming benchmark readiness. A release number, package script, or guide can refer to commands absent from that installation.
Benchmark guides and ADRs must describe the delivered runtime adapter and current readiness blockers; completed ticket numbers are not permanent missing-runtime gates.
For installed-run applicability, compare package metadata against pnpm's packed `package.json`, which can differ from the source file.
Use `pnpm` for installs, scripts, and package executables in this repository; keep its pnpm lockfiles and generated worker commands aligned.
Keep `@standard-schema/spec` as a direct dependency: exported `Output` types import it, and a fresh pnpm install does not expose the transitive copy to typecheck.
`AGENTS.md` links to `CLAUDE.md`; edits to this guidance appear under `CLAUDE.md` in Git.
Use NUL-separated Git path discovery for frozen benchmark inputs; line-oriented Git output quotes Unicode filenames and can silently omit protected checks.
Run the build before the full test suite, sequentially: the build clears `dist/`, which CLI tests execute.
If Vitest fails before collecting tests with `/tmp` `ENOSPC`, check inode availability and set `TMPDIR` to a fresh directory on the project disk. Preserve retained pilot directories.
Implementation `finishedAt` precedes independent judging and cleanup. Report end-to-end duration from retained `settledAt`; older ledgers without it must remain unknown.
Generate final benchmark exports after the terminal controller snapshot is persisted and before releasing its ownership lock; closing progress changes the ledger hash.

- **CRITICAL**: Native proof receipts and applicability records are bound by byte hashes. Preserve exported evidence JSON exactly; formatting changes invalidate their recorded hashes.
- **CRITICAL**: Issue #26's protected historical grader must commit its isolated shadow before focused tests that exercise Git worktrees; an archive without `.git` makes known corrections fail preflight.
- **CRITICAL**: Historical grading may replace worker-installed `node_modules` when pnpm store paths differ. Permit the noninteractive purge during the grader install or it aborts before protected tests.
- **CRITICAL**: Issue #26's frozen worker configuration must come from a private snapshot. The live Codex configuration can change during calibration; a runtime-identity mismatch must stop that attempt before preflight.
- **CRITICAL**: Issue #26's review prompts must include the exact task instructions. A reviewer asked to verify requirements without them can reject calibration even when the candidate is correct.
- **CRITICAL**: Issue #26's pilot may stop on a failed required review before using its second permitted implementation iteration. Retain that slot as incomplete; do not infer that another iteration ran or replace the frozen case.
- **CRITICAL**: Fixed benchmark task scopes must include `.changeset`; historical candidates follow this repository's changeset rule, and a `src`-only scope rejects them after reviews.
- In-flight benchmark activities reserve their maximum time in `budget.json`; the ledger replaces that reservation with elapsed time when the activity finishes.
- **CRITICAL**: Retaining large test environments after each ticket/issue completion are taking too much disk space. Cleanup what is not used and keep your test environment lean!

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `DenislavVelichkov/sandcastle`; external PRs are also a triage surface. For work on an existing issue, follow the progress and closure rules in `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Visual acceptance

A visual parity action exists only when the source requires a named production
surface to be compared against a visual reference, requires selecting and
freezing that reference for the later comparison, or links an existing manifest
that records either obligation. Only then create and validate an initiative
manifest before drafting implementation tickets or editing production code. UI
work without that comparison uses no manifest. See
`docs/agents/visual-acceptance.md`.

Benchmark reasoning efforts are open-ended worker catalog strings. Validate capabilities against model/list, including hidden entries, instead of a fixed effort allowlist.
Freeze visual applicability per selected benchmark task; a scoped visual criterion must not waive another task's nonvisual requirements.

Linux Unix sockets have short pathname limits. Bind benchmark inspection sockets through a directory descriptor and connect from their parent directory with a relative socket path.
Android Emulator can fall back to legacy guest networking when a private netsim transport is unavailable. Verify the fixture's required network state rather than inferring isolation from netsim launch flags.
Android radio preferences can retain enabled values in airplane mode, and its transition can restore Wi-Fi. Apply the offline policy after cellular radio-off and verify the live services.
