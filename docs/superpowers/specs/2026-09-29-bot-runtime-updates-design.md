# Automatic Claude Code and Codex updates in bots

## Goal

Bots should get new Claude Code and Codex releases on their own, without waiting for a Maestrly release and without
interrupting work in progress. When Anthropic ships a model that needs a newer Claude Code, a bot should pick it up
within hours. The Mac shows which runtime versions each environment runs and can ask it to check for updates.

## Evidence

- A bot runs the Claude Code binary of its image. `resolve-claude.ts` prefers the SDK's platform package
  (`/opt/maestrly/node_modules/@anthropic-ai/claude-agent-sdk-linux-<arch>/claude`) over any system install, and
  `runtime-env.ts` sets `DISABLE_AUTOUPDATER=1`. On the development fleet the image shipped 2.1.263 while a newer
  `~/.local/bin/claude` (2.1.285) installed by hand was ignored.
- The remote model catalog lists `claude-opus-5-5` with `behavesAs: claude-opus-4-6` and no capabilities. With
  2.1.263, `supportedModels()` reports it with the Opus 4.6 profile (200k window, no `xhigh`); with 2.1.285, `opus`
  resolves to `claude-opus-5-5` with `xhigh`. The API rejects 2.1.263 for that model ("requires 2.1.280 or newer").
- The SDK handshake (`initializationResult()` then `supportedModels()`) works without credentials in a temporary
  `HOME`/`CLAUDE_CONFIG_DIR` (`tokenSource: none`, about 0.5 s, no model turn).
- `@anthropic-ai/claude-code-linux-<arch>@<v>` ships a byte-identical `claude` to
  `@anthropic-ai/claude-agent-sdk-linux-<arch>` of the SDK whose `claudeCodeVersion` is `<v>`. Its package version is
  the CLI version. npm dist-tags: `latest` and `stable` (about a week behind).
- Codex in a bot resolves `resources/codex` from the image (the unpackaged path) and startup skipped
  `startRuntimeAssetUpdates()` in bot mode, so it has the same problem.
- Bot egress only blocks private networks; `registry.npmjs.org` is reachable.

## Decisions

| Topic | Decision |
| --- | --- |
| Where | Bots only (`MAESTRLY_BOT_MODE=1`). On the Mac, Claude keeps coming from the system and Codex is unchanged. |
| Policy | Automatic by default in bots: a check 60 s after start, then every 6 h. It can be turned off in the bot's own Settings → Components. There is no update triggered by an error message. |
| Claude source | `https://registry.npmjs.org/@anthropic-ai/claude-code/latest`, then `@anthropic-ai/claude-code-linux-{arm64,x64}@<v>`. The tarball must be the canonical npm URL and carry a SHA-512 `dist.integrity`. Channel `latest`, the native installer's default and what the Mac runs. |
| Floor | A bot never runs a version older than its image. When the image is newer than the managed install, the image wins and the shadowed install is removed once nothing uses it. Only the major release of `CLAUDE_CODE_COMPATIBLE_VERSION` (2.x) is accepted. |
| Claude validation before activation | `claude --version` prints `<v> (Claude Code)`; the version is compatible; the SDK handshake without credentials lists at least one model; 60 s timeout. A failure rejects that version for automatic updates. |
| Nothing interrupted | Claude starts one process per turn: each query retains the executable it started with, and an old install is released when the last turn using it closes. Codex keeps one long connection: it stays on the old version and is recycled once no bot of the environment has a turn, a queue, a pending request or a compaction in progress. |
| After a switch | The Claude managers drop cached status, models and observed context windows (the stale 200k), and the renderer gets `models:catalog-changed`. |
| Server switch | `MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off` on the gateway sets `MAESTRLY_BOT_RUNTIME_UPDATES=off` in bot containers, like `MAESTRLY_GATEWAY_BOT_EGRESS`. It turns automatic checks off for container end-to-end tests and for servers that pin versions. Manual checks still work. |
| Disk | Up to about three Claude installs (about 240 MB each: current, previous and one still in use) plus Codex, in the bot's home volume. |

## Architecture

### Part 1: automatic updates in bots

- **Generic release channel.** The npm metadata helpers move out of `codex-releases.ts` into `npm-registry.ts`. A
  `RuntimeReleaseProfile` describes what differs between runtimes (id, supported targets, canonical artifact URL,
  target layout, size caps). `CodexReleaseStore` becomes `RuntimeReleaseStore`, driven by a profile, with an
  optional `automaticDefault` used only while nothing was ever persisted. `CodexUpdateController` becomes
  `RuntimeUpdateController`.
