# Read and regenerate implementation benchmark reports

`sandcastle benchmark` writes `report.html`, `report.json` and `evaluations.csv`
from its retained version-two manifest, execution ledger and judge assessments.
Completion prints an opening command, browser URL, export paths, retained
candidate location and this post-run guide. Open the HTML directly as a local
file. It embeds its data, interactions and
downloads, so it also works when copied without adjacent JSON or CSV files.
There are no external fonts, chart libraries or services.
`benchmark-resume` prints the same opening guidance on stderr and preserves its
JSON result on stdout for callers that parse it.

Open the report from the chosen benchmark output directory:

```sh
xdg-open '/absolute/path/to/evidence/report.html'
```

On macOS use `open` with the same quoted path. On Windows use
`Start-Process -FilePath 'C:\path\to\evidence\report.html'` in PowerShell, or
open the printed browser URL. Paths containing spaces or shell characters need
quoting; completion supplies the platform's quoted command.

## Locate generated code and evidence

These locations are relative to the frozen benchmark output directory. The
report's candidate links supply the exact recorded paths and availability.

| Location                                     | What you'll find                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `report.html`                                | Interactive report that opens directly in a browser.                                         |
| `report.json`, `evaluations.csv`             | Detailed records, the five inspection actions, judge checklist counts and comparison data.   |
| `manifest.json`, `execution.json`            | Frozen tasks, instructions, rubric and execution/identity records.                           |
| `events.jsonl`, `progress-inputs/`           | Ordered progress checkpoints/deltas and immutable shared candidate inventories for replay.   |
| `candidates/<candidate-key>/worktree/`       | Generated source for the exact original attempt or linked retry.                             |
| `candidates/<candidate-key>/candidate.patch` | Binary-capable changes against the frozen starting commit.                                   |
| `assessments/<assessment-id>.json`           | Sealed judge findings and evidence citations.                                                |
| `<candidate-key>-check.log`                  | Configured check output, including failed checks.                                            |
| `visuals/<runtime-id>/`                      | Runtime captures, live-inspection records and evidence receipts when supplied by an adapter. |

For an original attempt, `<candidate-key>` is its slot ID, such as
`ticket-1-arm-1`. For a retry it is the exact attempt ID, such as
`ticket-1-arm-1-attempt-2`. `<assessment-id>` is the assessment's UUID, not the
candidate or slot ID. Rejudging retains the previous assessment and creates a
new assessment ID for the same candidate. The report shows slot, attempt,
candidate ID, commit, retry link and assessment ID; use those identities to
avoid inspecting another arm's work.
If recovery seals interrupted source before judging, the candidate key is
`<attempt-id>-recovered-<UUID>`; it is still the same attempt. Use its recorded
worktree and patch paths. Recovery does not create another independent sample
or invent a completed check log.

Worktree, patch, check-log and assessment navigation does not depend on whether
the judge cited that artifact. The generator checks added artifact links against
recorded bytes and bindings. Missing, changed and unrecorded artifacts have
explicit states without an available-file link. The original check result stays
visible separately from the log's present availability.
Availability describes the snapshot at report generation. Regenerate after
evidence changes; opening an existing HTML file does not revalidate the disk.

The [installed launch guide](benchmark-installed-launch.md) connects package
verification, task selection, observer recovery and report opening. Its focused
offline proof opens an isolated HTML file, exercises keyboard controls and
verifies browser downloads against the embedded JSON/CSV.

New report JSON uses version 2. Candidate `paths` fields contain an
`inventorySha256` reference; `candidateInventories` maps each hash to the shared
path array. CSV uses the same references, resolved through that JSON table.
The HTML embeds both exports and the inventories, so its downloads stay
self-contained. Older reports keep their original format.

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

Regenerated exports can live outside the evidence directory. Embedded data and
downloads work without adjacent files; code/check/visual links still point to
the original frozen evidence. Copying HTML alone does not copy those artifacts.
The report API rejects destinations inside `candidates/`, `assessments/`,
`visuals/`, `runtime/`, `protected/` or a retained candidate worktree, including
symlink aliases. It also rejects export paths that would overwrite retained
evidence and existing export symlinks or hard links. Temporary exports are
created exclusively before atomic replacement. This protection applies to both
CLI and public API calls.

