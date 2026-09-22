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
| `apps/desktop/src/main/` | Electron services, IPC validation, persistence, processes, providers |
| `apps/desktop/src/preload/` | Typed bridge to the renderer |
| `apps/desktop/src/renderer/` | React desktop and styles |
| `apps/desktop/src/shared/` | Shared types, schemas, rules, and translation catalogs |
| `apps/desktop/test/unit/`, `apps/desktop/test/e2e/`, `tests/policy/` | Unit, Electron, and repository checks |
| `scripts/` | Development, runtime, packaging, and verification tools |
| `apps/desktop/runtime-assets/`, `apps/desktop/resources/`, `config/` | Runtime inputs, packaged assets, and configuration |

## Platform workspaces

`apps/web`, `apps/server`, and `apps/runner` build independently. Use the root `dev:web`, `dev:server`, `dev:runner`, and corresponding `build:*` commands. Contracts live in `packages/protocol`, `packages/client-sdk`, and `packages/runner-core`. See [self-hosting](self-hosting.md). Desktop-only commands below can be invoked with `--workspace @maestrly/desktop` from the repository root.

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

### Opus 5 harness evaluation

Model-specific harness behavior is declared in profile folders; see
[Harness profiles](harness-profiles.md) for the format and how to add a model.

The versioned `maestrly-opus-5-v1` profile applies to exact `claude-opus-5`
identities, including aliases resolved to that identity by the Claude runtime.
The internal `chat.opus5Profile` flag defaults to enabled. Disabling it selects
the legacy prompt for new admissions; frozen review executions retain their
recorded profile. Fable and Astra keep their own profiles.

The Opus profile calibrates scope, narration, delegation, and Ultra instructions.
Required user/project checks still apply. It does not change selected effort,
provider permissions, or concurrency limits. Claude SDK sessions carry changing
environment data in transient turn context; API requests add it to the latest
user message without persisting it or changing the system prompt.

For an opt-in live comparison, use a disposable repository and the same starting
commit, task, provider, model, effort, and tool catalog for both flag values.
Start fresh conversations after toggling the flag; do not reuse frozen executions
or warmed sessions across variants. Include a small bug fix, a multi-file feature,
a code review, and a long task continued after compaction. Repeat each variant
at `low`, `medium`, `high`, and `xhigh`; measure Ultra separately because it also
changes orchestration. Record:

- Completion against task acceptance checks and unintended changes.
- Wall time and total tokens/cost, including subagents and cache usage.
- Delegation count, repeated checks, and unnecessary user interruptions.
- Continuity of constraints, completed work, and rejected attempts after resume.

Unit tests cover profile selection, frozen identity, prompt isolation, and
session continuity. They do not measure model quality or establish a cost or
latency improvement. The prompting basis is Anthropic's
[Opus 5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
and [effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort).

## Runtimes and icons

Optional provider assets can be installed through app settings or the scripts
`fetch-codex-runtime.mjs`, `fetch-github-copilot-runtime.mjs`, and
`fetch-tunnel-client.mjs` in `scripts/`. These select a target and verify pinned
metadata or integrity. For models and offline setup, see the
[Local ML guide](../apps/desktop/runtime-assets/local-ml/README.md).

The Codex pin in `apps/desktop/src/main/runtime-assets/registry.ts`, the
`@openai/codex` development dependency, and `fetch-codex-runtime.mjs` stay
synchronized; they define the version used in development and tests and the
minimum version a build accepts. Installed apps can move past the pin without a
Maestrly release: **Settings › Maestrly Chat › Components › Codex runtime**
checks the latest stable npm release, installs it beside the active version
after a local compatibility check, and can return to the previous version.
Checking is manual by default; packaged builds also check about a minute after
startup and every six hours while the component is installed, and install
automatically only when the user enables it. Development and E2E runs never
check in the background. Conversations already open keep their runtime until
Maestrly restarts.

The compatibility check lives in `runtime-assets/codex-compatibility.ts`.
Increase `CODEX_COMPATIBILITY_REVISION` when the app starts depending on a new
Codex contract, so independently installed releases are validated again. The
opt-in smoke `RUN_RUNTIME_ASSET_SMOKE=1 npx vitest run
test/unit/runtime-assets-real-smoke.test.ts` (from `apps/desktop`) downloads the
official artifacts and exercises install, update, validation, and rollback
without credentials.

Copilot login needs a distributor-owned public OAuth Client ID:
`MAIN_VITE_GITHUB_COPILOT_CLIENT_ID` at package build time, or
`MAESTRLY_GITHUB_COPILOT_CLIENT_ID` for unpackaged development.

Icons are checked in. Regenerate on macOS with `npm run icon`, `icon:beta`, or
`icon:dev`; the converter uses `apps/desktop/resources/icon.png` or `MAESTRLY_ICON_SOURCE`.
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

## Cursor SDK packaging and checks

Cursor is pinned to `@cursor/sdk` 1.0.31. Postinstall fetches the host helper;
`fetch-cursor-sdk-platform.mjs` verifies its npm archive against a committed
SHA-512 pin before extraction. Update the runtime platform hash table and the
fetcher's pins together when upgrading. The package wrapper stages only the
selected target helper, restores the host helper after cross-builds, and runs
`verify-packaged-cursor-sdk.mjs` on unpacked apps and installers. Native binaries
and vendor files live outside ASAR. Windows ARM64 ships no Cursor helper and
reports the provider as unavailable without blocking the application build.

After a native package build, also run this offline check from the repository root:

```sh
node scripts/smoke-packaged-cursor-sdk.mjs
```

It launches the packaged Electron app with a temporary profile, loads the shipped
SDK, writes and reopens an SDK SQLite record, and executes the shipped `rg`.
An optional first argument selects an executable. Use `xvfb-run -a` on headless
Linux. The existing desktop and Local ML packaged smokes remain required.

The authenticated check starts live runs and requires both explicit opt-in and a
model ID from the Cursor catalog. To use the browser login flow:

```sh
MAESTRLY_CURSOR_LIVE_SMOKE=1 npm run smoke:cursor-sdk-authenticated -- --model MODEL_ID --login
```

With a dedicated `CURSOR_API_KEY` already supplied in the environment, omit
`--login`. `MAESTRLY_CURSOR_SMOKE_MODEL` can supply the model instead of `--model`.
The check discovers models, invokes a harmless host tool, closes and reopens the
SDK SQLite store, resumes the same agent and recovers a receipt from its history,
then cancels another run and checks local logout and cleanup. All state is
isolated in a temporary directory and an in-memory credential store. Browser
login mints a one-hour key; local logout clears the temporary credential store.
It never reads credentials from an existing Maestrly or global Cursor profile.
See [Cursor usage](cursor.md) for account setup and platform support.
