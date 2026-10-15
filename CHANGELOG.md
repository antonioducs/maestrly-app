# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

### Added

- See the phones and computers paired with your bot server, and remove one you
  lost, in **Settings → Bot server → Paired devices** on a computer and
  **Settings → Paired devices** in the mobile app. Update the bot server to use
  it. See [Mobile app](docs/mobile.md#unpair-and-revoke).

## [0.19.0] - 2026-10-15

### Added

- Review a project conversation's changes, or a plan, once instead of in a loop.
  **Review** in the conversation header (or `/code-review`) and **Review plan**
  in the Plan tab open a review room: three read-only reviewers for code, or two
  for plans, investigate in parallel, a verifier confirms or discards each
  finding, and you decide on them one at a time before they go to the agent as
  one message. **Check the fixes** then verifies what was sent. The review holds
  the conversation until the hand-off, and an open review is lost if the app
  closes first. See [code and plan reviews](docs/chat-context.md#code-and-plan-reviews).
- Run several workspaces environments on one server, one per scope of your work
  (for example personal and each company), so their accounts, keys, site
  sign-ins, Git and cloud credentials never mix. Each has its own Docker network,
  its own folder on the server, a name and a color in the sidebar's machine
  switcher, and optional CPU limit and stop when idle. Update the bot server to
  use it. See [several scopes on one server](docs/remote-workspaces.md#several-scopes-on-one-server).
- Move a conversation between this computer and a remote workspaces host, either
  way, from **Move to** in its menu. It keeps its history, attachments, notes,
  unpushed commits and uncommitted changes; the destination clones the project
  when it does not have it, and the source keeps the branch and a backup. A move
  that stops halfway can be continued or undone. See
  [remote workspaces](docs/remote-workspaces.md#move-a-conversation).
- Maestrly for iOS and Android. Pair a phone with your bot server by scanning
  the QR code in **Settings → Bot server → Pair a phone**, then follow and
  direct your bots and the chats and workspaces of the server's workspaces
  environment: read conversations as they stream, send messages, photos and
  files, dictate, approve requests, answer questions and plans, change models,
  modes and skills, compact, and open the pages agents publish. Messages sent
  offline wait on the phone. See [Mobile app](docs/mobile.md).
- Push notifications on paired phones when a bot or chat needs you, finishes a
  turn or a routine, or fails, chosen by category in the app. The bot server
  sends them through Expo's push service with only the bot's name or chat's
  title and a fixed phrase; set `MAESTRLY_GATEWAY_PUSH=off` to send none. See
  [Notifications](docs/mobile.md#notifications).
- Any paired device can create pairing codes for other devices, at most five
  unused at once.
- Give each conversation on a server's workspaces environment its own Linux
  computer. Open the **Computer** tab to watch it or take control while the
  agent keeps working; its `computer_*` tools use the same computer. A computer
  is given back a minute after nobody uses it and its programs are closed; a
  server runs up to eight at a time. Update the desktop app and the bot server,
  and restart the workspaces environments onto the new image. See
  [remote workspaces](docs/remote-workspaces.md#computer).
- Show the red dot of a conversation that needs you on every computer paired
  with the same host, and clear it everywhere once you open the conversation. A
  reload or a reconnection no longer drops a dot you have not read.

### Changed

- A workspaces environment created before moves to a network of its own the
  next time it restarts, and keeps the server's whole workspaces folder until
  you give it a folder of its own on its page.
- The bot gateway database moves to schema 14 to keep each phone's push token
  and notification choices. Older gateways cannot open it, so back up the
  gateway volume before updating the server. See
  [compatibility](docs/bot-fleet.md#compatibility).
- The Browser tab of conversations on a server's workspaces environment now
  streams as video, which keeps scrolling smooth and clicks quick on slow links,
  such as Tailscale Funnel. It falls back to still pictures on servers without
  video. See [remote workspaces](docs/remote-workspaces.md#browser).

### Fixed

- Make the tool shortcuts work in conversations on a server's workspaces
  environment. Their tools, the streamed browser included, now open in pop-ups
  and floating windows, from the shortcuts and the drawer's buttons, as they do
  for conversations of this computer. The Computer tab stays in the drawer.
- Keep the browser of a conversation on a server from staying on "Connecting to
  the browser on the server…" when its stream answered faster than its start.

### Removed

- **Breaking:** remove the paired review loop (a reviewer conversation
  alternating with the executor) and the ChatGPT Web review loop, replaced by
  the review room. ChatGPT Web loses its `start_review_loop`,
  `submit_review_fix`, `wait_review_fix`, `finish_review_loop` and
  `discover_frontend_previews` tools: refresh ChatGPT's tool list to continue.
  Messages from earlier loops stay readable.

## [0.18.0] - 2026-10-14

### Added

- Let the model search the web with a `web_search` tool, in every runtime.
  **Settings → Tools → Web search** picks automatic selection, Tavily, Brave,
  your ChatGPT subscription or DuckDuckGo (no key), or turns it off. Queries go
  to the provider you pick. See [chat context](docs/chat-context.md).
- Get answers with interactive interfaces. The model can write HTML, CSS and
  JavaScript that render in an isolated frame in chats, projects and bot
  conversations, and can preview an interface before showing it. Turn
  **Interactive answers** off in Settings → Tools, or in a bot environment's
  preferences. See [interactive answers](docs/chat-context.md#interactive-answers).
- Publish artifacts from chats on a server's workspaces environment, with
  nothing to set up: they go to the server that runs the chat. **Open** on their
  cards, and the agent's `artifact_open`, open the page in your computer's
  browser. Update the bot server to use it. See
  [remote workspaces](docs/remote-workspaces.md#use-it).

### Changed

- Stream the bots' screens as H.264 video instead of VNC. Screens stay
  responsive on slow or distant links, such as Tailscale Funnel: the bot server
  sends each viewer only what its link carries and adapts the quality and frame
  rate to it. Clipboard text crosses as UTF-8, so accents and emoji copy both
  ways. Update the desktop app and the bot server, and restart each environment
  onto the new image, to open its screens. See
  [screens of a bot](docs/bot-fleet.md#screens-of-a-bot).
- Make standalone chats and bots answer in a conversational voice that matches
  yours, instead of the terse style used for coding work. Project conversations
  are unchanged, and existing conversations start a fresh provider session on
  their next message.

### Fixed

- Make automatic compaction fail less: summary calls get more time and retries,
  and compaction, including `/compact`, reuses the summary prepared in the
  background instead of summarizing the whole history again.
- Make menus, selects, popovers and other floating surfaces opaque, so the
  content behind them no longer shows through.
- Keep a conversation hidden from the sidebar while its deletion runs, instead
  of showing it again until the deletion ends. Deleting several conversations
  now continues past a failure.

## [0.17.0] - 2026-10-13

### Added

- Let the agents of different conversations read, wait for and message each
  other. Ask a conversation to open another agent and bring its result back, send
  a follow-up to a conversation it started, or let a conversation report back to
  the one that gave it work. The first message to an unrelated conversation needs
  your confirmation, and turns the agents start stop after three exchanges
  without you. See
  [talking to other conversations](docs/chat-context.md#talking-to-other-conversations).
- Edit your last message to a bot with **Edit and resend**, as in desktop chats.
  The bot's reply and everything after it are removed. The edited text runs as a
  new turn and keeps the message's attachments. Editing is available while the
  bot is idle with nothing queued. Update the desktop app, the bot server and the
  bot environment to use it. See
  [bot conversation controls](docs/bot-fleet.md#bot-conversation-controls).
- Play videos that bots share (MP4, M4V, WebM, and MOV) in the conversation.
  The file card shows the first frame and the duration, and opens a player with
  speed, volume, full screen, and keyboard shortcuts. **Download** still saves
  the file. Formats the app cannot decode keep only the download.
- Follow a bot file's download: its card shows progress, speed, and the time
  left, and **Cancel** stops it and removes the partial file. Leaving the chat
  keeps the same transfer, and a system notification says when it finishes or
  fails. See [send and download files](docs/bot-fleet.md#send-and-download-files).
- Let a bot environment rotate between its Claude or Codex accounts when one
  reaches its usage limit. **Automatic account rotation** appears in the
  environment's **Accounts** tab once it has two accounts of the same kind.
  Update the bot server and restart the environment on the new image to use it.
  See [configure an environment from the app](docs/bot-fleet.md#configure-an-environment-from-the-app).
- Get address suggestions in the drawer browser from your history, open tabs,
  and Google search suggestions, with inline completion of frequent sites.
  Cmd/Ctrl+T opens a tab and Cmd/Ctrl+W closes the active one, without closing
  the window. Typed text that is not an address, local host, or IP address is
  sent to Google's suggestion service without cookies. History stays on this
  computer and **Clear browsing data** deletes it. See
  [drawer browser history](docs/local-data.md#drawer-browser-history).

### Changed

- Ask the agent to start other conversations in your own words, for example
  "send another agent to review this". When the message does not ask for them
  in so many words, the chat asks you to confirm with **Start** or **Don't
  start** instead of refusing; "don't open conversations" is still respected.
  See [starting conversations by asking the agent](docs/chat-context.md#by-asking-the-agent).
- Redesign the sidebar around an icon rail for Chats, Workspaces, and Bots,
  with Artifacts, Usage, Settings, and Help at its bottom. Collapsing the
  sidebar keeps the rail. With a remote workspaces server, the list shows one
  machine at a time, with a switcher that says what each machine is doing.
  **Show archived** moves to the list's **⋯** menu.
- When every account of a bot has reached its usage limit, the bot waits until
  the first account is expected back, checking at least every 10 minutes,
  instead of retrying every few seconds. The conversation says when it will try
  again, and other start failures back off up to 5 minutes.
- Address bar entries such as `localhost:3000` and local IP addresses open over
  HTTP instead of becoming a search.

### Fixed

- Show a confirmation the agent needs while a tool runs, such as creating a
  public GitHub repository, as soon as it is asked in an open conversation
  instead of only after switching back to it.
- Use a Claude or Codex subscription account again as soon as its usage limit
  resets and it answers, instead of treating it as exhausted until you
  refreshed it in Settings. Account failover now also covers Codex subagents of
  other runtimes, review loops, and background and bot compaction.
- Keep a bot's answered question in place in its transcript instead of at the
  end of the turn.
- Stop showing a bot's recalled memories as a downloadable attachment of your
  message.
- Keep a bot environment's screen responsive when its browsers download files:
  downloads go straight to the environment's `~/Downloads` instead of opening
  save dialogs that blocked input. Restart the environment on the new image to
  apply it.

### Removed

- **Breaking:** remove the Kanban platform: the web dashboard, the API server,
  the headless runner, and their `client-sdk` and `runner-core` packages.
  Desktop no longer offers **Settings → Platform**, the desktop executor, the
  workspace link to a Kanban project, the `board_*` and `get_linked_kanban`
  tools, the GPT Web **Linked Kanban** access, or web project chats. On first
  launch, the desktop deletes the stored platform connections, credentials,
  links and executor settings, and removes the executor's login item.
  Conversations that were projected from the web remain as ordinary local
  chats. Paired ChatGPT Web conversations ask to be paired again once, because
  their access no longer includes the Kanban.

## [0.16.0] - 2026-10-12

### Added

- Experimental: run your chats and workspaces on your bot server. **Set up
  workspaces on this server** on the server page starts a second Maestrly there
  for them, in an environment of its own that holds no bots. The sidebar lists
  the chats and workspaces of this computer and of the server side by side, and
  conversations on the server keep working while this computer sleeps or is
  off. In the drawer, **Terminal**, **Plan**, **Review**, and **Notes** run on
  the server; **Files** browses, previews, uploads, and downloads with a
  resumable queue; **Browser** shows the agent's browser live and lets you use
  it; and **Code** opens VS Code running on the server. Chats on the server use
  the server's own accounts and memory, chosen in **Settings of** and **Memories
  of**. The server and this app must run the same version, so use **Update
  bots** after updating the app. Several computers paired with one server see the
  same chats and workspaces, and workspaces of one server are not isolated from
  each other. See [Remote workspaces and chats](docs/remote-workspaces.md).

### Changed

- The bot gateway database moves to schema 11 to tell environments that run bots
  from the one that hosts workspaces. Older gateways cannot open it, so back up
  the gateway volume before updating the server. See
  [compatibility](docs/bot-fleet.md#compatibility).
- Update Electron to 44.7.0 and refresh the app's minor and patch dependencies.

### Fixed

- Wait for a bot's new browser tab to be ready before a tool drives it, so the
  first navigation of a conversation is not replaced by the tab's empty start
  page.
- Keep Mermaid diagram labels from being clipped in chats when line spacing or
  font size changes.

## [0.15.0] - 2026-10-08

### Added

- Create or clone a project directly from a chat and start development in it.
  Choose a Projects folder in Settings → Execution; GitHub search and repository
  creation use your signed-in GitHub CLI. New GitHub repositories are private
  by default, and public publication requires confirmation. See
  [creating or cloning a project](docs/chat-context.md#creating-or-cloning-the-project-first).
- Search a bot conversation with Cmd/Ctrl+F, step through matches with Enter
  or Shift+Enter, and close search with Esc. Search includes older transcript
  pages and opens folded activity containing a match.
- Let a bot of your bot server start and follow development conversations in the
  projects of your computers. Each computer gives the bot access on its own, in
  the bot's **Settings → This computer**, choosing the projects, models, actions
  and approval ceiling, and lists the other computers with access so you can
  remove them. Calls reach a computer only through the event stream it keeps open
  to the server, and fail at once when it is offline. Update the desktop app, the
  bot server and the bot environment to use it. See
  [work in the projects of your computers](docs/bot-fleet.md#work-in-the-projects-of-your-computers).

### Changed

- Place the activity line after the agent's text and cards, and keep its latest
  text visible while it works. Tool screenshots stay in their details unless
  the agent explicitly shares them; shared screenshots and generated images
  remain visible in the conversation.
- Open bot conversations at the end and offer a go-to-bottom button after
  scrolling up. Following new messages resumes when you return to the end.

### Fixed

- Preserve an unsent bot message when switching conversations, and keep a sent
  message visible while the bot prepares its turn.
- Refresh a bot's context window after changing its model, so its context meter
  and compaction use the selected model's limits.
- Keep the embedded VS Code memory snapshot files out of project Git status,
  including main checkouts, and write snapshots only when the app requests one.
- Update the image library bundled with the local AI runtime to sharp 0.35.5,
  which fixes a vulnerability in its SVG renderer (GHSA-wq5f-xc86-pv6w), and the
  MCP SDK copy used by the Claude runtime to 1.31.0 (GHSA-6qxp-vccf-f47h). The app
  installs the updated local AI runtime from its own package, without network
  access.
- Save an environment's settings when Cmd/Ctrl+S is pressed right after an
  edit. The shortcut could arrive before the settings panel registered the
  change and was then ignored, leaving the edit unsaved.

### Removed

- **Breaking:** remove the connection for external agents such as Grok Bot and
  other MCP clients; use [Maestrly bots](docs/bot-fleet.md) instead. Desktop no
  longer offers **Settings → Bots** or its `/mcp/bots` endpoint, and the server
  no longer serves `/mcp`, connectors, delegated tasks, or their web pages.
  Conversations such an agent created remain, with their bot badge marked
  revoked, and become yours to write in. Upgrading revokes the connections the
  agents had on this computer and deletes the OAuth clients registered for them.

## [0.14.1] - 2026-10-04

### Fixed

- Wait for active artifact queries before cleaning up storage from earlier
  versions, and let new queries wait until that cleanup finishes. This prevents
  the local host from reopening during removal and reporting that it stopped
  after artifacts were moved to the bot server.

## [0.14.0] - 2026-10-04

### Changed

- **Breaking:** artifacts are hosted only on the bot server. Without a paired
  server, agents ask you to connect one instead of publishing on this computer,
  and **Settings → Artifacts** offers an artifact-only server setup. Artifacts
  that earlier versions hosted on this computer no longer open until you move
  them to the server, with their IDs, versions, comments, and previews, or
  delete them; shared ones become private. See
  [artifacts from earlier versions](docs/artifacts.md#artifacts-from-earlier-versions).
- Give each bot one Linux desktop with its Maestrly browser, terminal, files,
  and other programs together. A dock opens its browser, running shells, and
  home folder; browser logins remain shared by the environment. Update the bot
  environment to use the unified desktop; older images keep separate Browser
  and Apps screens. See [bot screens](docs/bot-fleet.md#screens-of-a-bot).
- Show the bot's conversation beside its computer, and the environment's
  overview beside its screen, with resizable panels and a narrow-window switch.
  Bot and environment settings use tabs and keep unsaved changes together in
  one save bar.
- Enable Maestrly tools by default, with separate controls for Terminal,
  Browser, Notes, Memory, Conversation history, Debugger, Artifacts, and Kanban
  in Settings and each conversation. Existing explicit opt-outs are preserved.
- Move server, runner, gateway, and bot containers to Node.js 24 and update
  dependencies. Contributors now need Node.js 24.11 or later within Node.js 24.

### Added

- Send a development plan from a standalone chat to a registered project
  workspace on an explicit request, choosing a new branch and its base while
  preserving model, effort, and Fast settings. Retries reuse the same destination
  conversation. Ask chats keep their read-only permissions.
- Open standalone chats, workspace agents, and bot conversations in independent
  windows. Live responses, drafts, attachments, and queued messages stay with
  the conversation when you move it out or return it to the app. See
  [separate chat windows](docs/chat-context.md#separate-chat-windows).
- Share a personal memory collection across standalone chats and providers,
  with search, editing, archive, export, and recall controls. Optional automatic
  saving starts off; project and bot memories remain separate. Memory stays in
  this computer's application profile. See
  [personal memory](docs/chat-context.md#personal-memory-in-chats).
- Attach PDFs and UTF-8 text or code files to bot messages, and download files
  generated by bots to Downloads without overwriting existing files. Downloaded
  copies remain available across navigation and restarts, with Show in folder.
- Manage an environment's accounts, models, skills, tools and MCP servers,
  runtime components, and preferences from the desktop app. The settings are
  shared by its bots; update the gateway and restart the environment on the new
  image to use them. See
  [environment settings](docs/bot-fleet.md#configure-an-environment-from-the-app).
- The bot server's own port now also serves the artifact viewer, so one route
  to the server, such as Tailscale Serve, reaches bots and artifacts. See
  [reach the server from another device](docs/artifacts.md#reach-the-server-from-another-device).
- Clicking outside the artifact details panel closes it.

### Fixed

- Retry Claude turns that have not yet produced output when another process
  is refreshing the same account's OAuth token, instead of signing out the
  account and interrupting its other conversations. Model and usage discovery
  also retry this temporary contention.

## [0.13.0] - 2026-10-01

### Added

- Connect Google AI Pro or Ultra accounts through Google's official Antigravity
  ACP server and use its Gemini models in chat, Maestro, subagents, and bot
  environments. The runtime downloads on first sign-in; accounts and bot
  sign-ins remain separate. See [Google AI](docs/antigravity.md).
- Check, update, or roll back the Antigravity runtime in Components. Bots update
  installed runtimes automatically and switch existing processes when the
  environment is idle. Failed updates keep the current version and account data.
- Host artifacts on a paired bot server so shared pages stay available while
  your computer sleeps. Choose where desktop conversations publish, control
  publication per bot, and browse both hosts in the Artifacts center. Existing
  servers and migrated bots start with artifact hosting/publication off.
- Install an artifact-only server with just the gateway image; creating the
  first bot downloads its runtime later. Installer updates add the artifact
  viewer port, with a separate SSH tunnel for VPS setups. Public addresses and
  Tailscale access remain manual. See [server artifacts](docs/artifacts.md#hosting).

## [0.12.0] - 2026-09-30

### Added

- Dictate messages locally with whisper.cpp in chat and bot composers. Send
  transcriptions automatically or review them first, choose the language, and
  hold the microphone button to record. Recordings without speech are discarded.
- Experimental: cap a bot's context window in its compaction settings, including
  the shared environment default, to bound context use and cost.
- Agents can publish web pages as artifacts, such as prototypes, reports, and
  dashboards, with Maestrly tools on. Each change becomes a new version.
  **Artifacts**, in the sidebar, shows every artifact with a preview of its page,
  its versions, and the conversation it came from; pages open in an isolated
  frame. See [Artifacts](docs/artifacts.md).
- Share an artifact with other people: personal links that show every device
  that joins, access requests you approve, or a link for anyone with an optional
  access code and expiry. You can revoke a device, a person, or every session,
  and the sidebar counts new activity. Sharing needs a public address that you
  provide, such as Tailscale Serve. See
  [Sharing](docs/artifacts.md#sharing).
- People who can open a shared artifact can comment on a passage or a spot of the
  page. Comments appear as pins on the page, with previews, conversations
  beside them, and a list; the viewer's top bar also gains version steps, page
  widths, and full screen. You read, answer, and resolve comments in
  **Artifacts**, agents can read and answer them with Maestrly tools, and **Send
  to conversation** puts the open comments in the conversation's message box.
  See [Comments](docs/artifacts.md#comments).
- Experimental: see a bot's reasoning in its conversation, like in chats, once
  its bot server and environment are updated. Older bot servers and computers
  keep working without it.
- Choose how conversations show agent activity in **Settings → Appearance &
  sound → Agent activity**: **Compact** (the default) or **Expanded**, which
  shows every reasoning block and tool card as before.
- Experimental: see when bots can be updated and update them in one click with
  **Update bots**. Maestrly updates the bot server it installed, then each
  environment restarts on the new image once none of its bots is working,
  waiting for you, or under your control, even while your computer is off. An
  environment's view shows what its update waits for and offers **Update now**
  and **Cancel update**.
- Experimental: bots update Claude Code and Codex on their own, without
  waiting for a Maestrly release. Each environment checks npm every six hours,
  tests a new release before using it, never interrupts a turn in progress,
  and never goes below the version its image ships. A bot's **Settings →
  Components** shows the versions and offers manual checks; servers can turn
  automatic checks off with `MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off`.
- Experimental: an environment's view shows the Claude Code and Codex versions
  its bots run, where each comes from, an installed version still waiting for
  work in progress to end, and **Check for updates**.

### Changed

- Require macOS 13 or later. Apps on macOS 12 are not offered this update.
- Fold the reasoning, commands, searches, and other tool steps behind each
  answer into one activity line in chats, workspaces, subagent transcripts, and
  bot conversations. While the agent works, the line shows its current step;
  afterwards it summarizes what it did, including steps that failed or that you
  denied. Open it to see every step and its details. The answer, questions,
  plans, subagents, published artifacts, generated images, and tool screenshots
  stay in view.

### Fixed

- Share plain-text clipboard contents while controlling a bot or environment
  screen, preserve Caps Lock, and show the bot's pointer on its screen.
- Keep subagent cards visible outside the compact activity line, and show bots'
  to-do lists without offering desktop-only tools inside bot environments.
- Let bots use new Claude models such as Opus 5.5: the bot image now ships
  Claude Code 2.1.285, so bots see these models as the desktop app does,
  including the extra high effort, instead of a reduced context window and a
  request to update Claude Code on every turn.
- Close only the open list, not the whole dialog, when pressing Escape in a
  searchable dropdown such as the environment choice when creating a bot.
- Never move a bot server back to an older version when another computer
  already updated it past this app.

## [0.11.0] - 2026-09-28

### Added

- Experimental: run remote bots as separate Maestrly desktops in Docker, on this
  computer or on your own Linux server, with their own screens, browser, model
  accounts, and files. Bots on a server keep working while your computer is off.
- Set up the bot server from Settings → Bot server: Maestrly installs it on this
  computer's Docker or on an Ubuntu or Debian VPS over SSH, pairs this computer,
  and updates the server to the app's version. Bots reach only the public
  internet unless you let them reach private networks.
- Group up to eight bots in an environment that shares one desktop, home folder,
  and set of model accounts, skills, MCP servers, and site logins.
- Pair your computer with a bot gateway you manage, manage bots from the Bots
  sidebar, watch or take control of a bot's screen, and answer its questions and
  approval requests from Awaiting you.
- Add model accounts to an environment or bring them from your computer,
  schedule routines on the server, allow selected bots to exchange bounded
  messages, and review their activity.
- See the screenshots and images a bot's tools produce in its conversation, and
  send it images from your computer by attaching, pasting, or dropping them.
- Choose a bot's reasoning effort, fast mode, and access from its composer,
  dictate messages with the microphone, and follow its context use and
  estimated cost; its model list follows the models you enabled for its
  account.
- Hear an alert when a bot finishes or fails what you asked, or needs you.
- Split the sidebar into Chats, Workspaces, and Bots tabs.
- Recall relevant memories for each message in project conversations with
  memory; a chip under the message opens the recalled memories. Turn it off in
  Settings → Chat → Memory.
- Save memories from conversations in the background with a memory model you
  choose, and consolidate overlapping automatic memories. Saving starts off.
- Let agents search and read their own conversation history.

### Changed

- Encrypt MCP connection details (URLs, headers, commands, arguments, and
  environment values) at rest when secure storage is available. Earlier
  versions cannot read them: after a downgrade, set up those MCP servers again.
- Open and continue long conversations faster.

### Fixed

- Deliver browser and desktop screenshots to GPT-6 models on ChatGPT
  subscriptions when they call tools from code.
- Remove the temporary directory of a Codex runtime check on Windows instead
  of leaving it behind.

## [0.10.0] - 2026-09-26

### Added

- Attach PDF files to chat messages. Models that read PDFs receive the
  document; other runtimes receive text extracted locally.
- Click a PDF in a sent message to open it in the system's PDF viewer.
- Drag files onto the chat composer to attach them.

### Fixed

- Delete a conversation's attached images and PDFs when the conversation is
  deleted, instead of leaving them in the application profile.

## [0.9.3] - 2026-09-24

### Added

- Send requested tasks to new conversations in isolated worktrees, and hand
  approved plans to new Standard conversations.

### Fixed

- Run independent subagent tasks in parallel for Claude and Codex conversations.

## [0.9.2] - 2026-09-23

### Fixed

- Ignore malformed or incomplete task-list tool input in task cards instead of
  interrupting the chat interface.

## [0.9.1] - 2026-09-23

### Added

- Update the Codex runtime without waiting for a Maestrly release. Settings ›
  Maestrly Chat › Components checks the latest official stable release, tests
  its compatibility before switching, keeps the previous version for rollback,
  and can install updates automatically when enabled. Open conversations keep
  their current version until Maestrly restarts.

### Fixed

- Update the integrated Codex runtime to 0.155.1 so connected accounts can
  discover GPT-6 Sol and GPT-6 Luna from the provider catalog.
- Wait for the native macOS updater to finish preparing a downloaded update
  before offering the restart, and keep Maestrly running with a retryable error
  if the installer does not take over shutdown.

## [0.9.0] - 2026-09-22

### Added

- Connect a personal bot, such as a Grok bot, to the native conversations on
  your own desktop through an MCP endpoint the application serves itself, with
  no server, database or relay, and no organization, project, board, card or
  runner involved.
- Turn that endpoint on in Settings, choosing the local address it binds to and
  the public HTTPS address the bot dials; it is off until you enable it, and it
  answers only requests that arrive under that address.
- Approve or deny every bot authorization on the desktop itself, grant access
  per bot and workspace, and revoke it at any time; a bot only ever sees the
  conversations it created itself.
- Give every bot conversation a fresh, exclusive worktree, and resume that same
  worktree when the bot continues the conversation.
- Show bot conversations in the sidebar with a badge naming the bot, and let
  the person pause one so every bot instruction is refused until they resume it.
- Choose how far each bot goes before it asks you — request approval, approve
  for me, or full access — when you approve its request and later on its card;
  the bot is offered only the modes at or under that ceiling, and plan
  approvals always stay with you.
- Release a bot conversation for your own messages, after a confirmation that
  says what it means: the bot keeps the conversation and is not told what you
  write, so ask it to read the conversation again when that matters. Only one
  turn runs at a time, a bot instruction waits for the turn you started, and a
  bot can neither cancel nor steer it. Blocking your messages again closes the
  composer without interrupting anything, and pausing the bot still hands the
  whole conversation back to you.
- Let a bot read a conversation of its own back page by page, so it can pick up
  what you wrote in it; it reads public message text alone, never reasoning,
  tool work, attachments or any other conversation.

### Fixed

- Keep the composer showing the account, model, reasoning effort, fast mode,
  permission mode and behavior mode a conversation will actually run with when
  something other than you changes them — a bot configuring its conversation, a
  delegated stage, or a provider failover — instead of the previous values until
  the conversation is reopened.

## [0.8.0] - 2026-09-20

### Added

- Add standalone chats with private persistent files, isolated permissions,
  provider support, and sidebar lifecycle controls outside project workspaces.
- Add native Cursor subscription support across chat, Maestro, subagents, image
  interpretation, desktop execution, and account-isolated sessions.
- Add optional incremental background compaction with persistent checkpoints,
  resume, cancellation, retry controls, and provider-specific configuration.
- Add in-app update discovery and installation through GitHub Releases on
  macOS, Windows, and AppImage, with release notifications for Debian packages.
- Delegate development work to an external agent (for example a Grok Bot
  routine) through an authenticated MCP endpoint, with per-project and
  per-action grants the owner controls and can revoke at any time.
- Choose the account, model, reasoning effort, fast mode and execution mode for
  each stage of a delegated task, and change them while it runs; an effort is
  never translated between providers.
- Follow a delegated task to delivery: independent review bound to the exact
  code revision, required checks, artifacts, commit, push, pull request and
  merge, plus follow-up rounds when checks fail or changes are requested.
- Notify an external routine with a signed, at-least-once callback instead of
  polling, and manage connectors, delegations and OAuth consent in the web
  interface.

### Changed

- Redesign Kanban card and column-agent dialogs with responsive layouts,
  clearer configuration, contextual prompts, and concurrent agent execution.
- Replace the fixed drawer tool strip with searchable, reorderable, persistent
  tabs stored per conversation.
- Update compatible minor and patch dependencies across all workspaces.

### Fixed

- Keep messages visible and queued correctly during compaction, align portable
  Codex recovery with resolved context settings, and recover short turns whose
  terminal events are lost.
- Repair legacy databases during startup so workspace removal succeeds, while
  preventing unrelated UI updates from interrupting live chat subscriptions.

## [0.7.0] - 2026-09-16

### Added

- Preserve the complete available conversation when switching models or
  providers, compacting before dispatch when transport limits require it.
- Block model transfers that remain oversized or whose required compaction
  fails, avoiding silent context truncation.

### Fixed

- Restore Kanban project chat tool execution for Claude and avoid repeating
  project context after the first message.

## [0.6.1] - 2026-09-15

### Fixed

- Stream live context-window usage for Codex/Astra and Claude instead of
  showing stale measurements.
- Show compaction progress and failures, with staged retries that reuse
  successfully completed work.

## [0.6.0] - 2026-09-13

### Added

- Give project chat scoped control over boards, columns, cards, comments, and
  column automations, with versioned and idempotent mutations.
- Refresh board and open-card details in web clients through live server events
  without overwriting in-progress drafts.

### Fixed

- Use a properly sized macOS template icon for the menu bar, removing the white
  square while preserving platform-specific colored icons elsewhere.

## [0.5.0] - 2026-09-13

### Added

- Link desktop workspaces and conversations to Kanban projects and boards, with
  scoped read and write tools for local agents, Maestro, and GPT Web.
- Enforce project permissions, resource versions, idempotency, and audit
  attribution for agent-driven board mutations.

### Changed

- Replace model-specific harness branching with versioned declarative profiles
  shared across providers, prompts, sessions, subagents, and live controls.

### Fixed

- Hide the paired review loop badge after the loop reaches a terminal state.

## [0.4.3] - 2026-09-13

### Fixed

- Compile internal workspace packages before creating desktop installers, fixing
  the missing module error on startup in v0.4.2.
- Reject desktop packages that omit compiled workspace entry points.

## [0.4.2] - 2026-09-12

### Fixed

- Use a Debian-safe package name and the desktop workspace artifact paths in
  native release builds.
- Validate native packages before tagging without launching packaged GUI apps
  in hosted runner sessions.

## [0.4.1] - 2026-09-12

### Fixed

- Restore native packaging and packaged smoke commands used by the release
  workflow after the monorepo workspace migration.

## [0.4.0] - 2026-09-12

### Added

- Multi-tenant Kanban platform with audited execution, project chat, scoped
  permissions, OAuth Device Flow, and self-hosting support.
- Opus 5 behavior profile across Claude, Copilot, subagents, resumes, and review
  executions.

### Fixed

- Shut down delayed Codex processes reliably on Windows.
- Accept ephemeral Claude sessions in paired review loops and release the split
  view when a loop reaches a terminal state.

## [0.3.0] - 2026-09-09

### Added

- Ordered Claude subscription account rotation for chat, subagents, summaries,
  and image interpretation, with configurable fallback accounts.

### Fixed

- Preserve conversation context and completed tool results when switching
  subscription accounts after usage limits are reached.
- Make GPT account failover transparent and preserve physical account ownership.
- Harden archive extraction and web text parsing.

### Changed

- Update compatible dependencies and development tools.

## [0.2.0] - 2026-09-07

### Added

- GPT-6 Astra support for OpenAI API and ChatGPT subscription sessions, with
  conversation continuity and context compaction.
- Mid-turn text steering and live reasoning updates for subscription runtimes
  that support them.
