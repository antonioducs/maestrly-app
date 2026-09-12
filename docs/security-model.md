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

## MCP, skills, and memory

A stdio MCP server is an executable chosen by the user. A remote MCP server is a
network service chosen by the user. Either can return hostile text, request
powerful tool actions, or perform side effects outside Maestrly App's visibility.
Only configure servers and skills from sources you trust.

Maestrly App discovers catalogs lazily, validates tool schemas, and applies its
permission model to host-mediated calls. It cannot constrain independent side
effects performed internally by an MCP executable or remote service after the
connection is authorized.

Memory and notes stay local. Search indexes and embeddings are reproducible
caches, not authoritative copies. Promoting local memory into a repository is an
explicit write and then follows that repository's own review and disclosure
rules.

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
- External MCP servers, skills, provider CLIs, Git helpers, browser pages, and
  downloaded editor/runtime components have independent security behavior.
- Local SQLite, notes, repositories, terminal output, and logs are visible to
  software with the same OS user's filesystem access.
- Provider and browser data already sent cannot be removed by resetting the local
  application profile.
- CI package smokes do not establish signing, notarization, clean-machine trust,
  or public release support.

Read the user-facing data inventory in [PRIVACY.md](../PRIVACY.md), development
controls in [development.md](development.md), and release boundary in
[releasing.md](releasing.md).
