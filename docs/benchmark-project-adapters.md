# Owned benchmark project runtimes

`sandcastle benchmark --contract launch.json` can connect a frozen candidate to
a project-owned browser or native runtime. The controller owns scheduling,
allowances, candidate integrity, evidence and recovery. The project adapter owns
build rules, readiness, protected checks, captures, live observation and stopping
its resources. The implementation worker and independent judge still use their
separate private worker runtimes.

Declare an adapter in the version 1 launch contract:

```json
{
  "version": 1,
  "adapter": {
    "id": "my-project-native-v1",
    "module": "benchmark-adapter.mjs",
    "readiness": "true",
    "config": { "architecture": "x86_64", "profile": "my-private-device" }
  },
  "protectedFiles": ["benchmark-adapter.mjs", "check-native.sh"],
  "references": ["approved-reference.png"],
  "rubric": [
    {
      "id": "required-screen",
      "requirement": "The selected task's screen matches its frozen reference",
      "weight": 1,
      "partialCredit": 0.5,
      "applicability": "visual",
      "evidence": ["check", "visual"]
    }
  ]
}
```

The module must be a tracked regular `.mjs` file in `--base`. Its exact bytes,
configuration, identity, check/preparation commands and capabilities enter the
launch plan hash. A changed plan or installed runner cannot silently resume an
old run. Modules are self-contained ESM with Node builtin imports. They execute
from frozen bytes, so relative imports into a live checkout are unavailable.
Put dependency and external tool identities in the configuration and verify them
in the adapter. Add all check/build inputs to `protectedFiles`.

`readiness` is the existing isolated worker's executable readiness probe. It
does not prove that a headless device has booted. The reference fixtures use
`true` because their host device readiness is established only after the exact
candidate is available. A required visual task without a module has an explicit
execution-readiness gap. A module that cannot obtain its required device records
an unavailable attempt and actionable reason. Its visual criteria remain
unassessed. A desktop test cannot supply native coverage.

## Adapter API

The public package exports `BenchmarkProjectAdapter`, `BenchmarkProjectContext`,
`BenchmarkProjectIdentity`, `BenchmarkVisualCapture` and
`BenchmarkProjectEvidence` as types. Export these six functions from the module:

| Function                 | Required behavior                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare(context)`       | Build from `worktree`, establish an owned runtime's readiness, and return its kind, build identity, profile, device, ports and required services.              |
| `check(context)`         | Run the frozen `check` using protected inputs in `checkWorktree` against the candidate's owned application. Return `stdout`, `stderr`, and integer `exitCode`. |
| `capture(context)`       | Return image descriptors with unique IDs, relative paths, PNG/JPEG/WebP media types and concise observations. Write files in `evidence`.                       |
| `inspect(context)`       | Observe the live candidate read-only. Return its build identity and a concise observation, such as the current DOM or native hierarchy.                        |
| `stop(context)`          | Stop resources created by this attempt, including partial startup. Work without in-memory session state and tolerate repeated recovery.                        |
| `verifyStopped(context)` | Return `true` only after the owned processes, device and required services are stopped.                                                                        |

Every operation receives the exact sealed candidate worktree, candidate commit,
tree and source hash, protected checking worktree, run/attempt identity, private
writable `root`, retained `evidence` directory, frozen `config`, exact task,
frozen reference bytes/hashes, configured commands, cancellation signal and
remaining allowance. Build commands specific to an adapter belong in its frozen
configuration. The ordinary `--prepare` command still prepares the implementation
worker before its invocation.

The controller journals ownership before importing or starting project code and
binds its recovery context by a byte hash. The adapter must record resource
intent and acquired identities in `root` before reporting readiness. Preserve
enough state for `stop` and `verifyStopped` after controller death. Verify process
start identities or resource ownership before signalling them. If startup loses
an identity before recording it, retain ownership and report the targeted
reconciliation needed. Do not guess a PID or delete a root whose stop is unknown.

Never reuse the user's active emulator/simulator, main development server,
Metro process, browser profile, writable installation, database or another arm's
state. Share only immutable toolchain/system-image inputs. Required databases,
queues and networks need their own attempt-owned instances and data. Validate
architecture and resource limits. Use unique ports/device IDs, bounded startup,
and cancellation-aware commands. An occupied port is a blocker, not permission
to attach to its listener. The reference adapters need no external backend.

## Candidate checks and judge access

Protected checks also run through the adapter for declared known-bad and
known-good controls. The controller checks protected inputs and candidate bytes
before and after operations. Candidate changes invalidate the bound evidence.
Capture IDs, hashes, observations, runtime/build identities and a byte-bound
runtime receipt enter the existing code/check/visual assessment contract.
Images are copied into the judge's read-only reference mount alongside the
applicable frozen references.

During assessment the judge can use `GET /inspect` on its private Unix socket to
observe the actual application. Change directory to the socket's parent and run
`curl --unix-socket inspection.sock http://localhost/inspect`. Linux binding uses
a directory descriptor to avoid the socket's short pathname limit. The endpoint
provides no device-control or application-write action. Each returned observation
has an evidence ID and content hash in the same assessment contract.

