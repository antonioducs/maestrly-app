<p align="center">
  <img src="resources/icon.png" width="112" alt="Maestrly App icon">
</p>

<h1 align="center">Maestrly App</h1>

A local AI workspace with chat, agent orchestration, Git worktrees, terminals,
an embedded editor and browser, notes, and project memory.

![Maestrly desktop with integrated developer tools](docs/images/desktop-chat.png)

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
- [Local ML and offline setup](runtime-assets/local-ml/README.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Dependencies, SDKs, runtimes, models, and assets retain their own
licenses and terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).
