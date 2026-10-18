# Plugins

A plugin bundles skills and MCP servers, and sometimes parts made for one agent runtime, such as hooks or commands.
Maestrly installs plugins itself and gives their skills and MCP tools to every model, whichever provider runs the
conversation. You do not need a separate version of a plugin for each model.

Maestrly reads three plugin formats: [Agent Plugins](https://agent-plugins.org/) (`plugin.json`), Codex
(`.codex-plugin/plugin.json`), and Claude Code (`.claude-plugin/plugin.json`).

Plugins also work in [bot environments](#bot-environments), managed from this computer.

## Open the plugin center

Open **Settings → Maestrly Chat → Plugins**. The composer also links to it: **Browse plugins** at the bottom of the
**+** menu and of the skills menu. From a conversation on a [remote workspaces host](remote-workspaces.md), the link
opens that host's plugins.

Plugins belong to a host. Choose the host with the **Settings of** selector: **This computer**, or a workspaces
environment of a server. A server with [several workspaces environments](remote-workspaces.md#several-scopes-on-one-server)
lists each one, and each has its own plugins.

## Sources

A source is a public Git repository that lists plugins, as a Codex or Claude Code marketplace does, or a repository
that is a single plugin. Maestrly suggests two sources, `openai/plugins` and `openai/community-plugins`. Their
plugins are listed only after you open the source.

To add a source:

1. Under **Sources**, choose **Add source**.
2. Enter the repository as an `https://` URL or `owner/repo`. Optionally, enter a branch, tag, or commit, and the
   folders to download, one per line.
3. Choose **Add source**.

Adding a source only lists its plugins. Nothing is installed or run until you install a plugin and approve what it
needs. Sources need Git on the host. Repositories that need a sign-in are not supported.

Maestrly does not review plugins from third-party sources: any source other than the two suggested ones is marked
**Third party**, and so are the details of its plugins. Install only plugins from publishers you trust.

**Refresh** fetches the source again, and installed plugins with a newer version show **Update available**.
**Remove** stops listing the source's plugins. If plugins from the source are installed, you can uninstall them at the
same time, or keep the source.

## Compatibility

Maestrly offers only what works the same with every model, so switching models never changes what a plugin does. Each
plugin is in one of two states:

| State | Meaning |
| --- | --- |
| **Works with every model** | Its skills and MCP servers, and the parts Maestrly adapts, work the same whichever provider runs the conversation. |
| **Not compatible** | Nothing in it works the same with every model. It is not offered and cannot be installed. |

The catalog lists only plugins that work with every model. Below the list, a counter such as **3 plugins don’t work
the same with every model** opens the plugins left out, each with its reason. A plugin is not compatible when:

- it relies on ChatGPT app connectors (`.app.json`) and ships no MCP server for the same service, so its skills would
  expect tools that only exist inside OpenAI products;
- it has no skill and no MCP server Maestrly can run;
- its manifest is invalid, or its source or marketplace rules it out.

Maestrly adapts what it can. A plugin's commands become skills you start yourself with `/<plugin>:<command>`, its
agents become subagents (see [Agents](#agents)), and Maestrly runs its hooks itself (see [Hooks](#hooks)). Parts that
only work inside one product, such as app connectors, language servers, and hooks on events Maestrly does not control,
are never enabled for any model. They appear in the plugin's details under **Not included**, each with its reason;
none is dropped silently.

An installed plugin that stops being compatible, for example after its files change, stops applying to every
conversation. It stays in **Installed** with its reason, where you can update or uninstall it.

## Install a plugin

Open a plugin to see its components, compatibility, license, declared capabilities, the external endpoints its MCP
servers reach, its scripts and executables, its requirements, and the settings it asks for. A plugin is code from its
publisher, so check the license and the publisher's terms before installing.

Choose **Install**. Before anything is installed, Maestrly asks you to:

- approve each MCP server that runs as a local process (stdio);
- acknowledge that the plugin ships scripts or executables that agents may run, with your approval, through the shell
  tool;
- approve the plugin's [hooks](#hooks), if it has any. Each hook is listed with its event and command. You can install
  the plugin without them and switch them on later;
- choose where the plugin applies: **All conversations**, or **Selected projects** of the host;
- fill in the settings the plugin asks for. Secret values are masked, stored encrypted on the host, and never shown
  again.

If the source changed after you opened the plugin, Maestrly shows the new version for you to review before it
installs.

## Use a plugin

A plugin's skills are named `<plugin>:<skill>`. They appear in the composer's skills menu and in **Settings →
Maestrly Chat → Skills**, under the plugin's name. You can switch them on and off, add them to skill groups, and
override them in a conversation, like your own skills. They are removed only with the plugin.

### Agents

A plugin's agents (`agents/*.md` in Claude Code and Codex plugins) become subagents named `<plugin>-<agent>`, which any
model can delegate to with `task` or a `#<plugin>-<agent>` mention, like your own agents. The plugin's details list them.

- **Tools.** The tools an agent names map to Maestrly's: `Read`, `Grep`, `Glob`, `LS`, `Bash`, `Edit`, `MultiEdit`,
  `Write`, `WebFetch` and `WebSearch` keep their meaning, and any `mcp__…` tool becomes access to the enabled MCP servers
  through `mcp_search` and `mcp_call`. `WebSearch` is Maestrly's `web_search`, so the agent searches only while web search
  is on in Settings. Tools with no equivalent every model can use, such as `Task` or `TodoWrite`, are left out and listed
  under **Not included**. An agent that names no tools gets the read-only set.
- **Model.** An agent's `model` is ignored: it runs on the conversation's model, unless a subagent rule in
  **Settings → Maestrly Chat → Subagents** chooses another, so it behaves the same with every provider.
- **Names.** An agent file of the project (`.claude/agents`, `.agents/agents`) or of your home with the same name wins
  over the plugin's.

### Hooks

A plugin's hooks (`hooks/hooks.json`, or `hooks` in its manifest) are commands its publisher wrote to run at set moments
of a conversation. Maestrly runs them itself, with Claude Code's input and output format, so they behave the same with
every model.

- **Approval.** Hooks run only after you approve them, at install or later with the **Hooks** switch under
  **Installed**. An update that changes them asks again.
- **Where.** Hooks run only in Agent and Design conversations, on the host that runs the conversation, in its folder.
  They never run in Ask, Plan, or Maestro conversations, nor for the reviewers of a code or plan review, which run in
  Ask.
- **Events.**

  | Event | When | What the hook can do |
  | --- | --- | --- |
  | `SessionStart` | The first turn of a conversation (`startup`); the first turn on a host whose hooks never ran for a conversation with history, such as one moved from another computer or one whose hooks were switched on later (`resume`); and the first after clearing or compacting it (`clear`, `compact`) | Add context for the model |
  | `UserPromptSubmit` | Each message you send, before it is stored | Add context, or block the message |
  | `PreToolUse` | Before each tool call | Block the call, or change its input |
  | `PostToolUse`, `PostToolUseFailure` | After a tool call succeeds or fails | Add text the model reads with the result |
  | `Stop` | When the agent ends a turn | Keep the agent going with a reason, at most 8 times in a row |

  Other events, and hooks that are not commands, are listed under **Not included**.
- **Tools.** Hooks see Maestrly's tools with Claude Code's names and inputs: `bash` is `Bash`, `edit` is `Edit` with
  `file_path`, `web_search` is `WebSearch`, and an MCP tool is `mcp__<server>__<tool>`, so matchers such as `Edit|Write`
  work. A hook can deny a
  call, but its `allow` or `ask` answer never skips Maestrly's own permission.
- **Every model.** In a conversation with tool hooks, Codex models use Maestrly's shell, file, and web search tools
  instead of their own, so every call goes through the hooks. Subagents' tool calls run them too.
- **Messages.** A hook's `systemMessage`, failure, or timeout shows above the composer and is not stored in the
  conversation. Context from a hook reaches the model as hidden parts of your message. When a hook blocks a message,
  the message comes back to the composer.
- **Running.** A hook gets its input as JSON on standard input, and `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`,
  `CLAUDE_PLUGIN_DATA`, `PLUGIN_ROOT`, and `PLUGIN_DATA` in its environment. It has 60 seconds unless it sets another
  timeout, up to 10 minutes; **Stop** ends it. Its `transcript_path` is a temporary copy of the conversation's text,
  deleted when the turn ends.
- **While the agent works.** With `UserPromptSubmit` hooks, a message you send during a turn waits for a turn of its
  own instead of steering the current one, so the hooks see it.
- **Other senders.** Messages from a bot, from the [mobile app](mobile.md), or from the agent of another conversation
  are prompts too: `UserPromptSubmit` hooks see them and can block them. The phone shows that a plugin hook blocked
  the message; another conversation's agent is told it could not be delivered, with the hook's reason.
- **ChatGPT companion.** The ChatGPT Web companion runs tool hooks around its tools. Its turns run in ChatGPT, where
  Maestrly cannot run `SessionStart`, `UserPromptSubmit`, or `Stop` hooks, so it does not start in an Agent
  conversation with a plugin that has them. Switch that plugin's hooks off, or limit where the plugin applies.

### MCP servers and sign-in

A plugin's MCP servers appear in the **+** menu and in **Settings → Maestrly Chat → Tools**, marked **From
&lt;plugin&gt;**. You can switch a server off in one conversation from the **+** menu. Switch it off everywhere, or back
on, in **Plugins**.

A server that uses OAuth shows **Needs sign-in**. Choose **Sign in** next to it, in **Installed** or under **Tools**,
and finish in your browser. The sign-in is kept on the host that runs the server, which renews it as needed. Servers
that take a token instead ask for it as a setting.

Some plugins name their publisher's own app, which works only in the publisher's products: Slack in OpenAI's catalog is
one. Maestrly never uses that app. Such a server signs in with [your own OAuth client](#own-oauth-client) instead, or
takes an **access token** under **Edit settings**, which Maestrly sends as `Authorization: Bearer <token>` and uses
before any signed-in account. If the server rejects the token, the model tells you to replace it.

### Several accounts

One server can have several signed-in accounts, for example a personal and a work e-mail. Choose **Add account** under
the server and pick the other account in your provider's account chooser. Each account is named by its e-mail when the
provider shares it, or **Account 1**, **Account 2**, and so on; choose **Rename** to change the name. For each account
you can:

- choose **Change** to set where it applies: all conversations, or selected projects;
- choose **Sign in again** when it shows **Needs sign-in**, for example after its sign-in expired;
- choose **Remove** to sign it out.

When a conversation can use several accounts of a server, every model names the account in each call, and asks you
when it is not clear which one you mean. You can switch an account off for one conversation in the **+** menu. With a
single account, nothing changes: calls use it.

### Own OAuth client

Some servers do not register apps automatically, such as Google's and Slack's. Signing in to one shows a form for your
own OAuth client: create a client with the server's provider, of the desktop or native-app type, add the **Redirect
URL** the form shows to it, and enter its client ID and, if it has one, its secret. The secret is kept encrypted on the
host that runs the server and is never shown again; **Own OAuth client** under the server lets you change or remove the
client.

The redirect URL, `http://127.0.0.1:<port>/callback`, is the same for every sign-in to that server, port included, so
providers that accept only the URLs they know, such as Slack, accept it. It is shown again under the server, and
changes only when the server is removed and added again. If another app on this computer uses its port, signing in
says so; close that app and try again.

With Google:

1. In Google Cloud Console, open **APIs & Services → Credentials → Create OAuth client ID** and choose **Desktop app**.
2. Enable the service's API in the same project, for example the Gmail MCP API.
3. On the OAuth consent screen, add your accounts as test users. While the app is in **Testing** mode, Google ends
   each sign-in after 7 days, so you sign in again weekly.

With Slack:

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app in your workspace. Only apps internal to a
   workspace or listed in the Slack Marketplace can use Slack's MCP server; a workspace admin may need to approve it.
2. Under **OAuth & Permissions**, add the redirect URL the form shows, and the user token scopes of the tools you use.
3. Enter the client ID and client secret from the app's **Basic Information**.

A plugin whose server declares only a client its publisher fills in, or names its publisher's own client, signs in
this way too.

## Manage installed plugins

**Installed** lists the host's plugins. For each plugin you can:

- switch it on or off;
- **Change** where it applies;
- switch each of its MCP servers on or off;
- switch its hooks on or off. Switching them on shows them for your approval;
- **Update** it when its source has a newer version. If the new version changes what runs, such as a new local server,
  new scripts, or changed hooks, Maestrly asks for your approval again;
- **Edit settings**;
- **Uninstall** it. Its skills and MCP tools leave every conversation, and its saved settings are deleted. Choose
  **Also delete the plugin's data** to remove the files its servers keep.

A plugin marked **Needs settings** or **Server needs approval** is missing a required setting or the approval of a
local server. The MCP servers that need them stay off until you provide them; the plugin's skills keep working.

## Remote workspaces

With a workspaces environment selected in Settings, the plugin center manages that environment's plugins. They are
downloaded and run on the server, in that environment, and its conversations use them. **Selected projects** lists the
environment's workspaces. Nothing is copied between this computer and the server, or between environments.

When a conversation [moves](remote-workspaces.md#move-a-conversation) to another computer or environment, it uses the
plugins installed there. What you switched off for it, a plugin's server or an account, stays off where the same plugin
is installed; the destination's sign-ins are its own. The destination's `SessionStart` hooks run again on the
conversation's next turn there, as `resume`.

On a phone, a chat's **MCP servers** lists a plugin's servers only where the plugin applies, and each account of a
server with several signed-in accounts as a switch of its own.

## Bot environments

Open the environment's settings and choose **Plugins**. The plugin center works the same way, with these differences:

- The environment downloads, checks, and runs its plugins itself. Its plugins serve all of its conversations.
- **Bring from this computer** installs one of this computer's plugins in the environment. The environment downloads
  it from the same source at the same commit, checks it against the approvals you gave on this computer, and stores
  the settings you entered here, encrypted. Plugin files are never copied from this computer. If the environment
  cannot match your approval, install the plugin from the environment's sources and review it there.
- **Sign in** for a server of the environment opens the consent page in this computer's browser. The environment
  keeps the sign-in. Its accounts serve all of its conversations, and the bot's model names the account in each call
  when there are several.
- The plugins' skills appear in the environment's **Skills** settings under each plugin's name, where you can switch
  them on and off and add them to groups.

The bot server and the environment must be up to date. See [Configure an environment from the
app](bot-fleet.md#configure-an-environment-from-the-app).

## Related documentation

- [Security model](security-model.md#plugins)
- [Local data and recovery](local-data.md#plugins)
- [Architecture](architecture.md#plugins)
