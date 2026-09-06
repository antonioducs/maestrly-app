<p align="center">
  <img src="resources/icon.png" width="112" alt="Maestrly App icon">
</p>

<h1 align="center">Maestrly App</h1>

<p align="center">
  A local-first AI workspace for conversations, orchestration, projects, and developer tools.
</p>

<p align="center">
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/ci.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/security.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/security.yml/badge.svg" alt="Security checks"></a>
  <a href="https://github.com/antonioducs/maestrly-app/actions/workflows/package-smoke.yml"><img src="https://github.com/antonioducs/maestrly-app/actions/workflows/package-smoke.yml/badge.svg" alt="Package smoke status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg" alt="macOS, Linux, and Windows">
  <img src="https://img.shields.io/badge/status-source%200.x%20preview-orange.svg" alt="Source 0.x preview">
</p>

Maestrly App brings chat, Maestro orchestration, Git worktrees, terminals, an
embedded editor and browser, notes, and project memory
into one desktop. Application state stays on the local machine. A Maestrly
account, license server, hosted backend, telemetry endpoint, and mandatory
updater are not required.

> [!IMPORTANT]
> This project is a `0.x` source preview. Official binaries, when available,
> exist only as assets on a tagged [GitHub Release](https://github.com/antonioducs/maestrly-app/releases).
> There is no automatic update channel, and a source build or CI package is not
> a production release.

![A local Maestrly conversation with integrated developer tools](docs/images/desktop-chat.png)

## Capabilities

- **Chat and providers:** API-key providers plus user-enabled Codex, Claude,
  GitHub Copilot, Grok, and ChatGPT Web integrations.
- **Maestro:** coordinated workers, specialist profiles, subagents, plans,
  paired review loops, permissions, and usage accounting.
- **Workspaces:** isolated or attached conversations, sibling worktree groups,
  migration recovery, and conflict-aware persistence.
- **Developer tools:** Git repositories and worktrees, native terminals, an
  embedded editor, browser surfaces, screenshots, and file references.
- **Knowledge:** project notes, local memory and search, skills, MCP servers,
  and optional local embedding, transcription, and inference assets.
- **Local ownership:** independent profiles, explicit export and reset,
  repository preservation, migration recovery, and multilingual UI catalogs.

## Platform status

| Platform | Source CI | Native package smoke | Public download |
| --- | --- | --- | --- |
| macOS arm64 | Typecheck, tests, build, and Electron | Verified locally; scheduled CI configured | Tagged signed DMG and ZIP |
| Linux x64 | Typecheck, tests, build, and Electron | Scheduled CI configured; first run required | Tagged AppImage and DEB |
| Windows x64 | Typecheck, tests, build, and Electron | Scheduled CI configured; first run required | Tagged NSIS installer |

The standard CI matrix validates all three operating systems. Package smoke jobs
are intentionally separate because they build native runtimes and installers.
The table describes the release pipeline, not the existence of a published
version; the Releases page is the only source of official downloads. See
[Releasing](docs/releasing.md) for the distinction between a validation bundle
and a distributable release.

## Quickstart from source

Requirements:

- Node.js 22.15 or newer, but lower than 23;
- npm 10 or newer and the committed lockfile;
- Git; and
- the native compiler/toolchain required by Electron and `node-pty` on the host
  operating system.

```sh
git clone https://github.com/antonioducs/maestrly-app.git
cd maestrly-app
npm ci
npm run hooks:install
npm run dev
```

Development uses an isolated `maestrly-app-dev-<instance>` profile. Production,
beta, and development profiles are separate, and each running channel opens only
its own profile. Repositories and worktrees remain in their existing filesystem
locations.

For operating-system setup, repository layout, profiles, and troubleshooting,
read the [development guide](docs/development.md).

## Offline and network boundaries

Projects, stored conversations, notes, memory, local search, Git state,
and prepared local models work without a Maestrly service. Network access occurs
only through a feature that needs it: a selected AI provider, user navigation or
web fetch, Git/`gh`, a configured remote MCP server, metadata lookup, or an
explicit runtime/model/skill/editor download. Prepare optional runtimes and
models before disconnecting if they must work offline.

Credentials managed by the application are encrypted with Electron
`safeStorage`; persistence fails closed when operating-system encryption is not
available. Provider CLIs and Git credential helpers retain their own independent
credential lifecycle. Read [Privacy](PRIVACY.md) and the
[security model](docs/security-model.md) before using sensitive repositories or
enabling external tools.

## Checks

```sh
npm run check
npm run test:e2e
npm run audit:dependencies
```

`npm run check` covers TypeScript, Biome, unit and repository-policy tests,
documentation links, and the production renderer/main build. Electron tests use
temporary profiles and synthetic repositories. The dependency audit is separate
because it consults the live npm advisory service.

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Development](docs/development.md)
- [Releasing](docs/releasing.md)
- [Repository governance](docs/repository-governance.md)
- [Privacy](PRIVACY.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Support](SUPPORT.md)
- [Local data and recovery](docs/local-data.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and discuss major architecture, storage,
provider, privacy, or security changes before implementation. Report suspected
vulnerabilities only through the confidential process in [SECURITY.md](SECURITY.md).

## License

Maestrly App source is licensed under the [MIT License](LICENSE). Dependencies,
SDKs, downloadable runtimes, models, and derived code retain their own licenses
or service terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).