The runtime remains available through required checks, captures, inspection and
assessment sealing. Afterwards the controller stops it, verifies absence, and
removes only disposable owned resources. Compact candidate code/patches, captures,
observations and receipts remain. Failed cleanup retains ownership, stops further
admission and requires reconciliation. Cancellation, deadline, partial startup
and judge failures follow this same path. Recovery uses the frozen adapter and
bound context before replacing any runtime. Explicit rejudging starts a new
runtime/evidence identity for the unchanged candidate and preserves old bytes.

Reports and assessment applicability reads stay passive. They verify retained
candidate/evidence hashes and start no browser, device or model call. A rendered
screen or positive judge verdict does not select a production design, promote a
visual baseline, waive task prerequisites, or grant project/human acceptance.
The adapter must respect the selected project's existing frozen-reference and
approval obligations. Project acceptance remains `not_assessed` in a benchmark.

## Reference fixtures

Copy one folder from `src/templates/benchmark-runtime-browser` or
`src/templates/benchmark-runtime-android` into a disposable project and commit its
files. Installed packages carry the same folders under `dist/templates`. These
are reference files to copy, not additional `sandcastle init` template choices.

The browser fixture supports Node.js 22 or later, Linux Chromium and a user systemd scope. It serves
the candidate's immutable HTML on a private server, starts a fresh profile, limits
the scope to two CPUs, 1 GiB and 128 tasks, captures at 800 by 600, and observes
the actual DOM through Chromium's private debugging port. It blocks if systemd,
Chromium or sandbox readiness is unavailable.

The native fixture supports Linux x86_64, KVM, a compatible Android SDK with API
35 Google APIs x86_64 image/platform and build tools 35.0.0, a JDK, `zip`, `rg`,
and working host graphics. Set `adapter.config.sdk` to the owning SDK before
committing the fixture. It creates a fresh AVD, private ADB server and private
network simulator, reserves an
even console lane plus separate ADB and gRPC ports, and uses two guest CPU cores
and 2 GiB RAM. It checks Android boot and the live GLES renderer, builds a small
Java APK using the fixture's build script, verifies installed APK bytes, captures
the actual screen and supplies native hierarchy inspection. It never borrows an
existing AVD or selects a software-rendering fallback. Its reference app runs
offline, with networking between devices and external forwarding disabled.
Android's
[command-line documentation](https://developer.android.com/studio/run/emulator-commandline)
describes the private writable data and headless launch flags used by this fixture.
The [network simulator documentation](https://developer.android.com/studio/run/emulator-networking-advanced)
describes its private artifact directory.

Run the small explicit proofs from a source checkout after building:

```sh
pnpm run build
pnpm exec node scripts/prove-benchmark-runtime.mjs browser /absolute/private-browser-proof
ANDROID_HOME=/path/to/Android/Sdk pnpm exec node scripts/prove-benchmark-runtime.mjs android /absolute/private-native-proof
```

These operations execute real owned applications through the public benchmark
path with controlled external provider/judge responses. Their fixture grades
prove lifecycle and evidence behavior, not measured model quality or real worker
readiness. An unavailable runtime keeps the proof incomplete. They retain compact
proof/evidence and remove the source fixture only after verified cleanup.
