# Workflow capability evidence

Issue #27 retains Sandcastle's existing fixed Sol High policy. No selected-project activation, live-state migration, benchmark extension or additional model invocation is part of this change. Other projects retain their own selected fixed policy. The [operating guide](workflow-user-guide.md#review-the-routing-decision) gives the read-only admission check and future activation requirements.

| Capability                                    | Evidence and disposition                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed controller recovery and owner decisions | [Issue #17](proofs/issue-17-live-attempt.md) records the tested Linux/Docker/Codex release, live session recovery and one integration. Those receipts retain their original artifact identities.                                                                                                                                 |
| Release distribution and browser isolation    | [Issue #18](proofs/issue-18-release-adoption.md) records the library and web consumers. It establishes no adaptive quality result.                                                                                                                                                                                               |
| Native diagnostic                             | [Issue #22](proofs/issue-22-native-isolation.md) records the three-profile diagnostic. Product acceptance and visual baseline promotion remain separate.                                                                                                                                                                         |
| Managed updates                               | [Issue #25](proofs/issue-25-compatible-updates.md) records the two-release update, deferral and rollback proof. Unfinished runs retain their runtime and policy.                                                                                                                                                                 |
| Actual adaptive policy admission              | Blocked. [Issue #26's seventh findings](proofs/issue-26-v7-report/findings.md), [HTML](proofs/issue-26-v7-report/report.html), [JSON](proofs/issue-26-v7-report/report.json) and [CSV](proofs/issue-26-v7-report/evaluations.csv) show one incomplete slot and 63 unrun slots. Fixed Sol High remains selected.                  |
| Later fixed comparison                        | Also incomplete. [Issue #31 v2 findings](proofs/issue-31-v2-report/findings.md), [HTML](proofs/issue-31-v2-report/report.html), [JSON](proofs/issue-31-v2-report/report.json) and [CSV](proofs/issue-31-v2-report/evaluations.csv) show an account reset during the first slot and 39 unrun slots. It supplies no adaptive pair. |
| Admission and route validation                | Deterministic source tests exercise qualifying synthetic evidence, fixed retention, changed evidence, both permitted task classes, required costs and the two-attempt rule. They establish no measured model savings or deployed adaptive policy.                                                                                |

## Evidence behind fixed retention

The retained adaptive policy identity is `issue26-seven-arm-v7`. Its manifest hash is `5851f4657c6a6964fed68afa23b9718303ddf384a0e6c60a7496b881fe927b43`; its ledger hash is `2dcf2d9f0f7da91e42d3a2437f13c324b6a70a55b04454b5d0a1eeecb7b211a4`. Calibration and all four historical preflights passed. The first candidate passed Standards review but failed specification review. The controller retained the slot as incomplete, including its unused second implementation allowance and recovery ownership.

The missing evidence is concrete: the other 27 fixed development evaluations, a qualified Sol High reference and development-selected pair, all 28 fixed held-out and eight adaptive evaluations, and comparable subscription observations with complete attributable costs. The unchanged coarse 42% account reading is not zero consumption. Shared-account activity confounds the comparison, and the interrupted calibration call's token cost is unknown. No 20% subscription savings, repetition consistency, held-out quality result or model ranking is established.

The separate fixed study uses policy `issue31-fixed-v2` and ledger hash `c4a29b8c6b93fbaa6336654f3bc29280b8cf34aaeb565d76b1ac35af76bc01dc`. Its reset-crossing account readings are incomparable. Its verified checkpoint stays attached to its original policy and remaining allowances. Fixed-study credit estimates cannot satisfy the adaptive subscription promotion rule.

The admission tests read both published ledgers directly, check their exact hashes, reject both independently gradable classes and verify the files remain unchanged. Original report bytes are preserved, including their historical limitations and row counts.

## Source verification

The public API fixtures are runnable without model calls:

```sh
pnpm exec vitest run src/benchmark.test.ts src/workflow.test.ts src/workflowGuard.test.ts src/workflowUsage.test.ts src/workflowControl.test.ts src/workflowStop.test.ts
```

`benchmark.test.ts` covers development freeze, complete ordered assessment, role/cost coverage, strict acceptance, conservative savings, rejection of changed conditions or evidence, unsupported classes, and deterministic receipt hashes. Its controller fixture replays the frozen start/fallback rule with ordinary session continuation and a diagnostic handoff when the first call returns no session. Each implementation call has one iteration; required review and implementation allowances remain charged. Environment failure, timeout, an unchanged source tree and absent independent findings stop after the first attempt.

`workflowGuard.test.ts`, `workflowUsage.test.ts`, `workflowControl.test.ts` and `workflowStop.test.ts` cover actual controller admission, missing capabilities, stale/denied account observations, policy/runtime/allowance changes on resume, retained rejection and waiting state, checkpoints and exhausted implementation calls. Required checks and review roles remain project-owned. `workflow.test.ts` verifies that the opt-in workflow rejects hidden structured-output retries and model overrides supplied through prompt options before dispatch. The ordinary public `run()` API is unchanged.

These are checks of the source candidate, starting at `0741b71983704b668b3fe8e193951cb6cd2c6966` on `codex/issue-31-fixed-benchmark`. They do not re-certify older released archives or activate a policy. A qualifying receipt and a separate project request would still require validation of the exact activation binding before new runs could use it.

Validation passed on September 26, 2026: `pnpm run typecheck`, `pnpm run build` followed by `pnpm test`, all 65 test files with 1,490 tests passed and two skipped, and formatting of the changed TypeScript and workflow documents. The guide's admission command returned its expected refusal. `/tmp` had exhausted its inodes, so checks used a fresh `TMPDIR` on the project disk. No benchmark evidence file changed.
