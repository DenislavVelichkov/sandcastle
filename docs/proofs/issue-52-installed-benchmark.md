# Issue 52: installed benchmark launch and recovery

The local candidate passes the installed consumer, browser, Android and offline
report proofs. All implementation responses, judgments, usage and prices are
deterministic fixtures. The runtime applications and report browser are real.
This proves the connected launch path; it does not measure model performance or
grant project acceptance. No live model call or Renovio pilot ran.

## Candidate and checks

Work started from `862373136f7e11080e4795a2c7363cce9599daf5` on `dv8/main`.
Implementation and the accepted cleanup fixes are committed in `e52ca23`,
`8f99a62` and `a02adae`. The installed proof uses the build at
`a02adaec96191e16200f3e2af67be43d724b2960`. The subsequent offline proof correction
and this record do not change shipped files, runtime adapters or candidates.

| Gate                                                                             | Result                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm run typecheck`                                                             | Passed                                                |
| `pnpm run build`                                                                 | Passed, including public type checks                  |
| `pnpm run test --maxWorkers=1 --reporter=dot`                                    | 69 files passed; 1,623 tests passed, 2 existing skips |
| Installed consumer with packaged browser and Android adapters                    | Passed                                                |
| Isolated HTML opened through `file:`, keyboard, accessibility tree and downloads | Passed                                                |
| Runtime evidence hashes and separate removal receipts                            | Passed                                                |

The final suite ran after typecheck and build, sequentially, in 217.18 seconds.
Earlier concurrent runs hit existing short test deadlines under observed host
load. Their failures were retained; assertions and deadlines were not weakened.
The complete final regression surface passed with one worker.

## Installed consumer

The proof packed `@ai-hero/sandcastle@0.12.0-dv8.25.0`, installed that archive
offline with pnpm into an unrelated disposable consumer, and inspected actual
help output for `benchmark`, `benchmark-status`, `benchmark-cancel`,
`benchmark-resume` and `benchmark-report`. It invoked the installed
`dist/main.js`, rather than a repository script or a version-only readiness check.

| Identity                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Installed archive         | `0f47bc18a71fe3740482fe5312c828ece3c51e3cad50961d9a157eaee3fa0952` |
| Installed entry           | `d5eaa8853b5916b5044d88bcd6848a1ec52bcf944572341943dc5ad7d39ee891` |
| Installed proof           | `b6cda1a354cc7bb4191d3f604af2f0d9b86f5beed44bd031414fadbdd22d3d37` |
| Installed removal receipt | `101a389d719c1af6fe091efc793dda99a6474c4817e84b95d332ddc052e722bf` |

Evidence is retained at
`/home/dv8/.codex/.tmp/sandcastle-issue52-installed-20261006-01/`.
`proof.json` seals verified resource stopping before disposable removal;
`cleanup.json` binds its exact bytes and records successful removal.

The installed commands verified local ticket, GitHub fixture, prompt, local
fallback and confirmed-absent issue routes. Defaults select Astra medium, high,
xhigh and max with `gpt-6.1-sol:xhigh` judging. Independent worker/judge overrides
retain the same frozen base and rubric. Dirty and untracked host files survived.
Each candidate had separate Git storage and protected checks. A deliberately
wrong implementation that replaced its check script with `exit 0` still failed
the restored check and direct-code judgment.

A watching observer disconnected and reconnected using its durable cursor.
Cancellation deliberately encountered a failed worker stop and retained its
resources and interrupted usage. Installed recovery released them without
replaying implementation. Final ledgers have no owner or outstanding resources.

The report contains four current fixture grades of 100/100 with full coverage,
passed checks and project acceptance recorded as not assessed. Report exports
bind the frozen manifest and terminal ledger. Offline regeneration produced
identical HTML, JSON and CSV without further implementation or judge calls.

## Real project runtimes

Both packaged reference projects ran through the installed benchmark entry.
Each completed protected checks and a fixture judge's live inspection of the
actual candidate application, retained visual evidence and verified cleanup.

| Profile | Observed runtime                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| Browser | Owned Chromium profile at 800 by 600; private candidate server and browser scope                                     |
| Android | Owned `emulator-5680`, `android-35-x86_64-headless`, x86_64; NVIDIA hardware GLES; verified offline guest networking |

The browser build is
`6488ad5ef433aeac5b478ea063eebbd3d8fea8eadc56b5b8ce6fdfb15487ef80`;
the Android build is
`304d4deafe8a0666b0f416f74a7fbd4b9efa376e0225f8626c707c7f2964221c`.
Their frozen adapter module hashes match the current packaged sources. Screen
and live-inspection bytes match every evidence hash in `proof.json`.

The installed runner identity differs from earlier source-run proof, so these
claims were refreshed once against the stable installed candidate. Later edits
affect only the offline proof harness and documentation. Existing issue 50
receipts and historical pilots were preserved without rewriting their bytes.

## Offline report

`report.html`, SHA-256
`d77d781a306ade94581c718878ce1761faf068354ff26fa436d4db1cf7bdff13`,
opened in a private Chromium profile through `file:` with no adjacent JSON or
CSV and HTTP/HTTPS blocked. No external request or runtime exception occurred.
At 1440 by 1000 and 390 by 844, document width stayed within the viewport.
Retained screenshots were also inspected visually.

Actual Tab input reached a chart point with the visible dot focus indicator.
ArrowRight moved to the next point, Enter displayed its high-effort details,
and cost/scope controls changed the visible graph. The accessibility tree
exposed chart buttons and named radio controls. Chromium completed actual JSON
and CSV downloads whose contents match the embedded data.

Evidence is retained at
`/home/dv8/.codex/.tmp/sandcastle-issue52-offline-20261006-02/`.
The proof hash is
`b17628ab8b33b6c5f5d0e5a6a11937ce7e70e0f870c451013ebffd8530d3db38`;
its successful removal receipt hash is
`fcae39be8454b66e78a9104d1ad9548388e11e6bc155572219cc40dad27b2eb9`.
Both download-completed browser events and downloaded files are retained.

The first offline attempt checked the SVG group's outline, although the report
renders focus on the point's dot. That proof assertion failed. The harness was
corrected to navigate with Tab and check the actual indicator; production HTML
was unchanged. Its failure log, screenshots, original stop receipt and separate
final removal receipt remain in `sandcastle-issue52-offline-20261006-01`.

## Cleanup and delivery

Disposable consumers, package archives, external tools, source fixtures,
private browser profiles and Android device data were removed after owned
processes stopped and proof was sealed. The runtime emulator is absent;
the existing emulator on 5554 and physical phone remain available. Frozen
candidate Git storage and assessment artifacts remain as compact verification
evidence, about 15 MiB. Two small failed-suite diagnostics, about 324 KiB total,
remain in their original temporary locations.

The [installed launch guide](../benchmark-installed-launch.md) documents tools,
project adapters, active Luna observation, recovery, cost assumptions, judge
interpretation and operator/project acceptance gates. A nonduplicating minor
changeset covers this delivery. Initial full review and accepted-fix delta
review found no outstanding Standards or Spec findings. The final offline
correction is reviewed as a delta with its affected HTML and adapter contracts.

All local issue 52 acceptance checks pass. No public release is required. These
commits have not been pushed; the tracker remains open for integration under
the repository's closure rule. A future live benchmark requires an explicit
task and bounded allowance, and its outcome remains unmeasured.
