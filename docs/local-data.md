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
a memory space: a workspace, the profile's `personal-chat` space, or a fleet bot's
own `bot-self:<botId>` space. Bot
profiles from before environments used a single `bot-self` space, which is
re-keyed when the bot is adopted (see
[bot environment data](#bot-environment-data)). The migration removes the
workspace foreign key and preserves workspace deletion cleanup through a
trigger. Entries can have source `auto` for automatic extraction. Conversation
provenance does not make saved entries disappear when a transcript is deleted.

Ordinary standalone chats share `personal-chat`; project and bot conversations
do not use it. The existing schema supports this space without a new table or
synthetic workspace. Personal configuration lives in `app_settings` under
`chat.personalMemory`, separately from project recall/extraction configuration
at `chat.memory`. Missing settings enable personal access and recall but leave
extraction disabled. Unreadable or invalid personal settings disable assistant
access without removing entries. Deleting a chat or workspace leaves personal
entries intact. Manage and export them from **Settings → Chat → Models & agents →
Personal memory → Manage personal memory**; exports
include the full collection, including archived and superseded entries. There is
no automatic import from project/bot memory and no cross-device synchronization.

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

The OAuth sign-in of a remote MCP server is stored apart from its connection
details, encrypted under `chat.mcpOAuth.<id>` on the host that runs the server,
so that a token refresh never rewrites the details. The record (version 2) holds
the server URL it was made for, the person's own OAuth client (client ID and
secret, when set), and each signed-in account: its id, name, e-mail, scope,
client registration, tokens, and discovery results. A version 1 record (one
sign-in) is read as a single account named **Account 1** for all conversations
and rewritten. It is written only through secure storage, is left out of data
exports, and is removed on sign-out (one account, or all of them) and when the
server is removed. Accounts switched off in a conversation are listed in that
conversation's preferences as `<serverId>#<accountId>`; no token is.

## Plugins

Plugin records live in `app_settings`:

- `plugins.marketplaces.v1`: the marketplace sources (URL, ref, sparse paths,
  last fetched commit and error). The two OpenAI sources are listed once by
  default (`plugins.presetsSeeded.v1`) and fetched only when opened or refreshed.
- `plugins.installed.v1`: each installed plugin, with its source, commit,
  enablement, scope, consent, MCP server ids (`plg_…`), and the normalized MCP
  configuration and input declarations of the installed version. It never holds
  input values.
- `plugins.secrets.<plugin>`: the values entered for a plugin, encrypted through
  the secure store. A record that cannot be decrypted leaves the plugin's
  servers that need those values unavailable.

Files live under `<userData>/plugins`:

| Directory | Contents |
| --- | --- |
| `sources/<marketplace>/` | Partial Git clone of a marketplace source |
| `sources/ext/<hash>/` | Partial Git clone of a plugin hosted in another repository |
| `packages/<plugin>/<version>/` | Installed files of one version, never modified after install |
| `data/<plugin>/` | `PLUGIN_DATA` of a plugin's MCP servers; kept across updates, deleted only on request |
| `.staging/` | Temporary copies, removed after 30 minutes |

Startup finishes interrupted removals, rolls back interrupted installs and
updates, and deletes directories no record references. Uninstalling removes the
plugin's servers, cached tool catalogs, skill settings, stored values and
installed files.

Plugin hooks keep little state. A conversation's `hookSession` preference
records where its `SessionStart` hooks last ran. While a turn runs hooks, the
conversation's text is copied to an owner-only file under the system temporary
folder (`maestrly-hook-transcripts/`) for hooks that read `transcript_path`;
the file is deleted when the turn ends. Hook messages are never stored.

A remote workspaces host and a bot environment keep the same records and files in
their own profile, in the environment's persistent home volume. A plugin brought
from a computer is downloaded there from its source; the computer keeps its own
copy, and later changes on either side do not affect the other.

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

Claude Code, Codex and Google Antigravity ACP releases a bot downloads live in the
profile's `runtime-assets/` folder, with the accepted release metadata in the
`runtimeAssets.claudeCodeReleases`, `runtimeAssets.codexReleases` and
`runtimeAssets.antigravityReleases` settings.
They are shared by the environment's bots and survive container replacement;
Maestrly keeps the active version, the previous one, and any version a running
turn still uses, and removes the rest. Google AI credentials and ACP conversation
files live separately under `antigravity/accounts/` in the profile. Runtime
updates preserve those account homes; signing out removes the selected home.

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

Artifacts are hosted on the bot server; see [Server artifacts](#server-artifacts).
The desktop profile holds artifacts only if an earlier version published them on
this computer, until you [move or delete them](artifacts.md#artifacts-from-earlier-versions);
no new ones are created there. Moving the last one, or deleting them, removes
the folder.

Those artifacts live in `artifacts/` in the application profile: `artifacts.sqlite`
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

While that folder exists, export includes a consistent snapshot of its database
(`artifacts/export/artifacts.sqlite`, written for the export and removed after
it) together with `artifacts/blobs/`. If the snapshot cannot be written, the
export reports "Could not export artifacts." Reset stops the host and removes
`artifacts/`. See [Artifacts](artifacts.md).

### Server artifacts

The paired bot server stores its artifacts database, blobs, previews, sharing
state, sessions, activity, and comments in `/data/artifacts/` inside the gateway
volume. These are separate from the desktop profile. The same artifact storage
layout applies; the gateway owns the writes. Server settings and per-bot
publication permissions live in the gateway's state. Artifacts carry a device
or bot owner ID; the desktop center lists them without copying the server's
database into the desktop profile. An artifact moved from this computer keeps
its ID, versions, comments, and previews, but not its sharing state.

Desktop export and reset do not include server artifacts. The server API does not
provide a database snapshot; back up the gateway volume separately while its
writer is stopped, together with the rest of your bot server data. Turning
hosting or a bot's publication permission off preserves pages. Unpairing leaves
the server running; explicit server removal with data deletion removes its
artifact data too. See [bot server management](bot-fleet.md#update-disconnect-and-remove).

## Remote workspaces data

Each [workspaces environment](remote-workspaces.md) keeps a whole Maestrly
profile of its own on the server, not on this computer:

| Data | Where it is kept |
| --- | --- |
| The host's profile: conversations, messages, memory, notes, settings, model accounts and their keys, skills, MCP servers, and the agent's browser profile | The environment's home volume, `maestrly-env-<id>-home`, mounted at `/home/bot`. Secrets are encrypted with the keyring of the environment, as in a bot environment. |
| Files of plain chats and worktrees of conversations | The same home volume, inside the profile |
| Workspaces added from the server's **Workspaces** folder | The environment's own folder of the server (`<MAESTRLY_GATEWAY_WORKSPACES_ROOT>/<id>`; `/srv/maestrly/<id>` on a VPS that Maestrly set up), as ordinary files owned by uid 1000. An environment created before these folders keeps the whole `MAESTRLY_GATEWAY_WORKSPACES_ROOT` until you move it. Deleting an environment never deletes its folder. |
| The environment's record, kind, limits, idle stop, color, and folder mode | The gateway's database (`environments`, schemas 11 and 13) |
| Uploads in progress | A hidden `.maestrly-upload-<id>.part` file next to the destination, and its record under `host-file-uploads/` in the profile. An upload untouched for 7 days is removed with its partial file. |

This computer keeps only what it needs to show the host: its own id for the
paired server (`fleet.serverId`, removed when you disconnect the server) and,
for each conversation of the host you opened, the drawer's width and open
state for as long as the window runs. Conversations and messages of the host
are never stored here. The drawer tabs a conversation has open are kept by the
host, with the conversation.

Files moved with the **Files** tab are the exception, because you ask for them:

| Data | Where it is kept on this computer |
| --- | --- |
| The transfer queue: each transfer, its paths, size, state, checksums, and which of its parts arrived | The `host_transfers` and `host_transfer_ranges` tables of the app database. **Clear finished** in the **Transfers** list removes finished ones. |
| A download in progress | A hidden `.maestrly-<id>.download` file in the Downloads folder, renamed to the file's name once it is verified |
| Files opened from the server | `maestrly-remote-files/<id>/` in the system's temporary folder |
| Downloaded files | The Downloads folder, as ordinary files |

Archiving a workspaces environment removes its container and keeps its home
volume; deleting it forever removes the volume and everything in the host's
profile. Neither touches the files under the server's **Workspaces** folder.
Both remove the environment's Docker network, which holds no data. Back up that
folder and the environment's home volume to keep both.

## Drawer browser history

The drawer browser keeps one history for all conversations, like its shared
session. `browser-history.json` in the application profile (created `0600`)
holds each visited `http`/`https` page without its fragment: its URL, title,
visit and typed-visit counts, last visit time, and favicon address. Favicons are
stored there too, as images of at most 32 KiB, for up to 500 sites. Error pages
and tabs that delegated agents open are not recorded. The history keeps at most
5,000 pages, dropping the least used and least recent first, and is written a
moment after each change and when the app quits.

Remove a page from the address bar suggestions with **Shift+Delete** or the ×
button; removing a search removes every visit of that query. **Clear browsing
data** in the browser toolbar deletes the whole history together with the
browser's cache, cookies, and storage. Exports do not include the history. Reset
deletes the file. A file that cannot be read is kept
as `browser-history.json.corrupt` and the history starts empty.

A conversation of a [workspaces environment](remote-workspaces.md) browses on
the server, so its visits, and the requests for its search suggestions, belong
to the host's profile rather than this computer's.

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
