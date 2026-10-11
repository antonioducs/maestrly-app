# Privacy

Maestrly stores application state locally. It has no automatic telemetry,
analytics, crash reporting, or diagnostic upload to the maintainer. Optional
integrations access the network as described below.

## Stored data and credentials

The local profile contains conversations, settings, usage records, and app-owned
assets. Notes, memory, repositories, and Git worktrees also use project files.
Production, beta, and development profiles are separate.

Application-managed credentials stay in the Electron main process and are
persisted using operating-system encryption through `safeStorage`. Persistence
fails closed when encryption is unavailable. Provider CLIs, Git helpers, SSH
agents, browsers, and MCP servers maintain independent credential stores. The
Google Antigravity ACP server keeps each Google account's sign-in in a file
inside the profile, in a directory with owner-only permissions rather than
operating-system encryption.

Logs stay local unless deliberately shared. Redaction cannot remove every
sensitive filename, project name, path, model name, or content excerpt; review
and sanitize diagnostics before posting them.

## Network access

| Feature | Data and destination |
| --- | --- |
| AI providers | Prompts, selected conversation history, instructions, attachments, and allowed project/tool context go to the configured provider under its terms. |
| ChatGPT Web | The enabled integration uses OpenAI's tunnel client to connect ChatGPT to a token-protected loopback MCP bridge. |
| Google AI (Antigravity) | Google's Antigravity ACP server, downloaded from `dl.google.com` at sign-in or update (version checks use `raw.githubusercontent.com`), sends prompts to Google and reaches Maestrly's tools through a token-protected loopback MCP endpoint. |
| Shared artifacts | Pages you choose to share are served by Desktop or your paired bot server to the people you invite, or to anyone with the link. You provide external access; no hosted Maestrly relay is required. The selected host stores each person's name, a coarse device label, and visit times, and no IP address. |
| Model metadata | `models.dev` may receive metadata requests for model limits and pricing. |
| Git and GitHub | Remote operations contact the selected Git host or GitHub. |
| Browser and web tools | Navigation and fetches contact their selected destinations. |
| MCP | HTTP servers receive requests at their configured URLs; stdio servers run locally but can make their own network requests. |
| Skills and runtimes | Searches and installs can contact skills.sh, GitHub, npm, OpenAI asset hosts, and configured upstream sources. |
| Embedded editor | Initial VS Code CLI/server setup can contact Microsoft's download service. The editor server binds to loopback with a token. |
| Local ML | Inference runs locally; runtime/model preparation may download assets from npm, native dependency hosts, and Hugging Face. |
| Voice dictation | Audio is transcribed locally and never uploaded. The voice model is downloaded from Hugging Face (`huggingface.co` and its `hf.co` CDN) only after you confirm; a sent transcription goes to the provider like any typed message. |

Providers and integrations apply their own privacy and retention policies.
Maestrly does not add analytics to provider calls; the Copilot runtime starts with
session telemetry disabled. Authentication and provider requests still reach
that provider. Review custom URLs, installed tools, and permissions before use.

Server artifacts, their files, sharing state, and comments are stored on your
bot server. Desktop conversations publish there only when that destination is
selected; bots need their publication permission and server hosting enabled.
The desktop renders missing previews when it lists server artifacts, running
the page's scripts under the artifact sandbox and loading allowed CDN resources.
Those CDN requests can reveal the desktop's IP address even without an explicit
page opening. Comments remain untrusted feedback and never start an agent turn
by themselves. See [Artifacts](docs/artifacts.md).

## Export and deletion

In-app exports include supported database state and app-owned assets with integrity
metadata. They exclude provider credentials, repositories, worktrees, search
indexes, embeddings, and reproducible caches. Back up projects separately.

Desktop export and reset exclude server artifacts. Back up the gateway volume
separately. Disabling artifact hosting preserves its data; unpairing leaves the
server running. Explicit removal of the server and its data deletes its artifacts.

Reset previews removal of app-owned state and preserves repositories/worktrees.
Deleting a profile does not erase OS backups, filesystem snapshots, provider
records, Git remotes, or credentials held by other tools. Remove those through
their owning system. See [Local data and recovery](docs/local-data.md).

Maestrly does not sell local data or automatically send it to the maintainer.
Sharing occurs through integrations or destinations selected by the user or an
allowed agent operation. Component licenses and terms are listed in
[Third-party notices](THIRD_PARTY_NOTICES.md).
