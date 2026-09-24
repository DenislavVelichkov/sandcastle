# Visual Acceptance Protocol

## Applicability

Use this protocol only for a **visual parity action**. The source must do at
least one of these:

- require `Compare <production surface> against <visual reference>`
- require `Select and freeze <visual reference> so <production surface> can be
compared later`
- link an existing visual-acceptance manifest that records that obligation

Applicability must precede artifact creation. A proposed manifest path or a
request to create a new manifest does not establish it.

If the source cannot complete either sentence and links no manifest, use the
normal workflow. A UI change, redesign, prototype, screenshot, or visual test
without a production-to-reference comparison creates no manifest and adds no
visual-acceptance gate.

## Invariant

A production screenshot is a candidate, never its own acceptance reference.
Only a human can accept a candidate. Regression baselines are promoted only
after that acceptance is bound to the exact candidate hashes.

Prototype selection means `design_selected`; it never means
`member_accepted`.

## Durable artifacts

Keep one manifest per initiative at:

```text
docs/visual-acceptance/<initiative>/manifest.json
```

Keep approved references, candidate captures, and comparison pages beside it.
Move selected references out of disposable prototype or temporary directories
before the design-selection ticket closes.

Start from [the manifest template](visual-acceptance.template.json). Paths in
a manifest are repository-relative and must not escape the repository root.

## Planning prerequisite

After a visual parity action establishes applicability, a valid manifest must
exist before `to-tickets` drafts implementation tickets and before `implement`
edits production code.
If the manifest is missing or invalid, the skill running that preflight creates
or repairs it before either phase begins. Absence is not a reason to defer the
artifact to implementation.

Create the smallest truthful planning manifest from decisions already present
in the conversation, map, spec, or ticket:

1. Copy the manifest template to
   `docs/visual-acceptance/<initiative>/manifest.json`.
2. Set the initiative and add one `planned` row per known visual surface.
3. Record the route, current selection or `Pending design selection`, required
   visible regions, and known interactions. Start references, candidates,
   deviations, and baselines empty; set comparison, approval request, and
   approval to `null`.
4. Run the validator and repair the manifest until it passes.

Use this exact shape for each new `planned` row, replacing every bracketed
value with facts from the source:

```json
{
  "id": "<stable-surface-id>",
  "route": "<route-or-entry-point>",
  "selection": "<known target or Pending design selection>",
  "requiredRegions": ["<visible-region>"],
  "requiredInteractions": [],
  "state": "planned",
  "references": [],
  "candidates": [],
  "comparison": null,
  "deviations": [],
  "approvalRequest": null,
  "approval": null,
  "baselines": []
}
```

A valid `planned` row unlocks ticket drafting, not production implementation.
Implementation of that surface starts only after durable reference files and
their hashes advance it to `design_selected`. When the source already contains
an explicit selection and durable references, record that evidence and advance
the row. Never manufacture a reference, hash, state transition, approval
request, or human approval to satisfy the validator.

## Surface states

Each route or independently accepted surface moves through these states in
order:

1. `planned`
2. `design_selected`
3. `implemented`
4. `compared`
5. `approval_requested`
6. `member_accepted`
7. `baseline_promoted`

The manifest records one row per surface. Each row names the route, selected
option, required regions and interactions, and every reference viewport,
locale, and scenario. Reference files and hashes are fixed at
`design_selected`.

## Implementation loop

Work one surface at a time unless the human explicitly authorizes another
order.

1. Implement the surface in the real application.
2. Run its automated behavior, accessibility, localization, responsive, and
   lifecycle checks.
3. Set the surface to `implemented`, commit it, and complete code review and
   accepted fixes before capturing approval candidates.
4. Capture final candidates using the same locale, viewport, scenario, and
   deterministic data as each reference.
5. Record candidate hashes and a side-by-side comparison artifact; set the
   surface to `compared` and validate the manifest.
6. Record an approval request bound to that candidate-set hash, set
   `approval_requested`, validate again, and end the turn with the mandatory
   request printed by the validator below.
7. On rejection or any candidate-changing edit, clear the request, return to
   `compared`, revise, recapture, and request approval again.
8. On explicit approval, bind the approval to the requested surface and
   candidate-set hash; set `member_accepted`.
9. Copy the accepted candidate bytes to regression baselines, record their
   hashes, rerun the visual tests, and set `baseline_promoted`.
10. Only then resolve the surface and unlock work blocked by it.

## Approval boundary

An approval request records its ISO timestamp, durable conversation or review
source, and candidate-set SHA-256. The same turn must end with this block and
no text after it:

```text
Approval required: <surface id>: <selected option>
Comparison: <clickable comparison path or URL>
Candidate set: <sha256 digest>
Deviations: <None or concise list>

Do you approve this exact production candidate?
Reply “Approve” or “Reject”.
```

Generate that block after validation and copy its stdout verbatim:

```bash
node scripts/validate-visual-acceptance.mjs \
  docs/visual-acceptance/<initiative>/manifest.json \
  --print-request=<surface-id>
```

An immediate explicit `Approve` response is bound to the surface and hash
shown in that request; the human does not need to repeat the digest. Generic
messages such as "continue", "looks good", or an earlier prototype selection
do not approve production. If a later invocation finds an unresolved
`approval_requested` surface, show the request again before doing other work.

Record:

- human approver
- ISO timestamp
- durable review source (for example a protected PR review URL or recorded
  conversation reference)
- candidate-set SHA-256 printed by the validator
- every accepted deviation from the reference

The validator checks structure and hashes; it cannot authenticate a human.
Treat approval as a human-owned process boundary. The implementation agent may
present the request and record an explicit response, but it must never invent,
infer, or self-author approval. Repository hosting controls are optional and
sit outside this protocol.

## Reporting

Always report these counters separately:

```text
Implemented: <n>/<total>
Compared: <n>/<total>
Approval requested: <n>/<total>
Member accepted: <n>/<total>
Baseline promoted: <n>/<total>
```

Use `implementation candidate` while any applicable surface is below
`member_accepted`. Use `complete` only when every applicable surface is
`baseline_promoted` and all non-visual acceptance gates also pass.

## Validation

Run the bundled dependency-free validator from the target repository root:

```bash
node scripts/validate-visual-acceptance.mjs \
  docs/visual-acceptance/<initiative>/manifest.json
```

`--print-request=<surface-id>` fails unless the manifest is valid and that
surface is exactly `approval_requested`.

Use `--require-complete` only at the final completion gate. Setup installs the
validator in the repository. Run it locally before each state change and
before claiming completion.

## Workflow ownership

- **Wayfinder** freezes selected references and creates the manifest.
- **to-spec** creates or repairs a missing planning manifest, then carries its
  path and acceptance boundary into the spec.
- **to-tickets** repeats that preflight before drafting, then creates one gated
  surface slice and its blocking edges per manifest row, with local-validator
  setup first when needed.
- **implement** performs the last creation preflight before editing code,
  requires `design_selected`, produces candidates, and pauses at the human
  boundary. It never self-approves or promotes an unaccepted baseline.
- **code-review** reports Standards and Spec independently, then reports visual
  acceptance status without converting a clean code review into human
  acceptance.

## Terminal conditions

A ticket or initiative with a visual parity action remains open when any
applicable row is below its required state. Review loops, green tests, snapshot
updates, and commits cannot substitute for the missing state transition.
