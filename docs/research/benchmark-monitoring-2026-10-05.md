# Local benchmark monitoring research

Research completed 2026-10-05 by the user-requested research agent. Sandcastle source was inspected at `36826ec48e85cc58ffdaaa1e1313ee1a4c809e5e`. This note contains findings and recommendations, not an implemented benchmark or new performance measurements.

## Recommended experiment

Compare `gpt-6-astra` at `medium`, `high`, `xhigh`, and `max` using identical frozen instructions and starting code. Use a separate candidate repository and worktree per arm, run candidates sequentially, and grade committed changes independently. The user selected one implementation invocation plus configured project checks, with project-acceptance gaps shown separately.

A single ticket is a case study. Repeated attempts measure variability on that ticket; a general ranking requires representative additional tasks. OpenAI recommends task-specific evaluations, human calibration, and evaluation sets representative of actual use. [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)

## Model capability evidence

| Observation                   | Inspected value                                                    |
| ----------------------------- | ------------------------------------------------------------------ |
| Astra identifier              | `gpt-6-astra`                                                      |
| Default effort                | `medium`                                                           |
| Requested supported efforts   | `medium`, `high`, `xhigh`, `max`                                   |
| Catalog timestamp             | `2026-10-05T09:11:44.823041668Z`                                   |
| Catalog client                | `0.160.0`                                                          |
| Shell CLI                     | `codex-cli 0.159.0`                                                |
| Catalog source                | `/home/dv8/.codex/models_cache.json`                               |
| Catalog SHA-256 at inspection | `e546c64b03095d780a995cef8d39897f5efd1927c3fadf10e4abc89b330dfc67` |
| Catalog pricing               | No pricing field                                                   |

