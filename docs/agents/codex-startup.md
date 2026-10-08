# Codex startup activation

The contract is: ticket work cannot start unless required activation checks pass.
The runner withholds the task prompt until it verifies selected host files and
versions, intentional enables/disables, exact hook trust, successful lifecycle
receipts, and complete Ponytail/Unslop instruction injection. Each Sandcastle
invocation, including resume/fork and parallel agents, performs a fresh check.
This is an activation guarantee, not a guarantee of perfect model adherence.

Keep the default selection and startup guide in all five init templates. Wire
every generated Codex factory to the prepared gate and every Docker/Podman
provider to its mounts/environment. Templates import only public package APIs.
Keep the startup registration home ignored; approvals belong to the local host.

## Registration and storage

- The installed Ponytail plugin can have `hooks/codex-hooks.json` without a
  manifest reference. Codex discovers the default `hooks/hooks.json`; listing
  installed skills does not prove that legacy hook files were registered.
- Keep exact definitions untrusted until reviewed. Preserve prior approval only
  by its actual definition hash. Changed skill text changes the generated
  instruction hook hash and needs review again.
- Copy the full effective `hooks.state` table, including host approval hashes,
  into the generated config. An allowlist that drops it loses existing approvals.
  Compare each trusted hook's current hash directly with its stored approved
  hash before dispatch and again after the probes. Discovery and execution remain
  separate requirements. Managed hooks can use Codex's administrative trust.
- Hook state keys include the hook source path. The host registration home and
  container home differ; retain reviewed host keys and copy their existing
  states to the container keys. Never manufacture a trusted hash for a new hook.
- Plugin roots are immutable source mounts. Legacy commands get `PLUGIN_ROOT`
  and a writable, private `PLUGIN_DATA` under the current `CODEX_HOME`.
- File-mount parents must be inside `/home/agent`; the providers create/chown
  those parents. Directory mounts alone can leave the `plugins` parent owned by
  root. Mount the startup snapshot under `plugins/` to establish its writable
  parent, while keeping the snapshot file read-only.
- Project skill paths relocate into `/home/agent/workspace`. Freeze and mount
  those paths too; preserve their disables at both discovery paths.

## Execution proof

- Codex hooks can fail open. A listed hook is insufficient. Require actual
  `hook/completed` success receipts and full context entries before task dispatch.
- SessionStart executes at the first turn, not at `thread/start`. Start with a
  harmless activation prompt. No ticket text goes into that probe.
- Require exactly one completed shell command in that probe's owning thread
  and turn, with exit code zero and the exact activation output. A successful
  turn or hook receipt cannot substitute for shell execution. Apply the same
  check after reconnecting for a resumed session or child lifecycle probe.
- Keep model probes read-only. Grant the requested task sandbox policy only
  after the activation gate passes; hook runtime storage remains writable.
- An already loaded `thread/resume` does not rerun SessionStart. Reconnect the
  app-server before proving a resumed session with changed runtime settings.
- `SubagentStart` cannot stop a child from starting. Exercise required child
  hooks with a harmless probe, then disable built-in delegation for ticket work
  using `agents.enabled = false`. Sandcastle owns the guarded ticket agents.
  The older `features.multi_agent` flag is insufficient on current Codex.
- A required matcher/event that the probe cannot exercise must stop startup.
  Background executions must finish within the startup deadline. Check receipts
  by source path, display order, event, and owning thread.
- Keep the timeout over source/storage validation, inspection, and probes.
  Kill the app-server process group on failure so hook children cannot linger.

Validate fake-protocol failure cases without models, init wiring in every
template/provider, and native container permissions. Native proofs may trust
only inspected synthetic test definitions in a disposable test home; never
alter production hook approval to make a test pass. Remove test containers and
temporary generated schemas after validation; preserve retained pilot data.

Official contracts: [hooks](https://learn.chatgpt.com/docs/hooks),
[skills](https://learn.chatgpt.com/docs/build-skills), and
[agent configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
