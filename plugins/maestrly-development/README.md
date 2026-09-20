# Maestrly development skill

This folder is the skill an external agent (a Grok Bot routine, or any other MCP client) installs to
delegate development work to Maestrly. It contains no credentials and no code: the agent connects to the
Maestrly MCP endpoint with OAuth, and the tools it may call are decided by the grant its owner created in
Maestrly, not by this file.

## Files

| File | What it is |
| --- | --- |
| `SKILL.md` | Operating instructions the agent loads: the flow, the rules, and what it must never do. |
| `mcp.json` | Example MCP client configuration pointing at a Maestrly instance. |

## Connecting an agent

1. In Maestrly, open **Connectors** and register the agent's OAuth client id, then choose the projects and
   the actions it may use. Granting nothing is a valid choice: a connection starts with no access at all.
2. Point the agent at `https://<your-instance>/mcp`. Discovery lives at
   `https://<your-instance>/.well-known/oauth-protected-resource/mcp`, which tells the client where to
   authorize.
3. Complete the OAuth flow as the person who owns the connection. The token is issued for the MCP resource
   only: it cannot act on the REST API with that person's full authority.
4. Optionally set a **callback URL** on the connection. Maestrly then posts a signed notification when
   something worth reacting to happens, so a routine does not have to poll.

## What the grant controls

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

Every tool call rechecks the persisted grant **and** that the owner still holds the matching project
permission. Revoking the connection, or removing the owner from a project, stops the agent immediately.
