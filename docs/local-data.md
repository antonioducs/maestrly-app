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

Keep exports and project backups independently. Never test a migration or
recovery against the only copy of real data.

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
