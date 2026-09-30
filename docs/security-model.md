# Security Model

This document describes the intended security properties of Maestrly App `0.x`.
It is a design model, not a guarantee that the software is free of
vulnerabilities. Report discrepancies privately through
[SECURITY.md](../SECURITY.md).

## Assets and goals

Maestrly App is designed to protect:

- provider API keys, subscription sessions, OAuth tokens, and local capability
  tokens;
- conversations, prompts, generated assets, usage records, notes, memory, and
  project metadata;
- repositories, worktrees, uncommitted changes, terminals, and command output;
- Maestro plans, worker results, and permissions;
- browser sessions, configured MCP transports, skills, and external tool results;
- SQLite integrity and recoverable profile migrations; and
- packaged application/runtime provenance and file boundaries.

The primary risks are renderer-to-main privilege escalation, unintended command
or network execution, cross-project disclosure, credential leakage, destructive
filesystem operations, provider-native capability escape, malicious MCP/skill
content, loopback service exposure, and substituted package/runtime assets.

## Assumptions and non-goals

The model assumes the operating-system user account, credential protection,
application files, and running Electron process have not already been
compromised. It does not defend local data from an attacker who can read or
modify the user's profile, inject into the process, replace trusted executables,
control the OS, or approve a dangerous operation as the user.

Maestrly App is a single-user developer workspace. Projects and conversations
are organizational scopes, not multi-tenant security boundaries. It is not a
sandbox for mutually hostile repositories, MCP servers, skills, commands, web
pages, or AI providers. Use separate operating-system accounts or machines when
that isolation is required.

## Trust boundaries

| Boundary | Sensitive input | Primary controls |
| --- | --- | --- |
| React renderer to preload/main | IDs, paths, settings, messages, tool intent | Context isolation, no Node integration, named preload API, schema/main-process validation |
| Main process to SQLite/filesystem | Persisted content, migrations, assets, reset/export operations | Transactions, savepoints, validated paths, recoverable staging, explicit confirmation |
| Main process to Git/terminal | Repositories, arguments, environment, command output | Structured process arguments, project binding, permission broker, lifecycle ownership |
| Main process to embedded browser | URLs, cookies, downloads, site permissions, popups | Separate partition, navigation guards, denied permissions, isolated companion/OAuth surfaces |
| Main process to MCP/skills | Tool schemas, commands, files, remote responses, installed content | Explicit configuration/install, lazy lifecycle, schema validation, permission and project scope |
| Main process to AI providers | Prompt, context, tool results, attachments, account state | User-enabled provider, host-owned tools, permission modes, redaction, bounded context |
| Main process to Local ML | Model/runtime archive and inference payload | Target manifest, critical-file verification, utility process, package checks |
| Loopback clients to local services | Editor or ChatGPT Web bridge requests | Loopback bind, random capability token, session lifecycle, restricted host/path |
| Fleet environment to gateway and other environments | Bot calls, screen input, network traffic, provisioned secrets | Separate container, home volume, keyring and control token per environment; per-bot gateway token; loopback-only VNC; screen tickets and takeover |

## Renderer and IPC boundary

The primary application renderer has `contextIsolation: true` and
`nodeIntegration: false`. It receives named functions through `window.api`.
Sensitive IPC handlers parse renderer input in the main process; renderer-side
validation exists for usability, not authority.

The primary trusted renderer, floating windows, and some tool panels currently
use `sandbox: false` because their preloads and native integrations need Electron
capabilities. This increases the importance of context isolation, navigation
blocking, dependency hygiene, content sanitization, and the narrow preload API.
OAuth popups and ChatGPT visual/companion surfaces use sandboxed, isolated
sessions with stricter origin and permission controls.

New renderer APIs should expose one domain operation, not a generic IPC sender,
SQL executor, filesystem primitive, process launcher, or credential accessor.

## Local data and migrations

The main process owns SQLite and applies the application identity before opening
the database. Migrations and backfills are atomic. Recovery closes active
handles before replacement and preserves enough staging/quarantine state to
resume or diagnose an interrupted operation.

Repositories and worktrees are external user assets. Export/reset does not
silently absorb or delete them. Operations that can detach, move, archive, or
delete a conversation use a prepared preview, a short-lived single-use token,
and stale-state checks before confirmation.

