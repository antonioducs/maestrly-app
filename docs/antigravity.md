# Google AI subscription (Antigravity)

Maestrly's desktop chat can use a Google AI Pro or Ultra plan through Google's
official Antigravity ACP server 1.2.1. In provider settings, open
**Google AI (Antigravity)** and choose **Sign in with Google**. The first sign-in
downloads the server; then complete Google's sign-in in your browser and choose a
Gemini model in the conversation model picker. Use **Connect another account** to
add another Google account with its own label. An eligible Google AI plan and an
internet connection are required.

Google AI is available for chat, Maestro, and subagent profiles. It is not yet
available to bots or to the desktop executor. The model list comes from the
Antigravity server, which offers Gemini models only; variants that differ only by
thinking level appear as one model with Low, Medium, or High effort. The server
does not report token usage, remaining quota, or reasoning text, so Maestrly shows
none of them for this provider.

## Runtime

The server is not bundled with Maestrly. It is downloaded from `dl.google.com`
only when you sign in, checked against SHA-256 digests pinned in Maestrly, and
stored in the selected profile's application data. Builds are pinned for macOS
arm64/x64, Linux arm64/x64, and Windows arm64/x64. Google publishes no checksums
for these archives, so each new server version must be measured and pinned
before Maestrly accepts it; the server is not updated independently of Maestrly
releases.

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
session files. Deleting a conversation deletes its Antigravity session. Neither
erases Maestrly's chat history. Resetting local data signs out every Google
account. See [Local data](local-data.md) before moving or resetting a profile.

Model access, authentication errors, rate limits, and service availability are
governed by Google. If access fails, check the provider status and sign in again.
The Antigravity server has its own terms; see
[Third-party notices](../THIRD_PARTY_NOTICES.md).
