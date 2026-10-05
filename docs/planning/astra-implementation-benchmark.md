# Configurable implementation benchmark

Status: research and design confirmed by the user on 2026-10-05, including the later explicit judge requirement. The user explicitly requested no code changes. Renovio is an example of a project needing this functionality, not a pilot to execute or a repository to repair. The exact task is supplied when the benchmark launches.

## Agreed scope

Sandcastle should offer a reusable implementation benchmark for a selected project. Each arm gets one implementation invocation followed by configured project checks and an independent benchmark judge assessment. The judge defaults to GPT-6.1 Sol ExtraHigh and can be replaced through `--judge model:effort`. Other required project reviews and human-acceptance requirements remain visible as separate gaps. The default implementation arms are Astra Medium, High, ExtraHigh, and Max; command arguments can replace them with other supported model/effort combinations.

The delivery in this conversation is research, a specification, and domain documentation. There is no current implementation ticket, live pilot, production change, project integration, or publication task. The earlier discussion of a Renovio pilot is superseded by the user's clarification.

## Launch contract

The proposed command accepts a project directory, an explicit local task path or GitHub issue URL/number, repeated `--arm model:effort` values, `--judge model:effort`, project preparation/check configuration, environment requirements, execution limits, and an evidence directory. A prompt supplied at launch can serve as the input when no usable ticket exists.

| Input                                           | Required behavior                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Existing local task file                        | Read and freeze its exact contents before inference.                                                       |
| GitHub issue URL or number                      | Resolve the intended repository, freeze issue text and relevant prerequisite state, and record its source. |
| Prompt with no ticket                           | Use the supplied prompt as the fixed input.                                                                |
| Missing ticket with an explicit fallback prompt | Report the missing source and freeze the supplied fallback before model work.                              |
| Missing ticket with no prompt                   | Stop with an actionable request for a task or prompt; make no model call.                                  |
| Network, authentication, or permission failure  | Report resolution failure. Such a failure does not prove the ticket is missing.                            |
| A path pattern resolving to multiple tasks      | Require explicit task selection or an explicit multi-task plan.                                            |

The command must not quietly choose a different issue from the backlog. Chat file mentions should resolve to actual filesystem paths before launch. Local prompts and ticket instructions are benchmark inputs; they do not authorize unrelated host actions, integration, deployment, or messages.

The proposed four-arm selection is:

```sh
--arm gpt-6-astra:medium
--arm gpt-6-astra:high
--arm gpt-6-astra:xhigh
--arm gpt-6-astra:max
```

`xhigh` is the canonical provider spelling of ExtraHigh. Preserve dotted model identifiers. Validate each requested effort against the actual worker's model catalog rather than a host-only cache. Keep service tier fixed, and record requested and observed model/effort identities.

The proposed judge default and an example override are:

```sh
--judge gpt-6.1-sol:xhigh
# Example alternative, applied consistently to every candidate in the run:
--judge gpt-6-astra:high
```

Omitting `--judge` selects `gpt-6.1-sol:xhigh`. Its value configures the judge independently of implementation arms. Preflight must verify the selected judge's model/effort capability and budget; it cannot silently substitute a different judge. Freeze the same judge configuration for every candidate in a comparison.

The current source already supports repeated `--arm`, `--ticket`, `--base`, `--image`, `--prepare`, `--check`, `--output`, `--max-minutes`, `--max-new-slots`, and `--dry-run`. The judge role and `--judge`, prompt fallback, project selection independent of the runner's directory, detailed monitoring, isolated native environment integration, and the new graphs are proposed refinements. This document does not claim those options exist in an installed release.

## Freeze and preflight

Resolve the runtime-supplied input and freeze its text/hash, selected base commit, instructions, allowed edits, checks, dependency lockfile, runner version, worker image digest, Codex version, service tier, model catalog, rate card, and time/call limits before inference. Also freeze the judge model/effort, assessment prompt, requirement rubric and weights, evidence requirements, and judge call/time allowance.

Preflight verifies the installed CLI's actual commands, worker authentication without exposing credentials, dependency/tool availability, disk and inode capacity, independent grader readiness, and any required browser or native environment. It also establishes the selected task's real prerequisites. A dry-run plan proves scheduling; it does not prove execution readiness.