Anyone with access to the same OS account may inspect non-encrypted profile and
project data. SQLite is not an encrypted vault. Use filesystem encryption and an
appropriately protected user account for sensitive conversations and source.

## Credentials

Application-managed API keys and integration credentials remain in the main
process. `apps/desktop/src/main/secure-store.ts` stores only `enc:v1:` ciphertext produced by
Electron `safeStorage`. Reads ignore legacy plaintext, and writes return failure
when OS encryption is unavailable instead of falling back to plaintext.

Provider CLIs, browser sessions, Git credential helpers, SSH agents, and MCP
servers retain independent credential stores. Maestrly App cannot guarantee
their encryption, expiry, revocation, or provider retention. Renderer state sees
connection presence and sanitized status, not credential values.

### Configuring bot environments from a paired device

Every paired device can configure every environment and bot on its gateway.
Selected stored credentials flow from the desktop app's main process through the gateway
to the environment, whose bots all use them; provisioning does not retrieve
stored secrets. The picker receives names, IDs, hosts and warnings, and account
lists include only a last-four-character API-key hint. Stored secrets are not
exposed to the renderer or recorded in logs, activity or gateway idempotency
records. Import requests are not stored in the idempotency table.

Successful additions and updates through provisioning, and subscription, skill
and MCP removals, record `bot_configured` activity on the environment with the
paired device's name and counts only, also when a desktop app from before environments
configures one of its bots. Unchanged imports and interactive logins do not
create this activity; the existing API-key removal route does not create it
either. Copilot and Cursor imports share the same credential between your computer and
the environment. Codex, Claude and Grok sign in to separate sessions in the
environment. Accounts and MCP imports are refused when secure storage is
unavailable in the environment.

Sign-in URLs are restricted to HTTPS: `auth.openai.com` for Codex;
`claude.com`, `claude.ai` and `platform.claude.com` for Claude; and `x.ai` or its
subdomains for Grok. The desktop app's callback relay binds only to loopback, accepts the
attempt's exact callback path and closes on completion, cancellation or expiry.
It never renders bot-provided content and redirects only to allowed provider
origins; other responses use the desktop app's own completion or failure page. Codex
local success redirects are followed inside the environment, keeping tokens in
those URLs there.

