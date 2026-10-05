# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. For multiline issue and comment bodies, write the exact text to a file and pass `--body-file <path>`.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters. Keep `--limit` high (default `gh` returns only 30) so the full backlog is visible.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Implementation progress

When completing or pausing work on an existing issue, comment on that issue with the commit or PR, checks run and their results, acceptance criteria met, and any remaining work or blockers. Update its labels or checklist when the project's conventions use them. Close it only after its required gates pass on the intended integration branch; otherwise leave it open and say what remains. A `#<number>` commit reference does not record this progress.

## Pull requests as a triage surface

**PRs as a request surface: yes.** External PRs are treated as feature requests; `/triage` reads this flag and pulls them into the same queue as issues, running them through the same labels and states using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR` — collaborators' in-flight PRs are left alone).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. A map is a single issue with child issues as tasks.

- Create the map with the `wayfinder:map` label and Notes / Decisions-so-far / Fog sections. Use `gh issue create --label wayfinder:map`.
- Link each child task to the map as a GitHub sub-issue using `gh api`. If sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use the appropriate `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task` label. Assign a claimed task to the developer doing the work.
- Record blocking relationships with GitHub native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the numeric database ID with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`; the issue number and `node_id` are not database IDs. If native dependencies are unavailable, add `Blocked by: #<n>, #<n>` at the top of the child body. A task is unblocked when every blocker is closed.
- To select the next task, list the map's open children using its sub-issues or task list. Exclude assigned tasks and tasks with open blockers. Native `issue_dependencies_summary.blocked_by` counts open blockers; for the fallback, check the issues named in `Blocked by`. Choose the first eligible child in map order.
- Claim the task with `gh issue edit <n> --add-assignee @me` before other tracker writes for that task.
- Record the outcome with `gh issue comment <n> --body-file <path>` following the Implementation progress rules above. Close the task only when its required gates pass on the intended integration branch. Then append a concise outcome and a link to the map's Decisions-so-far section.