Use a configurable run limit and per-attempt limit. A 60-minute run cap is an example, not a requirement to launch a study now. Setup, implementation, checks, judge assessment, and cleanup need explicit accounting. Reserve the required judging allowance before admitting an implementation attempt. Stop admitting further attempts when the remaining allowance cannot cover the required next operation. Preserve partial outcomes and unrun slots.

## Candidate and environment isolation

Every arm, including different efforts of Astra, gets a separate worktree from the same frozen base. Sequential execution is the default to reduce resource contention. Candidate code, writable dependency installations, build outputs, and runtime state must be independent.

Use private candidate Git storage or an isolated shadow repository so workers cannot inspect other arms' solutions or mutate the active project's references. Preserve the host project's working files and existing uncommitted work; do not stash, reset, merge, or rewrite it as part of benchmark preparation. Retain compact candidate patches or commits outside the disposable runtime.

When a task requires an emulator or simulator, project-owned preparation launches a distinct headless instance for that attempt and binds it to the candidate worktree. Use private writable device data, distinct ports and identifiers, and isolated required backend data, networks, and queues. Build for the selected device's supported architecture using the project's own rules.

Reserve and limit CPU, memory, and device resources. Do not borrow the user's active device, live database, main Metro/dev-server process, or existing writable fixture. An unavailable required native runtime produces a blocked result with its reason. A desktop test or an unrelated existing emulator cannot replace required native evidence.

The generic controller owns orchestration and resource tracking. A project adapter owns task-specific preparation, runtime readiness, checks, evidence capture, and cleanup. It receives the exact worktree, run/attempt identity, private evidence directory, cancellation signal, and remaining allowance. Its identity and check configuration are frozen with the run. This boundary avoids teaching the benchmark every project's build and emulator layout.

## Evaluation contract

The benchmark measures one implementation invocation, the configured project checks, and a separate judge assessment of each available candidate result. The judge's call does not consume another implementation iteration or repair the candidate. Freeze the checks and judge rubric before viewing candidates and protect the grading inputs from worker edits. Exercise meaningful controls before measurement when a task has a known baseline failure or correct reference.

Report configured-check outcomes, judge assessments, and project acceptance separately. An implementation commit, completion message, passing unit tests, positive judge verdict, or successful screenshot capture cannot satisfy other required reviews or human visual approval. Required native checks use the actual candidate runtime.

A single binary-graded attempt per arm gives a 0% or 100% configured-check result. The judge supplies a separate specification adherence score using the rubric established at launch. Missing checks, blocked environments, missing visual evidence, and unrun attempts remain explicit. Aggregate comparisons display scheduled/completed/graded counts and their denominator. The screenshot's percentages are not benchmark data. One task does not establish a general model ranking.

## Judge assessment contract

Run a fresh judge session for each candidate so another candidate's implementation or assessment cannot influence its initial grade. Give the judge direct read access to that candidate's separate worktree, together with the exact frozen task/specification, governing requirements, selected visual references, rubric, committed candidate code/diff, independent check results, and evidence bound to that candidate. The judge inspects the worktree itself, including relevant surrounding code and configuration, rather than relying solely on a supplied diff or the implementer's report. Task/reference instructions govern the assessment; candidate-authored instructions and self-reported success claims are evidence to inspect, not authority over the judge.

Conceal implementation model, reasoning effort, cost, and display order during individual assessment. Use neutral candidate identifiers. After all assessments are recorded, the controller maps the frozen grades back to the arms and reports which candidate most closely matches the spec. The judge remains independent of the implementer even when a CLI override selects the same underlying model.

The judge inspects the relevant code in the candidate worktree and required visuals from the application built from that worktree. For a visual task, compare the frozen references against current captures and, where required, observe the candidate's routes and interactions through the approved project adapter in its isolated browser/emulator. Bind observations to the exact worktree, committed candidate, build, viewport/device, and evidence hashes. Freeze the candidate before assessment; changed work invalidates the associated grade. The judge cannot edit the code, repair the result, manipulate grading inputs, or use the host's active application. Keep the worktree and required candidate runtime resources available through assessment and then clean them up.

