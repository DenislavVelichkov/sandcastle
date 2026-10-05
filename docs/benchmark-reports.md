# Read and regenerate implementation benchmark reports

`sandcastle benchmark` writes `report.html`, `report.json` and `evaluations.csv`
from its retained version-two manifest, execution ledger and judge assessments.
Open the HTML directly as a local file. It embeds its data, interactions and
downloads, so it also works when copied without adjacent JSON or CSV files.
There are no external fonts, chart libraries or services.

The [installed launch guide](benchmark-installed-launch.md) connects package
verification, task selection, observer recovery and report opening. Its focused
offline proof opens an isolated HTML file, exercises keyboard controls and
verifies browser downloads against the embedded JSON/CSV.

Regenerate through the same report entry without starting an implementation,
judge, browser or native runtime:

```sh
sandcastle benchmark-report --directory /absolute/path/to/evidence --output /absolute/path/to/report
xdg-open /absolute/path/to/report/report.html
```

The public `writeBenchmarkReport({ directory, outputDirectory })` API performs
the same operation. Keep the original evidence directory at its frozen path.
Reports verify assessment applicability through `readBenchmarkAssessments`.
Missing or changed candidate, assessment, stream, session, runtime or cited
evidence prevents a grade from being displayed as current. A changed manifest
or ledger during generation rejects the snapshot. Regeneration leaves these
inputs unchanged and produces identical exports for unchanged inputs and
generator bytes. Inspect a settled snapshot when the controller is still active.

Historical pilots retain their existing protocol and report behavior. Their
`benchmark-report` invocation still requires `--policy-id` and uses its existing
pilot activity budget. An optional `--manifest` binds the historical host
conditions. Those reports cannot supply fresh judge scores or new Astra results.

## Interpret the report

The main graph plots implementation model/effort arms against their recorded
judge-derived specification adherence. The judge is evaluation metadata. Choose
one frozen task at a time; different tasks are not a shared model-quality scale.
Hover, click or focus a point to inspect its candidate, rubric, sample count,
coverage, verdicts, concise observations and explanations, evidence links,
configured checks, duration, cost basis and assumptions. Left and right arrow
keys move between points. The evidence section offers the same information
without the graph. Links open retained local code/check/visual artifacts.

Switch between API-equivalent dollars and Codex Standard token-derived credits,
and between implementation-only and implementation-plus-judge costs. The latter
includes all recorded judging for that candidate and is the full required
evaluation cost. Range markers use a midpoint with horizontal bounds, not a
claim of exact spending. Partial assessments use hollow points, disclose their
assessed rubric weight and show their whole-rubric score range. Missing grades,
stale assessments and unavailable costs produce explicit unplotted rows.

Comparisons preserve the controller's closest-to-spec, tie and inconclusive
outcomes. Every original scheduled candidate needs a current complete assessment
under the frozen protocol for a conclusive comparison. A linked retry is not a
new independent repetition. A single task/arm attempt is not a general ranking.

The planned denominator is the number of original slots. Attempted counts slots
with an attempt record; completed counts original implementations returning an
exit code, including failures; graded counts current complete original
assessments. Blocked outcomes also remain incomplete. Unrun slots have no attempt.
These categories can overlap. Configured-check failures and project/human
acceptance are separate from scores. Neither a positive grade nor a passing
check satisfies required project reviews or human approval.

Duration tables retain implementation and judge phase timings. End-to-end measures elapsed time from attempt start through recorded settlement
after judging and owned cleanup. Older ledgers without a settlement timestamp
show unknown end-to-end duration and retain measured phase totals separately.
Waiting duration is not separately measured. The execution budget retains overall
elapsed time and reservations separately.

## Freeze model-specific rates at launch

The report never looks up new rates or rewrites a saved rate card. Add a
`rateCard` to the launch contract before freezing the run. Include separately
verified rates for every implementation model and the selected judge. Retrieve
the appropriate dated [API prices](https://developers.openai.com/api/docs/pricing)
and [Codex token rates](https://learn.chatgpt.com/docs/pricing#token-rates) for the
frozen Standard service tier. Missing, malformed, undated or incompatible rates
produce unavailable estimates for the affected model or unit.

The supported input shape is below. **Every price in this example is synthetic
test data. Replace it with verified model-specific rates and a real source.**

```json
{
  "rateCard": {
    "source": "Synthetic accounting example, not official prices",
    "date": "2026-10-05",
    "inputs": {
      "version": 1,
      "serviceTier": "default",
      "unit": "per-million-tokens",
      "models": {
        "gpt-6-astra": {
          "api": [
            {
              "upToInputTokens": 272000,
              "input": 10,
              "cachedInput": 1,
              "cacheWriteInput": 12.5,
              "output": 50
            },
            {
              "upToInputTokens": null,
              "input": 20,
              "cachedInput": 2,
              "cacheWriteInput": 25,
              "output": 75
            }
          ],
          "codexStandard": { "input": 250, "cachedInput": 25, "output": 1250 }
        },
        "gpt-6.1-sol": {
          "api": [
            {
              "upToInputTokens": null,
              "input": 2,
              "cachedInput": 0.2,
              "cacheWriteInput": 2.5,
              "output": 8
            }
          ],
          "codexStandard": { "input": 50, "cachedInput": 5, "output": 200 }
        }
      }
    }
  }
}
```

API bands have ascending inclusive request-input bounds and finish with an
unbounded `null` band. Each model may provide API rates, Codex Standard rates,
or both. All rates are nonnegative per million tokens. `default` identifies the
controller's frozen Standard service tier.

The calculation validates the retained raw Codex stream against its recorded
hash and normalized counters. Normalized input already excludes cached tokens;
the report does not subtract them again. Output already includes reasoning.
For API valuation, a retained raw `cache_creation_input_tokens` dimension
replaces ordinary-input pricing for those tokens. Codex Standard credits charge
that input without a separate cache-write fee. Codex's normalized zero cache
creation counter alone does not establish that API-equivalent writes were zero.

When cache-write dimensions are absent, the API range spans no writes through
all uncached input as writes. Per-request context bands cannot be inferred from
an accumulated turn token total, so the range spans every frozen band. These
assumptions appear beside each estimate. Unknown observed identity uses the
frozen requested model/tier only as a disclosed assumption. Multiple observed
models or an incompatible tier make that valuation unavailable. Unknown or
conflicting counters and unreconciled turn totals are unavailable rather than
zero.

Study totals include all implementation attempts and retained judge calls,
including failed, interrupted and explicitly repeated work. Unknown calls or
costs prevent a complete total; the known recorded portion remains visible.
Other model review/grading and observer usage are separate unknowns outside this
ledger. Token-derived credits are not subscription consumption, and
API-equivalent dollars are not an actual bill.

## Retain the exports

JSON preserves the frozen plan, execution records, assessments, applicability
decisions, raw usage, valuation inputs, assumptions and report rows. Manifest,
ledger, candidate, assessment, grader protocol, rate-card and generator identities
bind the snapshot. CSV repeats the manifest, ledger, grader and generator
bindings on every scheduled slot and linked retry, with explicit states and
empty unknown values. It quotes text and protects leading
spreadsheet formula characters. JSON retains the original text. Embedded
downloads contain the same evidence as the generated files.
