# Mandatory Codex startup

Ticket work cannot start unless the required activation checks pass.

The Codex launcher registers the selected plugins, skills, and hook files from
`startup.json` in a private home under `.sandcastle/startup/`. It preserves host
disables and trusted hashes for unchanged definitions. It mounts plugin and
skill source files read-only and gives hooks writable container storage.
The generated config carries the complete host `hooks.state` table, including
container path aliases. Trusted hooks must match their stored approval hashes
before and after the execution probes.

Before every Sandcastle Codex invocation, including a reviewer, planner,
merge agent, retry, or resumed session, the runner compares the selected
versions and files with the host snapshot. It checks exact hook trust, starts
an activation-only turn, and requires successful lifecycle receipts and the
complete injected Ponytail and Unslop instructions before releasing the task
prompt. SessionStart and SubagentStart hooks inject the full instruction text,
with no context truncation. The task prompt includes it explicitly as well.
Other selected skills remain available for invocation when relevant.

Ticket agents run through Sandcastle's guarded invocations. When the required
hooks include subagent events, an initial probe exercises them. The runner then
reconnects, resumes the same session with `agents.enabled = false`, and proves
root startup again before releasing work. Built-in Codex delegation is disabled
for ticket work because its SubagentStart hooks cannot enforce a startup stop.
Sandcastle's parallel planner and reviewer agents each keep their own gate.
These probes use model turns and count toward usage. Their model sandbox is
read-only; task write access is granted only after activation passes. Hook
processes keep their writable runtime storage.

## First launch and changed hooks

Run the generated launcher once to create the registration. New or changed
hooks stop startup. On the host, run:

```sh
CODEX_HOME="$(pwd)/.sandcastle/startup" codex --cd "$(pwd)"
```

Open `/hooks`, review and trust the exact definitions, then exit and restart
the launcher. Sandcastle preserves those approvals while definitions remain
unchanged. It never bypasses hook trust or approves new definitions itself.
Changes to the always-loaded skill text change its hook definition and require
review again.

## Selection and failure messages

Edit `startup.json` to choose exact plugin IDs and skill names. `"host"` selects
the host inventory; its intentional disables are retained. A required
Ponytail or Unslop disable is a conflict that stops startup, not permission to
silently re-enable it. `disabledHooks` maps a Codex hook key to an explicit
reason for omitting an optional hook; use the host registration key shown by
`/hooks`. Mandatory instruction hooks cannot be disabled.

The default probe exercises SessionStart, UserPromptSubmit, shell PreToolUse
and PostToolUse, Stop, and subagent start/stop when required hooks use those
events. A required hook with a matcher or lifecycle event the probe does not
exercise stops startup with its key and event. Choose relevant hooks and
matchers; do not claim execution from registration alone. Missing skills,
unsupported capabilities, untrusted hooks, execution errors, missing
instruction injection, and timeouts all prevent task dispatch.

This gate applies to the generated Codex launcher and Sandcastle-managed
sessions. Other agent providers need their own activation protocol.
Interactive Codex sessions with this gate are rejected because they have no
controlled task dispatch. The check guarantees activation before task work;
it does not guarantee that a model follows every instruction perfectly.

Official contracts: [hooks](https://learn.chatgpt.com/docs/hooks) and
[skills](https://learn.chatgpt.com/docs/build-skills).
