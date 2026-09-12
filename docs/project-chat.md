# Project chat

Project chat keeps a conversation beside the Kanban board and runs it with an explicitly selected Maestrly desktop executor. The executor uses a persistent worktree, connected model account, enabled MCPs and skills, and the linked workspace's project memory. Provider credentials remain on that computer.

## Connect and use

1. Update the API, web app and Maestrly desktop to versions supporting `chat:interactive:v1`.
2. In desktop **Settings → Platform**, connect the instance and link the project to its local repository. The selected base branch must have a commit.
3. Under **Maestrly executor**, select the provider accounts and allowed tools, enable **Interactive project chat in the web**, and start the executor. **Only me** limits the destination to its owner; a team executor serves its explicitly approved projects.
4. Open **Chat** in the project's web header. Choose executor, workspace, model/account label, base branch, reasoning effort, Fast mode, conversation mode and permission profile, then **Start conversation**. **Ask** is read-only; **Agent** can change files within the selected permission profile. Planning and design modes remain desktop-only.
5. Send messages, inspect tool results, answer questions and decide plans in the drawer. **Discuss this card** adds card context. Search tools can query completed and archived cards separately; deleted cards are excluded.

Conversations are individual: project membership does not expose another member's chat. The creator must retain project access, and starting work requires contributor/maintainer or organization owner/admin permission. Personal computers can only be used by their owner. A team executor acts on the Kanban using the requesting user's authority, never the operator's broader account token.

The drawer can be closed while a turn runs. Reloading restores messages and pending interactions from the server. Text and tool events arrive through SSE; reconnect uses persisted sequence numbers to avoid duplicated output. The composer retains an unsent draft if a request fails.

## Workspaces, tools and approvals

Each conversation creates one worktree from the selected committed base and reuses it for later turns. The original checkout and its uncommitted changes stay in place. The source workspace ID is preserved for project memory and configuration. Files and worktrees remain on the executor, while the web receives the public conversation projection.

Enabled skills and MCPs follow the desktop configuration. The web indicates which integrations are available. An executor without interactive-chat capability cannot accept a new chat. An offline but previously configured executor can have work queued specifically for it; no automatic reassignment occurs.

Conversation settings are persisted on the server and frozen for each active turn. They can be changed between turns with optimistic version checks; a stale browser reloads the current settings instead of overwriting them. Changing models clears an unsupported reasoning effort or Fast mode in the web, and the server validates the final combination against the executor's latest inventory.

The permission profiles are **Request approval**, **Approve for me**, and **Full access**. Request approval prompts before protected actions. Approve for me permits routine file/tool actions but still asks before commands and external folders. Full access suppresses those prompts for capabilities the executor has enabled. The executor's command, web, app-tool, MCP and Git-push switches remain hard ceilings in every profile; read-only conversation modes remain read-only. When a prompt is required, decisions are still **Allow once** or **Reject** and cannot save a global rule on the executor. Plan approval/revision starts a new queued turn; a repeated decision does not run it twice. Jobs triggered by Kanban columns keep their unattended execution policy and do not inherit these interactive brokers.

Web-managed conversations can be inspected on the executor. Send, edit, steering and plan decisions for them belong to the web queue. Local controls do not start untracked turns.

## Cancellation and recovery

**Stop response**, executor pause, quit, access removal or an expired lease cancels the native turn and its delegated work. A conversation without a running turn consumes no execution slot. Card jobs and chat share runner capacity.

The executor persists command admission and unacknowledged events locally. Lost upload acknowledgements are retried with stable IDs. A process crash does not silently repeat a potentially mutating tool call: uncertain work becomes interrupted, with partial output retained. Continue explicitly after inspecting the result. If the conversation's local worktree or mapping is missing, restore it before continuing.

## Privacy and operations

The public projection excludes system/developer messages, raw provider reasoning, account/session files and unrelated local conversations. Tool inputs/results have size limits and credential redaction. Model responses and tool output can still contain project information; this is not a guarantee of detecting every possible secret.

All executor connections are outbound; no desktop listener or tunnel is required. Migrations enable and force RLS on chat tables. Runtime PostgreSQL credentials must not use BYPASSRLS. Private chat contents are not placed in the project's shared domain-event feed.

Deployment requires migrations `008_project_chat.sql` and `009_project_chat_settings.sql`, the API, the web bundle and an updated executor. Roll out the additive migrations/API first, then web and the executor. An older interactive executor remains compatible but exposes only its conservative Agent/Ask behavior with per-operation approval. Preserve database backup and prior images; a web-only rollout does not deliver this feature. See [self-hosting](self-hosting.md) and [desktop executor](desktop-executor.md).

Run `node scripts/test-project-chat-e2e.mjs` to validate PostgreSQL, API, Electron, a local deterministic model, a fixture MCP and Chromium together. It exercises code/memory/skill/card context, model switching, permission profiles, multi-turn history, streaming, web interactions and reconnection without paid model calls.
