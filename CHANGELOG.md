# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

## [0.9.0] - 2026-09-22

### Added

- Connect a personal bot, such as a Grok bot, to the native conversations on
  your own desktop through an MCP endpoint the application serves itself, with
  no server, database or relay, and no organization, project, board, card or
  runner involved.
- Turn that endpoint on in Settings, choosing the local address it binds to and
  the public HTTPS address the bot dials; it is off until you enable it, and it
  answers only requests that arrive under that address.
- Approve or deny every bot authorization on the desktop itself, grant access
  per bot and workspace, and revoke it at any time; a bot only ever sees the
  conversations it created itself.
- Give every bot conversation a fresh, exclusive worktree, and resume that same
  worktree when the bot continues the conversation.
- Show bot conversations in the sidebar with a badge naming the bot, and let
  the person pause one so every bot instruction is refused until they resume it.
- Choose how far each bot goes before it asks you — request approval, approve
  for me, or full access — when you approve its request and later on its card;
  the bot is offered only the modes at or under that ceiling, and plan
  approvals always stay with you.
- Release a bot conversation for your own messages, after a confirmation that
  says what it means: the bot keeps the conversation and is not told what you
  write, so ask it to read the conversation again when that matters. Only one
  turn runs at a time, a bot instruction waits for the turn you started, and a
  bot can neither cancel nor steer it. Blocking your messages again closes the
  composer without interrupting anything, and pausing the bot still hands the
  whole conversation back to you.
- Let a bot read a conversation of its own back page by page, so it can pick up
  what you wrote in it; it reads public message text alone, never reasoning,
  tool work, attachments or any other conversation.

### Fixed

- Keep the composer showing the account, model, reasoning effort, fast mode,
  permission mode and behavior mode a conversation will actually run with when
  something other than you changes them — a bot configuring its conversation, a
  delegated stage, or a provider failover — instead of the previous values until
  the conversation is reopened.

## [0.8.0] - 2026-09-20

### Added

- Add standalone chats with private persistent files, isolated permissions,
  provider support, and sidebar lifecycle controls outside project workspaces.
- Add native Cursor subscription support across chat, Maestro, subagents, image
  interpretation, desktop execution, and account-isolated sessions.
- Add optional incremental background compaction with persistent checkpoints,
  resume, cancellation, retry controls, and provider-specific configuration.
- Add in-app update discovery and installation through GitHub Releases on
  macOS, Windows, and AppImage, with release notifications for Debian packages.
- Delegate development work to an external agent (for example a Grok Bot
  routine) through an authenticated MCP endpoint, with per-project and
  per-action grants the owner controls and can revoke at any time.
- Choose the account, model, reasoning effort, fast mode and execution mode for
  each stage of a delegated task, and change them while it runs; an effort is
  never translated between providers.
- Follow a delegated task to delivery: independent review bound to the exact
  code revision, required checks, artifacts, commit, push, pull request and
  merge, plus follow-up rounds when checks fail or changes are requested.
- Notify an external routine with a signed, at-least-once callback instead of
  polling, and manage connectors, delegations and OAuth consent in the web
  interface.

### Changed

- Redesign Kanban card and column-agent dialogs with responsive layouts,
  clearer configuration, contextual prompts, and concurrent agent execution.
- Replace the fixed drawer tool strip with searchable, reorderable, persistent
  tabs stored per conversation.
- Update compatible minor and patch dependencies across all workspaces.

### Fixed

- Keep messages visible and queued correctly during compaction, align portable
  Codex recovery with resolved context settings, and recover short turns whose
  terminal events are lost.
- Repair legacy databases during startup so workspace removal succeeds, while
  preventing unrelated UI updates from interrupting live chat subscriptions.

## [0.7.0] - 2026-09-16

### Added

- Preserve the complete available conversation when switching models or
  providers, compacting before dispatch when transport limits require it.
- Block model transfers that remain oversized or whose required compaction
  fails, avoiding silent context truncation.

### Fixed

- Restore Kanban project chat tool execution for Claude and avoid repeating
  project context after the first message.

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
