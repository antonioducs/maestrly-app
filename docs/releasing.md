# Releasing

Maestrly App publishes native artifacts through a maintainer-triggered tag
workflow. No public binary exists until an authorized version tag is pushed, and
there is no automatic update channel. This guide is the maintainer checklist for
preparing and validating a `0.x` release; publishing authority, signing
credentials, and the decision to create a public release remain separate
controls.

## Version policy

The project follows Semantic Versioning with `vMAJOR.MINOR.PATCH` tags:

- increment `MINOR` for a backward-compatible feature set or an intentionally
  documented `0.x` compatibility break;
- increment `PATCH` for backward-compatible fixes and security updates; and
- document storage, migration, provider, security, privacy, and platform changes
  under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).

Do not create, move, or advertise a tag until a publication review explicitly
authorizes it. A version in package metadata is not proof of a published release.

## Release preflight

1. Start from a reviewed `main` commit with a clean worktree and successful
   Linux, macOS, Windows, Dependency policy, and Secret history checks.
2. Confirm the repository visibility and intended audience. Do not expose a
   private repository as an incidental part of release automation.
3. Move completed changelog entries from `[Unreleased]` into a dated version and
   add a fresh empty `[Unreleased]` section.
4. Align the version in `package.json`, `package-lock.json`, application metadata,
   provider client identifiers that intentionally use the app version, and
   runtime manifests whose schema is tied to the release. Do not change
   third-party protocol versions only because the app version changed.
5. Review [PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md), the
   [security model](security-model.md), [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md),
   direct/transitive dependencies, downloadable runtimes, and packaged notices.
6. Test profile migration, export, reset, and startup recovery using synthetic
   copies representing every supported upgrade path. Never test against the sole
   copy of real user data.
7. Resolve or explicitly disclose known platform, provider, migration, signing,
   and rollback limitations.

Install from the committed lockfile and run:

```sh
npm ci
npm run audit:dependencies
npm run check
npm run test:e2e
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
go run github.com/zricethezav/gitleaks/v8@v8.30.1 git . --config .gitleaks.toml --no-banner --redact
```

## Native packages

Build each advertised target on a matching clean host or runner. Packaging
mutates target-specific staging and native dependency directories, so use a
separate checkout for concurrent targets.

```sh
# macOS arm64 validation app
npm run package

# Windows x64 NSIS installer
npm run package:win

# Linux x64 AppImage and DEB
npm run package:linux
```

The package wrapper builds and verifies the target Local ML archive, builds
Electron output, inspects ASAR/resources, requires expected installer formats,
and checks bundle-size/leakage budgets. It always appends `--publish never`.

An approved tagged release publishes exactly these deterministic assets:

- `Maestrly-App-<version>-linux-x64.AppImage`;
- `Maestrly-App-<version>-linux-x64.deb`;
- `Maestrly-App-<version>-windows-x64.exe`;
- `Maestrly-App-<version>-macos-arm64.dmg`;
- `Maestrly-App-<version>-macos-arm64.zip`; and
- `SHA256SUMS.txt`, covering the five native artifacts.

The macOS files contain the signed and notarized application. The Linux and
Windows files are native validation builds but are not currently code-signed.

If GitHub Copilot login is included in a distribution, provide
`MAIN_VITE_GITHUB_COPILOT_CLIENT_ID` from an OAuth App owned by the distributing
project or organization. The identifier is public but must not be borrowed from
a maintainer's personal OAuth App.

After each native build, run on that host:

```sh
npm run smoke:packaged-desktop
npm run smoke:packaged-local-ml-runtime
```

The desktop smoke uses a temporary profile and synthetic Git project, exercises
a real native terminal, and closes the app. The Local ML smoke loads the packaged
archive and native ONNX/Sharp modules through Electron. On headless Linux, run
both commands through `xvfb-run -a`.

Inspect the generated bundle-size JSON, package contents, executable
architectures, app identity, icons, microphone usage text, the project license,
third-party notices, and absence of source, environment files, foreign runtimes,
credentials, or build staging.

## macOS signing and notarization

`npm run package` is ad-hoc signed and is not distributable as a trusted public
release. A release candidate uses `electron-builder.release.yml` and requires a
Developer ID Application identity plus App Store Connect notarization settings.

Keep certificate and API-key material in the maintainer's Keychain or a protected
CI release environment. Never commit or print it. The supported environment
names are:

- `CSC_NAME` and either an available Keychain identity or `CSC_LINK` with
  `CSC_KEY_PASSWORD`;
