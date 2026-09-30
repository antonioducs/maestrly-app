# Artifacts

An artifact is a web page (HTML, CSS, JavaScript, and assets) that an agent
publishes for you. Every change creates a new version, and earlier versions are
kept. Maestrly serves artifacts from this computer while the app is open. An
artifact is private until you [share](#sharing) it.

## Asking for an artifact

Artifact tools are Maestrly app tools, so they are available when app tools are
on for the conversation. Ask an agent for a prototype, a report, a dashboard, or
any other page worth viewing in a browser. While you have no artifacts, the
Artifacts center suggests a few requests: choosing one opens a new standalone
conversation with Maestrly tools on and the request in its message box, ready to
edit and send. The agent uses these tools:

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
- **In the Artifacts center**: **Artifacts**, in the sidebar footer, shows every
  artifact as a card with a preview of its page. The sheets stacked behind a
  preview show that earlier versions exist. Each card names the project and the
  conversation it came from (or "Deleted conversation" and its last title) and
  when it was last updated. Search by title or description, filter by project,
  and sort by update, creation, title, or storage used. Selecting a card opens
  its details: where it came from, the storage it uses, and every version, each
  of which opens in your browser. From a card or its details you can also go to
  the conversation, share the artifact, or delete it.

The page opens in a viewer that shows its title, a version picker, who you are
on that page, and **Leave**, which ends the browser's session on it. When you
open an artifact from Maestrly, the link carries a single-use ticket that expires
after 60 seconds and is removed from the address bar immediately.

### Previews

After each publication, Maestrly renders the new version in a hidden window on
this computer and keeps an image of it as the card's preview. Until then, and if
a page never finishes loading, the card shows an outline instead. Rendering runs
the page's scripts and loads what it loads, including libraries and fonts from
the allowed CDNs, even if you never open the page yourself.

## Hosting

The artifact host runs in a separate process and listens only on
`127.0.0.1`, on the port set in **Settings → Artifacts** (4010 by default). It
starts when an agent publishes or when you open an artifact, and at launch when
artifacts exist. The Artifacts center shows the host's state next to its title.
When the host cannot run, the center says why instead of listing artifacts, and
offers the fix: turn hosting on, choose another port if the port is in use, or
restart the host after repeated failures. Nothing is deleted in those cases.
Turning hosting off stops the host: agents cannot publish, and existing artifacts
do not open until you turn it on again.

The host never listens on another network interface. For other people to reach a
shared artifact, you expose the host yourself and tell Maestrly the address in
**Settings → Artifacts → Public address**: for example, the HTTPS address of
[Tailscale Serve](https://tailscale.com/kb/1312/serve) pointed at the host's
port. Maestrly builds shared links on that address and accepts requests sent to
it. Without a public address, links work only on this computer.

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
web page that uses them does. This also happens when Maestrly renders a new
version for its preview.

## Storage and limits

Artifacts are stored under `artifacts/` in the application profile, separately
from conversations: deleting a conversation keeps its artifacts. A version holds
up to 500 files, 10 MiB per file and 50 MiB in total, and an artifact keeps up to
200 versions. The storage limit (2 GB by default) is set in **Settings →
Artifacts**; new versions fail above it, and the Artifacts center warns from 90%
of it. Files are stored once, however many versions or artifacts share them, so
deleting an artifact frees only what no other artifact uses. Previews are stored
with the artifact and count toward the limit.

Deleting an artifact removes all of its versions and files, and its links stop
working. See [Local data and recovery](local-data.md#artifacts) for export and
reset.

## Sharing

**Share**, on a card's menu or in its details, sets who can open an artifact:

| Who can open | What it means |
| --- | --- |
| **Private** | Only you, on this computer. This is how every artifact starts. |
| **People you invite** | Each person opens it with a personal link, or asks for access and waits for your approval. |
| **Anyone with the link** | Whoever has the link opens it as a guest, until the link expires. Invited people keep their access. |

Links work while Maestrly is open and this computer is awake, and reach other
people only through the [public address](#hosting) you set.

### Personal links

Type a name and choose **Create link**: Maestrly copies a link that belongs to
that person. When they open it, the viewer says who invited them and under which
name, and nothing happens until they choose **Continue as** that name. If the
link reached someone else, **I'm not** that person tells you so. Each browser
that continues becomes one of the person's devices, up to 10, and stays signed in
for 90 days after its last visit.

Under **People** you see each person's devices, as a label such as "Safari on
iPhone", and when each was last seen. You can remove one device, revoke the
person, which ends every device and the link at once, or copy the link again.
Maestrly keeps the link encrypted with the operating-system keyring; where that
is unavailable, the link is kept only until you quit, and afterward **Reset
link** issues a new one that replaces it.

### Access requests

Someone who opens a shared artifact's address without a personal link can type a
name and a short message and ask for access. The request appears in the
artifact's details, where you confirm or correct the name before you **Approve**
or **Deny**. The page opens in the browser that asked as soon as you approve. A
request waits for 24 hours, and an artifact holds up to 20 waiting requests.
Maestrly plays the permission sound when a request arrives.

### Anyone with the link

With **Anyone with the link**, the artifact's address opens the page for guests.
You can set an access code of at least 6 characters, which guests type first;
after five wrong codes a browser waits 15 minutes. The link stops working for
guests after 7, 30 (the default, which you can change in **Settings →
Artifacts**), or 90 days, or never. Guests are signed in for up to 30 days,
appear under **People** while they are, and are shown as unverified because
nobody confirmed their name. Changing or removing the code signs guests out.

### What you see, and what is kept

The **Artifacts** entry in the sidebar counts what you have not seen yet: a new
device, an access request, a declined invitation. Opening the artifact's details
shows this recent activity and clears the count. **Revoke all sessions** signs
everyone out of an artifact on every device, you included; personal links still
work afterward. Making an artifact private blocks everyone else at once without
forgetting them, so sharing it again restores their access.

For each person Maestrly keeps the name, a coarse device label, and when each
device joined and was last seen. It keeps no IP address and no raw browser
identification. Deleting the artifact deletes all of it.

Agents cannot share an artifact, invite people, approve requests, or change who
can open it. Comments and hosting on a bot server are planned.
