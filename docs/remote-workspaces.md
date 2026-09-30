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
  **Terminal**, **Plan**, **Review**, and **Notes**. The terminal is a shell on the server, in the conversation's
  folder.
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
either can answer a permission request, a question, or a plan.

## Not available yet

- **The agent's browser and the editor are not shown** for a conversation on a server. The agent can still use its
  browser there: it runs on the server and keeps its site logins. The **Browser** and **Code** tabs are hidden for
  those conversations.
- **Files do not move between this computer and the server.** Attach images and PDFs to a message as usual, since those
  travel with the message. To move other files, use Git or SSH. Opening a file, a folder, or a PDF attachment in a
  desktop app is unavailable for a server, because it would open on the server's own desktop, which nobody sees.
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
  mixed sidebar, a chat turn, a terminal, and adding a workspace. `remote-hosts-server.spec.ts` does the same through
  a gateway, from the **Server** page to a stopped and started environment.
- `npm run test:e2e:bot-fleet:workspaces` checks a workspaces environment on the real images: server mode, the
  mounted folder, the bridge through the gateway, a chat turn whose model drives the host's browser, and a host
  terminal. It needs Docker and both images; `npm run test:e2e:bot-fleet` runs it as one of its steps.