MCP URLs, headers, commands, arguments and environment values are encrypted at
rest when secure storage is available, on both your computer and the bot environment. General
desktop MCP configuration retains an inline fallback when secure storage is
unavailable or a secure write fails; unreadable encrypted entries are never
connected. See [MCP storage](local-data.md#mcp-configuration) and the
[fleet security boundary](bot-fleet.md#security-and-data).

## Commands, files, and Git

Terminals and agent tools can modify source, run executables, and contact the
network. Permission modes map user intent to read-only, workspace-write, or
full-access behavior where the provider supports it. Tool implementations also
validate project scope and command/file arguments.

Full-access mode intentionally permits broad local effects and should be used
only for repositories and instructions the user trusts. A model prompt is not a
security boundary. Provider-native tool systems are disabled or constrained in
favor of host-owned tools, but external CLIs and child processes remain part of
the trusted computing base.

Git remote URLs with embedded HTTP credentials, query strings, or fragments are
rejected. Authentication belongs to a configured credential helper or SSH agent.
Tests replace global/system Git configuration so host filters, signing, and line
ending rules cannot change fixtures.

## Browser, web, and loopback services

The embedded browser is a real network client. Its shared partition denies site
permission requests by default, and application-owned OAuth/preview surfaces
guard popups and navigation. Web content remains untrusted; do not expose preload
capabilities to arbitrary pages.

The embedded VS Code server and ChatGPT Web bridge bind to loopback and use
random tokens. The editor token file receives best-effort owner-only permissions.
The ChatGPT bridge uses a random per-session path and validates loopback hosts.
These controls reduce accidental local access but do not defend against a fully
compromised process running as the same user.

## Artifacts

Artifacts are active HTML, CSS, and JavaScript written by agents, so the desktop
renders them as untrusted content. The artifact host runs in an Electron utility
process that receives only its configuration and holds no app credentials. It
is not a sandbox: it runs as the same user with full Node.js access, and it
isolates crashes and keeps secrets out of its memory.

The host listens on `127.0.0.1` only and refuses requests whose `Host` is not a
loopback name on its port, which blocks DNS rebinding. Artifact IDs and tokens
carry at least 128 random bits and are stored as SHA-256 digests. A missing,
deleted, or inaccessible artifact answers the same 404, and responses ask
crawlers not to index them.

The owner signs in with a single-use ticket that the desktop mints, which
expires after 60 seconds and travels in the URL fragment, so it never reaches
server logs or `Referer`. The viewer removes it from the address bar before
using it. The resulting session cookie is `HttpOnly`, `SameSite=Strict`, and
scoped to that artifact's API path. The viewer's API accepts writes only with
the exact origin, a custom header, and a JSON body. The viewer cannot share,
delete, or change access; those actions exist only in the desktop.

Artifact content is served from a separate path carrying an HMAC-signed
capability bound to the session, the artifact, the version, and an expiry of 12
hours. Its responses carry a sandbox Content Security Policy without
`allow-same-origin` or `allow-top-navigation`, so content has an opaque origin
even when opened directly: it cannot read cookies, call the host API, navigate
the viewer, submit forms, or register service workers. Network access is limited
to its own files and a fixed allowlist of CDNs. Messages from content to the
viewer are validated, capped, and rendered as text.

After each publication the desktop renders the new version for a preview, in
an offscreen window that is never shown. It loads the owner view through a fresh
single-use ticket, like any other opening, so the page runs under the same
sandbox and Content Security Policy. The window uses an in-memory partition of
its own that grants no permission, opens no window, allows no download, and lets
no top-level navigation leave the host. After the capture the desktop ends that
owner session and clears the partition. Only the resulting image reaches the
desktop, which stores it through the host's admin interface after checking its
format and size.

The drawer browser partition is shared with the agent's browser tools, so an
agent browsing there acts with the owner's artifact session. That grants no
more than the artifact tools already do. Agents can read and write only the
artifacts of their own project or standalone conversation, and cannot delete or
share them.

## Bot server access

An installed bot server publishes its gateway only on the Docker host's loopback.
For a VPS, the desktop app forwards a port on `127.0.0.1` through SSH to the
server's loopback port `7443`; a dropped tunnel reconnects. The desktop app pins
the server's SSH host key as a SHA-256 fingerprint on first use and stops the
tunnel if the key changes. A server you manage separately may use private HTTPS,
such as Tailscale Serve.

VPS setup accepts a password or private key for that job and generates a new
ed25519 key for later access. This key grants root or passwordless `sudo`
authority to the VPS: protect it as you would an administrator credential. The
desktop app stores its private key as ciphertext protected by the OS keyring
when secure storage is available; otherwise it holds the key only in memory.
**Disconnect this computer** removes the local key and attempts to revoke its
tagged public key on the server. If the server is unreachable, revoke that key
in `authorized_keys` yourself. **Remove bot server** also revokes this
computer's key; keys authorized by other computers must be removed separately.

The gateway mounts the Docker socket and can control the Docker engine wherever
it runs, including on this computer. Installer setups default to `public` bot
egress: each environment starts with `NET_ADMIN`, installs network rules in its
own namespace, then runs as uid 1000 without that capability in its bounding
set. The rules reject the Docker host, private, link-local, CGNAT,
remote loopback, multicast and reserved destinations while retaining access to
the fleet Docker network and public internet. IPv6 is guarded when present. If the guard cannot
install its rules, the environment refuses to start. The host firewall is not
changed. The switch in **Settings → Bot server** selects `open` to allow private
network access; each environment follows the new setting on its next start or
restart. Manual Compose setups default to `open`. This is an outbound network
control, not isolation between bots or environments on the shared fleet network.
Host root or anyone with Docker socket access can change container settings;
`docker exec` into a `public` container defaults to root, so pass `-u 1000` to
act as the bot user.

## Bot environments

A fleet environment is one Linux container running one Maestrly process for up
to eight bots. The environment, not the bot, is the fleet's isolation boundary.
See [environments](bot-fleet.md#environments) for what its bots share.

- **Inside an environment, bots trust each other.** They run as the same Linux
  user with one home folder, one credential store and keyring, one set of
  accounts, skills and MCP servers, and one browser session for `browser_*`. A
  bot that runs commands can read and modify its neighbours' files,
  conversations, memories, queued inputs, browser profiles and stored
  credentials, operate their displays and programs, and use their gateway
  tokens to call the gateway as them, for example to message a peer or save the
  environment's owner memory. Approval ceilings, **Conversations with other bots** grants, per-bot
  memory spaces and per-bot displays limit each bot's own tools; they are not a
  security boundary between bots of one environment.
- **Environments are separated** by their own container, home volume, keyring
  and control token, and each bot calls the gateway with its own gateway token.
  The gateway derives a bot's environment from that token, never from the
  request. This separates ordinary activity but is not a hostile-code boundary
  against the Docker host.
- **The network is shared.** Environment containers and the gateway share one
  Docker bridge network. The `public` egress guard does not filter traffic
  between containers: a service a bot starts on a network port can be reached
  from other environments. The gateway's public API refuses fleet-network
  clients, every control-server request needs the environment's control token, and VNC servers
  start on demand and listen only on each container's loopback.
- **Screens.** Takeover holds exactly one bot, and control of a bot's browser
  area or apps screen requires that device's takeover. The environment screen
  shows only Maestrly's settings, so a paired device can control it without a
  takeover. The browser areas and the environment screen share one display, and
  the gateway allows one control session on it per environment at a time. While
  it lasts, Electron windows outside the controlled screen are disabled for
  native input and cannot request keyboard focus. Opening other bots' browser
  popups or settings leaves the controlled screen focused. If window-manager
  fallback assigns focus to a disabled window, keys are dropped until the owner
  clicks their screen. The shared display has no window-move, resize, maximize
  or cycling bindings; page-driven popup moves stay within the bot's area.
  Bot browser pages answer JavaScript dialogs with their per-tab policy instead
  of opening native windows. Popups suppress native dialogs, including confirmations,
  so they cannot block another screen. Each apps screen is a separate display
  with its own input.
- **Browsers.** The browser that bots drive with `browser_*` keeps one set of
  cookies and site logins for the whole environment. Programs on a bot's apps
  screen open Chromium with a separate per-bot profile that uses Chromium's
  basic password store, which the keyring does not protect.
- **Secrets** flow only from your computer through the gateway to the environment and
  are never returned. The gateway keeps each environment's control token and
  keyring password and each bot's gateway token in plaintext in its database;
  host root and anyone who controls the Docker socket can read them.

## MCP, skills, and memory

The optional personal bot endpoint runs inside Desktop and binds to loopback by
default. The owner can explicitly select a network bind address and is responsible
for publishing it over HTTPS. OAuth uses PKCE and requires consent in Desktop;
tokens are scoped to a bot and the configured public audience. Workspace grants,
pausing and revocation are enforced locally. Changing the public URL invalidates
existing authorizations. Bot clients receive their own conversations and events,
but cannot approve permission requests or plans. A bot conversation refuses the
owner's own messages until the owner explicitly releases it; a released
conversation still admits one turn at a time, and a bot can neither cancel nor
steer a turn the owner started, nor change its account, model or approval mode.
Reading a conversation back is scoped to one conversation of the calling
connection and carries public message text only, never reasoning, tool results or
attachments. See [bot setup](grok-connector.md).

A stdio MCP server is an executable chosen by the user. A remote MCP server is a
network service chosen by the user. Either can return hostile text, request
powerful tool actions, or perform side effects outside Maestrly App's visibility.
Only configure servers and skills from sources you trust.

Maestrly App discovers catalogs lazily, validates tool schemas, and applies its
permission model to host-mediated calls. It cannot constrain independent side
effects performed internally by an MCP executable or remote service after the
connection is authorized.

Desktop project memory and notes stay in the local profile. Search indexes and
embeddings are reproducible caches, not authoritative copies. Promoting local memory into a repository is an
explicit write and then follows that repository's own review and disclosure
rules.

## Agent and bot memory

Fleet owner memory lives in the gateway. Global entries are included in every
bot's context and an environment's entries in the context of that environment's
bots; no entry is private to the authoring bot. A bot's saves belong to its
environment, which the gateway derives from the bot's gateway token, and a bot
can replace or archive only entries of its own environment. Under the owner's
direct-write policy, `memory_upsert`, `memory_archive`, `memory_restore`,
`owner_memory_save`, `owner_memory_forget` and `routine_report` run without
approval prompts in bot conversations. The owner reviews changes in the desktop app.
Owner-memory writes carry author and origin information; replacement and
archival preserve history. `owner_memory_forget` archives, while permanent local
deletion with `memory_forget` retains the normal approval gate. Read-only memory
and history tools and host recall never prompt.

The gateway checks saved owner-memory content for invisible or bidirectional
control characters and recognized prompt-injection phrases. Extracted memories
and memories that agents write with `memory_upsert` use the same content checks.
The extraction prompt instructs the model to take owner facts only from owner
messages and to treat tool and web content as untrusted; extraction ignores
proposed owner facts for batches that contain no owner message. This is model guidance and heuristic filtering, not proof that a
memory is correct or safe. Recalled blocks are framed as evidence to check, not
instructions overriding system or repository rules.

History tools read only their calling conversation; the bot-memory proxy exposes
only that bot's own space. These are tool scopes, not isolation from another bot
of the same environment that runs commands. Hidden memory blocks are excluded
from history tool output and extraction. Automatic extraction and consolidation
send condensed history or stored memories to the selected memory model (the
compaction model for bots), consume its quota and record usage. Review shared
owner memory in **Bots → Memory about you**, and each bot's memory in
**Settings → Bot memory**. See
[chat memory](chat-context.md#automatic-memory-saving) and
[storage and retention](local-data.md#memory-storage).

## AI providers and data egress

AI is optional. Enabling a provider can send prompts, selected conversation
history, system instructions, project metadata, file/tool results, images, and
approved context to that provider. Provider terms govern processing and
retention. Maestrly App does not route these requests through a hosted Maestrly
backend.

The host owns permission prompts, tool routing, and project context. Subagents
inherit explicit execution profiles and cannot silently become a separate
authority. Context budgeting and redaction reduce accidental disclosure but
cannot determine whether user-authored prompt content is sensitive.

## Runtime and package provenance

Optional provider binaries and Local ML assets use pinned versions, target
selection, and integrity or manifest checks where their upstream format permits.
The package wrapper stages one target architecture, rejects foreign native
packages, verifies resources outside the ASAR, and enforces size/leakage budgets.

The Codex runtime can also be updated independently of Maestrly releases. The
main process reads only the `latest` stable version document of `@openai/codex`
and its declared platform alias from `https://registry.npmjs.org`, with a
10-second timeout, a response size limit, and no redirects to other origins. It
accepts the release only when the package name, stable version, alias, canonical
tarball URL, and SHA-512 integrity are all coherent, and it never accepts a
version older than the build's pinned reference. The renderer supplies only the
asset ID; URLs, hashes, and paths are chosen in the main process.

A candidate is downloaded under an explicit size ceiling, checked against the
published SHA-512, extracted beside the active version, and validated before
activation in a temporary profile without credentials: native manifest, reported
version, the neutralized sub-agent catalog, and an `app-server` handshake with
model listing and deferred dynamic tools. Only then is its metadata persisted and
the active pointer swapped. Failures leave the active version in place, open
connections keep the version they leased, and the previous version remains
available for an offline rollback. Checks are notify-only by default; automatic
installation is opt-in and skips versions that failed or were rolled back.

The electron-builder base configuration is an allowlist. Source trees, private
environment files, unrelated build output, and unstaged runtime families must
not be packaged. GitHub Actions are pinned to immutable commits. Dependency
advisories require exact, expiring exceptions; Git history is scanned for
secrets.

## Known limitations

- Primary trusted renderers are not Electron-sandboxed.
- Full-access agent mode can execute commands and modify files broadly with the
  user's authority.
- Projects are logical scopes within one user profile, not isolation for hostile
  tenants.
- Bots of one fleet environment are not isolated from each other, and fleet
  environments share a Docker network without traffic filtering.
- External MCP servers, skills, provider CLIs, Git helpers, browser pages, and
  downloaded editor/runtime components have independent security behavior.
- Independently updated Codex releases are trusted through the npm registry's
  TLS endpoint and published SHA-512 integrity, not through a Maestrly-signed
  manifest; npm provenance attestations are not verified. The local
  compatibility check covers the contracts Maestrly uses, not every possible
  upstream regression.
- Local SQLite, notes, repositories, terminal output, and logs are visible to
  software with the same OS user's filesystem access.
- Provider and browser data already sent cannot be removed by resetting the local
  application profile.
- CI package smokes do not establish signing, notarization, clean-machine trust,
  or public release support.

Read the user-facing data inventory in [PRIVACY.md](../PRIVACY.md), development
controls in [development.md](development.md), and release boundary in
[releasing.md](releasing.md).
