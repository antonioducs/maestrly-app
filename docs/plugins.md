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

Plugins belong to a host. Choose the host with the **Settings of** selector: **This computer**, or a server that hosts
workspaces.

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

**Refresh** fetches the source again, and installed plugins with a newer version show **Update available**.
**Remove** stops listing the source's plugins. If plugins from the source are installed, you can uninstall them at the
same time, or keep the source.

## Compatibility

Each plugin shows how much of it runs in Maestrly, with the reasons:

| Level | Meaning |
| --- | --- |
| **Portable** | Only skills and MCP servers. Works with every model. |
| **Partial** | Skills and MCP servers work everywhere. Some parts need adaptation or cannot run here, such as hooks, agents, or app connectors. |
| **Unavailable** | Nothing in the plugin can run in Maestrly. It cannot be installed. |

Maestrly adapts what it can. A plugin's commands become skills you start yourself with `/<plugin>:<command>`. Hooks
never run. App connectors (`.app.json`) run only inside OpenAI products. Every part that does not run is listed with
its reason; none is dropped silently.

## Install a plugin

Open a plugin to see its components, compatibility, license, declared capabilities, the external endpoints its MCP
servers reach, its scripts and executables, its requirements, and the settings it asks for. A plugin is code from its
publisher, so check the license and the publisher's terms before installing.

Choose **Install**. Before anything is installed, Maestrly asks you to:

- approve each MCP server that runs as a local process (stdio);
- acknowledge that the plugin ships scripts or executables that agents may run, with your approval, through the shell
  tool;
- choose where the plugin applies: **All conversations**, or **Selected projects** of the host;
- fill in the settings the plugin asks for. Secret values are masked, stored encrypted on the host, and never shown
  again.

If the source changed after you opened the plugin, Maestrly shows the new version for you to review before it
installs.

## Use a plugin

A plugin's skills are named `<plugin>:<skill>`. They appear in the composer's skills menu and in **Settings →
Maestrly Chat → Skills**, under the plugin's name. You can switch them on and off, add them to skill groups, and
override them in a conversation, like your own skills. They are removed only with the plugin.

A plugin's MCP servers appear in the **+** menu and in **Settings → Maestrly Chat → Tools**, marked **From
&lt;plugin&gt;**. You can switch a server off in one conversation from the **+** menu. Switch it off everywhere, or back
on, in **Plugins**.

A server that uses OAuth shows **Needs sign-in**. Choose **Sign in** next to it, in **Installed** or under **Tools**,
and finish in your browser. The sign-in is kept on the host that runs the server, which renews it as needed; choose
**Sign out** to remove it. Servers that take a token instead ask for it as a setting.

## Manage installed plugins

**Installed** lists the host's plugins. For each plugin you can:

- switch it on or off;
- **Change** where it applies;
- switch each of its MCP servers on or off;
- **Update** it when its source has a newer version. If the new version changes what runs, such as a new local server
  or new scripts, Maestrly asks for your approval again;
- **Edit settings**;
- **Uninstall** it. Its skills and MCP tools leave every conversation, and its saved settings are deleted. Choose
  **Also delete the plugin's data** to remove the files its servers keep.

A plugin marked **Needs settings** or **Server needs approval** is missing a required setting or the approval of a
local server. The MCP servers that need them stay off until you provide them; the plugin's skills keep working.

## Remote workspaces

With a server selected in Settings, the plugin center manages the server's plugins. They are downloaded and run on the
server, and conversations on the server use them. **Selected projects** lists the server's workspaces. Nothing is copied
between this computer and the server.

## Bot environments

Open the environment's settings and choose **Plugins**. The plugin center works the same way, with these differences:

- The environment downloads, checks, and runs its plugins itself. Its plugins serve all of its conversations.
- **Bring from this computer** installs one of this computer's plugins in the environment. The environment downloads
  it from the same source at the same commit, checks it against the approvals you gave on this computer, and stores
  the settings you entered here, encrypted. Plugin files are never copied from this computer. If the environment
  cannot match your approval, install the plugin from the environment's sources and review it there.
- **Sign in** for a server of the environment opens the consent page in this computer's browser. The environment
  keeps the sign-in.

The bot server and the environment must be up to date. See [Configure an environment from the
app](bot-fleet.md#configure-an-environment-from-the-app).

## Related documentation

- [Security model](security-model.md#plugins)
- [Local data and recovery](local-data.md#plugins)
- [Architecture](architecture.md#plugins)