Require a human-readable evidence explanation for each requirement. It states what the judge observed in the code or visual, cites the relevant file/line, screenshot/frame, or behavior record, and explains how that observation supports the verdict. For example, an explanation may identify a visible button's label and state, connect its handler to the specified action, and describe an observed mismatch with the reference. Retain concise findings and justifications rather than requiring a transcript of private internal deliberation.

Each assessment contains the candidate and judge identities, specification/rubric hashes, requirement-level verdicts, supporting code/visual observations, uncovered requirements, applicable score and coverage, and a summary of the material deviations. Verdicts distinguish met, partially met, not met, not assessed, and not applicable. Partial-credit rules and weights must be defined in the frozen rubric. Required visual evidence that is missing stays not assessed; code-only inspection cannot satisfy it. Nonvisual tasks explicitly mark visual criteria not applicable.

Use the rubric to report specification adherence on a 0–100 scale with its weights, assessed coverage, and limitations. Keep executable-check pass rate alongside it. A failed mandatory check remains failed even if the judge likes the implementation. Report ties or inconclusive comparisons when the evidence cannot distinguish candidates. A closest-to-spec result may still have acceptance gaps; no grade or ranking authorizes integration or human visual acceptance.

Record judge failure, interruption, timeout, unavailable capability, or missing evidence as an incomplete assessment, not a zero-cost success or a fabricated score. Any explicit rejudging retains the original assessment and reason and uses a new assessment identity. Changing judge configuration or rubric creates a new comparison identity; it cannot rewrite the frozen run's results.

## Monitoring contract

Persist `manifest.json`, append-only `events.jsonl`, an atomic `status.json`, worker/check/judge logs, structured judge assessments, captured usage, candidate changes, and report exports. Version the normalized records and bind them to the run and frozen manifest.

Progress events include sequence number, timestamp, run/attempt/arm identities, phase, relevant configuration, and artifact references. The status snapshot exposes current phase, exact implementation/check/judge completion counts, elapsed and remaining allowance, controller heartbeat, last worker/judge activity, current wait or failure reason, known usage coverage, environment ownership, and recovery guidance.

Useful phases are input resolution, preflight, worktree preparation, environment readiness, implementation, project checks, judge preparation, code/visual assessment, assessment completion, evidence sealing, cleanup, and report generation. Keep a controller heartbeat separate from evidence of model progress. Silence during reasoning is not enough to diagnose a stall. A Luna observer should be able to report that an implementation finished while its judge assessment is still running.

A read-only status interface and sequence cursor allow an active Luna chat to summarize the saved output. The observer does not steer workers or alter task instructions. Observer disconnection leaves the controller's records intact; reopening the chat must not replay completed work. Chat updates depend on an active observer or an explicitly configured follow-up mechanism. Durable records alone do not promise notifications after the app closes.

Persist cancellation and its reason, stop owned operations within a bounded grace period, retain available usage and incomplete results, and verify cleanup. Resume only against the unchanged plan and remaining allowance. An explicit retry is a new attempt linked to the interrupted one, not an independent repetition. Distinguish infrastructure failures, failed checks, timeouts, cancellation, unverified results, and unrun work.

## Cost and report contract

The final report is a self-contained dark HTML artifact that opens locally, with JSON and CSV exports. The attached charts establish the desired presentation style, not measured values or a requirement to copy their model series.

Display each candidate's judge result in the main cost-versus-score graph. The vertical axis is explicitly labeled specification adherence, and its values come from the recorded judge assessments. Each point represents the implementation model/effort evaluated in its own worktree. The selected judge's model/effort is identified as evaluation metadata, not as an additional implementation arm. Point details show the judge verdict, concise explanation, requirement findings, evidence coverage, and links to the inspected code and visuals. Missing assessments have an explicit incomplete state and no invented numeric score. Keep configured-check outcomes available as a separate metric.

