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

## Bot server installation

When the desktop app installs a bot server, `fleet.installer` in
`app_settings` records whether it runs here or on a VPS, the app image
version, the local gateway or SSH tunnel port, the private-network setting,
and the installation time. For a VPS it also records the SSH host, port, user,
pinned host-key fingerprint and the tag of Maestrly's authorized key. It
contains no password or private key.

`fleet.installer.sshKey` holds the generated VPS private key as ciphertext
protected by the OS keyring through Electron `safeStorage`. If secure storage
is unavailable, the key remains in memory only; after restarting the app, use
**Set up again** with the server's password or key. The password or private key entered for setup is
not saved. **Disconnect this computer** clears the install record and stored
key, while leaving the server's Compose files and volumes running. On a VPS,
it attempts to revoke this computer's tagged public key.

The app writes `<userData>/bot-server/compose.yml` and
`<userData>/bot-server/.env` for an install on this computer. On a VPS it writes
the same files under `/opt/maestrly-bots/`. The `.env` names both images, the
gateway bind and port, display name, time zone, Docker network and bot egress
mode; it does not hold the SSH key. The Compose `gateway-data` volume holds
the gateway database, and each environment has a
`maestrly-env-<id>-home` volume (older environments may have a
`maestrly-bot-<id>-home` volume). Back up the gateway volume and every
environment home together; see
[updates, backups, and removal](bot-fleet.md#updates-backups-and-removal).

**Remove bot server** requires a connected server and deletes its bots,
environments and their home volumes, the Compose gateway and data volume, the
configured images when Docker can remove them, and the app-managed Compose
files. It clears this computer's install record and key; on a VPS it also
revokes this computer's key and removes `/opt/maestrly-bots/`. Other
computers' authorized keys must be removed separately. It leaves Docker
itself installed. Removal affects other paired computers too.

## Memory storage

Desktop durable entries remain in `local_memories`. Its `workspace_id` now names
a memory space: a workspace or a fleet bot's own `bot-self:<botId>` space. Bot
profiles from before environments used a single `bot-self` space, which is
re-keyed when the bot is adopted (see
[bot environment data](#bot-environment-data)). The migration removes the
workspace foreign key and preserves workspace deletion cleanup through a
trigger. Entries can have source `auto` for automatic extraction. Conversation
provenance does not make saved entries disappear when a transcript is deleted.

`conversation_memory_state` stores the frozen core, source baseline and recalled
IDs; `memory_extraction_state` stores the extraction cursor and failure state.
Both are deleted with their conversation. `memory_consolidation_state` tracks
new automatic entries and the last consolidation per space. Search indexes and
embeddings remain rebuildable caches; back up the profile for authoritative data.

The [bot gateway](bot-fleet.md#security-and-data) database is at schema v7.
Schema v5 added `owner_memories`, `routine_runs` and
`meta.owner_memory_revision`. Schema v6 adds `environments` and
`environment_secrets`, gives each bot an `environment_id` and display `slot`,
and adds a nullable `environment_id` to owner memory (null for global entries)
and activity. The migration turns every bot into an environment of one, in one
transaction with integrity and foreign-key checks. Schema v7 adds
`environments.compaction_json`, the default compaction model of an
environment's bots without one of their own (`bots.compaction_json` is null);
the migration seeds it from each environment's bots in the same transaction. Owner memory survives bot
deletion; entries that belong to an environment are deleted with that
environment. Routine runs are deleted with their routine or bot. Each bot's own
memory lives in its environment's desktop profile inside the environment's
persistent home volume. Back up both gateway data and environment homes. A
gateway binary refuses a database newer than its supported schema; an older
gateway cannot open v7 unless it supports v7. Downgrade by restoring a matching
backup.

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

## Configuration brought to an environment

Global skills sent from a computer are installed atomically in
`~/.agents/skills/<name>` in the bot environment, with provenance `fleet` (shown
as **From a computer**). They live in the environment's persistent home volume and
are shared by its bots; changing or removing the source on that computer does not update
that copy automatically.

Subscription slots created for remote sign-in are ordinary subscription slots,
kept in the environment's profile with credentials managed by the corresponding
provider integration, and every bot of the environment can use them. They
survive container replacement with the home volume. New slots are removed when
their sign-in fails, expires or is cancelled; successful slots remain until
removed. Back up environment homes together with gateway data as described in
the [fleet guide](bot-fleet.md#updates-backups-and-removal).

## Bot environment data

A fleet environment's home volume holds one Maestrly profile for all of its
bots. The environment's model providers and API keys, subscription slots,
skills, MCP servers and settings are shared, and so are the cookies and site
data of the browser that bots drive with `browser_*`. Each bot keeps its own
data under its bot id:

| Bot data | Where it is kept |
| --- | --- |
| Membership and display slot | The `fleet.instance.bots` setting |
| Profile and pause state | The `fleet.instance.bots.<botId>.profile` and `fleet.instance.bots.<botId>.paused` settings |
| Gateway token | `fleet.instance.bots.<botId>.gatewayToken` in the secure store; only in memory when secure storage is unavailable |
| Conversation | A standalone conversation of the profile, with working files in `standalone-chats/<conversationId>` |
| Queue and transcript extras | `fleet-instance/bots/<botId>/inputs.json` and `transcript.json` in the profile |
| Queued attachments and tool images | `fleet-inputs/<botId>/` and `fleet-images/<botId>/` in the profile |
| Durable memory | The `bot-self:<botId>` memory space in `local_memories` |
| Chromium profile of its apps screen | `~/.config/maestrly-bots/<botId>/chromium` |
| Session bus, desktop socket, wallpaper, and the size and place of its browser window | `~/.cache/maestrly-bots/<botId>/` (`bus`, `desktop.sock`, `wallpaper.*`, `presenter.json`) |

Claude Code and Codex releases a bot downloads on its own live in the
profile's `runtime-assets/` folder, with the accepted release metadata in the
`runtimeAssets.claudeCodeReleases` and `runtimeAssets.codexReleases` settings.
They are shared by the environment's bots and survive container replacement;
Maestrly keeps the active version, the previous one, and any version a running
turn still uses, and removes the rest.

Two browsers keep separate data. The browser that a bot drives with `browser_*`
runs in the environment's Maestrly process, so all bots of the environment share
its cookies and site logins. Programs on a bot's apps screen open Chromium
through the `BROWSER` wrapper with that bot's own profile, which shares nothing
with the `browser_*` browser or other bots' profiles. That profile uses
Chromium's basic password store rather than the environment's keyring, so treat
passwords and cookies saved there as unencrypted. Bots of the same environment
can read all of these files; see the
[fleet security boundary](bot-fleet.md#security-and-data).

Archiving a bot uninstalls it and keeps its data; only its gateway token is
removed from the environment until the bot is restored. Deleting it forever
removes its conversation and working files, its memory space, its folders under
`fleet-instance`, `fleet-inputs`, `fleet-images`, `~/.config/maestrly-bots` and
`~/.cache/maestrly-bots`, and its settings. It never removes the environment's
accounts, skills, MCP servers or other files in the shared home folder.

The first start of a bot image with environments on the home volume of a
single-bot container from before environments adopts that bot, found by its
`fleet.instance.profile` setting, as the bot in slot 1:

1. The queue, transcript extras, attachments and images are copied (hard-linked
   when possible) into the bot's own folders; the legacy files stay
   authoritative until the next step succeeds.
2. One database transaction writes the bot's profile and pause settings, re-keys
   its memories from `bot-self` to `bot-self:<botId>`, records it in slot 1 and
   removes the legacy settings.
3. The legacy files are removed. Leftovers are removed at a later start.

A failure before the transaction leaves the legacy bot unchanged, and the next
start tries again; the adoption can run again safely. It copies no secrets: the
bot gets its gateway token again when the gateway installs it, and the
environment keeps the control token and keyring password the container already
had.

## Voice model

Voice dictation uses a speech model installed only after you confirm its
download from the microphone or in **Settings › Maestrly Chat › Components**. It
lives in the profile at `runtime-assets/whisper-model` (547 MB, verified
against a pinned SHA-256 before use) and can be removed from Components; the
next dictation offers to download it again. The speech engine and its
voice-activity model are part of the local ML runtime under
`runtime-assets/local-ml-runtime`.

Recordings and transcriptions are not stored separately: audio is kept in memory
only until it is transcribed, and a sent transcription is an ordinary user
message. Earlier versions cached a smaller model under
`transformers-cache/Xenova/whisper-base`; the app deletes it the first time
dictation starts.

## Artifacts

Local artifacts live in `artifacts/` in the application profile: `artifacts.sqlite`
holds artifacts, versions, sessions, and which preview image belongs to
each version, and `blobs/` holds file contents and preview images, stored once
by SHA-256. The directory is owner-only (`0700`), and the database
and stored files are created `0600`. Only the artifact host process writes there. Artifacts are independent
of conversations: deleting a conversation keeps its artifacts, and deleting an
artifact removes its versions and any files no other artifact uses.

For shared artifacts, `artifacts.sqlite` also holds the people each one is shared
with (their names, the digests of their personal links, and a coarse label and
the last visit of each device), pending access requests, the scrypt hash of an
access code, up to 500 recent events per artifact, and the comments left on it
(author name, text, the quoted passage, and the version). Revoking a person
deletes their row, link digest, and devices. Deleting an artifact deletes all of
it. The tokens of personal links are kept outside that database, in
the application settings, encrypted with the operating-system keyring; without
it they stay in memory until the app quits. Exports do not include them, so after
restoring an export personal links must be reset.

Export includes a consistent snapshot of the local artifacts database
(`artifacts/export/artifacts.sqlite`, written for the export and removed after
it) together with `artifacts/blobs/`. If the snapshot cannot be written, for
example because hosting is turned off, the export reports "Could not export
artifacts." Reset stops the host and removes `artifacts/`. See
[Artifacts](artifacts.md).

### Server artifacts

The paired bot server stores its artifacts database, blobs, previews, sharing
state, sessions, activity, and comments in `/data/artifacts/` inside the gateway
volume. These are separate from the desktop profile. The same artifact storage
layout applies; the gateway owns the writes. Server settings and per-bot
publication permissions live in the gateway's state. Artifacts carry a device
or bot owner ID; the desktop center combines the hosts without copying the
server's database into the desktop profile.

Desktop export and reset include only local artifacts. The server API does not
provide a database snapshot; back up the gateway volume separately while its
writer is stopped, together with the rest of your bot server data. Turning
hosting or a bot's publication permission off preserves pages. Unpairing leaves
the server running; explicit server removal with data deletion removes its
artifact data too. See [bot server management](bot-fleet.md#update-disconnect-and-remove).

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
