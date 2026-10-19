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

## QA builds

[QA build](../.github/workflows/qa-build.yml) packages Linux x64 (`.AppImage`,
`.deb`), Windows x64 (`.exe`), and macOS arm64 (`.dmg`, `.zip`) installers from
any branch, tag, or commit SHA for manual QA on clean machines without cutting
a tag, bumping `package.json`, or publishing a release.

Trigger a run for a specific ref (defaults to `main`):

```sh
gh workflow run qa-build.yml -f ref=main
```

Download the staged artifact for the target OS using the 7-character commit SHA:

```sh
gh run download <run-id> -n qa-build-linux-<sha7>
gh run download <run-id> -n qa-build-windows-<sha7>
gh run download <run-id> -n qa-build-macos-<sha7>
```

Each artifact is retained for 7 days and contains the staged installer(s),
`SHA256SUMS.txt`, and `qa-build.txt` (full commit SHA, requested ref,
`package.json` version, UTC build timestamp, and workflow run ID). QA build
packages are unsigned, are never published to GitHub Releases, and do not go
through auto-update.

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

## Build configuration

Desktop packages embed public identifiers at build time. They are GitHub Actions
repository variables (**Settings → Secrets and variables → Actions →
Variables**), not secrets, because each value ships inside the app. The workflow
stops before building when one is missing or malformed, and checks each built
main-process bundle for it.

| Variable | Value |
| --- | --- |
| `MAESTRLY_GITHUB_COPILOT_CLIENT_ID` | Client ID of the Maestrly GitHub OAuth App, used for GitHub Copilot sign-in |

Create a dedicated OAuth App, owned by the account or organization that
publishes Maestrly, in **Settings → Developer settings → OAuth Apps → New OAuth
App**: users see its name and owner when they authorize it. Use the project's
homepage as both the homepage and callback URL (Device Flow never calls it back),
then select **Enable Device Flow** and save. Copy only the client ID; the app
uses no client secret, so do not generate one. Store the ID with
`gh variable set MAESTRLY_GITHUB_COPILOT_CLIENT_ID --body "<client ID>"`.

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

The workflow publishes the native installers named
`Maestrly-App-<version>-<platform>-<arch>.<extension>` plus the metadata the
in-app updater (`electron-updater`, GitHub provider) reads:

| Target | Files |
| --- | --- |
| Linux x64 | `.AppImage`, `.deb`, `latest-linux.yml` |
| Windows x64 | `.exe`, `.exe.blockmap`, `latest.yml` |
| macOS arm64 | `.dmg`, `.zip`, `.zip.blockmap`, `latest-mac.yml` (signed and notarized) |

`SHA256SUMS.txt` covers all ten files. Linux and Windows packages are not
code-signed. SemVer prerelease suffixes produce GitHub prereleases, which the
updater ignores. Packaged `prod` builds check for updates on launch and every
six hours, download only after the user accepts, and install on restart.
AppImage, NSIS and the notarized macOS `.zip` self-update; `.deb` users are
notified and download the new package manually. Only arm64 macOS builds are
published, so Intel Macs receive no updates. `beta` and `dev` builds never
check for updates.

On macOS, download progress can remain at 100% while the native updater prepares
and validates the package. Restart becomes available only after that step finishes.
During installation, the updater controls the final exit and relaunch; preparation
errors leave the app running and can be retried from Settings.

If publication fails, inspect the workflow logs and retained draft. Do not move
tags, overwrite assets, or publish a draft without repeating checksum verification.
For a defective release, identify the affected version and issue a new patch/tag;
use [SECURITY.md](../SECURITY.md) for vulnerabilities. Warn users when a schema
change makes downgrade unsafe and point them to [backup/recovery](local-data.md).

## Bot server images

Each release also publishes `ghcr.io/antonioducs/maestrly-bot-gateway:<version>`
and `ghcr.io/antonioducs/maestrly-bot-instance:<version>` for Linux amd64 and
arm64. The tag uses the release version without `v`, including any prerelease
suffix (for example, `0.9.4` or `0.9.4-beta.1`). The workflow publishes no
`latest` tag. The GitHub Release cannot publish until both versioned images
contain both architectures.

After the first publication, make the `maestrly-bot-gateway` and
`maestrly-bot-instance` packages public in each package's settings on GitHub
(**Package settings → Change visibility**). This is a one-time setup so desktop
installations can pull the images without signing in.
For each release, inspect the published manifest, for example:

```sh
docker buildx imagetools inspect ghcr.io/antonioducs/maestrly-bot-instance:<version>
```
