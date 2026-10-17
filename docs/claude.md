# Claude subscription

Maestrly's desktop chat can use a Claude Pro, Max, Team or Enterprise plan
through the official Claude Agent SDK. It runs the Claude Code installed on the
computer that holds the chat; no API key is needed. Claude Code is not bundled
with the desktop app.

## Install Claude Code

When Claude Code is missing, the Claude account in **Settings › Maestrly Chat ›
Accounts** shows the official installer for your system:

| System | Command |
| --- | --- |
| macOS and Linux (Terminal) | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |

Homebrew, WinGet, npm and the apt, dnf and apk repositories work too; see
Anthropic's [setup guide](https://code.claude.com/docs/en/setup). After
installing, choose **Check again**: no restart is needed. Maestrly looks for
Claude Code in `~/.local/bin`, Homebrew, npm's global directory, `/usr/bin`,
`/snap/bin` and the `PATH`. A version older than the supported one shows
`claude update` instead.

## Sign in

Choose **Sign in with Claude** and authorize Maestrly in the browser. Each
account signs in to its own isolated Claude Code profile; the sign-in of a
Claude Code you use in a terminal is not shared.

On macOS and Linux, Maestrly opens the sign-in page itself and also shows a
link that ends with a code. Use it when no browser opens, for example on a
Linux session without a default browser, or when the page cannot return to
Maestrly: open the link in any browser, authorize, paste the code shown by
Claude into **Authorization code**, and choose **Continue**. On Windows, Claude
Code opens the browser.

## Environment

Claude Code runs with a short list of the app's environment variables: paths,
locale, proxies and certificates, and on Linux the desktop session (display,
D-Bus, XDG directories and `BROWSER`) so it can open pages. Variables that
authenticate or reroute Claude, such as `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL` or the Bedrock and Vertex switches, never reach it, so a
subscription cannot be billed to an API account by accident.
