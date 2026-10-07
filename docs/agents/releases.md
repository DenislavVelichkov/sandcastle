# Maintained fork releases

The fork uses versioned GitHub release archives and keeps the package name
`@ai-hero/sandcastle`. Installing that name from npm selects upstream.
`pnpm run release` publishes to npm; it does not create the fork's archive
release. The existing release and CI workflows trigger on `main`, while the
maintained fork branch is `dv8/main`.

## Prepare and verify

- Compare the intended source against the last published fork tag. Review
  existing changesets before adding or grouping user-facing release notes.
- Keep the maintained version convention, such as `0.12.0-dv8.27.0`, and update
  `package.json`, `CHANGELOG.md` and the README's installation and upgrade links.
- Run a frozen pnpm install, build and typecheck. Finish the build before running
  the full suite; use `pnpm test --maxWorkers=2` for its benchmark and CLI tests.
- Check formatting for every changed release file. The repository-wide
  `pnpm run format:check` can also scan generated `docs/.next` and `docs/.source`
  files, historical proof reports and unrelated existing style issues. Record
  that result separately. Do not reformat byte-bound historical evidence to make
  it pass, or describe a scoped check as a passing whole-repository check.
- Commit the source before sealing. `pnpm run seal -- artifacts/<release>`
  requires a clean checkout, rebuilds the package and writes the archive plus
  a receipt with source commit, version, contracts and SHA-256.
- Run `pnpm run verify:seal -- <archive>.receipt.json`. It verifies package
  identity, public imports, declarations and the CLI in a temporary consumer,
  then removes that consumer. Check newly added exports and generated template
  files from the installed archive when the release changes them.

## Publish and confirm

Push the recorded source commit to `dv8/main`. Create a draft release targeting
that exact commit, and attach the sealed archive, its receipt, release notes,
validation summary and relative-path `SHA256SUMS`. Complete the assets and notes
before publication; published releases are immutable. Use a fresh version and
tag for later changes.

After publication, verify the release and archive attestation, download its
assets and compare the archive bytes and checksums with the sealed local copy.
Retain compact release evidence and remove disposable consumers or containers
only after their owned processes stop. Preserve existing pilot directories.
