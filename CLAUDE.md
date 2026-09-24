Use `npm run typecheck` for type checking.

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
