# Changelog

User-visible changes by version. Downloads are on
[GitHub Releases](https://github.com/antonioducs/maestrly-app/releases).

## [Unreleased]

### Fixed

- **Stop** in a bot's conversation now stops it. A turn stopped while it was
  still preparing, for example while it compacted a long conversation, no
  longer starts again on its own a few seconds later. The messages waiting in
  that conversation show **Stopped**, with any that arrive meanwhile, and wait
  until you write there: your message goes first, then theirs. Remove a stopped
  message to discard it. Stopped messages no longer keep the bot shown as
  working. It needs a bot server and a bot environment image on this version.
  See [conversations at once](docs/bot-fleet.md#conversations-at-once).
- A bot's conversation with another bot, and a routine run, say when the bot is
  compacting their context. Before, they only showed that the bot was working,
  with no tool running, sometimes for many minutes.
- Two bots in a conversation no longer keep answering each other. Each
  message from the other bot used to tell the bot to reply, so it answered
  thanks and confirmations too. Now a bot replies only when that moves the work
  forward (an answer, a decision or what was asked), and ends the exchange by
  not replying once nothing is left to settle. **Let them go on** lets the bot
  continue only if its message was held back or something is still open. It
  needs a bot server and a bot environment image on this version. See
  [conversations with other bots](docs/bot-fleet.md#conversations-with-other-bots).
- Compacting a conversation between two bots keeps the questions each bot asked
  and the answers it got, what they agreed, and what each still owes the other.
  Before, the summary could keep only the topic, and the bot asked the other bot
  again what it had already answered.
- When a conversation of a bot cannot start its turn, it says why in that
  conversation, even when another conversation of the bot failed the same way.
  A context that cannot be compacted is reported again every 30 minutes while
  it keeps failing, with a readable message instead of its error code.
- The **Send to the agent**, **Check the fixes** and **Send back** buttons on
  the Code review card show their text again. It was transparent on the
  button's light background, so they looked like empty light rectangles.
- A turn in **Plan** mode no longer ends without a plan to approve when the
  model writes the plan as text. GitHub Copilot, Claude and ChatGPT models
  sometimes did, and the **Plan** tab never opened. Maestrly now asks the model
  once, in a hidden message, to submit the plan it just wrote, or to ask you
  what is missing.
- **Settings → Updates** shows the release notes of an available version as
  readable text. On Windows they appeared as raw HTML tags and attributes.
- The plan of a ChatGPT conversation no longer starts with a `<proposed_plan>`
  line in the **Plan** tab.
- Cursor models that call a Maestrly tool with snake_case argument names, such
  as `old_string` and `new_string` for **Edit**, no longer get the call
  rejected, so the edit is applied instead of the model falling back to the
  shell. When a Cursor tool call is still rejected, or fails while it runs, for
  example an edit whose text is not in the file, its card now shows the error
  and its message instead of a success such as "Edited notes.txt", and the turn
  summary counts it as failed.
- Claude models that call a Maestrly tool by its short name, such as `grep` or
  `memory_upsert`, no longer get the call rejected for arguments that arrived
  as text, for example a `limit` of `"50"`. The arguments get their types back
  before the tool runs, so the call is carried out.
- A conversation whose Claude model called **Ask question** with its questions
  as text opens again. It used to show "Something went wrong" instead of the
  conversation, and the call no longer shows an empty question in a bot's
  conversation.

## [0.23.0] - 2026-10-19

### Added

- Let a bot split independent work into tasks that run at the same time: up to
  four at once across all its conversations, with several image generations
  running together instead of one after another. Tasks share the bot's desktop
  and browser, so only one of them uses the computer at a time. It needs a bot
  environment image on this version. See
  [tasks in parallel](docs/bot-fleet.md#tasks-in-parallel).
- Let a bot delegate: in **Settings → Tasks** choose **Delegate**, check the
  models it may use and say what each is for (fast, balanced or strong). The bot
  hands long work to tasks and declares how hard each one is, and Maestrly runs
  it on an allowed model of that class, on the account with the most usage
  left. Task rows in the bot's conversation show each task's difficulty, model
  and result. **Normal** stays the default. It needs a bot server, a bot
  environment image and a desktop app on this version. See
  [delegate mode](docs/bot-fleet.md#delegate-mode).
- The **Computer** tab of a conversation on a server's workspaces environment
  opens in a pop-up over the chat or in a floating window, like the other
  tools: with its shortcut, **⌘⌃C** on a Mac and **Ctrl+Alt+C** elsewhere (with
  Shift for a floating window), or with the drawer's **Open in a floating
  window** button. The shortcut can be changed in **Settings → Tools & drawer**.
  See [remote workspaces](docs/remote-workspaces.md#computer).
- The mobile app shows a bot's routine runs and its conversations with other
  bots apart from your conversation with it, as the desktop does: **Runs** and
  **Bots** tabs under the bot's name count what is new or waits for you, each
  run or conversation opens with everything it did, and you can write there,
  let a paused conversation between bots go on, keep or delete one, and cite a
  run in your next message. Your conversation shows where a run ended and the
  conversations the bot opened with other bots. It needs a bot server and
  environment image that keep them apart. See
  [Mobile app](docs/mobile.md#what-it-does).
- Gemini 4 Argon and Gemini 3.8 Flash follow instructions written for them,
  based on Google's prompting guidance for Gemini agents, on every provider
  that serves them: Google AI (Antigravity), a Gemini API key, OpenRouter,
  GitHub Copilot and Cursor. With a Gemini API key or OpenRouter they offer
  Low, Medium and High effort only. Claude Opus 5 and Claude Fable 5.1 on
  OpenRouter now get the same instructions as on Anthropic.
- Review a plan from the mobile app. A chat in Plan mode shows its plan as a
  compact card with its steps, and **Read and review** opens it in a sheet:
  comment on a part of the plan, edit its Markdown, see what changed since the
  previous version, and decide at the bottom to approve, request changes,
  discard, build it **With Maestro** or **In a new conversation**. What you
  write stays on the phone while the app runs, and a review of the plan on your
  computer holds it until you hand it off or discard it. Starting a plan review
  is still done on the computer. A host from before this version takes only the
  decision and one general comment; the phone writes your line comments into it
  and hides Edit, Maestro and new conversation. See
  [Mobile app](docs/mobile.md).

### Changed

- The bot gateway database moves to schema 21 to keep how each bot splits its
  work into tasks. Older gateways cannot open it, so back up the gateway volume
  before updating the server. See
  [compatibility](docs/bot-fleet.md#compatibility).

### Fixed

- The context limit you set from the context meter now works with Claude,
  GitHub Copilot, Grok, Cursor and Google AI subscriptions, not only with API
  providers and Codex. Maestrly compacts the conversation at the limit, and the
  meter shows the capped window. Cursor and Google AI compact only between
  turns, so a long turn there can go past the limit. Before, Google AI let you
  edit the limit but did not save it, and the other subscriptions hid the
  option. A save that fails now shows an error. See
  [context limit](docs/chat-context.md#context-limit).
- Google AI (Antigravity) conversations now receive the project's
  `AGENTS.md` or `CLAUDE.md`, the conversation's pinned memory, the skill and
  subagent catalogs, and the current date and git branch. Before, the model
  never saw them.
- The **Subscription usage** dialog in the desktop sidebar now includes
  connected Google AI (Antigravity) accounts alongside Claude and ChatGPT.
- In the **Terminal** tab of a conversation on a server's workspaces
  environment, **⌘T**/**Ctrl+T** opens a new terminal on the server and
  **⌘W**/**Ctrl+W** closes the one shown. Before, both did nothing there.
- Conversations that use an OpenAI API key work again in **Ask** and **Agent**
  modes, with the **OpenAI** preset or a custom OpenAI-compatible provider at
  `https://api.openai.com/v1`. Every first message failed with HTTP 400
  "Invalid schema for function 'start_conversations': … 'uri' is not a valid
  format", because the strict schema sent to OpenAI kept the `uri` string
  format.
- On Windows, after Git is installed while Maestrly is open, ChatGPT
  subscription conversations find `git` without restarting: refreshing `PATH`
  closes idle Codex background processes so the next turn starts with the
  updated `PATH`, while leaving any turn in progress untouched.
- File references and mentions in the chat of a conversation on a server's
  workspaces environment open in the drawer's **Code** tab, as on this
  computer. Before, clicking them did nothing. Markdown links written as
  `file:///path/to/file#L10` open too.
- The buttons that release or pause a bot's chat, in a conversation of a bot on
  a server's workspaces environment, now act on the right conversation. They
  passed the window's own key for it instead of the id the host knows.

## [0.22.0] - 2026-10-19

### Added

- The mobile app shows the subscription usage of the paired server in
  **Settings → Subscription usage**: how much of each plan limit the connected
  Claude, ChatGPT and Google AI subscriptions have used, one block per account
  when a provider has several, with when each window resets. It only reads
  them; the server needs this version to answer. See
  [Mobile app](docs/mobile.md#what-it-does).

- Let a bot run its conversations at once. Its own conversation always answers,
  and up to four side conversations, routine runs and threads with other bots,
  run beside it, so a long routine or an exchange with another bot no longer
  holds your messages. A side conversation that uses a computer gets a desktop
  of its own, freed after a minute idle, and the desktop app and the mobile app
  show and stop each conversation on its own. It needs a bot server, a bot
  environment image and a desktop app on this version; the others keep running
  one turn at a time. See
  [conversations at once](docs/bot-fleet.md#conversations-at-once).
- Keep each conversation between two bots as a thread of its own, with a **Bots**
  tab beside **Conversation** and **Runs** to read it and write in it, instead of
  landing in your conversation with the bot. A thread pauses after 4, 8 or 16
  messages in a row without you (8 by default) and asks for your attention, and
  a side is deleted 30, 60 or 90 days after its last message unless you keep it.
  The new `bot_peers_report` tool brings a thread's answer back to your
  conversation as a card, without starting a turn there. Messages between bots
  from before belong to no thread. See
  [conversations with other bots](docs/bot-fleet.md#conversations-with-other-bots).
- Dictate through OpenAI (`gpt-4o-transcribe`) or Groq (`whisper-large-v3-turbo`)
  on the desktop and on the phone, which handle mixed Portuguese and English
  technical speech better than the phone's own recognizer. On the desktop,
  choose the engine in **Settings › Maestrly Chat › Tools › Dictation**;
  **This computer (Whisper)** stays the default and keeps speech on the
  computer. With an API engine each recording goes to the provider under your
  key, stops by itself after 10 minutes, skips silence, and **Try again** sends
  a failed one again. **Use on my phone too** stores the engine and key on your
  bot server, which keeps the key unencrypted in its database like its other
  secrets, and a phone then dictates through it from **Settings → Dictation →
  Server**. The phone needs the updated app and a bot server on this version;
  without them it keeps its own recognizer. See
  [voice dictation](docs/chat-context.md#voice-dictation) and
  [Mobile app](docs/mobile.md).

### Changed

- The bot gateway database moves to schema 20 to keep the conversations between
  bots and the server's dictation key. Older gateways cannot open it, so back up
  the gateway volume before updating the server. See
  [compatibility](docs/bot-fleet.md#compatibility).

### Security

- A saved "Always allow" rule for a command no longer covers a longer command
  built to hide a second one. Before, a model could get, for example,
  `echo $(echo ')'); rm x` past a saved `echo *` rule without asking: the check
  that splits a command into the commands it runs ignored quotes inside
  `$( )`, missed commands in backquotes with escaped backquotes, in comments
  holding a quote, in heredocs, in `<( )` and in `$'...'`, and on Windows in
  PowerShell comments and arguments in parentheses. It now reads them the way
  the shell does. A command whose structure it cannot read with certainty no
  longer matches any saved rule: it asks every time (unless the conversation
  has full access) and offers no "Always allow". Ordinary commands such as
  `git status`, `npm test -- --run` or pipes still match their rules. See
  [Security model](docs/security-model.md#commands-files-and-git).

### Fixed

- On Windows, the agent's commands run in Windows PowerShell 5.1 instead of
  `cmd.exe`, and every model is told which shell that is. Before, nothing said
  the commands ran in `cmd.exe`: models sent PowerShell pipelines that failed
  with "is not recognized as an internal or external command" and concluded
  PowerShell was missing, or wrote bash syntax. The `bash` tool keeps its name,
  so saved permission rules still apply; its description and the environment
  line of each conversation now name the shell, and on Windows explain how to
  run a `cmd.exe` command. Output is UTF-8 and the exit code is the
  command's own. On macOS and Linux commands still run in `/bin/sh`. Plugin
  hooks still run in `cmd.exe` on Windows.
  See [Plugins](docs/plugins.md#hooks).
- Subagents are told the operating system, today's date and their directory,
  and, when they can run commands, which shell the `bash` tool uses, as the
  main agent already was. Before, a subagent on Windows learned about
  PowerShell only from the tool description, and subagents of every runtime
  had to guess the date. This applies to subagents run with an API key and to
  those of the Claude, ChatGPT, GitHub Copilot, Cursor and Google Antigravity
  subscriptions.
- Moving a bot whose working folder holds a Git repository no longer fails
  while its data is packed. Its whole working folder now moves, `.git` folders,
  empty folders, files ending in `.tmp`, and the links that lead inside it (such
  as `node_modules/.bin`) included, and a large folder moves several times
  faster.
  See [Move a bot to another environment](docs/bot-fleet.md#move-a-bot-to-another-environment).
- An API-key account whose key the provider refuses is flagged instead of
  looking connected: when listing its models returns HTTP 401 or 403, its card
  in **Settings → Accounts** shows **Key rejected** with the provider's message,
  with the key masked, it counts as needing attention instead of connected, and
  the model picker shows a line for it instead of leaving its models out with
  no explanation. Saving or replacing a key checks it right away. When the
  provider cannot be reached or has no model list, the key is saved and shown
  as not verified.
- Conversations that use an OpenAI API key work again, with the **OpenAI**
  preset or a custom OpenAI-compatible provider at `https://api.openai.com/v1`.
  Every first request failed with HTTP 400 "Invalid 'prompt_cache_key': string
  too long", because the prompt cache key had more than the 64 characters
  OpenAI accepts. Subagents had the same problem.
- While signing in to GitHub Copilot, the account card shows the GitHub
  device page next to the one-time code, with **Copy link** and **Open in
  browser**, and a **Copy code** button. If no browser opened, you can still
  finish signing in. The card shows and opens only
  `https://github.com/login/device`.
- Claude Code installed while the app is open is found: **Check again** and
  the refresh button on the Claude account look for it again, so a signed-in
  account reconnects without restarting Maestrly. Before, on Windows, the card
  stayed on **Claude Code unavailable** until a restart. While Claude Code is
  missing or too old, a signed-in Claude account no longer moves to
  **Available to connect**: it keeps its row in **Settings → Accounts** with
  its email and **Claude Code not found** or **Claude Code needs an update**,
  and counts as needing attention.
  See [Install Claude Code](docs/claude.md#install-claude-code).
- On Windows, Git installed while Maestrly is open is found without
  restarting. After **Git was not found. Install Git and try again.**, trying
  again after the install now adds the project, and project conversations,
  their worktrees and diff reviews work too: when `git` does not start,
  Maestrly rereads the `Path` that Windows keeps for new programs and also
  looks in the folders where the Git for Windows installer puts it. Plugin
  sources do the same: adding or updating one after installing Git no longer
  fails with **Git is not installed or cannot run.**
- List the reasoning efforts of Google AI models again, in the model picker and
  in subagent profiles, which showed **No configurable effort** for every Gemini
  model with Antigravity ACP 1.4.

## [0.21.1] - 2026-10-18

### Fixed

- The model picker and the account's model filter list every Claude model
  again: an alias such as `opus` and the model it points to, such as
  `claude-opus-5-5`, are separate rows. Since 0.21.0, a model whose alias the
  filter hid, such as Opus 5.5, was missing from both.
- An environment whose update failed after its old container was removed starts
  again: **Start environment** and **Restart environment** create a new
  container on its home volume instead of failing with "Environment container
  missing". It needs a bot server on this version. See
  [Update, disconnect, and remove](docs/bot-fleet.md#update-disconnect-and-remove).
- The bot server waits up to two minutes for Docker to create, start, stop or
  remove an environment's container, instead of 10 seconds. On a busy server,
  updating several environments at once could leave one without a container
  and another stopped.

## [0.21.0] - 2026-10-18

### Added

- A bot moves to another environment of its server, or to a new one, with its
  conversation and history, memory, files, images, routines and browser profile,
  under its own id: choose **Move to…** in its settings' **Environment** tab, or
  drag it onto another environment in the sidebar, and confirm. The accounts,
  skills and MCP servers of its former environment stay there. It needs a bot
  server and bot images on this version. See
  [Move a bot to another environment](docs/bot-fleet.md#move-a-bot-to-another-environment).
- The mobile app's dictation listens in the language chosen in **Settings →
  Language**; with **System**, it follows the phone. See
  [Mobile app](docs/mobile.md#what-it-does).
- The mobile app pastes a copied image into a message with **Paste image**,
  above the message field and in its **+** menu.
- A new chat in a workspace, started from the mobile app, asks for its branch as
  the desktop does: a new branch, named by you or after the chat, from the
  branch you choose, or an existing local or remote branch. It needs a
  workspaces environment on this version; older ones keep giving each chat a new
  branch of its own.
- The mobile app's **Workspaces** tab lists every chat of each workspace, with
  the chats that share a branch in a folder named after it, as in the desktop
  sidebar.
- The **Files** tab of a conversation on a server downloads and uploads whole
  folders: a folder's download button saves it, extracted, to **Downloads**,
  and **Upload folder…** or dragging a folder sends it to the server. A folder
  never replaces another: a taken name arrives as `name (2)`. It needs a
  workspaces environment and a bot server on this version. See
  [Files](docs/remote-workspaces.md#files).
- **Add account** offers a **Gemini** API key preset, which uses Google's
  OpenAI-compatible endpoint.
- A new chat outside a workspace starts in the mode you last chose in one, not
  always in **Ask**; permissions still start at **Ask for approval**. Without a
  default model in **Settings → Maestrly Chat → Models & agents**, any new chat
  starts on the last model you picked and keeps it once it has answered.
- Let a bot work in the projects of a workspaces environment of its own server,
  not only on the computers you paired, so it keeps working while every
  computer is off. In the bot's settings, the **This computer** tab is now
  **Projects**, with a **Workspaces on the server** section that has a card for
  each environment. Update the desktop app, the bot server and the environment
  image. See
  [work in the projects of your computers](docs/bot-fleet.md#work-in-the-projects-of-your-computers).
- Keep each routine run in a conversation of its own. A **Runs** tab next to
  **Conversation** in the bot's header lists the runs by day and counts those
  that ended with something new. Open a run to read everything it did, ask for
  changes, stop it, keep it, or cite it in the bot's conversation. Per bot,
  choose how long run conversations are kept and which runs notify you. It
  needs a bot server and environment image on this version; the others keep
  running routines in the bot's conversation. See
  [routine runs](docs/bot-fleet.md#routine-runs).
- Create a bot from the mobile app, in an existing environment of the paired
  server: **New bot** at the end of the menu's **Bots** tab, or **+** beside an
  environment. See [Mobile app](docs/mobile.md).
- Uninstall a plugin from its details page, next to **Installed**, on this
  computer, on workspaces hosts and in bot environments. If uninstalling fails,
  the confirmation stays open and shows the error.
- Show the plan and weekly usage of a connected Google AI account, as the cards
  of ChatGPT, Claude and Cursor do, when its runtime reports them.
- Show how to install Claude Code when it is missing or too old: the Claude card
  gives the official installer for your system with a copy button, a link to
  Anthropic's setup guide and **Check again**. See [Claude](docs/claude.md).

### Changed

- A bot's access to a computer now starts at the **Full access** ceiling,
  since the work is already delegated to the bot; the warning still shows, the
  stricter ceilings stay available, and saved connections keep their ceiling. A
  bot also no longer waits for a free slot: it used to run at most eight
  commands at once on a computer, and an answer to a question waited behind
  them.
- A bot's `git push` follows the permission level of its connection to your
  computer. With **Full access** it runs directly, and with the other levels it
  asks for your approval, instead of always being refused.
- Dictation takes over the composer's action bar while it records. **Insert**
  adds the transcription to the draft, and **↑** stops the recording and sends
  the draft followed by it, so a click on Send no longer leaves the microphone
  recording. **Send automatically** is removed, and ⌘D (Ctrl+D) toggles
  dictation in the editor. While an agent works, one button stops it, or queues
  or sends your text, and Esc stops it. See
  [voice dictation](docs/chat-context.md#voice-dictation).
- Dictate on iOS 26 and later with Apple's newer on-device transcriber, which
  punctuates by itself and handles long messages better. A language's model
  downloads in the background, and that dictation uses the previous recognizer.
  See [Mobile app](docs/mobile.md).
- Show a routine run in a bot's conversation as one line with the routine's
  title, time and schedule, with **Instructions** to unfold the prompt, and show
  messages between bots with their sender and recipient, rendered as Markdown,
  folded when long, with **Open bot**.
- Draw diagrams with Mermaid 12 and its new dark look. The ELK layout library it
  bundles (EPL-2.0) is listed in the third-party notices.
- Show compressed swap on the **Server** page apart from **System** memory, and
  mark an environment whose processes were ended for lack of memory with a
  warning in its row and in the sidebar. It needs a bot server on this version
  and a server with cgroup v2.
- The bot gateway database moves to schema 18 to keep bot moves and routine run
  conversations. Older gateways cannot open it, so back up the gateway volume
  before updating the server. See
  [compatibility](docs/bot-fleet.md#compatibility).

### Fixed

- The model picker opens at once on the last lists and shows each account's
  models as soon as they arrive, instead of waiting for every account.
- The model picker lists a Claude model once, not also under its catalog id and
  dated snapshot (`haiku`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001`).
- Searching the model picker matches each word in the model or account name and
  lists the model's own company first: "gemini" shows Google AI before other
  services that offer Gemini.
- Gemini through its OpenAI-compatible endpoint shows model names without the
  `models/` prefix and leaves out image, speech, Live and embedding models.
- **Choose photos** and **Choose a file** in the mobile app open the picker on
  iPhone again instead of doing nothing.
- The mobile app no longer shows **Back online** each time it returns to the
  screen, and shows a reconnection only when it takes more than a moment.
- A Claude conversation whose history was carried into a new session no longer
  fails its first tool call with "No such tool available" before retrying it.
- Dictation on an iPhone whose language and region have no recognizer of their
  own, such as English with the region set to Brazil, no longer says the phone
  can't take dictation in its language: it listens in that language's main
  variant, such as US English.
- **GitHub Copilot** can sign in on the published Linux, macOS, and Windows
  packages again: release builds include the GitHub sign-in configuration they
  were missing. A build without it now says so on the Copilot card instead of
  downloading the Copilot runtime and failing with a generic sign-in error.
- A turn that fails at a provider added with an API key, such as an
  OpenAI-compatible endpoint that runs out of credits, now shows the error in
  the conversation: the provider's name, the HTTP status and the provider's
  message, with keys and tokens masked. Errors that come back without a
  readable message, such as Gemini's, used to leave the response empty. A
  rejected key or exhausted credits now fail on the first request instead of
  being retried, and hovering the red status icon in the sidebar explains it.
- Quitting Maestrly no longer hangs, leaving only its tray icon, while a Claude
  sign-in is waiting for the browser or a pasted code: quitting cancels it.
- A Claude sign-in left unfinished on Windows now gives up after 15 minutes, as
  it already did on macOS and Linux, instead of waiting indefinitely.
- A plugin MCP server that names its publisher's own app, such as Slack in
  OpenAI's catalog, now offers **Sign in** with your own OAuth client from the
  start, or takes your access token under **Edit settings**, sent as
  `Authorization: Bearer`. It used to show only "Token required", with nowhere
  to enter one. Plugins installed before offer the token after the update. See
  [Plugins](docs/plugins.md#mcp-servers-and-sign-in).
- Signing in with your own OAuth client always returns to the same redirect
  URL, `http://127.0.0.1:<port>/callback`, shown with **Copy** in the form and
  under the server, so providers that accept only registered redirect URLs,
  such as Slack, accept it. The port used to change on every sign-in. See
  [Own OAuth client](docs/plugins.md#own-oauth-client).
- A stdio MCP server that stops at once, for example for a missing token, now
  says why: its error, with its environment values masked, reaches the model
  and, in a bot environment on a current server and image, the **Test** button
  of **Tools**. It used to say only "Connection closed".
- A bot told to sign in to an MCP server now points to its environment's
  settings in the app instead of **Settings → Maestrly Chat → Tools** on this
  computer, names **Plugins** for a plugin's server, and asks for a new token
  when the server rejected the one it has.
- Resume Claude, Cursor and GitHub Copilot sessions across turns. They were
  discarded and the whole transcript was resent as text on almost every turn,
  which spent many more tokens than needed. Each existing conversation rebuilds
  its session once on its next turn, then resumes normally.
- Sign in to Claude on Linux: the page now opens in your browser and the card
  has a field for the authorization code, instead of waiting forever for a code
  that had nowhere to be entered. See [Claude](docs/claude.md#sign-in).
- Choosing a Google AI model no longer starts dozens of sessions that stayed
  alive until Maestrly quit and froze the model picker. On macOS and Linux its
  sign-in opens in your browser, and the card shows the link with **Copy link**
  and **Open in browser**.
- Show **context unknown** in the context meter for Google AI and Cursor when
  the runtime reports no measurement, instead of a few hundred tokens of
  transcript. Google AI shows its measured context when the server sends it.
- Sign in to Google AI, Claude, Codex or Grok from the **Accounts** tab of a
  workspaces host through its environment. It used to open the page on the
  server, or call back to a port of this computer that nothing listened on.
- Open the **Code** tab of a cloud workspaces chat behind a reverse proxy such as
  Tailscale Serve, where the editor's Explorer kept loading. The desktop app and
  the workspaces environment image both need this version.
- Render web pages in the Browser tab with the white background of other
  browsers instead of black, which made dark text on pages without a background
  unreadable.
- Show a multi-line command exactly in the approval prompt, in the desktop app,
  the bot views and the mobile app, instead of its segments joined on one
  truncated line.
- Polish provider copy: lists no longer name only some subscriptions, the
  composer hint says Ctrl+V on Linux and Windows, ChatGPT plans show a name
  instead of the raw code, and the Codex and Google AI runtime cards show
  "Latest version" before the first install, then the version to be installed
  with its estimated size.
- Start the Linux `.deb` on a minimal desktop: it now depends on the ALSA and
  GBM libraries it needs, and failed with `libasound.so.2` missing.
- Quit without a confirmation unless an agent, a terminal command or a
  background command is running. Closing the session, shutting down and
  `SIGTERM` never ask, and a failed load of the main window no longer aborts
  startup.
- Wrap long links and words in bot conversations instead of giving them a
  horizontal scrollbar.

## [0.20.0] - 2026-10-16

### Added

- Plugins: install Codex, Claude Code and Agent Plugins plugins from Git in
  **Settings → Maestrly Chat → Plugins**. Their skills, MCP servers, commands,
  agents and hooks work the same with every model; plugins that depend on one
  product, such as ChatGPT app connectors, are counted apart with the reason.
  Plugins belong to the host: this computer, each workspaces environment of a
  server, and each bot environment, which can bring one from this computer.
  See [Plugins](docs/plugins.md).
- MCP servers that use OAuth can keep several signed-in accounts, each with
  where it applies; the model names the account in each call. Servers that do
  not register apps automatically, such as Google's, sign in with your own
  OAuth client. See [Plugins](docs/plugins.md#several-accounts).
- See the phones and computers paired with your bot server, and remove one you
  lost, in **Settings → Bot server → Paired devices** on a computer and
  **Settings → Paired devices** in the mobile app. Update the bot server to use
  it. See [Mobile app](docs/mobile.md#unpair-and-revoke).
- The mobile app shows the chats of any of the server's workspaces
  environments: choose one under the server's name in the menu, start a
  stopped one from there, and a chat notification opens its chat on its own
  environment. See [Mobile app](docs/mobile.md).
- Interactive answers run on the phone, in an isolated web view. Sending a
  message or opening a page from one always asks first. See
  [interactive answers](docs/chat-context.md#interactive-answers).
- Files a bot shares show in the mobile app: videos play in the conversation,
  and any other file downloads and opens the share sheet.
- **Allow everything in this chat** on a chat's permission request in the
  mobile app gives the chat full access after the same warning as its setup,
  and the setup pill shows when a chat has full access or approves for you.
- Free what a conversation leaves behind. Deleting or archiving it ends the
  processes its terminals and `bash` commands left running, such as a server
  started in the background, and deleting it removes the temporary files its
  tools wrote. Only what Maestrly can show the conversation started is touched;
  tools and caches shared by the machine never are. See
  [processes a conversation leaves running](docs/local-data.md#processes-a-conversation-leaves-running)
  and [temporary files](docs/local-data.md#temporary-files-of-a-conversation).
- Edit your last message in the mobile app while no turn runs and nothing waits
  to be sent. The edit keeps the message's attachments and removes the reply
  and everything after it, as on the desktop. Editing a chat's message needs
  Maestrly updated on the computer or server that hosts it. See
  [Mobile app](docs/mobile.md).
- Search a conversation in the mobile app from its header: matches ignore case
  and accents, are highlighted and stepped through, and older messages load
  when the ones on screen run out.

### Changed

- **Settings › Maestrly Chat › Accounts** lists every account in one compact
  list grouped by provider, with its status and usage, and shows the selected
  account's details beside it. Search the list, show only the accounts that need
  attention or are near a usage limit, and connect subscriptions or API keys
  from **Add account**. Providers you have not connected appear under
  **Available to connect**. Each account shows its provider's logo.
- The ChatGPT Web Companion is no longer marked experimental. Its settings show
  the active sessions first, each with its own **End session**, followed by
  the setup steps.
- Open the mobile app with the Maestrly intro. The first open plays the whole
  animation, later opens show the logo briefly, and Reduce Motion shows it
  still. The app icon, splash and in-app logo now match the official logo,
  which they drew without the two inner feet of the M.
- The mobile message field grows with the text up to 40% of the screen, then
  scrolls, and shrinks again when you delete text. A turn's tools, reasoning
  and earlier text fold into one collapsible block, as on the desktop, instead
  of a list that keeps stretching.
- Settings fill the window beside the icon rail, with the sidebar panel out of
  the way. Choose a tab on the rail, or the sidebar toggle, to leave Settings
  and show that panel again.
- **Settings › Maestrly Chat › Models & agents** is grouped by purpose:
  Conversation, Background tasks, Memory and Subagents. Every model shows as a
  chip with its provider, effort and Fast, and picking one saves it at once, so
  the tab has no Save buttons left. An **In use** summary lists the models the
  settings run, and subagent fallbacks read as a chain.
- Remove the list of messages between bots from the Server page. Messages
  between bots still appear in each bot's conversation.

### Fixed

- In the mobile app on iOS, the content of setup sheets no longer slides under
  their Back and Done buttons, and the chat setup screen opens at its title.
- The mobile app offers a button back to the latest message once a conversation
  is scrolled away from it, and sending a message puts the keyboard away.
- Closing a browser tab or conversation shortly after an agent navigated or
  reloaded its browser no longer shows an "Object has been destroyed" error
  dialog.
- Make **Open** on a started-conversation card, and the origin link of a message
  from another conversation, open the conversation in a chat of a remote
  workspaces host. They did nothing before.

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