Keep candidate worktrees, patches, assessments and runtime evidence at their
frozen location. Do not edit or reformat hash-bound evidence. Remove only
verified disposable resources after their owning controller stops them;
retained candidates and historical pilots are evidence, not disposable runtime
folders. Use a separate copy if you want to modify or execute generated code.

## Inspect each exact candidate

Open a graph point with click, focus, Enter or Space, or expand its row under
"Findings behind every result". Each exact model/effort/task candidate has five
numbered inspection actions:

1. Read the frozen task and full rubric. Follow its criterion links and inspect
   requirement text, weights, partial credit, applicability and required evidence.
2. Open the generated source worktree and patch. Inspect the cited code and line
   ranges against that task's code criteria, including surrounding behavior.
3. Read the log for the frozen configured check. Inspect failures against the
   linked check criteria; a positive judge score cannot override them.
4. Inspect applicable runtime captures, receipts and frozen visual references.
   A nonvisual task states that visuals are not required. Missing required
   runtime evidence stays pending. Embedded reference downloads preserve the
   frozen bytes; regeneration does not restart the application.
5. Read partial, unmet and pending findings, coverage and comparison limits.
   Make any human or project acceptance decision through the project's own gates.

The actions link the selected task's exact criteria and candidate artifacts.
Arms for that frozen task use the same criteria. Unrun candidates retain the
same guide and explicit unavailable evidence. Retries keep their own code and
evidence and contribute no additional independent sample.

This is an unsaved human inspection guide. It contains no human verdicts,
checkbox pass percentage or sign-off. Judge requirement status is separate.
Stale judge observations are labeled historical and cannot supply a current
score or checklist claim. Older evidence needs no human-review record.

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

Visible graph labels include the arm, judge percentage, exact attempt ID,
abbreviated commit, requirement status and coverage. Point details and the
accessible table retain full candidate/commit identities, original/retry sample
counts, and all met/partial/unmet/pending counts. Every scheduled or retry row
remains in the table, including its reason for being unplotted in the selected
task/cost view.

The selected percentage is **judge specification adherence**:
`100 × earned rubric weight / assessed applicable rubric weight`. A met verdict
earns full weight, a partial verdict earns its frozen partial-credit fraction,
and not met earns zero. Pending requirements do not enter that score denominator;
they remain in applicable weight for coverage and whole-rubric bounds.
Coverage is assessed weight divided by all applicable weight. Only frozen
task/protocol applicability excludes a requirement. Missing evidence never makes
one inapplicable. No assessed weight means an unavailable score.

Live status labels a terminal missing score "Score unavailable", active grading
"Score pending", and a valid assessed zero "Score 0%". Status retains separate
implementation, check and judge failures. A safely sealed timed-out partial
candidate can have a protected check and an assessment while its implementation
status stays timed out. The wall-clock allowance and reserved phase time remain
separate from the allowance available for admitting another slot.

For a synthetic example, one met requirement of weight 2 and one partial
requirement of weight 2 with a 0.25 partial-credit fraction yield 62.5% adherence.
If a required visual criterion of weight 6 is pending, coverage is 40%, with
whole-rubric bounds of 25% to 85%. The requirement counts are 1 met, 1 partial
and 1 pending. This is not a percentage of boxes passed or measured model
performance.

"All applicable judge requirements met" requires every applicable requirement
to be met with none partial, unmet or pending under a current assessment.
Recorded required check status and log availability stay alongside it. A failed
required check prevents an overall validated claim regardless of the score.
Neither judge status nor the inspection guide records human/project acceptance.

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
bind the snapshot. Report rows include `candidateId`, `judgeChecklistStatus`
and `inspection`, whose versioned structure retains full criteria, supporting
counts, five actions and artifact availability. HTML renders that same data;
CSV retains structured fields as quoted JSON cells. `score`, `coverage` and
`scoreRange` retain the existing judge values and semantics. No human metric
exists. CSV repeats the manifest, ledger, grader and generator
bindings on every scheduled slot and linked retry, with explicit states and
empty unknown values. It quotes text and protects leading
spreadsheet formula characters. JSON retains the original text. Embedded
downloads contain the same evidence as the generated files.
