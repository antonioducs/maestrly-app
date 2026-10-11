# Remote workspaces and chats

Maestrly can run your chats and workspaces on a server instead of this computer. They keep working while this computer
is off, and you use them from the same window: the sidebar lists the chats and workspaces of this computer and of the
server side by side, grouped by where they run.

This is experimental and builds on the [bot server](bot-fleet.md): the server runs one more Maestrly, in a container of
its own, for your chats and workspaces. That container is called a **workspaces environment**, and the Maestrly in it a
**host**. Bots and workspaces can share a server; they never share a container.

## What runs where

| On the server | On this computer |
| --- | --- |
| Conversations, their messages, and the agent's turns, including Maestro, subagents, plans, and reviews | The window: sidebar, chat view, drawer, and settings |
| Workspaces, their Git repositories and worktrees, and terminals | Sound, keyboard shortcuts, window layout, and updates of this app |
| Model accounts, skills, MCP servers, prompts, and memory of the host's profile | This computer's own chats, workspaces, accounts, and settings, unchanged |
| The agent's browser, with its cookies and site logins | The microphone and voice transcription |

A turn that is running on the server keeps running when this computer sleeps, loses its connection, or closes the app.
When you come back, the conversation shows what happened meanwhile.

## Set up

1. Set up a bot server and connect this computer to it: see [Set up the bot server](bot-fleet.md#set-up-the-bot-server).
   A server on a VPS is what keeps working while this computer is off.
2. Open the **Bots** tab, select the server, and choose **Set up workspaces on this server** under **Workspaces**.
   The server creates the workspaces environment and starts it. A server hosts workspaces in one environment; use
   another server to keep work apart.
3. On the environment's page, add the model accounts the host will use: an API key, a subscription sign-in, or accounts
   brought from this computer, as for a [bot environment](bot-fleet.md#bring-from-your-computer). The host has its own
   accounts, skills, and MCP servers; nothing is copied from this computer unless you ask.

Once the environment runs, the **Chats** and **Workspaces** tabs show two sections: **This computer** and the server's
name. With no server that hosts workspaces, the sidebar has no headings and looks as it always did.

If **Workspaces** says **Update the server to run workspaces on it**, the server runs a version from before this
feature: use **Update bots** first.

## Use it

- **New chat on the server.** Use the **+** button on the server's heading in the **Chats** tab. The header's own
  **New chat** button still creates a chat on this computer.
- **Add a workspace on the server.** Use the **+** button on the server's heading in the **Workspaces** tab. You open a
  folder that is already on the server, create a project, or clone a Git repository. Folders are chosen in a dialog
  that browses the server, because the server has no desktop to show a system dialog on. Cloning uses the Git
  credentials of the server's environment, not this computer's.
- **Work in a conversation.** The chat view is the same as for a conversation of this computer. The drawer offers
  **Browser**, **Terminal**, **Files**, **Plan**, **Review**, and **Notes**. The terminal is a shell on the server, in
  the conversation's folder. **Browser** shows the agent's browser on the server, live: see [Browser](#browser).
  **Files** moves files between this computer and the server: see [Files](#files).
- **Settings of the host.** In **Settings**, the sections about a profile (**Maestrly Chat**, **Bots**, **Platform**,
  **Usage & cost**, and **Execution**) get a **Settings of** selector. Choose the server there to change the host's
  accounts, models, skills, and defaults. The other sections are this computer's and have no selector.
- **Start, stop, restart, update, and archive.** These are on the environment's page, reached with **Manage** under
  **Workspaces** on the server page, or **Open server page** in the menu of the server's heading. Stopping,
  restarting, or updating at once interrupts the chats that are running on the server. **Update** waits until no chat
  is running.

### Where files live on the server

| Server | Folders offered when you add a workspace |
| --- | --- |
| A VPS set up by Maestrly | **Workspaces**: `/srv/maestrly`, a folder of the server itself, mounted in the environment at the same path. **Home**: the environment's home folder, in its Docker volume. |
| Docker on this computer | **Home** only. No folder of this computer is mounted. |
| A server you manage | **Workspaces** when you set `MAESTRLY_GATEWAY_WORKSPACES_ROOT` in its `.env`; **Home** always. |

Prefer the **Workspaces** folder for projects: its files are ordinary files of the server, so you can reach them over
SSH, back them up, and keep them when the environment is archived or deleted. The environment's home volume holds the
host's profile: conversations, accounts, settings, worktrees, and the files of plain chats.

A server you manage mounts the folder named by `MAESTRLY_GATEWAY_WORKSPACES_ROOT`, an absolute path owned by user id
1000, the user the environment runs as. The environment is created with that mount: after you set or change the
variable, restart the gateway and then restart the workspaces environment. A VPS that Maestrly set up before this
feature gets `/srv/maestrly` the next time you use **Update bots**.

## Browser

The **Browser** tab of the drawer, in a conversation on the server, shows the conversation's browser on the server: the
same browser the agent drives, with the server's cookies and site logins. What the agent does in it appears as it
happens, and you can use it yourself: click, scroll, drag, type, and use its tabs, address bar, **Back**, **Forward**,
and **Reload**.

- **Keyboard.** Accents, dead keys, input methods, and the emoji picker work as in any field of this computer: the text
  is composed here and typed into the page. Editing shortcuts follow this computer's habits; on a Mac, ⌘ works as Ctrl
  does on the server (⌘←/⌘→ go to the start and end of the line, ⌥←/⌥→ move by word). **⌘L**/**Ctrl+L** goes to the
  address bar, **⌘R**/**Ctrl+R** reloads, and **⌘[**/**⌘]** or **Alt+←**/**Alt+→** go back and forward. Other
  shortcuts stay with this app.
- **Copy and paste.** Copying copies the page's selection to this computer's clipboard, through the page's own copy
  command, so editors that put their own text on the clipboard copy as they would locally. Pasting pastes this
  computer's text (and its formatting, when the page accepts it). Images and files are not pasted.
- **Lists.** A drop-down list of the page opens as a list of this window, under the field; choose an option or press
  Escape. The keyboard also changes a focused list, as in any browser.
- **Sign-in windows.** A window the page opens to sign in (for example **Sign in with Google**) replaces the page while
  it is open, under a bar with its address and a **Close** button. It closes by itself when the sign-in finishes.
- **One device at a time.** When another computer opens the same conversation's browser, it takes over, and this one
  says **This browser is open on another device**, with **Show here** to take it back.

The browser sends a picture of the page only when the page changes, and at most two pictures travel at once: on a slow
connection it shows fewer pictures per second rather than falling behind. When the connection is very slow, the
pictures are smaller and more compressed until it improves. The stream stops when you switch tabs or conversations or
minimize the window; the page stays open on the server.

## Files

The **Files** tab of the drawer, in a conversation on the server, shows the server's files and moves them to and from
this computer. It opens on the conversation's folder when that folder is one Maestrly can use, and on the
**Workspaces** folder otherwise.

- **Browse.** The tab shows the folders offered when you add a workspace (**Home**, and **Workspaces** when the server
  mounts one), with each file's size and date, and the free space of the server's disk. **Show hidden files** lists the
  entries whose names start with a dot.
- **Preview, rename, and delete.** The **…** menu of a file shows its first 64 KB, renames it, or deletes it. Deleting
  a folder deletes everything in it, and asks first. A link is deleted without what it points to.
- **Upload.** Use **Upload…** to choose files on this computer, or drag them from the Finder or the file manager onto
  the tab. They go to the folder on screen. A name that is already taken stops the upload; choose **Replace** to
  overwrite the file on the server. Folders are not uploaded: compress them first.
- **Download.** The download button of a file saves it to this computer's **Downloads** folder, next to any file of the
  same name rather than over it. **Open on this computer** in the **…** menu downloads the file into a temporary folder
  and opens it with this computer's default app.
- **PDF attachments** of a chat on the server open on this computer the same way, through a download.

The **Transfers** list under the files shows each transfer's progress, speed, and time left, and can pause, resume,
cancel, try again, or show a download in its folder. A file moves in parts, up to four at a time, and each part is
checked with a SHA-256 checksum as it arrives. Text and other files that compress well are compressed with zstd on the
way. Once all parts arrive, the whole file is checked against the original on the other end before it is published.

Transfers survive interruptions. When this computer sleeps, the connection drops, the server restarts, or the app quits,
a transfer keeps the parts it has and goes on with the rest once the server can be reached. If the file changes on
either end while it moves, the transfer stops: **Try again** starts it over with the new version.

## Connection states

The server's heading shows how this computer reaches the host:

| State | Meaning | What to do |
| --- | --- | --- |
| No label | Connected. | — |
| **Connecting…** or **Reconnecting…** | The connection is being opened, or dropped and is being opened again. Work on the server continues. | Wait, or use **Try again**. The section keeps its last list, dimmed, and an open conversation says it is reconnecting. |
| **Update required** | The host and this app run different versions. They must run the same version, because this window calls the host's own functions. | Update the older of the two: **Update bots** for the server, or the app's own update for this computer. |
| **Stopped**, **Starting…**, or **Failed to start** | The state of the workspaces environment on the server. | **Start** it, or open the server page for details. |
| **Not connected** | This computer does not reach the bot server. | Check the server and its connection in **Settings → Bot server**. |

After a reconnection, the section and any open conversation of the host are loaded again. Messages queued behind a
running turn are kept by this window only, and are lost if the connection drops or the window closes before they are
sent.

Two computers paired with the same server see the same chats and workspaces. Both receive a turn as it streams, and
either can answer a permission request, a question, or a plan. A chat or workspace that the other computer created,
renamed, or removed appears here when this window gets the focus again.

## Not available yet

- **The editor is not shown** for a conversation on a server: its **Code** tab is hidden.
- **In the remote browser:** uploading a file through a page (a file field says so instead of opening), DevTools,
  date and color pickers of the page, drop-down lists inside frames of other sites (use the keyboard), the page's
  sound, and downloads, which stay on the server. The picture is not sharper on high-resolution displays.
- **Whole folders do not move.** **Files** uploads and downloads files one by one; compress a folder in a terminal of
  the server, or use Git. Revealing a file or folder of the server in a file manager is unavailable, because it would
  open on the server's own desktop, which nobody sees.
- **Alert sounds** do not play for conversations on a server.
- **Drawer tools stay docked** for those conversations: no floating windows and no pop-up shortcuts.
- **ChatGPT Web** companion sessions, paired reviews between two conversations, moving a conversation between
  folders, and workspace groups are for conversations of this computer.
- **Several servers.** This computer pairs with one bot server, so it shows one server's chats and workspaces.
- **Isolation between workspaces of one server.** They share one container, one user, and one set of accounts.

## Security

Pairing this computer with a bot server already lets it control every environment of that server. For the workspaces
environment that means everything a Maestrly window can do on its own computer: read and write the host's files, run
commands in its terminals, and use its accounts. See [Remote workspaces](security-model.md#remote-workspaces) for the
boundaries, and revoke a lost computer as described in [Security and data](bot-fleet.md#security-and-data).

## Troubleshooting

- **The server's section stays on Connecting… or Reconnecting….** Open the server page: the workspaces environment
  must be **Running**. For a VPS, check that the SSH tunnel is connected in **Settings → Bot server**.
- **Update required after updating the app.** Use **Update bots**: the server moves to this app's version, and the
  workspaces environment restarts on it once no chat is running.
- **A workspace cannot be added under `/srv/maestrly`.** The folder must belong to user id 1000 on the server:
  `sudo chown 1000:1000 /srv/maestrly`.
- **A cloned repository asks for credentials.** Configure Git credentials in the environment, for example from a
  terminal of a chat on the server. They are kept in the environment's home volume.

## For developers

- The design is in [`docs/superpowers/specs/2026-09-29-remote-hosts-design.md`](superpowers/specs/2026-09-29-remote-hosts-design.md).
- `MAESTRLY_DEV_DIRECT_HOST=http://<control token>@<address>:<port>` connects a development or test build straight to
  the control server of an app started with `MAESTRLY_SERVER_MODE=1`, without a bot server. Packaged builds ignore it.
- `apps/desktop/test/e2e/remote-hosts.spec.ts` runs two instances of the built app, one in server mode, and checks the
  mixed sidebar, a chat turn, a terminal, adding a workspace, the **Files** tab (browsing, preview, rename, delete,
  upload, download, and opening a file), and the **Browser** tab (frames drawn, address bar, typing with accents, and
  copying to this computer's clipboard). `remote-hosts-server.spec.ts` does the same through a gateway, from the
  **Server** page to a stopped and started environment.
- `npm run test:e2e:bot-fleet:workspaces` checks a workspaces environment on the real images: server mode, the
  mounted folder, the bridge through the gateway, a chat turn whose model drives the host's browser, the browser
  streamed over the bridge (JPEG frames paced by acknowledgements, input, a resize, a list, a refused file chooser, the
  agent's screenshot while streaming, a takeover, two conversations streamed at once, the stop and the release of its
  window), a host terminal, an upload and a compressed range download through the gateway, and that revoking the
  device cuts its transfers. It needs Docker and both images; `npm run test:e2e:bot-fleet` runs it as one of its steps.
- The browser stream (`apps/desktop/src/main/drawer/browser-stream.ts`) uses the bridge: the host moves the
  conversation's browser views into a shown, unfocusable window of its display while someone watches (Chromium paints
  nothing for a hidden window), streams JPEG frames from the page's DevTools session (`Page.startScreencast`), and holds
  each frame's acknowledgement to Chromium until the window acknowledges it. Input goes back through the same DevTools
  session; the host's display gets no input.
- File transfers use the `host-files` routes of the gateway (`/v1/environments/:eid/host-files/…`), passed through to
  the host's control server, never the bridge. A gateway or host without the `host-files` feature makes the **Files**
  tab ask for an update.
