# Linux bot runtime

Private JSONL worker for one bot session. In a shared VM, `vm/main.ts` supervises
multiple unprivileged workers with private desktops and files, with delegated shared authentication
([details and validation](../../docs/bot-runtime/shared-vm-validation.md)). The
following defaults describe the retained legacy single-session transport. Start the built service with
`node apps/bot-runtime/dist/main.js`. State defaults to `/var/lib/maestrly-bot`,
workspace to `/home/maestrlybot/workspace`, and the control port to
`/dev/virtio-ports/org.maestrly.bot.control.0`.

Environment overrides: `MAESTRLY_BOT_STATE`, `MAESTRLY_BOT_WORKSPACE`,
`MAESTRLY_BOT_CONTROL_PATH`, `MAESTRLY_BOT_BOOT_ID` (UUID),
`MAESTRLY_BOT_PROVIDER` (`codex` or `fixture`), `MAESTRLY_CODEX_BINARY`,
`MAESTRLY_BOT_PROXY_PORT`, `MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS`.
Fixture mode is refused when `MAESTRLY_BOT_PACKAGED=1` **or** `installed.json`
exists in the state directory.

The journal fsyncs acceptance before replying, retains unacknowledged events,
and records interaction intent before delivering any approval. Reconnection
increments the persisted generation. Restarted active turns are interrupted,
never executed again. Turns have host leases, active time and tool limits.
The file service stages writes beside the destination and publishes atomically;
non-overwrite publication uses link/unlink to avoid rename's replacement race.
`expectedDigest` verifies the whole incoming file before publication.

The VM has no network interface. `network/serial-transport.ts` multiplexes bounded
JSONL streams over `/dev/virtio-ports/org.maestrly.bot.egress.0` (override
`MAESTRLY_BOT_EGRESS_PATH`; Unix sockets work in tests). Channel loss destroys
streams, fails closed, and schedules reconnection. Stream ids never repeat during
a runtime lifetime. Guest writes respect a 512 KiB per-stream window and the
4 MiB VM budget. The local proxy binds only to 127.0.0.1, prechecks offline mode,
exact allowlisted hostnames and ports 80/443, and refuses loopback with LOCAL_ONLY.
The Host remains the authoritative network enforcer.

The runtime owns the tools registry, approval hooks and process groups. Codex
launches `dist/tools/mcp-main.js`, a JSONL MCP stdio forwarder to the mode-0600
`<state>/tools.sock`. Registration follows Codex's `config.toml` keys
`mcp_servers.<name>.command/args/env`. `MAESTRLY_BOT_MCP_MAIN` selects the bundled
entry; `MAESTRLY_BOT_TURN_ID` binds calls to their active turn. Request ids dedupe
effects within the runtime; journaled ids from a prior process return REPLY_LOST
instead of replaying an effect. A disconnected bridge does not automatically replay.
Snapshot and screenshot responses include observationId; clicking and typing
against a ref, and coordinate clicking, require the latest id. Actions,
navigation, browser closure and provider restart invalidate it.

Browser tools use headful sandboxed Chromium on Xvfb :10. The binaries default to
`/opt/maestrly-bot/chromium/chrome` and `/usr/bin/Xvfb`, overridden by
`MAESTRLY_CHROMIUM_BINARY` and `MAESTRLY_XVFB_BINARY`. The desktop service owns
the packaged display; development sessions supervise Xvfb and optional openbox.
There is no exposed CDP/VNC port. Chromium's configured bypass list is
`127.0.0.1;localhost;<-loopback>`; direct local fixture navigation also supports
workspace file URLs. Downloads land in `<workspace>/downloads`; screenshot
artifacts land in `<workspace>/.maestrly/screens` and emit file.produced.
Computer tools observe and control the full X11 desktop using scrot and xdotool; browser tools retain Playwright semantics.
Missing binaries produce BROWSER_UNAVAILABLE and omit desktop/browser capabilities.

In ask mode, system_exec requests explicit root approval; full-vm uses the existing
broad grant. It executes argv through `sudo -n` and the fixed installed helper,
with 64 KiB captured output, a five-minute timeout and cancellable process groups.
`MAESTRLY_BOT_HELPER` overrides the helper path. Command regexes are not a sandbox.
files_deliver uses the file service's bounded-path validation and streaming SHA256.
memory_propose only emits a proposal event; the person decides whether to remember.

See [shared account authentication](../../docs/bot-runtime/shared-accounts.md) for the persistent Host authority, memory-only worker login and migration of legacy credentials.

## Private Linux Arm64 bundles

Run `npm run build:bot-runtime:bundle` with `MAESTRLY_BOT_BUILD_CONFIG` pointing to
a private JSON manifest. Without it, the builder exits 1 with BUILD_CONFIG_REQUIRED.
It never downloads inputs. Example shape:

```json
{
  "architecture": "arm64",
  "version": "0.1.0",
  "nodeVersion": "22.23.2",
  "files": [
    { "path": "runtime/bin/node", "sha256": "<64 lowercase hex>", "license": "MIT", "source": "<provenance>" },
    { "path": "codex/bin/codex", "sha256": "<64 lowercase hex>", "license": "<license>", "source": "<provenance>" },
    { "path": "chromium/chrome", "sha256": "<64 lowercase hex>", "license": "<license>", "source": "<provenance>" }
  ]
}
```

