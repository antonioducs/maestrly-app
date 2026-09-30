# Artifacts

An artifact is a web page (HTML, CSS, JavaScript, and assets) that an agent
publishes for you. Every change creates a new version, and earlier versions are
kept. Maestrly serves artifacts from this computer, and only to this computer,
while the app is open.

## Asking for an artifact

Artifact tools are Maestrly app tools, so they are available when app tools are
on for the conversation. Ask an agent for a prototype, a report, a dashboard, or
any other page worth viewing in a browser. The agent uses these tools:

| Tool | What it does |
| --- | --- |
| `artifact_create` | Publishes a page, from files passed inline (up to 5 MiB) or from a folder in the conversation's files, such as a build output. The entry file defaults to `index.html`. |
| `artifact_update` | Creates a new version from exact text edits, added, replaced, or removed files, or a folder. The agent passes the version it read; if a newer version exists, the update fails instead of overwriting it. |
| `artifact_get` | Reads an artifact's versions and files, or the text of one file. |
| `artifact_list` | Lists the conversation's artifacts, or the whole project's. |
| `artifact_open` | Opens an artifact in the conversation's browser drawer. |

Reading and listing never ask for permission. Publishing, updating, and opening
follow the conversation's permission mode. An agent reaches only the artifacts
of its own project, or of its own conversation when that conversation is
standalone. Agents cannot delete or share artifacts.

## Opening artifacts

- **In the chat**: each publication shows a card with the title and version.
  **Open** shows the page in the conversation's browser drawer.
- **In the Artifacts center**: **Artifacts**, in the sidebar footer, lists every
  artifact with its versions, the conversation it came from (or "Deleted
  conversation" and its last title), and the last update. From there you can
  open any version in your browser, go to the conversation, or delete the
  artifact.

The page opens in a viewer that shows its title, a version picker, and **Leave**,
which ends the browser's session on that page. Only you can open artifacts in
this version: each opening uses a single-use ticket that expires after 60
seconds and is removed from the address bar immediately.

## Hosting

The artifact host runs in a separate process and listens only on
`127.0.0.1`, on the port set in **Settings → Artifacts** (4010 by default). It
starts when an agent publishes or when you open an artifact, and at launch when
artifacts exist. If the port is in use, the Artifacts center and the settings
say so; choose another port there. Turning hosting off stops the host: agents
cannot publish, and existing artifacts do not open until you turn it on again.

## Isolation

Artifact code is untrusted. The viewer and the page run on different origins:
the page is loaded in a sandboxed frame with an opaque origin, from a path that
carries a signed, expiring capability. The page:

- cannot read the viewer's cookies or call the host's API;
- cannot navigate the viewer or submit forms;
- can load only its own files, plus scripts, styles, images, and fonts from
  `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`,
  `fonts.googleapis.com`, and `fonts.gstatic.com`;
- can open popups, which show their real address.

Loading a library or font from those CDNs reveals your IP address to them, as any
web page that uses them does.

## Storage and limits

Artifacts are stored under `artifacts/` in the application profile, separately
from conversations: deleting a conversation keeps its artifacts. A version holds
up to 500 files, 10 MiB per file and 50 MiB in total, and an artifact keeps up to
200 versions. The storage limit (2 GB by default) is set in **Settings →
Artifacts**; new versions fail above it. Files are stored once, however many
versions or artifacts share them.

Deleting an artifact removes all of its versions and files, and its links stop
working. See [Local data and recovery](local-data.md#artifacts) for export and
reset.

## Sharing

Artifacts cannot be shared with other people yet. Personal links, comments, and
hosting on a bot server are planned.