- **Image baseline.** The controller accepts a `baseline` that reports the runtime shipped outside the
  `RuntimeAssetService` (the bot image). It counts as installed and is never downgraded: the effective version is the
  newer of the managed install and the baseline. A managed install that is not newer than the baseline is removed
  when it is not leased.
- **Claude Code asset.** `claude-code-runtime` joins the runtime asset registry, pinned to the SDK's
  `claudeCodeVersion` for `linux-arm64` and `linux-x64`. It is listed and accepted over IPC only in bot mode.
- **Scheduling.** Controllers schedule checks in packaged apps (Codex, as before) and in bots unless
  `MAESTRLY_BOT_RUNTIME_UPDATES=off`. The bot's Settings → Components shows "Included in the bot image" while the
  image runtime is the one in use.
- **Claude selection.** In bot mode, `ClaudeRuntimeSelection` picks the managed install when it is strictly newer
  than the image, holding a runtime asset lease on it. Each query retains the selection it started with.
- **Codex selection.** In bot mode, the Codex manager resolves the managed install when it is strictly newer than the
  image and leases it. After an activation that leaves old connections behind, a scheduler recycles the Codex
  connections once every bot of the environment is idle, checking every 30 s.

### Part 2: versions on the Mac

- Each bot status reports `runtimes`: per runtime, version, source (`image` or `managed`), automatic flag, update
  state, available version, last check and error.
- The gateway keeps the latest report per environment and projects it as `FleetEnvironment.runtimes`, emitting
  `environment.updated` when it changes. A new gateway route forwards "check now" to the environment's instance.
- The environment view on the Mac shows a "Claude Code and Codex" section with each version and **Check for
  updates**.

## Protocol (version 1, additive)

- Feature `runtime-updates`: in `/v1/meta` (gateway) and in instance capabilities.
- `FleetRuntimeInfo`: `{ id: 'claude-code' | 'codex', version, source: 'image' | 'managed', automatic, state,
  availableVersion, lastCheckedAt, error }`, with `state` from the runtime asset update states.
- `FleetEnvironment.runtimes` and `FleetInstanceStatus.runtimes`: arrays, nullable, default `null` (a gateway or image
  that predates the feature).
- Instance `POST /v1/runtimes/check` answers `{ ok: true }` at once; the checks continue in the background.
- Gateway `POST /v1/environments/:eid/runtimes/check` answers the environment. An instance without the capability
  answers `CONFLICT`; a stopped environment `BOT_NOT_RUNNING`.

## Error handling

| Case | Behaviour |
| --- | --- |
| No network, npm unavailable | The check fails (`check-failed`); the bot keeps its current version and retries at the next cycle. |
| Integrity or validation failure | The version is rejected for automatic updates; a manual update can still try it. |
| Disk full | `disk-space`; nothing is activated. |
| A new version breaks later | Roll back in the bot's Components: the previous install is reactivated without a download. |
| Image newer than the managed install | The image is used; the managed install is removed once nothing uses it. |
| `MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off` | Bots do not check on their own; manual checks still work. |

## Testing

- **Desktop main:** the profile-driven store (identity, canonical URL, floor, automatic default); the controller with
  a baseline (installs above it, never at or below it, removes a shadowed install only when not leased, unchanged
  Codex behaviour without one); Claude release discovery against a strict fake registry (every rejection case);
  Claude validation with strict fakes (version, compatibility, empty model list, timeout, no credentials, temporary
  directory removed); bot-mode wiring (`provided`, schedule switch, default automatic, bot-only listing); Claude
  selection (retained turns keep their path and lease, concurrent refreshes); Codex bot resolution and the idle
  recycle scheduler.
- **Gateway:** configuration and container environment for the switch; runtime reports stored, projected and emitted
  only on change; the check route (forwarded, `CONFLICT`, `BOT_NOT_RUNNING`); `/v1/meta` features.
- **Protocol:** payloads without `runtimes` parse as `null`; round trip; invalid states rejected.
- **Renderer:** IPC gating and validation, preload contract, the environment view section in the fake-server e2e.
- **Containers (`test:e2e:bot-fleet`):** bots start with the switch off and download nothing.

## Out of scope

- Maestrly managing Claude Code on the Mac: it keeps using the system install.
- Updates triggered by a "requires Claude Code X" error.
- Removing the Claude binary from the published bot image. `THIRD_PARTY_NOTICES.md` says Maestrly does not
  redistribute it, yet the image includes it today; this needs a separate product and legal decision.
