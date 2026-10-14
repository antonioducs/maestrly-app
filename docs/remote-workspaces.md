# Remote workspaces and chats

Maestrly can run your chats and workspaces on a server instead of this computer. They keep working while this computer
is off, and you use them from the same window: the sidebar lists the chats and workspaces of one machine at a time,
this computer or the server, and switches between them in one click.

This is experimental and builds on the [bot server](bot-fleet.md): the server runs one more Maestrly, in a container of
its own, for your chats and workspaces. That container is called a **workspaces environment**, and the Maestrly in it a
**host**. Bots and workspaces can share a server; they never share a container.

A server can run several workspaces environments, one for each scope of your work: for example **Personal**,
**Company A**, and **Company B**. Each one is a separate Maestrly with its own accounts, API keys, site sign-ins, Git
and cloud credentials, skills, MCP servers, memory, conversations, Docker network, and folder on the server, so what
you sign in to for one company never reaches the others. See [Several scopes on one server](#several-scopes-on-one-server).

## What runs where

| On the server | On this computer |
| --- | --- |
| Conversations, their messages, and the agent's turns, including Maestro, subagents, plans, and reviews | The window: sidebar, chat view, drawer, and settings |
| Workspaces, their Git repositories and worktrees, and terminals | Sound, keyboard shortcuts, window layout, and updates of this app |
| Model accounts, skills, MCP servers, prompts, and memory of the host's profile | This computer's own chats, workspaces, accounts, and settings, unchanged |
| The agent's browser, with its cookies and site logins | The microphone and voice transcription |
| VS Code (the **Code** tab), with its extensions and debug sessions | The editor's settings, applied to the server's editor |

A turn that is running on the server keeps running when this computer sleeps, loses its connection, or closes the app.
When you come back, the conversation shows what happened meanwhile.

## Set up

1. Set up a bot server and connect this computer to it: see [Set up the bot server](bot-fleet.md#set-up-the-bot-server).
   A server on a VPS is what keeps working while this computer is off.
2. Open the **Bots** tab, select the server, and choose **Set up workspaces on this server** under **Workspaces**. Give
   the environment a name and a color (and, if you want, memory and CPU limits and an idle stop), then **Create**. The
   server creates the workspaces environment and starts it. Use **New workspaces environment** for each other scope of
   your work.
3. On the environment's page, add the model accounts the host will use: an API key, a subscription sign-in, or accounts
   brought from this computer, as for a [bot environment](bot-fleet.md#bring-from-your-computer). The host has its own
   accounts, skills, and MCP servers; nothing is copied from this computer, or from another environment, unless you
   ask.

Once an environment runs, the **Chats** and **Workspaces** tabs get a machine switcher above the search. It shows the
machine whose chats and workspaces are listed, **This computer** or the environment's name in its color, with what is
going on there: how many conversations need you and how many are running. Beside it, shortcuts to the other machines
carry a red dot when a conversation there finished and needs you. Click a shortcut, or open the switcher and choose a
machine; hovering an environment there shows the server it runs on. The choice applies to both tabs and is remembered;
opening a conversation switches to the machine it runs on. While you filter, a link under the list says how many
results another machine has. With no server that hosts workspaces, the sidebar has no switcher.

If **Workspaces** says **Update the server to run workspaces on it**, the server runs a version from before this
feature: use **Update bots** first. If it says **Update the server to run more than one workspaces environment on it**,
the server hosts one environment and predates several: **Update bots** too.

## Use it

- **New chat on the server.** Switch to the server, then use the **+** button next to **Chats**. With **This
  computer** chosen, the same button creates a chat on this computer.
- **Add a workspace on the server.** Switch to the server, then use the **+** button next to **Workspaces**. You open a
  folder that is already on the server, create a project, or clone a Git repository. Folders are chosen in a dialog
  that browses the server, because the server has no desktop to show a system dialog on. Cloning uses the Git
  credentials of the server's environment, not this computer's.
- **Work in a conversation.** The chat view is the same as for a conversation of this computer. The drawer offers
  **Browser**, **Code**, **Terminal**, **Files**, **Plan**, **Review**, and **Notes**. The terminal is a shell on the
  server, in the conversation's folder. **Browser** shows the agent's browser on the server, live: see
  [Browser](#browser). **Code** is VS Code running on the server: see [Code](#code). **Files** moves files between this
  computer and the server: see [Files](#files).
- **Settings of the host.** In **Settings**, the sections about a profile (**Maestrly Chat**, **Bots**,
  **Usage & cost**, and **Execution**) get a **Settings of** selector. Choose the server there to change the host's
  accounts, models, skills, and defaults. The other sections are this computer's and have no selector.
- **Artifacts.** Agents in chats on the server publish [artifacts](artifacts.md) on the server itself, with nothing to
  set up: the gateway gives the workspaces environment a token of its own for them. Artifact hosting must be on in
  **Settings → Artifacts**. The server's browser cannot reach the artifact viewer, so **Open** on an artifact's card
  and the agent's `artifact_open` open the page in this computer's default browser, through its connection to the
  server. The Artifacts center lists them with the server's other artifacts, as **Other computer**.
- **Memory of the host.** Chats on the server remember with the server's personal memory, and its workspaces keep their
  own project memory there; nothing is shared with this computer's memory. The personal memory panel has a
  **Memories of** selector to show the server's or this computer's: open it with **Manage personal memory** in the
  host's **Maestrly Chat** settings. **Project memory** in a server workspace's menu shows that workspace's memory.
- **Start, stop, restart, update, and archive.** These are on the environment's page, reached with **Manage** next to
  the environment under **Workspaces** on the server page, or **Open environment page** in the **⋯** menu next to
  **Chats** or **Workspaces** while the environment is chosen. Stopping, restarting, or updating at once interrupts the
  chats that are running in that environment; the other environments keep running. **Update** waits until no chat is
  running.

### Where files live on the server

| Server | Folders offered when you add a workspace |
| --- | --- |
| A VPS set up by Maestrly | **Workspaces**: `/srv/maestrly/<environment>`, a folder of the server itself for that environment alone, mounted at the same path. **Home**: the environment's home folder, in its Docker volume. |
| Docker on this computer | **Home** only. No folder of this computer is mounted. |
| A server you manage | **Workspaces** when you set `MAESTRLY_GATEWAY_WORKSPACES_ROOT` in its `.env`; **Home** always. |

`<environment>` is the environment's id, made from its name when it was created: `/srv/maestrly/company-a` for
**Company A**. The gateway creates that folder, owned by user id 1000, before the environment starts.

Prefer the **Workspaces** folder for projects: its files are ordinary files of the server, so you can reach them over
SSH, back them up, and keep them when the environment is archived or deleted. The environment's home volume holds the
host's profile: conversations, accounts, settings, worktrees, and the files of plain chats.

A server you manage mounts subfolders of the folder named by `MAESTRLY_GATEWAY_WORKSPACES_ROOT`, an absolute path owned
by user id 1000, the user the environments run as. An environment is created with its mount: after you set or change
the variable, restart the gateway and then restart each workspaces environment. A VPS that Maestrly set up before this
feature gets `/srv/maestrly` the next time you use **Update bots**.

## Several scopes on one server

Each workspaces environment is a scope of your work. What one environment signs in to or keeps stays in it:

| Kept apart per environment | How |
| --- | --- |
| Model accounts, API keys, subscription sign-ins, skills, MCP servers | Its own Maestrly profile, provisioned on its page |
| Git, GitHub CLI, SSH keys, cloud CLIs, package registries | Its own home volume: sign in from a terminal of a chat there |
| The agent's browser, with its cookies and site logins | Its own browser profile |
| Conversations, workspaces, memory, notes, and artifacts | Its own profile and, for projects, its own folder on the server |
| Network | A Docker network of its own, shared only with the bot server's gateway: an environment cannot reach another's container |

On an environment's page, **Isolation** shows its network and its folder on the server, and **Resources** its memory
and CPU limits and its idle stop:

- **CPU limit** caps how much of the server the environment may use, so a busy build in one scope does not slow the
  others. It applies at once.
- **Stop when idle** stops the environment once no computer has been connected to it and no chat has run there for the
  time you choose (30 minutes to a day). Its terminals and background processes stop too. Start it again from the
  sidebar or its page. It is off by default.
- **Color** (under the environment's **Settings → Preferences**) is the color of its icon in the machine switcher.

An environment created before scopes keeps the server's whole folder (`/srv/maestrly`), so the paths of its workspaces
keep working, and **Isolation** warns that it can read and change the folders of the other environments. **Use a
folder of its own** moves it to `/srv/maestrly/<environment>` once it restarts; move its projects into that folder (over
SSH, for example) and add them again. The same environment moves to a network of its own the next time it restarts or
updates; until then, **Isolation** asks for a restart.

Separate environments keep credentials from mixing by mistake. They still share the server, its kernel, and your
pairing: anyone with root on the server, or with a paired computer, reaches all of them. When a company requires its
work to stay off a machine you share with other work, use a server of its own for it.

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

## Code

The **Code** tab of the drawer, in a conversation on the server, opens VS Code on the server, in the conversation's
folder. It runs there, like the terminal: its terminal, Git, extensions, and debugger work on the server's files and
tools. On this computer it is a window of the drawer like the local editor, so typing, input methods, copy and paste, and
the display's sharpness are this computer's own.

- **First opening.** The server downloads VS Code from Microsoft the first time its editor opens, which may take a
  minute; the tab says so meanwhile. Later openings start it in a few seconds. The editor stops on its own 15 minutes
  after the last window that showed it closes.
- **Settings.** Your VS Code settings on this computer, including the color theme, apply to the server's editor the
  first time it opens there. Extensions are not copied: install them in the server's editor, where they stay. A theme
  that comes from an extension shows the default theme until that extension is installed there.
- **With the chat.** **Maestrly: Send file to conversation** and **Maestrly: Send selection to conversation** in the
  editor add a reference to the conversation's composer. A file of a plan opens in the editor, and the agent's debug tools open the **Code** tab when they need it.
- **Restart.** The restart button next to the tabs restarts the server's editor and opens its windows again; this
  computer's editor keeps running.
- **Two computers.** Each computer that opens the same conversation's editor has a window of its own on the same
  folder. When both change the same file, the last one saved wins, as with two editors on one computer.

The editor is reached through the bot server, with this computer's pairing, like the server's files. On this computer it
runs at a local address (`127.0.0.1`) that only the drawer's editor windows can use.

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

The machine switcher shows how this computer reaches the host: a dot on the server's icon (green when connected, amber
while connecting, gray when not reached, red on a failure) and, under the server's name, one of these states:

| State | Meaning | What to do |
| --- | --- | --- |
| **Online**, or what its conversations are doing | Connected. | — |
| **Connecting…** or **Reconnecting…** | The connection is being opened, or dropped and is being opened again. Work on the server continues. | Wait, or use **Try again**. The server's list keeps its last state, dimmed, and an open conversation says it is reconnecting. |
| **Update required** | The host and this app run different versions. They must run the same version, because this window calls the host's own functions. | Update the older of the two: **Update bots** for the server, or the app's own update for this computer. |
| **Stopped**, **Starting…**, or **Failed to start** | The state of the workspaces environment on the server. | **Start** it, or open its page for details. |
| **Not connected** | This computer does not reach the bot server. | Check the server and its connection in **Settings → Bot server**. |

After a reconnection, the server's list and any open conversation of the host are loaded again. Messages queued behind a
running turn are kept by this window only, and are lost if the connection drops or the window closes before they are
sent.

Two computers paired with the same server see the same chats and workspaces. Both receive a turn as it streams, and
either can answer a permission request, a question, or a plan. A chat or workspace that the other computer created,
renamed, or removed appears here when this window gets the focus again. The red dot of a conversation that needs you is
kept by the server: opening the conversation on one computer clears it on the other.

## Not available yet

- **In the server's editor:** this computer's extensions, forwarding a port of the server to this computer (the
  agent's browser on the server reaches it there), and opening the folder in VS Code desktop.
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
- **Several servers.** This computer pairs with one bot server, so it shows the chats and workspaces of that server's
  environments only.
- **Isolation between workspaces of one environment.** They share one container, one user, and one set of accounts:
  use another environment for work that must stay apart.

## On a phone

The [mobile app](mobile.md) shows the same chats and workspaces of the server, and opens new chats on it. A phone uses
a smaller, versioned API of the host instead of a computer's full access: it reads and writes chats, answers what
they ask, and changes their setup, but it never reaches the server's files, terminals, accounts or settings. It does
not need the same app version as the server, only the same mobile API, so it keeps working while the server updates.

## Security

Pairing this computer with a bot server already lets it control every environment of that server. For the workspaces
environment that means everything a Maestrly window can do on its own computer: read and write the host's files, run
commands in its terminals, and use its accounts. See [Remote workspaces](security-model.md#remote-workspaces) for the
boundaries, and revoke a lost computer as described in [Security and data](bot-fleet.md#security-and-data).

## Troubleshooting

- **The switcher stays on Connecting… or Reconnecting… for an environment.** Open its page: it must be **Running**. For
  a VPS, check that the SSH tunnel is connected in **Settings → Bot server**.
- **An environment fails with "The gateway could not join the network of this environment."** The gateway runs outside
  a container on the fleet network, or cannot find its own container there. Run the gateway with the Compose file, or
  set `MAESTRLY_GATEWAY_CONTAINER` to its container's name; `maestrly-bot-gateway doctor` checks it.
- **An environment fails with "The folder of this environment could not be created on the server."** The server's
  workspaces folder must exist and belong to user id 1000: `sudo install -d -o 1000 -g 1000 -m 0750 /srv/maestrly`.
- **A service of the server is unreachable from an environment.** A container you run on the bot server's Docker network
  (a model proxy, a database) is not on an environment's own network. Connect it there,
  `docker network connect maestrly-bots-env-<environment id> <container>`, or publish its port on the server.
- **An environment fails with "Docker could not create the network of this environment."** Docker ran out of
  addresses for new networks, usually because of networks other software left behind: remove unused ones with
  `docker network prune`, or widen Docker's `default-address-pools`.
- **Update required after updating the app.** Use **Update bots**: the server moves to this app's version, and the
  workspaces environment restarts on it once no chat is running.
- **A workspace cannot be added under `/srv/maestrly`.** The folder must belong to user id 1000 on the server:
  `sudo chown 1000:1000 /srv/maestrly`.
- **The Code tab says VS Code could not start on the server.** The environment must reach `code.visualstudio.com` and
  Microsoft's download servers to fetch the editor the first time. Open the tab again once it can; **Restart VS Code**
  tries again too.
- **The agent says the server is too old to host artifacts.** The workspaces environment was created by a gateway from
  before its artifact token. Use **Update bots**; an environment already on the current version gets its token the
  next time it starts or restarts.
- **A cloned repository asks for credentials.** Configure Git credentials in the environment, for example from a
  terminal of a chat on the server. They are kept in the environment's home volume.

## For developers

- The design is in [`docs/superpowers/specs/2026-09-29-remote-hosts-design.md`](superpowers/specs/2026-09-29-remote-hosts-design.md),
  and several environments per server in
  [`docs/superpowers/specs/2026-10-14-workspaces-environments-design.md`](superpowers/specs/2026-10-14-workspaces-environments-design.md).
- `MAESTRLY_DEV_DIRECT_HOST=http://<control token>@<address>:<port>` connects a development or test build straight to
  the control server of an app started with `MAESTRLY_SERVER_MODE=1`, without a bot server. Packaged builds ignore it.
- `apps/desktop/test/e2e/remote-hosts.spec.ts` runs two instances of the built app, one in server mode, and checks the
  machine switcher, a chat turn, a terminal, adding a workspace, the **Files** tab (browsing, preview, rename, delete,
  upload, download, and opening a file), the **Browser** tab (frames drawn, address bar, typing with accents, and
  copying to this computer's clipboard), and the **Code** tab (the editor through both proxies, its token kept on the
  host, a Plan file opening it, and a selection reaching the composer). For the editor the host uses a stand-in for
  serve-web that the test runs: `MAESTRLY_E2E_VSCODE_SERVER=<port>:<token>`, honored only in E2E mode.
  `remote-hosts-server.spec.ts` does the same through a gateway, from the **Server** page to a stopped and started
  environment, and creates two environments of different scopes with the dialog, checking their color, CPU limit, idle
  stop, isolation, and their names and colors in the machine switcher. `remote-host-artifacts.spec.ts` has an agent on the host publish and open an artifact through a
  stand-in for the gateway's internal API, and checks that the client opens it and that the host's environment no
  longer holds the token.
- `apps/desktop/test/e2e/mobile-bridge.spec.ts` runs the built app in server mode and drives it with the mobile
  bridge client of `@maestrly/bot-fleet-protocol`, as a phone does: lists, a new chat, a streamed answer, a resend
  that is not sent twice, and the chat's setup and models.
- `npm run test:e2e:bot-fleet:workspaces` checks a workspaces environment on the real images: server mode, its own
  mounted folder and network, a second environment out of reach of the first, the bridge through the gateway, a chat turn whose model drives the host's browser, the browser
  streamed over the bridge (JPEG frames paced by acknowledgements, input, a resize, a list, a refused file chooser, the
  agent's screenshot while streaming, a takeover, two conversations streamed at once, the stop and the release of its
  window), a host terminal, the host's real editor (downloaded and started on the host, its workbench, a static file and
  its WebSocket through the gateway), an upload and a compressed range download through the gateway, and that revoking
  the device cuts its transfers and its editor connection. It needs Docker, both images and Internet access for the
  editor; `npm run test:e2e:bot-fleet` runs it as one of its steps.
- The browser stream (`apps/desktop/src/main/drawer/browser-stream.ts`) uses the bridge: the host moves the
  conversation's browser views into a shown, unfocusable window of its display while someone watches (Chromium paints
  nothing for a hidden window), streams JPEG frames from the page's DevTools session (`Page.startScreencast`), and holds
  each frame's acknowledgement to Chromium until the window acknowledges it. Input goes back through the same DevTools
  session; the host's display gets no input.
- The editor (`apps/desktop/src/main/drawer/remote-vscode.ts`) is VS Code's serve-web on the host, started on demand
  and reached under `/v1/environments/:eid/editor/` of the gateway, which passes requests and WebSockets to
  `/v1/editor/` of the host's control server (`remote-host/server/host-editor.ts`), which passes them to serve-web on
  its loopback with the editor's token. On the computer, `remote-host/client/editor-proxy.ts` gives the editor a
  loopback origin; the bridge only opens, follows, and restarts it (`editor:*` channels).
- File transfers use the `host-files` routes of the gateway (`/v1/environments/:eid/host-files/…`), passed through to
  the host's control server, never the bridge. A gateway or host without the `host-files` feature makes the **Files**
  tab ask for an update.
