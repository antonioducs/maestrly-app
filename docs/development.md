# Development

## Setup

Use Git, Node.js 22.15–22.x, npm 10 or newer, and the committed lockfile.
Native modules also need the host toolchain when a prebuilt binary is unavailable:

- macOS: Xcode Command Line Tools.
- Linux: Python 3, `make`, and a C/C++ compiler. On supported Debian/Ubuntu hosts,
  `npx playwright install-deps chromium` installs Electron test libraries.
- Windows: Python 3 and Visual Studio Build Tools with Desktop development with C++.

```sh
npm ci
npm run hooks:install
npm run dev
```

Postinstall prepares Electron and native dependencies. Development uses an isolated
`maestrly-app-dev-<instance>` profile and detects instance collisions. Close dev
instances before running `npm run clean:dev`, which removes development profiles
and build caches. See [Local data](local-data.md) before resetting or moving profiles.

## Layout

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron services, IPC validation, persistence, processes, providers |
| `src/preload/` | Typed bridge to the renderer |
| `src/renderer/` | React desktop and styles |
| `src/shared/` | Shared types, schemas, rules, and translation catalogs |
| `test/unit/`, `test/e2e/`, `tests/policy/` | Unit, Electron, and repository checks |
| `scripts/` | Development, runtime, packaging, and verification tools |
| `runtime-assets/`, `resources/`, `config/` | Runtime inputs, packaged assets, and configuration |

## Checks

```sh
npm run check
npm run test:e2e
```

`check` runs TypeScript, Biome, unit/policy tests, Markdown links, and the build.
Individual commands include `typecheck`, `lint`, `test:unit`, `test:policy`,
`test:docs`, and `build`. Build output goes to `out/`.

Tests use temporary profiles and synthetic projects. Real provider/runtime tests
must be opt-in; do not use personal credentials or data in fixtures. Electron tests
run serially and isolate Git configuration.

Run `npm run audit:dependencies` for dependency changes; it consults the live npm
advisory service. Exact, expiring exceptions live in
[config/npm-audit-allowlist.json](../config/npm-audit-allowlist.json).
For workflow/security automation changes, also run:

```sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
go run github.com/zricethezav/gitleaks/v8@v8.30.1 git . --config .gitleaks.toml --no-banner --redact
```

## Runtimes and icons

Optional provider assets can be installed through app settings or the scripts
`fetch-codex-runtime.mjs`, `fetch-github-copilot-runtime.mjs`, and
`fetch-tunnel-client.mjs` in `scripts/`. These select a target and verify pinned
metadata or integrity. For models and offline setup, see the
[Local ML guide](../runtime-assets/local-ml/README.md).

Copilot login needs a distributor-owned public OAuth Client ID:
`MAIN_VITE_GITHUB_COPILOT_CLIENT_ID` at package build time, or
`MAESTRLY_GITHUB_COPILOT_CLIENT_ID` for unpackaged development.

Icons are checked in. Regenerate on macOS with `npm run icon`, `icon:beta`, or
`icon:dev`; the converter uses `resources/icon.png` or `MAESTRLY_ICON_SOURCE`.
Preserve asset licenses and attribution.

## Packaging

Build one target at a time on a matching host, using a separate checkout for
concurrent targets:

| Command | Target |
| --- | --- |
| `npm run package` | macOS arm64, ad-hoc signed app |
| `npm run package:linux` | Linux x64, AppImage and DEB |
| `npm run package:win` | Windows x64, per-user NSIS installer |

Beta and additional architecture commands are in [package.json](../package.json).
Windows/Linux arm64 require compatible native dependencies and are not verified
release targets; see the Local ML guide for cross-build limits.

For explicit channel/target selection, use
`node scripts/package.mjs <prod|beta|dev> <electron-builder arguments>`.
The wrapper builds and verifies Local ML, builds the app, checks package contents
and size, and passes `--publish never`. Do not invoke electron-builder directly.
After packaging on the target host, run:

```sh
npm run smoke:packaged-desktop
npm run smoke:packaged-local-ml-runtime
```

Prefix both commands with `xvfb-run -a` on headless Linux. Smokes use disposable
profiles; the desktop smoke accepts an explicit executable path when run directly
as `node scripts/smoke-packaged-desktop.mjs <executable>`.
Signed publication follows [Releasing](releasing.md).

## Troubleshooting

- Node or native-module mismatch: check `.nvmrc` and host architecture, then run
  `npm ci` with the required compiler tools installed.
- Instance collision: use or close the existing window; do not remove a live lock.
- Missing provider: check its settings, authentication, and installed runtime.
- Foreign runtime in packaging: use a clean checkout for a single target.
- Migration/reset error: close the app and preserve the complete profile; follow
  [recovery instructions](local-data.md) using a copy.
