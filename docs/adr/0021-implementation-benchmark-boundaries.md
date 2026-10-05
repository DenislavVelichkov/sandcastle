---
status: accepted
---

# Separate implementation benchmarks from project acceptance

A reusable implementation benchmark compares one implementation invocation, frozen project checks, and a separate benchmark judge assessment across model/effort arms. The user selected this scope instead of a complete ticket workflow and later added a judge defaulting to GPT-6.1 Sol ExtraHigh, configurable through `--judge`. Persisted executable-check outcomes, judge-derived specification adherence, and project acceptance therefore remain separate; future consumers must not reinterpret a check pass or judge preference as an accepted ticket.

Sandcastle owns durable scheduling, progress, budgets, candidate isolation, and reporting. Project adapters own required browser/native environments, protected checks, evidence capture, and cleanup. Each arm gets its own worktree and writable runtime state. This boundary allows the same benchmark to support projects such as Renovio without embedding their emulator, service, or approval rules into the generic runner.

The judge directly inspects each candidate's worktree and required application visuals against the same frozen specification and rubric, with implementation model/effort concealed during individual grading. It records observations, cited evidence, requirement verdicts, and concise explanations in a fresh assessment context per candidate. The comparison maps grades back to arms afterward and displays the judge-derived specification adherence scores in the main cost-versus-score graph. Judging has its own captured usage and bounded allowance; its invocation does not add a permitted implementation iteration.

Cost reports retain raw usage and freeze the rate source and calculation basis. Codex Standard credit equivalents and API-equivalent dollar estimates are separate from actual subscription consumption. This preserves [ADR-0005](0005-usage-raw-tokens-no-percentage.md) and avoids assigning a billing meaning that the provider counters do not establish.

The trade-off is additional judging cost and time, a rubric-dependent adherence score, and explicit missing evidence, with project-specific adapter work when native checks are required. Freezing and calibrating the rubric makes these limits reviewable. Changing the judge, rubric, or outcome meanings later requires a new protocol identity for durable evidence, rather than rewriting historical reports.

The user confirmed this design in the [benchmark interview](../planning/astra-implementation-benchmark.md) on 2026-10-05 and explicitly added the judge requirement afterward. The implementation now provides durable control, independent judging, owned project runtimes and offline reports. The [installed-consumer proof](../proofs/issue-52-installed-benchmark.md) records validation through the packaged CLI and the separate project acceptance gates.
