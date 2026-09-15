# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

## [0.6.1] - 2026-09-15

### Fixed

- Stream live context-window usage for Codex/Astra and Claude instead of
  showing stale measurements.
- Show compaction progress and failures, with staged retries that reuse
  successfully completed work.

## [0.6.0] - 2026-09-13

### Added

- Give project chat scoped control over boards, columns, cards, comments, and
  column automations, with versioned and idempotent mutations.
- Refresh board and open-card details in web clients through live server events
  without overwriting in-progress drafts.

### Fixed

- Use a properly sized macOS template icon for the menu bar, removing the white
  square while preserving platform-specific colored icons elsewhere.

## [0.5.0] - 2026-09-13

### Added

- Link desktop workspaces and conversations to Kanban projects and boards, with
  scoped read and write tools for local agents, Maestro, and GPT Web.
- Enforce project permissions, resource versions, idempotency, and audit
  attribution for agent-driven board mutations.

### Changed

- Replace model-specific harness branching with versioned declarative profiles
  shared across providers, prompts, sessions, subagents, and live controls.

### Fixed

- Hide the paired review loop badge after the loop reaches a terminal state.

## [0.4.3] - 2026-09-13

### Fixed

- Compile internal workspace packages before creating desktop installers, fixing
  the missing module error on startup in v0.4.2.
- Reject desktop packages that omit compiled workspace entry points.

## [0.4.2] - 2026-09-12

### Fixed

- Use a Debian-safe package name and the desktop workspace artifact paths in
  native release builds.
- Validate native packages before tagging without launching packaged GUI apps
  in hosted runner sessions.

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
