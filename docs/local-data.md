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