| View                                | Required content                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost versus specification adherence | Judge-derived scores under the frozen rubric, model/effort labels, coverage, and missing-assessment states.                                                             |
| Configured-check outcomes           | Executable-check pass rate and mandatory failures, kept separate from judge-derived scores.                                                                             |
| Judge explanation and comparison    | Requirement-level code/visual observations, cited evidence, deviations, ties or inconclusive results, and the closest-to-spec comparison.                               |
| API-equivalent dollar view          | Clearly labeled estimate, frozen official rates and date, service tier, context-band/cache-write assumptions, and coverage.                                             |
| Codex Standard credit view          | Token-derived credit equivalents with captured uncached/cached/output buckets.                                                                                          |
| Duration comparison                 | Implementation, judging, and end-to-end elapsed time, with setup/check/cleanup timings where measured.                                                                  |
| Progress and outcomes               | Planned, attempted, completed, graded, blocked, incomplete, and unrun counts.                                                                                           |
| Evidence table                      | Candidate and judge identities, task/rubric hashes, checks, judge findings, acceptance gaps, environment identities, usage provenance, and links to retained artifacts. |

Tooltips or keyboard-accessible details show implementation effort, judge model/effort, rubric identity, trial count, specification adherence, check outcome, duration, cost basis, coverage, assumptions, and evidence. Support readable narrow-screen tables, visible focus, sufficient contrast, and local access without fetching adjacent JSON through a web server.

Codex credits, subscription usage, and API dollars remain separate. Retain raw counters and the calculation version. Sandcastle's normalized input count already excludes cached tokens; never subtract them twice. API cache-write charges replace ordinary-input pricing for their tokens, and reasoning output is already included in output totals.

When dollar billing dimensions are missing, display a justified estimate/range with its assumptions or an explicit unavailable value. Never present an incomplete estimate as the user's actual bill. Capture each judge call's actual usage and freeze rates for the selected judge model separately from implementation-model rates. Keep implementation, judge, other review/grading, and Luna observation usage separate. Offer implementation-only and implementation-plus-judge cost views, with the full evaluation view including the required judge cost. Include failed and interrupted work in study totals. A missing counter is unknown, not zero.

Generate reports from retained evidence without another model call. Bind each export to manifest, ledger, candidate, grader, and generator identities. Preserve historical rates and byte-bound evidence exactly. Remove only the run's verified disposable worktrees, containers, device instances, installations, and fixtures after sealing compact evidence; cleanup failures remain visible.

## Renovio example evidence

The inspected example project is `/home/dv8/Projects/renovio.io`. Its package scripts refer to absent `.sandcastle/main.mts` and `.sandcastle/verify-runtime.mjs`; an older `.sandcastle/main.ts` exists. It pins `v0.12.0-dv8.23.0`, whose installed CLI help exposes `benchmark-report` but not `benchmark`. No Renovio Sandcastle worker image was present. These observations prevent a claim that this checkout is launch-ready and do not create a repair task.

The source build passed. The current planner resolved issue #94 at Renovio base `d629ad378bf5846ac0bf6dea676ec73ac1ef223f` into exactly four requested Astra arms without model calls. This proves input resolution and scheduling only.

Issue #94's prerequisite #93 is still open. Its 2026-10-05 08:30:19 UTC update explicitly requires new visual approval, baseline promotion, closure, and post-resolution review before #94. The #94 surface is `design_selected`, with no approval. This illustrates why arbitrary ticket resolution is different from task readiness and project acceptance.

The current report was observed in the browser using the real retained three-model pilot. It is a wide table without the requested graphs. Those historical results cannot supply measurements for the four-Astra comparison.

## Confirmed scope

The user confirmed the reusable functionality and documentation-only scope in the final shared-understanding check, then explicitly added the configurable GPT-6.1 Sol ExtraHigh judge on 2026-10-05. The judge inspects the candidate worktrees directly, and its results are displayed in the graph. This amendment preserves the one-invocation implementation limit and adds separate judging. No particular ticket or prompt is needed now; it is supplied at launch. Implementation remains planned. No new measured benchmark report can exist until a future authorized run produces data.

## Research

[Primary-source research and rate/accounting evidence](../research/benchmark-monitoring-2026-10-05.md) supports this design. [ADR-0021](../adr/0021-implementation-benchmark-boundaries.md) records the agreed durable measurement and ownership boundary. [ADR-0005](../adr/0005-usage-raw-tokens-no-percentage.md) remains unchanged: provider usage exposes raw counts, and report-level estimates must not fabricate subscription or context percentages.
