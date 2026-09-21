# Maestrly development skill

This folder is the skill an external agent — a Grok bot routine, or any other MCP client — installs to work
in a person's repositories through Maestrly. It contains no credentials and no code: the agent connects to a
Maestrly MCP endpoint with OAuth, and the tools it may call are decided by the grant its owner created in
Maestrly, not by this file.

## Files

| File | What it is |
| --- | --- |
| `SKILL.md` | Operating instructions the agent loads: the flow, the rules, and what it must never do. |
| `mcp.json` | Example MCP client configuration for both endpoints: the desktop one and the server one. |

## Two endpoints, two different things

| | Personal bot — `/mcp/bots` | Delegated development — `/mcp` |
| --- | --- | --- |
| Who serves it | Maestrly Desktop on the person's own computer | a Maestrly server |
| What it drives | a native conversation on that desktop | a task with stages, review, checks and delivery |
| A grant names | one workspace on that desktop | one project in one organization |
| Needs a server, an organization, a project, a board or a runner | no | yes |
| Tools | `bot_*` | `maestrly_*` |

The skill treats the personal bot as the default path and the delegated pipeline as a separate one, used
only when the connection actually has those tools. A client may be configured for one endpoint or both;
each one is a separate connection, with its own grant, and its token is accepted by that endpoint only.

## Connecting a personal bot

1. Open **Settings → Bots** in Maestrly Desktop and enable the bot endpoint. It is off by default, it
   binds to the local address chosen there, and the public address is whatever HTTPS entry point — a
   reverse proxy or a tunnel — the person puts in front of it. No Maestrly server is involved.
2. Point the bot at `https://<their-address>/mcp/bots`, from inside the bot itself — the person asks their
   own bot to add that connector, rather than registering it on a website. Discovery lives at
   `https://<their-address>/.well-known/oauth-protected-resource/mcp/bots`, which tells the client where
   to authorize.
3. Complete the OAuth flow, authorization code with PKCE and no client secret. The owner approves the
   request on their own desktop; until they do, no token exists. The token is issued for that resource
   only: it is refused by every other route, including the delegation endpoint on a server.
4. The owner sets the bot up from that waiting request: the name arrives filled in from the client name
   and can be changed, and they choose the local projects, account/model pairs, allowed actions and the
   approval ceiling before approving. Nothing is created in advance, and only the selected projects are
   authorized; removing all project grants later removes all bot access.
5. That ceiling is what `bot_list_selections` publishes as `permissionModes`. A selection may name any
   `permissionMode` from that list and nothing beyond it: asking for more fails the instruction. Naming
   none runs at the owner's ceiling. Plan approvals always stay with the owner.

The address must be reachable over HTTPS from wherever the bot runs, and it answers only while their
application is running: a bot hosted by a provider cannot reach a `localhost` address, and a computer
that is asleep or offline returns a connection error rather than queueing anything for later.

### What the bot grant controls

| Action | What it allows |
| --- | --- |
| `chats:read` | List the conversations this connection created and read their transcript. |
| `chats:write` | Create a conversation, send a message, rename it, change its model selection. |
| `chats:control` | Cancel the turn that is running. |
| `chats:answer` | Answer an ordinary question the conversation raised. |

A bot never sees a conversation it did not create. Its catalog uses opaque ids instead of local paths or
provider credentials, and it cannot approve a permission request, a plan or an escalation — those stay
with the person at the desktop. The owner can pause a conversation, which refuses every bot instruction
until they resume it; revoking the connection, or turning the endpoint off, cuts the bot immediately while
the conversation stays on their computer.

## Connecting a delegation agent

1. In Maestrly, open **Connectors** and register the agent's OAuth client id, then choose the projects and
   the actions it may use.
2. Point the agent at `https://<your-instance>/mcp`. Discovery lives at
   `https://<your-instance>/.well-known/oauth-protected-resource/mcp`.
3. Complete the OAuth flow as the person who owns the connection. The token is issued for the MCP resource
   only: it cannot act on the REST API with that person's full authority.
4. Optionally set a **callback URL** on the connection. Maestrly then posts a signed notification when
   something worth reacting to happens, so a routine does not have to poll.

### What the delegation grant controls

| Action | What it allows |
| --- | --- |
| `tasks:read` | Read tasks, stages, attempts, events and evidence metadata. |
| `tasks:write` | Create tasks, send follow-ups, change stage configuration, subscribe to a pull request. |
| `execution:control` | Start, pause, resume and cancel work. |
| `evidence:read` | Read artifact content and request configured project checks. |
| `inspect:read` | Read files, diffs, searches and pull request status through the executor. |
| `inspect:interact` | Interact with a configured preview in a browser. |
| `delivery:manage` | Request a commit, push, pull request or merge. |
| `interactions:answer` | Answer a question an execution raised. |

Every tool call rechecks the persisted grant **and** that the owner still holds the matching permission —
the workspace grant for a bot, the project permission for a delegation agent. Revoking the connection, or
removing the owner's access, stops the agent immediately.
