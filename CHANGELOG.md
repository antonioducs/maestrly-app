# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

### Added

- Experimental: see a bot's reasoning in its conversation, like in chats, once
  its bot server and environment are updated. Older bot servers and computers
  keep working without it.
- Choose how conversations show agent activity in **Settings → Appearance &
  sound → Agent activity**: **Compact** (the default) or **Expanded**, which
  shows every reasoning block and tool card as before.
- Experimental: see when bots can be updated and update them in one click with
  **Update bots**. Maestrly updates the bot server it installed, then each
  environment restarts on the new image once none of its bots is working,
  waiting for you, or under your control, even while your computer is off. An
  environment's view shows what its update waits for and offers **Update now**
  and **Cancel update**.
- Experimental: bots update Claude Code and Codex on their own, without
  waiting for a Maestrly release. Each environment checks npm every six hours,
  tests a new release before using it, never interrupts a turn in progress,
  and never goes below the version its image ships. A bot's **Settings →
  Components** shows the versions and offers manual checks; servers can turn
  automatic checks off with `MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off`.
- Experimental: an environment's view shows the Claude Code and Codex versions
  its bots run, where each comes from, an installed version still waiting for
  work in progress to end, and **Check for updates**.

### Changed

- Fold the reasoning, commands, searches, and other tool steps behind each
  answer into one activity line in chats, workspaces, subagent transcripts, and
  bot conversations. While the agent works, the line shows its current step;
  afterwards it summarizes what it did, including steps that failed or that you
  denied. Open it to see every step and its details. The answer, questions,
  plans, subagents, published artifacts, generated images, and tool screenshots
  stay in view.

### Fixed

- Let bots use new Claude models such as Opus 5.5: the bot image now ships
  Claude Code 2.1.285, so bots see these models as the desktop app does,
  including the extra high effort, instead of a reduced context window and a
  request to update Claude Code on every turn.
- Close only the open list, not the whole dialog, when pressing Escape in a
  searchable dropdown such as the environment choice when creating a bot.
- Never move a bot server back to an older version when another computer
  already updated it past this app.

## [0.11.0] - 2026-09-28

### Added

- Experimental: run remote bots as separate Maestrly desktops in Docker, on this
  computer or on your own Linux server, with their own screens, browser, model
  accounts, and files. Bots on a server keep working while your computer is off.
- Set up the bot server from Settings → Bot server: Maestrly installs it on this
  computer's Docker or on an Ubuntu or Debian VPS over SSH, pairs this computer,
  and updates the server to the app's version. Bots reach only the public
  internet unless you let them reach private networks.
- Group up to eight bots in an environment that shares one desktop, home folder,
  and set of model accounts, skills, MCP servers, and site logins.
- Pair your computer with a bot gateway you manage, manage bots from the Bots
  sidebar, watch or take control of a bot's screen, and answer its questions and
  approval requests from Awaiting you.
- Add model accounts to an environment or bring them from your computer,
  schedule routines on the server, allow selected bots to exchange bounded
  messages, and review their activity.
- See the screenshots and images a bot's tools produce in its conversation, and
  send it images from your computer by attaching, pasting, or dropping them.
- Choose a bot's reasoning effort, fast mode, and access from its composer,
  dictate messages with the microphone, and follow its context use and
  estimated cost; its model list follows the models you enabled for its
  account.
- Hear an alert when a bot finishes or fails what you asked, or needs you.
- Split the sidebar into Chats, Workspaces, and Bots tabs.
- Recall relevant memories for each message in project conversations with
  memory; a chip under the message opens the recalled memories. Turn it off in
  Settings → Chat → Memory.
- Save memories from conversations in the background with a memory model you
  choose, and consolidate overlapping automatic memories. Saving starts off.
- Let agents search and read their own conversation history.

### Changed

- Encrypt MCP connection details (URLs, headers, commands, arguments, and
  environment values) at rest when secure storage is available. Earlier
  versions cannot read them: after a downgrade, set up those MCP servers again.
- Open and continue long conversations faster.

### Fixed

- Deliver browser and desktop screenshots to GPT-6 models on ChatGPT
  subscriptions when they call tools from code.
- Remove the temporary directory of a Codex runtime check on Windows instead
  of leaving it behind.

## [0.10.0] - 2026-09-26

### Added

- Attach PDF files to chat messages. Models that read PDFs receive the
  document; other runtimes receive text extracted locally.
- Click a PDF in a sent message to open it in the system's PDF viewer.
- Drag files onto the chat composer to attach them.

### Fixed

- Delete a conversation's attached images and PDFs when the conversation is
  deleted, instead of leaving them in the application profile.

## [0.9.3] - 2026-09-24

### Added

- Send requested tasks to new conversations in isolated worktrees, and hand
  approved plans to new Standard conversations.

### Fixed

- Run independent subagent tasks in parallel for Claude and Codex conversations.

## [0.9.2] - 2026-09-23

### Fixed

- Ignore malformed or incomplete task-list tool input in task cards instead of
  interrupting the chat interface.

## [0.9.1] - 2026-09-23

### Added

- Update the Codex runtime without waiting for a Maestrly release. Settings ›
  Maestrly Chat › Components checks the latest official stable release, tests
  its compatibility before switching, keeps the previous version for rollback,
  and can install updates automatically when enabled. Open conversations keep
  their current version until Maestrly restarts.

### Fixed

- Update the integrated Codex runtime to 0.155.1 so connected accounts can
  discover GPT-6 Sol and GPT-6 Luna from the provider catalog.
- Wait for the native macOS updater to finish preparing a downloaded update
  before offering the restart, and keep Maestrly running with a retryable error
  if the installer does not take over shutdown.

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
