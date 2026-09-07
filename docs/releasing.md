# Releasing

[Release](../.github/workflows/release.yml) runs when an annotated `v*` tag is
pushed. It validates the source, builds native packages, runs packaged smokes,
and publishes only after downloaded artifact checksums pass.

## Prepare a version

1. Select an unused SemVer version. For `0.x`, increment minor for features or
   documented compatibility breaks, and patch for backward-compatible fixes.
2. On a branch, run `npm version <version> --no-git-tag-version`. Align app-owned
   version metadata; leave independent protocol/dependency versions unchanged.
3. Move user-visible entries from `[Unreleased]` to a dated version in
   [CHANGELOG.md](../CHANGELOG.md), leaving a fresh `[Unreleased]` section.
4. Review dependencies and [third-party notices](../THIRD_PARTY_NOTICES.md), test
   supported data upgrades and recovery with synthetic copies, and document any
   compatibility or platform limitations that affect users.
5. Merge the PR into `main` after the Linux, macOS, Windows, Dependency policy,
   and Secret history checks pass.

Prepare and test native packages using [Development](development.md#packaging).
Validate installation, startup, native terminal, Local ML, and uninstall on clean
target machines. Include profile upgrade/rollback checks when storage changes.
CI smoke checks do not replace those tests.

## Signing setup

The GitHub `release` environment must allow `v*` tags and contain:

| Secret | Value format |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID PKCS#12 certificate |
| `CSC_KEY_PASSWORD` | Certificate password |
| `CSC_NAME` | Certificate name and team ID, without the `Developer ID Application:` prefix |
| `APPLE_API_KEY` | Base64-encoded App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

Provision through GitHub's secret settings or `gh secret set --env release`.
Pass file contents through stdin and enter string secrets interactively; never
put values in source, command arguments, logs, issues, or chat. The workflow
creates temporary signing files and a keychain and removes them after the job.

For local signed macOS builds, `npm run package:release` runs the signing preflight.
Use a Developer ID identity in the Keychain or `CSC_LINK` with `CSC_KEY_PASSWORD`,
plus `CSC_NAME`, `APPLE_API_KEY` (a local key path), `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER`. Local packaging does not publish; verify signing and
notarization against the exact distributable bytes before distribution.

Copilot-enabled distributions also need the public OAuth Client ID described in
[Development](development.md#runtimes-and-icons).

## Publish

Publishing requires maintainer authorization. Start from a clean, reviewed `main`
checkout containing the version update. The tag version must match `package.json`
and the root package in `package-lock.json`; its commit must be reachable from
`origin/main`. The tag and its draft/published release must not already exist.

After checking these prerequisites, run:

```sh
git switch main
git pull --ff-only
npm ci
npm run audit:dependencies
npm run check
npm run test:e2e
```

When all checks pass, derive the tag from the committed version:

```sh
release_version="$(node -p "require('./package.json').version")"
git tag -a "v$release_version" -m "Maestrly App v$release_version" &&
  git push origin "refs/tags/v$release_version"
```

The workflow publishes five native files named
`Maestrly-App-<version>-<platform>-<arch>.<extension>`:

| Target | Files |
| --- | --- |
| Linux x64 | `.AppImage`, `.deb` |
| Windows x64 | `.exe` |
| macOS arm64 | `.dmg`, `.zip`, signed and notarized |

`SHA256SUMS.txt` covers all five files. Linux and Windows packages are not
code-signed. SemVer prerelease suffixes produce GitHub prereleases. Updates are
installed manually.

If publication fails, inspect the workflow logs and retained draft. Do not move
tags, overwrite assets, or publish a draft without repeating checksum verification.
For a defective release, identify the affected version and issue a new patch/tag;
use [SECURITY.md](../SECURITY.md) for vulnerabilities. Warn users when a schema
change makes downgrade unsafe and point them to [backup/recovery](local-data.md).
