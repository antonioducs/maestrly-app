# Local data and recovery

Back up the application profile and project repositories separately. Production
uses `maestrly-app`, beta uses `maestrly-app-beta`, and development uses
`maestrly-app-dev-<instance>` under Electron's OS application-data directory.
Each channel opens only its own profile.

## Export and backup

Use in-app export before reset, schema experiments, or moving data between
machines. Exports contain supported database state and app-owned assets with
integrity metadata. They exclude provider credentials, repositories, worktrees,
search indexes, embeddings, and reproducible caches.

Standalone chats keep working files under `standalone-chats/<conversationId>` in
the application profile. Exports include those files, skipping symbolic links
and reporting unreadable or excluded entries. Archiving retains the directory;
deleting the chat removes it. Back up the complete profile before reset.

Keep exports and project backups independently. Never test a migration or
recovery against the only copy of real data.

## Memory storage

Desktop durable entries remain in `local_memories`. Its `workspace_id` now names
a memory space: a workspace or the bot's `bot-self` space. The migration removes
the workspace foreign key and preserves workspace deletion cleanup through a
trigger. Entries can have source `auto` for automatic extraction. Conversation
provenance does not make saved entries disappear when a transcript is deleted.

`conversation_memory_state` stores the frozen core, source baseline and recalled
IDs; `memory_extraction_state` stores the extraction cursor and failure state.
Both are deleted with their conversation. `memory_consolidation_state` tracks
new automatic entries and the last consolidation per space. Search indexes and
embeddings remain rebuildable caches; back up the profile for authoritative data.

The [bot gateway](bot-fleet.md#security-and-data) moves to schema v5, adding
`owner_memories`, `routine_runs` and `meta.owner_memory_revision`. Owner memory
is shared across bots and survives bot deletion. Routine runs are deleted with
their routine or bot. The bot's own memory lives in its desktop profile inside
its persistent home volume. Back up both gateway data and bot homes. A gateway
binary refuses a database newer than its supported schema; an older gateway
cannot open v5 unless it supports v5. Downgrade by restoring a matching backup.

## MCP configuration

On every desktop, `chat.mcpServers` in `app_settings` keeps the MCP identities
`{ id, name, transport, enabled }`. Connection details (`url`, `headers`,
`command`, `args`, `env`) are encrypted through the secure store under
`chat.mcpServer.<id>` when secure storage is available. Existing inline details
migrate when the list is read, and are removed from the inline list only after a
successful secure write.

Without secure storage, or if a secure write fails, details remain inline in
`chat.mcpServers`. Treat that profile data as sensitive. A server whose encrypted
details cannot be read remains listed as needing reconfiguration and never
connects. Removing a server also removes its secure-store entry. Bot provisioning
requires secure storage before accepting MCP imports.

## Configuration brought to a bot

Global skills sent from a Mac are installed atomically in
`~/.agents/skills/<name>` on the bot, with provenance `fleet` (shown as
**From a Mac**). They live in the bot's persistent home volume; changing or
removing the Mac's source does not update that copy automatically.

Subscription slots created for remote sign-in are ordinary bot subscription
slots, kept in the bot's profile with credentials managed by the corresponding
provider integration. They survive container replacement with the home volume.
New slots are removed when their sign-in fails, expires or is cancelled;
successful slots remain until removed. Back up bot homes together with gateway
data as described in the [fleet guide](bot-fleet.md#updates-backups-and-removal).

## Temporary tool output

Large built-in chat tool results are saved under `chat-tool-output` so the agent
can read beyond the shortened chat preview. These files are temporary: the app
retains at most 256 MiB and 2,000 files, removing the oldest first, and expires
files after seven days. Cleanup runs at startup, hourly, and when saving output;
it also applies to files accumulated by older versions. Files above 16 MiB are
not saved, and the preview reports when full output is unavailable.

Conversation history and project files are retained, but paths in older tool
messages can stop working after expiration or eviction. Save any output you need
to keep in your project. Cleanup failures do not interrupt tools; if space cannot
be reclaimed, the app stops saving full output until storage is available.

## Upgrades and reset

SQLite upgrades are forward-only and transactional. If an upgrade fails, close
the app and investigate a copy of the complete profile. Downgrading can be unsafe;
restore a backup made with the older version instead of opening a newer profile.

Reset previews removal of app-owned state and preserves repositories/worktrees.
It does not securely erase filesystem snapshots, OS backups, provider records,
Git remotes, or credentials owned by CLIs and other tools. Remove those through
their owning systems. See [Privacy](../PRIVACY.md).

## Recovery

1. Stop all Maestrly processes using the affected profile.
2. Copy the complete profile and relevant project directories before changing them.
3. Verify export checksums and preserve the original export.
4. Reproduce and repair with a disposable profile or copied database.
5. Restore profile and project data separately, then verify conversations, notes,
   assets, repositories, and worktrees.

Do not copy individual SQLite files while the app is running. Database sidecars
and app-owned assets must remain consistent with the main database.
