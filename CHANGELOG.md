# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

## [0.4.1] - 2026-09-12

### Fixed

- Restore native packaging and packaged smoke commands used by the release
  workflow after the monorepo workspace migration.

## [0.4.0] - 2026-09-12

### Added

- Multi-tenant Kanban platform with audited execution, project chat, scoped
  permissions, OAuth Device Flow, and self-hosting support.
- Opus 5 behavior profile across Claude, Copilot, subagents, resumes, and review
  executions.

### Fixed

- Shut down delayed Codex processes reliably on Windows.
- Accept ephemeral Claude sessions in paired review loops and release the split
  view when a loop reaches a terminal state.

## [0.3.0] - 2026-09-09

### Added

- Ordered Claude subscription account rotation for chat, subagents, summaries,
  and image interpretation, with configurable fallback accounts.

### Fixed

- Preserve conversation context and completed tool results when switching
  subscription accounts after usage limits are reached.
- Make GPT account failover transparent and preserve physical account ownership.
- Harden archive extraction and web text parsing.

### Changed

- Update compatible dependencies and development tools.

## [0.2.0] - 2026-09-07

### Added

- GPT-6 Astra support for OpenAI API and ChatGPT subscription sessions, with
  conversation continuity and context compaction.
- Mid-turn text steering and live reasoning updates for subscription runtimes
  that support them.