This is host evidence. Query `model/list` using the actual worker client and account before inference, retain its response, and reject unsupported configurations. Client versions and account access can differ. [Codex model discovery](https://learn.chatgpt.com/docs/app-server#list-models-modellist)

Official guidance also confirms the requested Astra efforts and recommends measuring the extra latency and cost of higher efforts against their benefit. Keep service tier and other reasoning settings fixed during the comparison. [Reasoning effort guidance](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-reasoningeffort)

## Local implementation evidence

[The generic benchmark](../../src/ticketBenchmark.ts) already accepts local documents, GitHub issues, and repeated model/effort arms. It freezes a plan, creates Docker worktrees, retains sessions, and writes HTML, JSON, and CSV. It performs one invocation per input and arm. Completed slots can continue without replay; interrupted slots block further calls. It has no prompt fallback or detailed phase progress, and its report is a table.

Its configured check executes in the worker workspace. Passing that check does not establish protected project acceptance. The [retained three-model pilot](../proofs/issue-31-three-model-pilot/findings.md) validates the mechanism on one historical task. All three candidates passed; it establishes neither a general ranking nor subscription savings.

## Freeze before inference

Retain the exact task text, source, retrieval time, and hash. Freeze its prerequisites and checks, base commit, runner version, image digest, Codex version, dependency lockfile, instructions, tool capabilities, service tier, and execution allowances.

Give every attempt the same starting files. Keep other candidate solutions, reference patches, and grading assets outside worker access. Record requested and observed model, effort, service tier, and session identity. A rerouted model is a configuration deviation.

For repeated studies, schedule blocks containing all four efforts on the same task and environment. Randomize arm order using a recorded scheduling seed to reduce load and cache-order effects. This seed controls scheduling, not deterministic model output. [NIST randomized block designs](https://www.itl.nist.gov/div898/handbook/pri/section3/pri332.htm)

Distinguish natural completion time from deadline-constrained results. An identical deadline can truncate higher efforts more often. Preserve timeout outcomes and captured usage. Measure setup, implementation, checks, grading, waiting, and cleanup separately, alongside end-to-end duration.

## Independent grading

Establish task requirements and protected checks before observing candidates. Exercise the grader against the unchanged base, a known correct solution when available, and representative broken variants. Grade the committed candidate separately from candidate-authored tests.

If an LLM judge is added, freeze its model and rubric, include the exact requirements, conceal candidate model/effort/cost, and calibrate against human judgments. A judge cannot override a failed deterministic requirement. Keep grading cost separate. [OpenAI agent evaluation example](https://developers.openai.com/cookbook/examples/agent_optimization/optimizing_agents_for_cost_and_quality#optional-judge-customer-answer-completeness-and-grounding)

A UI task also needs the specified runtime, reference, viewports, test data, interactions, and screenshots. Build and unit-test success cannot establish visual acceptance. Separate held-out tasks for a later broad ranking from protected checks applied to the current task. [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)

## Durable monitoring

An append-only `events.jsonl` and atomically replaced `status.json` are sufficient for a local controller. Retain the manifest, raw worker and grader logs, normalized usage, candidate changes, and report exports.

Each event should identify its schema version, monotonically increasing sequence, run and slot, timestamp, event type, and referenced artifacts. The status snapshot should expose the current phase, terminal outcome, completed/scheduled counts, controller heartbeat, last worker output time, remaining allowance, usage coverage, requested and observed configuration, session and process identities, and the next permitted recovery action.

Codex `exec --json` emits thread, turn, item, error, and usage records. App-server events expose completion, interruption, failure, token usage, and rerouting. Keep the raw stream alongside normalized progress. [Non-interactive events](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable), [app-server events](https://learn.chatgpt.com/docs/app-server#turn-events)

A read-only status command and sequence cursor let a Luna chat summarize progress without steering the workers. Show exact counts and elapsed time. A controller heartbeat proves controller activity, not worker progress. A quiet worker may be reasoning or running a long command.

Persist cancellation, interrupt the active operation, collect final usage, stop owned processes within a bounded grace period, and record cleanup. Resume only against the original plan and remaining allowance. Observer disconnection must not replay completed slots. An explicit retry needs its own attempt identity and retains the interrupted attempt's cost. A resumed conversation is not an independent repetition. [Codex session resume](https://learn.chatgpt.com/docs/non-interactive-mode#resume-a-non-interactive-session), [app-server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview)

Keep infrastructure failure, failed checks, timeouts, cancellation, missing grading, and unrun work distinct. Reports must retain denominators and explain exclusions.

## Cost accounting

Rates retrieved from official documentation on 2026-10-05:

| Astra Standard basis, per million tokens | Ordinary input | Cached input |  Cache-write input |        Output |
| ---------------------------------------- | -------------: | -----------: | -----------------: | ------------: |
| API, at most 272K request input tokens   |            $10 |           $1 |             $12.50 |           $50 |
| API, above 272K request input tokens     |            $20 |           $2 |                $25 |           $75 |
| Codex credit billing                     |    250 credits |   25 credits | No separate charge | 1,250 credits |

API dollars and Codex credits are different billing systems. Credit purchase prices depend on the plan or agreement; token prices do not establish included subscription consumption. Freeze units, rates, source URLs, retrieval date, service tier, and calculation version. [API pricing](https://developers.openai.com/api/docs/pricing), [Codex token rates](https://learn.chatgpt.com/docs/pricing#token-rates)

Sandcastle already subtracts cached input once when normalizing Codex usage. `IterationUsage.inputTokens` is uncached input; `cacheReadInputTokens` is the cached bucket. Do not subtract cached input again. [Usage normalization](../../src/AgentProvider.ts)

Current API cache-write pricing replaces ordinary-input pricing for those tokens; it is not additive. Sandcastle's Codex parser hardcodes cache creation to zero, which does not prove API-equivalent cache writes were zero. Retain raw provider usage and apply its actual schema. [Prompt caching accounting](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance)

Output totals already include reasoning and other non-visible generated tokens. Do not charge a reasoning breakdown again. [Output token counts](https://developers.openai.com/api/docs/guides/token-counting#understand-output-token-counts)

A complete API-equivalent dollar estimate requires the billable token buckets, per-request context bands, effective model, and service tier. With missing dimensions, show a labeled partial estimate, a justified range with its assumptions, or unavailable cost. Do not label it an actual Codex subscription bill. Missing counters and unchanged account percentages do not mean zero cost.

Separate implementation, project review, grading, and Luna monitoring costs, plus total study cost. Include failed and interrupted attempts. Show both cost per attempted task and cost per successful checked task; the latter is unavailable when there are no successes.

## Report design

Use a dark report inspired by the supplied examples. Its cost/score chart must define its score and cost basis, with effort, trial count, outcome, duration, coverage, assumptions, and evidence in accessible tooltips or details. Also show latency, phase timing, and a keyboard-accessible evidence table.

One binary-graded task with one attempt per effort yields only pass/fail points. A continuous quality score needs a rubric selected before the run. Counting ordinary test cases does not create an independent quality scale. Repeated pass-rate estimates need success/trial counts and suitable small-sample uncertainty; they still describe that task. [NIST binomial confidence limits](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbici.htm)

Rebuild final reports from retained evidence without another model call. Include generator version, manifest/ledger hashes, grader identity, candidate commits, and artifact hashes. SWE-bench likewise separates saved predictions, logs, and reports and can reconstruct verdicts from saved test output. [SWE-bench report conventions](https://www.swebench.com/SWE-bench/reference/cli/)

## Environment readiness and cleanup

Preflight the actual image, worker model catalog, dependencies, disk space, inodes, grader, and required browser or native environment before model calls. Share immutable caches only; keep writable installations, build outputs, fixtures, and candidate changes separate. [SWE-bench image operations](https://www.swebench.com/SWE-bench/reference/cli/#images)

For the user's native-isolation requirement, the design must use an owned headless device per arm, a private writable device-data directory, distinct ports, and isolated required service data. Project-owned host preparation and verification should bind that device to the candidate worktree. This is a design recommendation; this research did not launch or validate an emulator.

After sealing evidence, remove only disposable resources owned by the run. Preserve patches or commits, logs, existing retained pilots, and byte-bound historical evidence. An unsuccessful cleanup remains visible in status.

## Subsequent judge requirement

After the original research and design confirmation, the user required a benchmark judge defaulting to `gpt-6.1-sol:xhigh`, replaceable through `--judge model:effort`. It directly inspects every available candidate's worktree against the frozen specification using code and required visual evidence and returns concise observations, supporting explanations, requirement verdicts, and a rubric-based specification adherence score. The judge's result is displayed in the main cost-versus-score graph. The original research's optional-judge guidance now applies to this required role.

The [amended specification](../planning/astra-implementation-benchmark.md#judge-assessment-contract) requires independent candidate assessments, a frozen rubric, concealed implementation identities during grading, exact-candidate evidence, separate judge usage and time allowances, and explicit missing or inconclusive assessments. No judge was launched and no code was changed. Selected judge capabilities and rates must be verified and frozen at a future launch; the Astra rates above are not a rate table for Sol.
