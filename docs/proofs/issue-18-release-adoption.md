# Issue 18: immutable release adoption, September 25, 2026

**Result: distribution and browser gates passed.** The independent npm library and pnpm web consumers install the same immutable GitHub release. This proof reused the exact archive and source from the [issue 17 live recovery](issue-17-live-attempt.md); it made no new Codex model call.

## Release identity

| Item                           | Verified value                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Release                        | [`v0.12.0-dv8.16.0-r2`](https://github.com/DenislavVelichkov/sandcastle/releases/tag/v0.12.0-dv8.16.0-r2), GitHub `immutable: true` |
| Tag target and embedded source | `0df2ba5c91afca41294ea026a95f9e21a7ba6d73`                                                                                          |
| Package                        | `@ai-hero/sandcastle@0.12.0-dv8.16.0`                                                                                               |
| Archive                        | `ai-hero-sandcastle-0.12.0-dv8.16.0.tgz`, 2,743,896 bytes                                                                           |
| SHA-256                        | `eca2e0116d09ac920b9ccf2e6e8d6896124c9533a83d9945066079ecead83164`                                                                  |
| Other asset                    | `SHA256SUMS`                                                                                                                        |

The archive was published through a draft without repacking it. The downloaded release asset compared byte for byte with the sealed issue 17 archive, and `sha256sum -c SHA256SUMS` passed on fresh downloads. `gh release verify v0.12.0-dv8.16.0-r2` and `gh release verify-asset` against that archive passed GitHub's release attestation. The source seal check passed. Package contents, license files and public exports therefore remained the tested bytes. The earlier `v0.12.0-dv8.16.0` publication is retained as historical: GitHub reported it as mutable, so the consumers pin the new immutable release identity instead.

## Independent consumers

| Check            | npm library                                                               | pnpm web                                                                   |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Local repository | `../limit-items-release-consumer`                                         | `../counter-web-workflow-fixture`                                          |
| Source commit    | `13629612fa251dc73a5b4760f1e1a5418f2e702d`                                | `3b698908a2829f0d7dfadedfe8ce96245c81301c`                                 |
| Evidence commit  | `dc9cafc`                                                                 | `18b355a`                                                                  |
| Receipt          | `evidence/issue-18-library-r2.json`                                       | `evidence/issue-18-r3/manifest.json` and two browser receipts/capture sets |
| Docker image     | `sha256:ce10c263c8d2cde7002f346e75c79da87b7f44578f5fcd0c217c45c199ba138b` | `sha256:2eb4cca9c0f41999436248a01cafa4a9ff23ebfd7a458c4c2e29cac62db3b240`  |

Both independent manifests and lockfiles record the exact release URL and integrity, with no range, symlink or moving source reference. The library's clean `npm ci`, four tests, typecheck, installed public import, metadata, resolution and `sandcastle --help` passed. The host and Sandcastle-created Node-only Docker worker resolved the same release, source and lockfile integrity at separate installed paths. The worker container `0effbc7c2057` was removed before the receipt was reopened and verified. That image has no browser tooling. The library's zero-limit behavior came from the earlier live recovery; this run checked its distribution and regression tests.

The web repository owns its counter source, `TASK.md`, `.sandcastle/implement.md`, Dockerfile, pnpm lockfile, Playwright script and evidence validator. It imports the installed public Sandcastle API and Docker provider; it contains no copied workflow controller or routing implementation. Its no-backend counter persists the count in browser local storage. Reset displays zero, removes the saved count, and still reads zero after reload.

The web proof started two Sandcastle-created Docker sandboxes at the same time from the pinned image. Their distinct containers were `f5cbdfb4e4fd` and `69af285b11fc`; the local static servers used ports `33627` and `35149` inside those isolated containers. Each ran a frozen pnpm installation, the public CLI check and actual Playwright assertions. Playwright was `1.63.0`, Chromium was `153.0.8010.12`, and captures used en-US, UTC, light mode and a 1280×720 viewport at scale 1. The checks covered increment, saved count, reload, Reset, storage removal, another reload and a separate browser context with no leaked storage. Both runs exported `incremented.png`, `reset.png` and a receipt with source and capture hashes. Their distinct container IDs, worktrees, run IDs and ports establish separate outputs. No mutable backend fixture was used.

The proof removed both containers and worktrees, reopened the exported artifacts and revalidated the source, image, release, browser details and capture hashes. `pnpm run verify:evidence -- --self-test` passed four controlled rejections: wrong build, changed fixture, missing browser and stale capture. The final browser receipts have SHA-256 `96df4bfcf62ffe11afa8cd926ab38911f4618d83f6172308ec90e6c59ce62263` and `fc223f6a0a99a7a4fdbba7d4a3a700a88ea1e0871edbe342b2611060615164d6`. Prior capture directories remain historical; the current evidence is never overwritten.

## Support boundary

The first verified environment is Linux with Docker and Node 24. The library worker used npm 11.17.0 without browser or native tooling. The web worker used pnpm 11.19.0, Playwright 1.63.0 and the pinned Chromium image. The issue 17 receipt separately covers the actual Docker/Codex recovery path with Codex CLI 0.156.1 and its observed model calls. This issue establishes release distribution and real browser behavior; it does not claim another live Codex coding result, native proof, production visual acceptance, baseline promotion or benchmark savings.

The [workflow user guide](../workflow-user-guide.md) gives clean installation, project binding, browser readiness, evidence review and troubleshooting commands. Its npm checks ran in the pinned Node image because the Linux host had no npm executable; the same proof entry ran with `node scripts/proof.mjs` on the host. The pnpm commands ran on the host.
