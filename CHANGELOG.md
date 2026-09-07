# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioned
releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added

- A versioned `gpt-6-astra` harness for official OpenAI Responses and ChatGPT subscription sessions, including
  profile-safe continuity, native-first context management, persisted reasoning, prompt caching, mid-turn text
  steering, and live reasoning updates when the runtime advertises them.
- Initial public source baseline for the local-first Maestrly desktop.
- Chat, Maestro orchestration, Git/worktrees, terminal, embedded
  editor and browser, notes, memory, MCP, settings, i18n, export/reset, and
  optional Local ML capabilities.
- Reproducible dependency installation, cross-platform CI, security checks, and
  native package-smoke workflows.
- Tag-driven GitHub Releases with Linux x64, Windows x64, and signed/notarized
  macOS arm64 artifacts plus verified SHA-256 checksums.

### Security

- Local credentials remain in the Electron main process and use operating-system
  protected storage.
- CI scans complete Git history for secrets and enforces an exact dependency
  advisory policy.
- Package verification rejects source leakage, unexpected runtime content, and
  missing legal notices.

This source preview has no supported public binary or automatic update channel.
