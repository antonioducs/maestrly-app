<p align="center">
  <img src="resources/icon.png" width="112" alt="Maestrly App icon">
</p>

<h1 align="center">Maestrly App</h1>

<p align="center">
  A local-first AI workspace for conversations, orchestration, projects, and developer tools.
</p>

<p align="center">
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/ci.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/security.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/security.yml/badge.svg?branch=main" alt="Security checks"></a>
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/package-smoke.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/package-smoke.yml/badge.svg?branch=main" alt="Package smoke status"></a>
  <a href="https://github.com/antonioducs/maestrly-app/releases/latest"><img src="https://img.shields.io/github/v/release/antonioducs/maestrly-app" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg" alt="macOS, Linux, and Windows">
</p>

<p align="center">
  <a href="https://www.maestrly.com/"><strong>Website</strong></a> ·
  <a href="https://github.com/antonioducs/maestrly-app/releases/latest">Download</a> ·
  <a href="#documentation">Documentation</a>
</p>

Maestrly App brings chat, Maestro orchestration, Git worktrees, terminals, an
embedded editor and browser, notes, and project memory into one desktop.
Connect your own provider accounts and APIs, and keep your project context
and tools together as you plan, build, and review.

![Maestrly desktop with integrated developer tools](docs/images/desktop-chat.png)

The repository is also a modular platform with four independently buildable products:

| Product | Purpose |
| --- | --- |
| `apps/desktop` | Existing local-first Electron workspace; platform connection is optional |
| `apps/web` | Browser board, automations, approvals, executions, runners, and reports |
| `apps/server` | Versioned API, Better Auth, PostgreSQL persistence, RLS, audit, and durable job claims |
| `apps/runner` | Headless Node runner with leases, recovery, Codex, and Claude Agent adapters |

Focused public contracts live in `packages/protocol`, `packages/client-sdk`, and
`packages/runner-core`; there is no generic shared package. See
[self-hosting](docs/self-hosting.md) and [platform security](docs/platform-security.md).

## Capabilities

- **Chat and providers:** API-key providers plus user-enabled Codex, Claude,
  GitHub Copilot, Grok, and ChatGPT Web integrations.
- **Maestro:** coordinated workers, specialist profiles, subagents, plans,
  review loops, permissions, and usage accounting.
- **Workspaces:** conversations on the current branch or isolated Git worktrees,
  with project context and migration recovery.
- **Developer tools:** native terminals, an embedded editor and browser,
  screenshots, file references, and Git diffs.
- **Knowledge:** project notes, local memory and search, skills, MCP servers,
  and optional local embedding, transcription, and inference assets.

## Download

Get installers and SHA-256 checksums from [GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

| Platform | Packages |
| --- | --- |
| macOS arm64 | Signed and notarized DMG and ZIP |
| Linux x64 | AppImage and DEB |
| Windows x64 | NSIS installer |

Linux and Windows packages are not code-signed. Updates are installed manually.

## Run from source

Requires Node.js 22.15–22.x, npm 10 or newer, Git, and the host's native compiler
tools. See [Development](docs/development.md) for platform setup.

```sh
git clone https://github.com/antonioducs/maestrly-app.git
cd maestrly-app
npm ci
npm run dev
```

Platform entry points: `npm run dev:web`, `npm run dev:server`, and `npm run dev:runner`.

Development runs in a separate profile. Back up application data and project
repositories separately; see [Local data and recovery](docs/local-data.md).

## Providers and local data

Project state stays on your machine. AI features require a configured provider;
API keys and subscription integrations use your own provider account. Local ML
requires separately prepared runtime and model assets.

Provider calls, browser navigation, Git operations, MCP services, and optional
downloads can access the network. Maestrly does not automatically upload logs or
telemetry. See [Privacy](PRIVACY.md) for data handling and [Security](SECURITY.md)
for permission and isolation limits.

## Help and contributions

For setup questions or reproducible bugs, use [GitHub Issues](https://github.com/antonioducs/maestrly-app/issues).
Include the version or commit, operating system, reproduction steps, and sanitized
diagnostics. Support is best-effort. Report suspected vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Documentation

- [Development and packaging](docs/development.md)
- [Releasing](docs/releasing.md)
- [Local data and recovery](docs/local-data.md)
- [Local ML and offline setup](apps/desktop/runtime-assets/local-ml/README.md)
- [Changelog](CHANGELOG.md)

- [Self-hosting](docs/self-hosting.md)
- [Kanban workflows](docs/kanban-workflows.md)
- [Personal devices](docs/personal-devices.md)
- [Runner operations](docs/runner-operations.md)
- [Platform protocol](docs/platform-protocol.md)
- [Platform security](docs/platform-security.md)
- [Backup and restore](docs/backup-restore.md)

## License

[MIT](LICENSE). Dependencies, SDKs, runtimes, models, and assets retain their own
licenses and terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).
