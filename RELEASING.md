# Releasing

Publishing requires explicit owner approval.

This mirrors the `unblock-memory` release-on-release workflow: normal pushes and
pull requests run CI only. A **published GitHub Release** runs npm publication.
Do not create a release merely to test the workflow.

## One-time npm setup

The package is `@unblocklabs/unblock-codex-prompt` with public access.

- Verify publishing rights to the `@unblocklabs` scope.
- For the first publish, configure an appropriately scoped `NPM_TOKEN` repository
  secret if npm trusted publishing cannot yet be configured for the new package.
  Do not put a token in source or copy a host's `.npmrc` into the repository.
- Configure npm's GitHub Actions trusted publisher for organization
  `unblocklabs-ai`, repository `unblock-codex-prompt`, workflow `release.yml`.
  The workflow uses Node 24, npm 11.13.0, `id-token: write`, and provenance.
  Once OIDC is configured, the token can be removed.
- Without valid publishing credentials/trust, the release job fails; it does not
  report a successful release while skipping npm.

If first-package bootstrapping is needed, an authenticated owner can publish the
reviewed version once with `npm publish --access public`, then configure trust:

```sh
npx --yes --package npm@12.0.2 npm trust github @unblocklabs/unblock-codex-prompt --repo unblocklabs-ai/unblock-codex-prompt --file release.yml --allow-publish --yes
```

The Release workflow verifies the registry's tarball integrity against its own
packed artifact before accepting an already-published version. Different bytes
fail the job. Subsequent new versions publish through OIDC with provenance; a
local bootstrap publication does not have GitHub Actions provenance.

Trusted publishing was configured during the 0.1.0 release. The trust-management
command above uses npm 12 because the current registry requires explicit publish
permissions; npm 11.13.0's older trust request was rejected. Normal CI publishing
continues to use the pinned CLI in `release.yml`.

ClawHub publishing is not configured.

## Release checklist

1. Update `package.json`, `package-lock.json` (including its root package), and
   `openclaw.plugin.json` to the same version.
2. Review the prompt diff separately from code changes. Render Bill's name and
   verify a real fresh-session Responses request after meaningful prompt or
   compatibility changes. Keep captures private; publish only sanitized findings.
3. Run `npm ci`, `npm run preflight`, and `npm run release:check -- vX.Y.Z`.
4. Commit and push reviewed changes to `main`; require passing CI.
5. With explicit release approval, publish a GitHub Release `vX.Y.Z` targeting
   `main`. Use release notes that explain user-visible changes and activation.
6. Watch the Release workflow. Verify local/main/tag commit parity and
   `npm view @unblocklabs/unblock-codex-prompt@X.Y.Z version dist.integrity`.
7. Update one fleet node, sync, restart safely, and verify before wider rollout.

The workflow checks release-tag ancestry and all three version-bearing files,
runs preflight, then publishes with `latest` (or `next` for a prerelease).

## Private request-capture protocol

Use a localhost-only Responses receiver and a new capture directory, mode 0700.
Never capture real user turns intentionally; use dedicated no-delivery sessions.
Back up the managed Codex TOML privately before temporarily changing the provider
endpoint. Preserve credentials and unrelated settings, and arrange restoration
even if the test fails.

Capture template A, make one unmistakable but harmless temporary template change,
sync, and capture template B in a **different native thread**. Assert the rendered
base prompt appears exactly once (allowing Codex's outer-whitespace trimming),
the marker changes, and OpenClaw developer guidance still exists separately.
Inspect both `instructions` and developer text items in `input`: Bill's current
Codex build carries the base prompt in `input`, not `instructions`. A synthetic receiver
proves wire composition, not model obedience. Restore the canonical template and
real endpoint, verify a real model turn, and check Gateway health. Never commit
the marker, raw captures, local ports/PIDs, private config, or test conversations.
