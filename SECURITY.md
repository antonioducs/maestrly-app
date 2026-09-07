# Security

## Report a vulnerability

Use [private vulnerability reporting](https://github.com/antonioducs/maestrly-app/security/advisories/new).
Do not disclose a suspected vulnerability in a public issue or PR. If the private
form is unavailable, open an issue asking for a private contact channel without
including vulnerability details or personal data.

Include the affected version or commit, OS/architecture, impact, prerequisites,
and minimal reproduction steps using a disposable profile and synthetic project.
Share only sanitized diagnostics; never send real databases, conversations,
repositories, credentials, or signing keys.

Reports and fixes are handled on a best-effort basis with no response or
remediation SLA. Include whether the issue reproduces on the latest release or
`main`. Allow time for investigation and coordinated disclosure.

## Security limits

Maestrly is a single-user developer workspace. Projects and conversations do not
provide isolation between hostile tenants. Terminals, agents, provider CLIs, and
MCP executables can read files, execute commands, and access the network within
the authority granted to them. Full-access mode permits broad local changes.
Trust installed tools and review permissions; prompts alone are not a sandbox.

The primary application renderer uses context isolation and disables Node
integration, but it and some trusted tool panels are not Electron-sandboxed.
Application APIs validate input in the main process. OAuth and visual companion
surfaces use separate sandboxed sessions.

Application-managed credentials use Electron `safeStorage`; persistence fails
when operating-system encryption is unavailable. Local SQLite databases, notes,
logs, and project files are not an encrypted vault. Software with access to the
same OS account can access local data. Loopback service tokens do not protect
against a compromised OS account or application process.

External providers, MCP servers, skills, browsers, and downloaded tools have their
own security behavior and data retention. Reset cannot retract information
already sent to them. See [Privacy](PRIVACY.md) and
[Local data and recovery](docs/local-data.md).
