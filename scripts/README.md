# Local desktop build tools

Use npm and the repository lockfile. `postinstall.mjs` ensures Electron is installed
and rebuilds native application dependencies. It does not fetch optional provider
runtimes. Fetch those explicitly with `fetch-codex-runtime.mjs`,
`fetch-github-copilot-runtime.mjs`, or `fetch-tunnel-client.mjs`; each tool
supports target selection and pins its upstream version and integrity. Provider
setup inside the application is also available.

## Packaging

Use `node scripts/package.mjs <prod|beta|dev> <electron-builder arguments>`.
Choose one target OS and architecture per invocation, for example:

```sh
node scripts/package.mjs prod --mac --arm64
node scripts/package.mjs beta --win --x64
node scripts/package.mjs dev --linux --x64
```

The wrapper selects the channel configuration, builds and verifies Local ML,
stages the target archive, builds the application, and verifies packaged assets,
legal notices, and size budgets. Run packaging jobs in separate checkouts:
staging and native dependency installation mutate shared build directories.

Local ML must be built on a supported target host (macOS arm64 to Windows x64 is
the one supported cross-build). See [the runtime guide](../runtime-assets/local-ml/README.md)
for model-cache preparation and offline installation.

The default macOS package is an ad-hoc signed `.app`; Windows uses a per-user NSIS
installer; Linux generates AppImage and DEB packages. Configuration inheritance
preserves separate app IDs, executable names, and icons for each channel. Every
package invocation passes `--publish never` and all checked-in builder
configurations disable publication. The separate tag-only GitHub workflow stages
and publishes verified files after native packaging completes. Updates are
installed manually.

Optional signed macOS distribution uses `electron-builder.release.yml` or
`electron-builder.release.beta.yml`. Supply your own `CSC_NAME`, certificate
(or `CSC_LINK` and `CSC_KEY_PASSWORD`), `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER`. Run `node scripts/preflight-mac-signing.mjs`, then:

```sh
node scripts/package.mjs prod --mac dmg zip --arm64 --config electron-builder.release.yml
```

The protected `release` environment stores the PKCS#12 certificate and App Store
Connect key as base64 secrets. The release workflow materializes them only in
`RUNNER_TEMP`, uses a temporary keychain, verifies and notarizes the exact
distributables, and removes all temporary signing material. No feed bucket or
minimum-version gate is included. Size budgets are provisional for this edition:
measure actual distributable artifacts before promoting a target to a measured
baseline.

Local commands produce validation packages only. A source build, ad-hoc macOS
signature, or successful package smoke is not a supported release. An official
release requires an annotated, version-aligned tag reachable from protected
`main`, successful native jobs, signed/notarized macOS artifacts, and verified
checksums. Follow the full maintainer checklist in
[`docs/releasing.md`](../docs/releasing.md).

## Profiles and developer utilities

`dev.mjs` launches a separate `maestrly-app-dev-<instance>` profile and detects
instance collisions. `clean-dev.mjs` deletes only this edition's dev profile prefix
and local build caches; close development instances before running it. The original
`maestrly`, `maestrly-beta`, and `maestrly-dev` profiles are outside that prefix.

`convert-icon.mjs` uses the checked-in `resources/icon.png` or an explicit
`MAESTRLY_ICON_SOURCE` PNG. It requires macOS image tools; generated icons for every
OS are already checked in. Third-party asset licenses remain under `resources/`.

## Packaged smoke checks

After packaging, run:

```sh
npm run smoke:packaged-desktop
npm run smoke:packaged-local-ml-runtime
```

The desktop check launches the packaged executable with a temporary profile,
creates a disposable Git project and conversation, executes a command in a real
native terminal, verifies its output, and closes the app. Pass an explicit
executable path to `scripts/smoke-packaged-desktop.mjs` for another channel.
The ML check verifies native ONNX/Sharp loading in Electron's utility process.
Neither check opens an existing user profile or authenticates a provider. The
macOS desktop test selects a mock keychain at process launch so repeated ad-hoc
builds do not request access to the operating system keyring. This flag is limited
to the test launcher; normal application credential storage remains encrypted.
