# Google AI subscription (Antigravity)

Maestrly's desktop chat can use a Google AI Pro or Ultra plan through Google's
official Antigravity ACP server (version 1.2.1 or a newer validated release). In provider settings, open
**Google AI (Antigravity)** and choose **Sign in with Google**. The first sign-in
downloads the server; then complete Google's sign-in in your browser and choose a
Gemini model in the conversation model picker. Use **Connect another account** to
add another Google account with its own label. An eligible Google AI plan and an
internet connection are required.

Google AI is available for chat, Maestro, subagent profiles, and the desktop
executor's provider selection, and bot environments. The model list comes from the
Antigravity server, which offers Gemini models only; variants that differ only by
thinking level appear as one model with Low, Medium, or High effort. The server
does not report token usage, remaining quota, or reasoning text, so Maestrly shows
none of them for this provider.

## Runtime

The server is downloaded on first sign-in and stored in the selected profile's
application data. It supports macOS arm64/x64, Linux arm64/x64, and Windows
arm64/x64. Neither the desktop installer nor the bot image includes the server.

In **Settings → Components → Google Antigravity ACP server**, use **Check for
updates**, **Update to v…**, or **Go back to v…**. Desktop checks for new releases
and lets you decide when to install; **Update automatically** is optional. Bots
enable automatic updates by default after the first installation. Checks run
about a minute after startup and every six hours in packaged builds and bots;
ordinary development builds stay manual.

Maestrly reads the official ACP registry's version metadata and downloads only
canonical Google HTTPS archives. Google does not publish archive checksums.
The built-in reference version has measured SHA-256 pins; a newer version is
trusted through Google's HTTPS download origin, then its digest is recorded
after layout and ACP compatibility checks pass. That recorded digest protects
subsequent repairs and offline verification; it is not a Google signature.
Downloads have size limits and cannot redirect when establishing a new digest.

Failed updates keep the current version. Existing conversations retain their
running process. Restart Desktop to move those conversations to the new version;
bots switch once all bots in the environment are idle, including background
compaction. Updates preserve account homes and sign-in. Versions below the
build's reference version are never selected, and rollback or compatibility
failures prevent automatic retries of the rejected version.

## Bot environments

When creating a bot in a new environment, select a connected Google AI account
in the account setup list and complete the Google sign-in card after the
environment starts. You can also choose **Sign in with Google AI (Antigravity)**
in an existing environment's accounts section, or reconnect an existing slot.
Use matching desktop, gateway, and bot-image releases that support Google AI.

This starts a separate Google session in the environment; it does not transfer
the computer's credential. First-time setup downloads the runtime before opening
the Google page in your computer's browser. The app relays the callback to the
environment's loopback listener. Cancel stops preparation or sign-in and cleans
up an account slot created for that attempt. If the callback port is occupied on
your computer, close the other sign-in and retry; this provider has no device-code
fallback. All bots in that environment can use its connected accounts.

The environment's **Model runtimes** section shows its ACP version, a pending
version while work still uses the old process, and update status. **Check for
updates** requests an immediate check; automatic installation follows the
runtime's preference. The server setting
`MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off` disables scheduled checks. See
[Bot fleet](bot-fleet.md) for server setup and environment updates.

## Tools and permissions

Antigravity's own tools, including file reading, are disabled. The model works
through Maestrly's tools, served to the Antigravity server by a loopback-only MCP
endpoint that requires a per-session token. Every tool call goes through
Maestrly's permission prompts, plan and ask modes, and conversation controls. The
server only receives automatic approval for calls to that endpoint; other
permission requests are rejected.

The server always runs in an app-owned working directory, never in your
project, so project files such as `.agents/hooks.json` cannot run commands
through it. The project directory is passed to the model in its instructions and
used by Maestrly's tools.

## Credentials and local data

Each Google account gets its own app-owned home directory in the profile, created
with owner-only permissions. The Antigravity server keeps its Google sign-in in a
file in that directory, not in the OS secure store. Maestrly reads only the
`project_id` field of that file to tell accounts apart; it never reads, logs, or
copies the tokens. Do not copy these files into project files or commit them.

Signing out deletes the account's home, including its sign-in and the server's
session files, while keeping Maestrly's chat history. Deleting a conversation
also deletes its Antigravity session. Resetting local data signs out every Google
account. See [Local data](local-data.md) before moving or resetting a profile.

Model access, authentication errors, rate limits, and service availability are
governed by Google. If access fails, check the provider status and sign in again.
The Antigravity server has its own terms; see
[Third-party notices](../THIRD_PARTY_NOTICES.md).