- `APPLE_API_KEY`;
- `APPLE_API_KEY_ID`; and
- `APPLE_API_ISSUER`.

The protected GitHub `release` environment stores `CSC_LINK` as a base64
PKCS#12 file and `APPLE_API_KEY` as a base64 App Store Connect `.p8` file.
`CSC_NAME` contains the certificate name and team identifier without the
`Developer ID Application:` prefix. Provision file secrets through stdin and
enter string secrets at the interactive prompt:

```sh
base64 < "$P12_PATH" | tr -d '\n' | gh secret set CSC_LINK --env release -R antonioducs/maestrly-app
base64 < "$P8_PATH" | tr -d '\n' | gh secret set APPLE_API_KEY --env release -R antonioducs/maestrly-app
gh secret set CSC_KEY_PASSWORD --env release -R antonioducs/maestrly-app
gh secret set CSC_NAME --env release -R antonioducs/maestrly-app
gh secret set APPLE_API_KEY_ID --env release -R antonioducs/maestrly-app
gh secret set APPLE_API_ISSUER --env release -R antonioducs/maestrly-app
```

Never paste these values into issues, pull requests, logs, repository variables,
chat, or command-line arguments. The release workflow decodes them only under
`RUNNER_TEMP`, imports the certificate into a temporary keychain, and removes
the keychain and files even when packaging fails.

Run the preflight and signed package command only in an authorized release
checkout:

```sh
node scripts/preflight-mac-signing.mjs
npm run package:release
```

Verify the final `.app`, DMG, and ZIP architecture and identity. Submit the exact
distributable to Apple's notarization service, wait for acceptance, staple where
supported, and assess it with `codesign`, `spctl`, and `xcrun stapler`. Do not
publish an ad-hoc signature or a package notarized from different bytes.

## Windows and Linux release checks

For Windows, install the NSIS artifact as a non-administrative user, verify the
per-user destination, launch/uninstall behavior, native PTY, Local ML, provider
runtime discovery, long paths, non-ASCII paths, and cleanup after restart.

For Linux, test both AppImage and DEB on clean supported distributions. Verify
desktop metadata, executable permissions, sandbox/runtime library behavior,
native PTY, Local ML, browser/editor launch, and uninstall without removing user
projects.

CI package smokes are prerequisites, not substitutes for clean-machine testing.
Advertise only the operating systems and architectures exercised against the
exact candidate bytes.

## Checksums and provenance

The release workflow generates SHA-256 checksums only after signing,
notarization, and final packaging. It creates a draft, re-downloads every
uploaded asset, verifies `SHA256SUMS.txt`, and publishes the draft only after
the downloaded bytes pass. A manual release must apply the same process before
announcement.

Lockfiles, runtime manifests, package reports, and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) are the current component
inventory. A future SBOM or signed provenance attestation must be validated
against actual package contents before it is advertised.

## Publication

The checked-in `Release` workflow runs only when a maintainer pushes an
annotated `v*` tag. The tag must be valid Semantic Versioning, match
`package.json` and `package-lock.json`, and resolve to a commit reachable from
protected `main`. Merge the version and changelog update before creating it:

```sh
git switch main
git pull --ff-only
npm ci
npm run audit:dependencies
npm run check
npm run test:e2e
git tag -a v0.1.0 -m "Maestrly App v0.1.0"
git push origin v0.1.0
```

The workflow rechecks the source, builds on native Linux, Windows, and arm64
macOS runners, runs both packaged smokes, signs and notarizes macOS, stages only
the five expected files, and publishes them with checksums. Tags containing a
SemVer prerelease suffix create a GitHub prerelease.

Publication starts as a draft only after all native jobs succeed. If upload or
verification fails, inspect the retained draft and the workflow logs; never
overwrite assets with `--clobber`, silently replace a failed candidate, move
the tag, or publish the draft manually without repeating verification. A
successful tagged release does not enable a mandatory updater or hosted
Maestrly dependency.

## Rollback and security response

If a release is defective, preserve the audit trail, mark the affected version
clearly, remove a dangerous download when necessary, and issue a new reviewed
patch with a new tag and checksums. Document whether profile/schema changes make
downgrade unsafe.

For a compromised artifact, dependency, token, signing key, or certificate:

1. stop publication and distribution;
2. rotate or revoke the affected material with its owner;
3. identify exact versions, hashes, platforms, and exposure windows;
4. prepare fixed, fully revalidated artifacts through the confidential security
   process; and
5. tell users how to identify and replace the affected files.

Never conceal a replacement behind an existing checksum or tag.
