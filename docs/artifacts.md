# Artifacts

An artifact is a web page (HTML, CSS, JavaScript, and assets) that an agent
publishes for you. Every change creates a new version, and earlier versions are
kept. Maestrly serves artifacts from this computer while the app is open, or
from your paired bot server while that server is running. An artifact is private
until you [share](#sharing) it.

## Asking for an artifact

Artifact tools are Maestrly app tools, so they are available when app tools and
the Artifacts group are on for the conversation. Both are enabled by default.
Ask an agent for a prototype, a report, a dashboard, or
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
| `artifact_comments` | Reads the [comments](#comments) people left: each thread with the passage it quotes or the element it was placed on, its version, its author, and its replies. Open threads by default. |
| `artifact_comment_reply` | Replies to a thread on your behalf. The reply is shown as written by your agent. |
| `artifact_comment_resolve` | Marks a thread as resolved. |

Reading, listing, and reading comments never ask for permission. Publishing,
updating, opening, replying, and resolving follow the conversation's permission
mode. An agent reaches only the artifacts of its own project, or of its own
conversation when that conversation is standalone. Agents cannot delete or share
artifacts.

Bots have seven of these tools: all except `artifact_open`. Enable **Publish
artifacts** for the bot to let it use them on the server. A bot can read, update,
reply to, and resolve comments only on its own artifacts. **Open** on a bot
publication card in the desktop opens the external viewer.

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
  an available conversation, share the artifact, or delete it.

The center combines local and server artifacts. Use **Host** to choose **All
hosts**, **This computer**, or **Bot server**. Server cards identify their bot
or show **Other computer** when another paired device published them. Owner
management is available from the desktop; agent access remains scoped to the
publishing device and project or conversation, or to the owning bot.

The page opens in a viewer. Its top bar shows the title and who published it,
the version on screen (step back and forth, or choose one from a list that shows
each version's summary and open comments), the page width (full, tablet, or
phone), **Comment** and the list of comments, **Share** for you, **⋯** (reload,
full screen, copy a link to the version on screen), and your avatar. The avatar
says who you are on that page and offers **Leave on this device**, which ends
the browser's session on it. Viewing an earlier version shows a notice with a
way back to the current one. When you open an artifact from Maestrly, the link
carries a single-use ticket that expires after 60 seconds and is removed from the
address bar immediately.

### Previews

After each publication, Maestrly renders the new version in a hidden window on
this computer and keeps an image of it as the card's preview, without comments.
Until then, and if
a page never finishes loading, the card shows an outline instead. Rendering runs
the page's scripts and loads what it loads, including libraries and fonts from
the allowed CDNs, even if you never open the page yourself.

For server artifacts, the desktop also queues a missing preview when it first
lists that version in the center. Rendering takes place on your computer when
the viewer is reachable, not in the gateway. This can run a remote page and
contact its allowed CDNs before you explicitly open it.

## Hosting

### This computer

The artifact host runs in a separate process and listens only on
`127.0.0.1`, on the port set in **Settings → Artifacts** (4010 by default). It
starts when an agent publishes or when you open an artifact, and at launch when
artifacts exist. The Artifacts center shows the host's state next to its title.
When the host cannot run, the center says why instead of listing artifacts, and
offers the fix: turn hosting on, choose another port if the port is in use, or
restart the host after repeated failures. Nothing is deleted in those cases.
Turning hosting off stops the host: agents cannot publish, and existing artifacts
do not open until you turn it on again.

The desktop host never listens on another network interface. For other people to reach a
shared artifact, you expose the host yourself and tell Maestrly the address in
**Settings → Artifacts → Public address**: for example, the HTTPS address of
[Tailscale Serve](https://tailscale.com/kb/1312/serve) pointed at the host's
port. Maestrly builds shared links on that address and accepts requests sent to
it. Without a public address, links work only on this computer.

### Bot server

In **Settings → Artifacts → Bot server**, turn on **Host artifacts on the bot
server**. Existing servers start with hosting off after an upgrade. A fresh
installer setup enables it and copies only your sharing name and default link
expiry; joining an existing server preserves its settings.

Use **Copy from this computer** to copy those two values later, or edit the
server's **Your name** and default link expiry separately. Set its storage limit
and **Public address** independently: copying settings does not copy pages,
public addresses, or storage limits. The server's default storage limit is 2 GB.
Turning hosting off stops publication and viewing but keeps stored data.

Choose **Publish new artifacts to → This computer** or **Bot server** for
publications from desktop conversations. Changing this does not move existing
artifacts; updates go to the host that already owns them. If the chosen server
is off, unsupported, or unreachable, publication fails with a host error; it
never silently publishes on this computer instead.

In a bot's settings, turn **Publish artifacts** on or off. Newly created bots
default to the server's hosting setting; existing bots keep this permission off
when upgraded. Both server hosting and the bot's permission must be on. Turning
the bot's permission off preserves its existing pages.

You can install a server for artifacts alone, without downloading the bot
runtime image. See [bot server setup](bot-fleet.md#artifact-hosting) for ports,
updates, and adding a first bot. Server pages remain available while your
computer sleeps, as long as the server and the visitor's network route run.
Unpairing the desktop leaves the server running. Explicitly removing the server
and its data deletes its artifacts too.

### Reach the server from another device

Set up external access yourself; Maestrly does not install or configure
Tailscale or discover a public address. For example, on an installed VPS with
Tailscale already configured, expose its loopback artifact port to your tailnet:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:4010
```

Use the HTTPS address printed by the command, including `:8443`, as the server's
**Public address**. This separate HTTPS port avoids replacing a gateway service
on 443. Substitute your configured artifact port if it differs from 4010. See
[Tailscale Serve commands](https://tailscale.com/docs/reference/tailscale-cli/serve)
for setup and syntax. Serve provides access within your tailnet; a shared link
alone does not grant network access. Keep Docker's published port on loopback.
An SSH tunnel lets your paired desktop open pages but does not give visitors a
route to them. Server sharing requires a configured public address.

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

Local artifacts are stored under `artifacts/` in the application profile, separately
from conversations: deleting a conversation keeps its artifacts. A version holds
up to 500 files, 10 MiB per file and 50 MiB in total, and an artifact keeps up to
200 versions. The storage limit (2 GB by default) is set in **Settings →
Artifacts**; new versions fail above it, and the Artifacts center warns from 90%
of it. Files are stored once, however many versions or artifacts share them, so
deleting an artifact frees only what no other artifact uses. Previews are stored
with the artifact and count toward the limit.

Server artifacts use `/data/artifacts/` in the gateway volume and have their own
storage limit. Desktop export and reset cover only local artifacts; back up
server data separately.

Deleting an artifact removes all of its versions and files, and its links stop
working. See [Local data and recovery](local-data.md#artifacts) for export and
reset.

## Sharing

**Share**, on a card's menu or in its details, sets who can open an artifact:

| Who can open | What it means |
| --- | --- |
| **Private** | Only the owner through Maestrly. This is how every artifact starts. |
| **People you invite** | Each person opens it with a personal link, or asks for access and waits for your approval. |
| **Anyone with the link** | Whoever has the link opens it as a guest, until the link expires. Invited people keep their access. |

Local links work while Maestrly is open and this computer is awake; server
links work while the server runs. Other people need a route to the
[public address](#hosting) you set for the corresponding host.

### Personal links

Type a name and choose **Create link**: Maestrly copies a link that belongs to
that person. When they open it, the viewer says who invited them and under which
name, and nothing happens until they choose **Continue as** that name. If the
link reached someone else, **I'm not** that person tells you so. Each browser
that continues becomes one of the person's devices, up to 10, and stays signed in
for 90 days after its last visit.

Under **People** you see each person's devices, as a label such as "Safari on
iPhone", and when each was last seen. You can remove one device, copy the link
again, or revoke the person. Revoking ends the link and every device at once and
removes the person from the list; to let them back in, create a new link.
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
identification. Revoking a person deletes what is kept about them, except the
name on the comments they wrote and in the recent activity. Deleting the artifact
deletes all of it.

Agents cannot share an artifact, invite people, approve requests, or change who
can open it.

## Comments

Whoever can open a shared artifact can comment on it, as in a design tool. Each
conversation appears as a pin on the page, with the author's face and how many
messages it has; a red dot marks what is new since you last read it. Pointing
at a pin previews the comment and highlights its passage, and clicking it opens
the conversation beside it, where you reply, step to the previous or next
conversation, and, as the owner, resolve it.

To comment, select text in the page and choose **Comment**, or turn on
**Comment** in the top bar (or press **C**) and click a spot on the page or
select a passage. While comment mode is on, clicks in the page place comments
and do not reach its links or buttons; **Esc** turns it off. A comment belongs
to the version on screen and to its passage or spot. **Comment on the page**, at
the bottom of the list, adds one about the whole page. People reply to a thread,
and delete their own comments. Resolving and reopening threads is yours, or an
agent's on your behalf, and you can delete any comment. Deleting the comment that
starts a thread deletes its replies.

The list of comments, next to **Comment**, shows the open or resolved
conversations of the version on screen, then those of other versions with their
version number; choosing one from another version shows that version. Pins
scrolled out of sight are counted at the top or bottom of the page. When a later
version changes or removes a commented passage or spot, the thread stays with
the version it was written on; on the version on screen it is marked as not
found. The viewer checks for new comments every 30 seconds while it is open, and
remembers in your browser which conversations you read.

Names in comments follow how each person got in. Invited and approved people
carry the name you confirmed. A guest types a name before the first comment, and
it is shown as unverified. Your own comments carry the name set in **Settings →
Artifacts → Your name**, and replies written by an agent are marked as your
agent's.

In Maestrly, a card shows how many threads are open, and new comments count in
the sidebar. The artifact's details list every thread with its passage, author,
and version, where you reply, resolve, reopen, and delete without opening the
viewer. **Send to conversation** puts the open threads, quoted, in the message
box of the conversation the artifact came from, for you to edit and send; it
sends nothing by itself. An agent can also read comments with
`artifact_comments`. Either way the agent is told that other people wrote the
comments and that they are feedback to evaluate, not instructions. A comment
never starts an agent by itself.

**Share → Comments** turns commenting off for an artifact: existing comments stay
readable and nobody can add more from the viewer. An artifact holds up to 2,000
comments of up to 4,000 characters each.