List every Chromium resource/library and associated license input as well.
Paths resolve beside the manifest, or under optional absolute `inputDirectory`.
The builder verifies each digest with host-build-utils.verifyInput and verifies the
three executable ELF headers are Arm64. It bundles JavaScript, copies pinned
playwright-core with its license, and produces
`dist/bot-runtime/maestrly-bot-runtime-<version>-arm64.tar` plus its manifest.
The declared Node version cannot be executed/qualified on the controller;
target qualification remains required. The manifest explicitly records
`built-on-controller-not-qualified-on-target`.

The tar includes root `./install.sh`, as required by host-core's guest installer.
The installer accepts exactly `--bundle`, `--sha256`, `--version`, verifies
SHA256 before changes, refuses symlink destinations, stages under /opt and retains
the previous install. A pre-existing .previous directory is retained and stops
a subsequent update until an administrator moves it. It preserves home and state.
It installs the narrow-path sudoers rule, udev rule and systemd services, enables
them without assuming networking, and records both
`/var/lib/maestrly/bot-runtime/installed.json` (Host contract) and
`/var/lib/maestrly-bot/installed.json` (fixture-mode guard).
`MAESTRLY_BOT_INSTALL_ROOT` is test-only: it prefixes all destinations and skips
user/group creation, systemctl and udevadm. It must never be set in a real install.

Browser/computer integration tests run only when both binary overrides are set.
All other tests use local fake brokers, bridges and helpers without external access.

Known Host contract limitation: its sender pauses after exceeding STREAM_WINDOW,
so it can exceed 512 KiB by a socket chunk. The guest sender never exceeds that
window; the receiver remains bounded by the VM budget. Host schemas live privately
in host-core, so the guest validates matching frames locally without a forbidden
host-core dependency.

## Shared-contract notes

1. The Host welcome echoes `hello.nonce`; the runtime validates the echo strictly.
2. The shared Codex client preserves a numeric `code` thrown by the server-request
   handler, so unsupported methods are answered with wire `-32601`.
3. With `minimalEnvironment: true`, explicit env wins after prefix removal, so
   `CODEX_` and `OPENAI_` are both excluded while `CODEX_HOME` stays managed.

## Codex v2 method assumptions

Client requests: `initialize`, `initialized` (notification), `account/read`,
`account/login/start` (`chatgptDeviceCode` or `apiKey`), `account/login/cancel`,
`account/logout`, `model/list`, `thread/start`, `thread/resume`, `turn/start`,
`turn/interrupt`.

Notifications: `account/login/completed`, `item/agentMessage/delta`,
`item/started`, `item/completed`, `turn/completed`, `error`, `turn/error`,
`thread/tokenUsage/updated`. Completion statuses `completed`, `interrupted`,
and `failed` map to `succeeded`, `interrupted`, and `failed` respectively.

Server requests: `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/tool/requestUserInput`, and names
ending in `requestUserInput`. Approval replies use `{decision:'accept'|'decline'}`,
verified against the Codex 0.153.4 generated schema.
Question replies assume `{answers:{[questionId]:{answers:[text]}}}`. Device login
responses lack an expiry in the shared types, so pending logins use a ten-minute
local expiry estimate. Only HTTPS verification links on `auth.openai.com` or
`chatgpt.com` are accepted. Recent history is included only when creating a new
thread, including RPC-error fallback after a failed resume.

Run `npm run check:bot-runtime`, `npx biome lint apps/bot-runtime`, and
`node scripts/check-boundaries.mjs`. Tests use temporary directories, Unix
sockets, and a local Node app-server fixture; no real account or VM is needed.

## Reproducible acquisition on the controller

The controller can acquire all inputs without a user-provided manifest:

```sh
node scripts/fetch-bot-runtime.mjs dist/bot-inputs-20260913 0.1.0-20260913
MAESTRLY_BOT_BUILD_CONFIG=dist/bot-inputs-20260913/build-config.json node scripts/build-bot-runtime.mjs
```

Use a new destination and version for each run. Acquisition refuses existing
output directories, preserves failed downloads for inspection, and pins Node
22.23.2, desktop Codex 0.153.4, and Playwright 1.62.1 Chromium revision 1234 for
Ubuntu ARM64. Node is verified against the official HTTPS checksum list (not its
signature); Codex against the desktop fetcher's SHA512. Chromium's checked-in
SHA256 was observed from the official Playwright CDN, not an independently
published checksum. Archive URLs, resolved URLs, verification basis, and digests
are retained in the generated build config and bundle manifest. Chromium includes
its full resource tree; Node includes its license and Codex includes LICENSE/NOTICE.

Build outputs now live under `dist/bot-runtime/<version>/`; alternatively set
`MAESTRLY_BOT_BUILD_OUTPUT` to a new directory. Existing successful or partial
outputs are never overwritten. The numeric resource profile is explicitly an
**unmeasured planning estimate**, not a measured minimum. This is a runtime bundle,
not an Ubuntu image: guest GUI packages and Linux execution qualification remain
separate requirements.
