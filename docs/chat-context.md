# Context usage and compaction

## Chats and projects

Use **Chats → New chat** for a general conversation, explanations, or work with
attachments. A project is not required. Projects keep their existing repository,
branch and worktree workflows; standalone chats do not join a project or inherit
its instructions, memory or saved permissions.

New standalone chats start in Standard with Ask mode and Ask permissions. Saved
“always allow” decisions belong to that chat alone. Agent, Plan and Design can
use their usual generic capabilities under the selected permission policy.
Maestro, Git review, branch operations and project-memory tools require a project.
Browser, MCPs and other optional tools retain their existing enablement settings.
Models search the web with `web_search` when web search is enabled in
**Settings → Tools → Web search**, and read a specific URL with `webfetch`. Both
ask for permission under the Ask policy.

Each chat stores working files in `<userData>/standalone-chats/<conversationId>`.
This managed directory is an execution location, not an operating-system sandbox.
History, model selection and preferences remain attached to the conversation ID.
Archiving preserves history and files for restoration. Deleting removes that
chat's managed files and saved permissions; deleting a project does not delete
standalone chats. Back up the application profile to preserve these files.

## Separate chat windows

Use **Open chat in new window** in a conversation's header to detach a standalone
chat, workspace agent, or fleet bot conversation. Chats and workspace conversations
also offer this action in their sidebar menu. Each conversation has one window;
using the action again focuses it. Different conversations can stay open side by
side, including on different monitors, while you navigate the main app.

The same chat remains active when moved: drafts, attachments, queued messages,
and incoming responses stay with it. Close the detached window or choose
**Return to app** to bring the conversation back without stopping its work.
Local chats offer a button to open their tools in the main window; a pending
plan changes that action to **Review plan**. Bot screen and settings actions
continue to use the main app.

Window positions are remembered for the current app session. Detached windows
are not reopened automatically after restarting Maestrly, and closing the whole
application still follows its normal shutdown behavior.

## Notifications and badges

When a conversation finishes its turn, fails, asks you a question, waits for
your approval, or brings a plan to review, Maestrly shows a system notification,
unless you are looking at that conversation: shown in the focused main window,
or in its own focused window. This includes conversations on a server or another computer
(see [Remote workspaces](remote-workspaces.md)). Clicking the notification
opens the conversation, in its own window when it has one. A newer notification
replaces the conversation's last one, and opening the conversation removes it.
A turn that brought a plan shows only the plan's notification.

Notifications are silent: the **Alert sounds** play for the same events. Turn
them off with **System notifications** in **Settings → Appearance & sound**;
muting the sounds does not turn them off. Bots notify too (see
[Alerts, notifications, and marks](bot-fleet.md#alerts-notifications-and-marks)).

The app icon counts what needs you: the conversations with a red dot in the
sidebar, this computer's and those of the servers and computers it reaches,
plus the count on the **Bots** tab. On macOS the
count shows on the Dock icon, on Linux on launchers that support it, and on
Windows a red mark shows on the taskbar button.

### Notifications center

The **Notifications** tab, first in the sidebar's rail, gathers what needs you
from every conversation and bot: this computer's, those of the servers and
computers it reaches, and the bots of every paired server, including their
routine runs and conversations between bots. It shows each conversation or bot
once, at its latest state, and keeps no history. Its badge is amber while
something waits for you and counts what is waiting or new.

- **Waiting for you** lists questions, approvals, plans to review, and bots
  that ask for help. They stay until you act on them, read or not.
- **New** lists turns and routine runs that finished or failed since you last
  looked.
- **Read** lists what you read in the last 24 hours, after which it leaves.

Click an item to open it beside the list: the sidebar stays on the center, so
you can go through one item after another. **Show in** opens the item in its
own tab instead. **Allow once** and **Deny** answer an approval from the list.
**Mark as read** (or `e`) clears an item's red dot here and in its own tab;
**Dismiss** hides it until something newer happens. Filter by environment, by
source (workspaces, chats, or bots), or with the sidebar's filter, and move with
`j` and `k`. What you read and dismissed is kept on this computer.

## Task lists

The task card shows valid entries from the agent's latest task list. Malformed
or incomplete task data is omitted instead of interrupting the chat interface;
valid entries appear when the agent supplies them. This also applies when
reopening saved conversations and does not change the stored tool input.

## Code and plan reviews

**Review** in the header of a project conversation, or `/code-review` in the
composer, opens an independent, read-only review of the conversation's current
changes: the committed difference from the default branch, staged and unstaged
changes, and new files. In the Plan tab, **Review plan** opens a review of a
plan that is waiting for your decision. Reviewers run read-only: they read and
search the checkout but cannot change files.

A review takes over the conversation and moves through five stages:

1. **Scope** shows what will be reviewed (the changed files with their line
   counts, or the plan's steps) and asks who reviews: the conversation's own
   model, reasoning effort and Fast setting, or another model with its own
   effort and Fast setting. The choice is remembered for the next review and
   stored in the local database. Nothing runs until you choose **Start review**.
2. **Investigate**: reviewers work in parallel, three for code (logic,
   integration, and security and tests) and two for plans (feasibility and
   completeness). Each one has a column with what it reads and searches as it
   happens and the candidate findings it raises. An evidence map beside them
   shows which files each reviewer read, inside and outside the change, and
   where candidates point.
3. **Verify**: a verifier rules on every candidate. It confirms it (possibly
   with a corrected severity), discards it with a reason, or merges it into a
   duplicate. Discarded and merged candidates stay visible with their reason.
4. **Decide**: one finding at a time, with the code (or plan) lines it is
   about, its evidence and a suggestion. For code, choose fix, discuss or dismiss
   (with an optional reason); for plans, comment on the plan or dismiss. The
   keyboard works too: `J`/`K` move, `F`, `D`, `C` and `X` decide.
5. **Hand off**: for code, an editable message built from your decisions goes
   to the agent with the full report attached, or you keep only the report. For
   plans, your comments land on the plan lines (with your own comments from the
   Plan tab) as a revision request, or you approve the plan as written.

From **Start review** until you hand the result off or discard the review, the
conversation is paused: no turn runs, nothing can be sent, and the plan cannot be
decided. Messages from other conversations wait until the review ends. A code
review uses up to four runs of the reviewing model and a plan review up to
three; their usage counts toward the conversation, even when the review is
discarded.

The review then continues in the conversation as a receipt with its findings,
your decisions and where the hand-off stands. When the agent has finished,
**Check the fixes** (or **Check the revision**) runs one more verifier pass over
what you sent: no new findings, only whether each fix or comment holds up. The
conversation is paused for the few seconds it takes. A finding that is still
open can be sent back to the agent from the receipt.

One review runs per conversation at a time. Code reviews need a Git checkout
with changes, so they are not offered in multi-repository or archived
conversations. Receipts are stored with the conversation in the local database,
outside the model's context; the report reaches the model only with the message
you send it with. An open review that the app closes before it is handed off is
lost, and the conversation is free again. The earlier automatic review loop was
removed; older conversations keep its messages as history.

## Interactive answers

In chats, project conversations and bot conversations, an agent can answer with
interfaces mixed into its text, as many as the answer needs: small pages it
writes in HTML, CSS and JavaScript, shown in an isolated frame. They suit
pictures such as product photos, visual comparisons, charts, diagrams,
calculators and simulations, small tools and games.

How they behave:

- Before showing an interface, the agent can preview it: the app renders it
  offscreen at the width of the chat and returns a screenshot and the problems
  it found, so the agent can fix what looks wrong. The preview appears in the
  answer's activity with its screenshot, and the answer then shows the
  interface without the agent writing it again. Previews need Maestrly tools;
  without them the agent writes interfaces without seeing them.
- Each interface appears as soon as its block is complete, while the rest of
  the answer is still arriving.
- Changing a field or moving a slider runs inside the interface; it does not
  call the model.
- A button can send a message as you or open a web page in your browser. A sent
  message appears in the conversation like one you typed, and waits in the
  queue while a turn runs. An interface sends or opens something only right
  after you interact with the app window, and at most once per second.
- An interface keeps nothing: it starts over each time the conversation shows.
- The app checks each interface. An image that does not load is replaced by a
  placeholder, and a table wider than the answer scrolls sideways. What cannot
  be fixed is listed under the interface as **problems found**: content wider
  than the answer, text cut off, a layout that grows with its own frame, script
  errors and blocked requests.
- **Interface source** shows what the agent wrote.
- The [mobile app](mobile.md) runs interfaces too, in an isolated web view with
  the same policy, once their block is complete. On the phone, every message an
  interface asks to send and every page it asks to open first asks you, showing
  the message or the site, since the phone cannot tell a tap in the interface
  from the interface's own code. **Show code** shows the source.

Interfaces cannot call tools, read files or fetch data, so they show only what
the agent put in them. They may load images, video and audio from any web
address, and libraries and fonts from a few public CDNs; those servers see the
addresses requested, by previews as well.

The instructions that teach interfaces add about 850 tokens to each
conversation's cached system prompt, and each preview adds its screenshot to
the context. To save those tokens, turn off **Interactive answers** in
**Settings → Tools**; for bots, turn it off in the **Preferences** of the
environment's settings. Turning it off removes the instructions and the preview
from the next turn; answers that already have interfaces keep showing them.
Delegated subagents never receive them.

## PDF attachments

Attach PDFs with the **+** menu, by pasting them, or by dragging them onto the
composer; dragged images and text files are attached the same way. Each PDF can
be up to 10 MB, a message can carry up to four, and PDFs share the 20 MB
per-message budget with images.

Maestrly extracts each PDF's text locally when the message is sent, in a
separate process. The Claude subscription, and Anthropic or OpenAI API models
that accept PDF input, receive the original document when it has at most 100
pages. Codex, GitHub Copilot, Cursor, OpenAI-compatible providers and longer
PDFs receive the extracted text instead: at most the first 256 KB, without
layout or images. A scanned PDF without a text layer can only be read where the
document is sent natively. Password-protected or damaged PDFs are rejected with
a message and nothing is sent.

The document is stored in the application profile with the conversation's other
attachments and is removed when its message or conversation is deleted. Files a
provider received remain subject to that provider's retention policy. The context
meter counts at least 2,000 tokens per page, because native documents cost far
more than their text.

Click a PDF in a sent message to open it in the system's default PDF viewer. The
viewer receives a read-only copy named after the attachment, kept in the
application profile until its message or conversation is deleted or Maestrly
restarts; changes saved from the viewer never alter the attachment.

## Undoing a turn's file changes

When a turn changes files, its answer ends with a chip such as **3 files +42
−7**. Open it to see each file the turn added (A), modified (M) or deleted (D),
with its diff. **Undo changes of this turn** puts every file back the way it was
when the turn started; the arrow on a row undoes only that file. Changes made by
commands count too, not only by the file tools: Maestrly snapshots the whole
folder when the turn starts and when it ends, whatever the model or runtime.

Nothing is written before you review it. The dialog lists what happens to each
file (restore, delete or recreate) and shows the diff from the file as it is now
to what it becomes. A file that changed after the turn, by you, by a later turn
or by another conversation working in the same folder, is a conflict: it stays
unselected, and selecting it turns the button into **Undo N files (overwrites N
changes)**. When another conversation worked in the folder during the turn, the
dialog says so and names it next to the files it may have changed. If a selected
file changes while the dialog is open, confirming checks the files again
instead of writing. Undo is unavailable while the conversation is running.

After an undo the chip reads **Changes undone** and the panel offers **Redo**,
which puts back what the undo replaced, including edits you had made after the
turn and chose to overwrite.

Snapshots need the `git` executable on the computer that runs the conversation,
but the folder does not have to be a Git repository, and the project's own Git
data is never written. What a snapshot leaves out:

- Files Git ignores (`.gitignore`, `.git/info/exclude` and your global excludes)
  and, in folders without Git, `node_modules`, `.venv`, `venv`, `__pycache__`
  and `.DS_Store`.
- The content of files larger than 10 MB. They are listed, but cannot be
  restored.
- Submodules and other repositories inside the folder, and empty folders.
- Changes you make yourself while the turn runs: they cannot be told apart from
  the agent's.

A turn whose start snapshot takes longer than 4 seconds, or whose folder has
more than 100,000 new files, runs without one; its chip reads **Undo
unavailable**, with the reason on hover. Bot conversations are not snapshotted.
Snapshots last 7 days; see [Local data](local-data.md#turn-snapshots) for where
they are kept and how to remove them. Turn them off, see their size and clear
them in **Settings → Chat**. Editing and resending a message removes the undo of
the turns it replaces.

## Stopping and queueing

While the agent works, the composer's main button stops it. Once you type or
attach something, the same button sends instead: the message waits in the queue
until the turn ends, or reaches the running turn where the agent accepts
messages mid-turn, as bots and active Maestro runs do. To stop the agent with
text in the composer, press Esc there. In a chat, stopping also discards the
queued messages.

Maestrly also stops a model that is stuck. When it keeps making the same tool
call without progress, the call is refused and then the turn ends. With an API
key, the turn also ends after three steps with only invalid tool calls, or when
the model starts repeating the same text. The response then says why it
stopped; send a message to continue. Subscription runtimes (Claude, Codex,
Copilot, Google AI, Cursor) run their own loop, so there Maestrly refuses the
remaining tool calls of the turn and asks the agent to stop and report. The
limits are in
[Harness profiles](harness-profiles.md#loops-and-repetition).

## Voice dictation

Click the microphone in a chat or bot composer to speak, or press ⌘D (Ctrl+D on
Windows and Linux) in the composer. With **Hold to record** on, hold the button
while you speak. Dictation always runs on this computer, where the microphone
is, whether the chat runs here, in a remote workspace, or on a bot.

**Settings › Maestrly Chat › Tools › Dictation** chooses the engine:

- **This computer (Whisper)**, the default: speech never leaves the computer.
  Maestrly transcribes it locally with whisper.cpp and the Whisper
  large-v3-turbo model, and a voice-activity check discards recordings with no
  speech, so silence or room noise never becomes a message.
- **OpenAI** (`gpt-4o-transcribe`) or **Groq** (`whisper-large-v3-turbo`): each
  recording goes to that provider with your API key and is billed to your
  account (about US$0.006 and US$0.0007 per minute). Enter the key in the same
  section; Maestrly checks it with the provider before keeping it in the system
  keyring, and never shows it again. These engines work on any system,
  including those where the local model does not run, need no download, and
  stop a recording by itself after 10 minutes. Silent recordings are not sent.
  When a transcription fails, the microphone offers **Try again**, which sends
  the same recording again.

With a bot server connected, the same section shows the server's dictation key,
which [phones](mobile.md) dictate through. **Use on my phone too** stores this
computer's engine and key on the server, and **Remove from server** deletes it.

While you record, the composer's action bar shows the elapsed time and the
microphone level, and you can keep editing the text. The recording ends one of
three ways:

- **↑** or Enter sends the text already in the composer followed by the
  transcription, together with its attachments. During a running turn it is
  queued or reaches the agent, like any message you send then.
- **Insert**, or ⌘D again, adds the transcription to the composer, for example
  to review it first. Releasing the button with **Hold to record** also inserts.
- **✕** or Esc discards the recording.

While the text is transcribed, ✕ cancels it. When the composer cannot send (no
provider, or a conversation managed by a bot), the transcription goes to the
composer.

Right-click the microphone, or use the options button while recording, to see
the engine in use, choose the microphone, turn **Hold to record** on or off,
and choose the dictation language: **App language** (the default) transcribes
in the language Maestrly is displayed in, which is the most accurate choice;
**Detect automatically** lets the model identify the language and takes about
twice as long.

With the local engine, the first click offers to download the voice model once
(547 MB), or to use an API key instead. Nothing is downloaded before you
confirm. The model appears as **Voice model** in **Settings › Maestrly Chat ›
Components**, where it can be removed; see
[Local data](local-data.md#voice-model). The local engine requires macOS 15 or
later on Apple silicon, where it uses the GPU, or Windows x64 or Linux x64
(glibc 2.34 or later), where it runs on the CPU and is slower. With an API
engine and no key yet, the microphone points to the dictation settings.

## Starting other conversations

A project conversation can start new Standard conversations that keep working on
their own. They appear in the sidebar and belong to you like any other
conversation; they are not subagents and they do not end with the current turn.

### From an approved plan

In the **Plan** tab, **Implement in new conversation** opens a dialog with the
model, effort, Fast mode and workspace for the new conversation. It starts from
the current conversation's settings and offers only the effort levels and Fast
mode the chosen model supports. For the workspace, **Same checkout** works on
this conversation's branch and files, including uncommitted changes. **New
worktree** creates a branch from the current commit and does not include
uncommitted changes.

Approving creates the conversation in Agent mode and sends it the final plan,
including your edits. The current conversation keeps its model and mode. If the
new conversation cannot be created, for example because the model is no longer
available, the plan stays pending so you can choose again. If it is created but
its first turn cannot start, it shows **Retry start** above the composer and
keeps the plan.

### By asking the agent

In an Agent, Design or Ask turn you can ask for new conversations in plain language,
for example:

- "Open one conversation for each of these cards and start development with
  Opus, high effort, Fast off."
- "Abra uma conversa para cada card e comece o desenvolvimento."
- "Send this plan to a new conversation."
- "Send another agent to review this."

Ask offers these handoff tools, and the project tools below, in turns you start;
a request that is not explicit still needs your confirmation. Your current
chat stays in Ask mode; the development conversation starts in Agent mode. File
editing and shell commands remain unavailable in the source Ask chat.

Ask in your own words; you do not need to rephrase. The agent judges from the
whole conversation whether you want work started elsewhere, and a message that
asks for it explicitly, such as “Send this plan for development in workspace
Example, on a new branch feat/example from main”, starts the conversations
directly. When your latest message does not ask for them in so many words, the
chat lists the conversations the agent wants to start and asks you to confirm
with **Start** or **Don't start**; nothing starts if you decline or dismiss the
question. Text the agent read in files, cards, web pages or tool output can never
answer for you. The agent should not start conversations when you only ask for
analysis or planning, ask whether it is possible, give an example or describe a
feature. If you say not to open conversations, none are started and you are not
asked. If you state a number ("open 3 conversations"), no more than that are
started for that message.

Model, effort and Fast mode follow what you said. The agent matches names such
as "Opus" against your connected providers and asks you to choose when the same
model is available from more than one account. Settings you do not mention come
from the current conversation when the chosen model supports them; otherwise the
provider default is used, and the result says so. A setting you asked for
explicitly is never replaced: if the model does not support it, nothing is
started and the agent explains why. Fast mode is a separate on/off setting and
never means low effort.

By default each task gets its own worktree and branch (`task/<title>-<id>`) from
the current commit; uncommitted changes are not included. You can ask for the
same checkout instead when staying in the source project without a target.

From standalone or project chats, you can choose a registered workspace. The
agent discovers workspace names, paths, default branches and available branches,
uses the canonical workspace ID, and asks when names are ambiguous. Standalone
chats require a workspace choice. Targeting a workspace, a new branch or a base
branch always creates a worktree; **Same checkout** is unavailable with a target.
An explicit target starts from its workspace's configured default branch unless
you choose a base such as `main`. The base is resolved and pinned in the target
repository: a local branch takes precedence, and qualified remote names such as
`origin/main` use the locally fetched remote reference. Dispatch does not fetch
remote updates. Ambiguous remote-only names require choosing a qualified name.
A project request without a target retains the current-commit behavior.
Only branch/base and model/effort/Fast settings you choose are passed explicitly.
Batch target fields apply to all tasks unless a task overrides them.

Each new conversation receives a self-contained task
from the agent, marked **Started from another conversation**, rather than a
copy of this transcript. The agent's reply lists each conversation with its
status and an **Open** link.

Repeating the same request does not create duplicates: the existing
conversations are reported again, and one whose first turn failed is retried.
A conversation you delete is not recreated. New conversations cannot start
further conversations on their own. They can do so later only if you ask for
it in that conversation. They can answer the conversation that started them,
as described in [talking to other conversations](#talking-to-other-conversations).

To have the result brought back, say so ("open another agent to review this and
bring me the result"). When the new conversation's first turn ends, its final
answer arrives in this conversation as a new message marked **Result from …**,
and the agent here continues with it.

### Creating or cloning the project first

The project you are discussing does not need to be registered yet. Ask for it
in your own words; the agent understands the request from the whole
conversation, so a short follow-up such as "cria lá pra mim" works too:

- "Clone acme/api from GitHub and start implementing the export endpoint."
- "Clona https://gitlab.example.com/team/tool.git e começa a corrigir o build."
- "Create a new project called Atlas with a repository on GitHub and start the MVP."
- "Pega algum repo público qualquer e cria lá pra mim."

The agent first looks for a registered workspace. When none matches, it can find
the repository with your signed-in GitHub CLI (`gh`), clone it, or create an
empty project with a README and an initial commit. The project goes into the
**Projects folder** set in **Settings › Execution**, is registered as a
workspace and appears in the sidebar; the agent then starts the conversation in
it as described above. The chat shows a card with the source, the folder, the
clone progress and a link to the workspace.

- Without a projects folder nothing is created, and the card offers **Set
  projects folder**. The folder is also the default parent in **Add project**.
- Any git URL you give is cloned with your own git credentials; URLs with
  embedded credentials are rejected. GitHub `owner/name` uses the protocol you
  configured in `gh`.
- A GitHub repository for a new project is created only when you ask for one.
  It is private unless you want it public; a public repository is created only
  after you confirm it in the chat, where you can also keep it private. An
  existing repository with the same name is never reused or overwritten. If it
  cannot be created, the local project stays registered and the card reports why.
- A folder that already exists is reused only when it is a clone of the same
  remote; anything else is left untouched and reported.
- Projects are created only in turns you start, never by subagents, bots,
  automations or because a file, card or web page says so. One message can create
  up to 10 projects. Repeating the request reports the registered project again
  instead of cloning twice.
- Starting work in a project created in the same turn needs no separate request
  for a conversation: one conversation can start in each new project. Other
  conversations follow the rules above, and "don't open conversations" is
  respected.

### Talking to other conversations

The agent can also read and message conversations that already exist, in any
project or standalone chat. Ask in your own words:

- "What did the review conversation conclude?"
- "Pede pra ela corrigir o item 2."
- "Tell the Atlas conversation that the API changed, and bring me its answer."

The agent finds conversations by name, reads their latest answer and recent
messages (tool activity is left out), and can wait for one to finish its current
turn. A message it sends starts a turn in the other conversation, shown as a
bubble marked **Message from …** with a link back. The receiving agent keeps its
own mode, permissions and model, so a message from an Ask chat cannot edit files
anywhere it could not already. A conversation that is busy receives the message
when its current turn ends; messages wait in order and are kept across restarts.

- **Confirmation.** The first message to a conversation that has no link with
  this one asks you to confirm with **Send** or **Don't send**. Conversations
  started from this one, the one that started it, and ones that already
  exchanged messages with it are linked and need no confirmation.
- **Bring the result back.** Only when you ask for it, the other conversation's
  final answer to the message comes back as a new turn here, marked **Result
  from …**. Otherwise the answer stays there and the agent can read it later.
- **Reports.** A conversation that was given work can report back to the
  conversation that gave it, marked **Report from …**, for example when the work
  is done or blocked.
- **Turns the agents start.** Turns started by another conversation can only
  read and message linked conversations, can never start new conversations or
  create projects, and stop after three agent-to-agent turns since you last typed
  a message. The agent then tells you instead of continuing.

These tools are available in Agent, Design and Ask modes. They are unavailable in
Plan and Maestro modes, bot conversations, Kanban web chats, automations and
subagents. Messages between conversations are stored in the local database and
removed by a local data reset. A result whose turn was interrupted because the
app closed is not delivered; ask again to continue.

### Limits

Up to 20 conversations can be started per request; ask again for more.
Starting conversations is available in Agent/Design mode in local standalone
and project chats. It is unavailable in Plan and Maestro modes,
bot conversations, archived
conversations, conversations with an unfinished migration and multi-repository
conversations, and the app gives the reason. Missing or unknown workspace IDs,
invalid or existing branch names, unresolved base branches, and targets combined
with **Same checkout** are reported as errors rather than silently choosing
another target.
Results identify the destination workspace and resolved base revision.
Card contents come from whatever the agent can
already read, such as a connected MCP server or text you paste; no Jira
integration is added. Nothing is pushed, opened as a pull request or merged
automatically.

The request history, including projects created from a chat, is stored in the
local database and is removed by a local data reset; the project folders
themselves stay on disk. Worktrees follow the usual conversation rules: deleting a
conversation removes the worktree and branch it created.

## Context meter

The context meter shows how much of the model's working context is occupied.
For Codex (including Astra) and Claude subscriptions, it updates as the runtime
reports new samples, grouping updates within one second. Google AI does the same
when its ACP server reports usage (server 1.3.0 and later). It does not count every
generated character, and the value can decrease after compaction.

Cursor reports only the tokens billed for each turn, summed over all of its model
calls, so its meter shows **context unknown**. Google AI shows the same when the
server has not reported usage for the current session. Maestrly does not display its
transcript estimate as the context size for these runtimes because that estimate
omits the runtime's own instructions and tools. Hover over the meter to see the
transcript size. Accumulated usage and cost are still shown when reported.

Hover over the meter to distinguish the last runtime measurement from the
estimate for the next request. Estimates have a `~` prefix. The next-request
estimate can differ when a native session cannot be resumed. Context occupancy
is separate from accumulated token usage and cost, including subagent work.

Compaction status appears beside the meter. Portable compaction shows the current
chunk or consolidation stage and any retry. Codex native compaction also reports
its lifecycle. After completion, the reduction is shown when a new context sample
or estimate is available. A failure shows its diagnostic and preserves the last
available context observation; it does not mean the context was reduced.

Portable summaries use a ten-minute deadline per stage, which only catches stalled
calls, with up to three retries for a stage timeout, empty summary, or transient
provider error. Completed stages are reused within that operation. The total time
budget scales with the number of chunks, up to one hour. Cancellation and
authentication/configuration failures do not trigger retries. The new summary
becomes a context boundary only after all stages finish successfully; original
messages remain in visible history.

Summaries follow a fixed structure: objective, requirements and constraints,
decisions, work state, pending user requests, next steps, relevant files, exact
identifiers, and errors and fixes. Headings stay in English, and the content uses
the conversation's language. Identifiers, paths, commands and error messages are
kept literally. Each compaction updates the previous summary instead of rewriting
it. Large histories are still summarized in chunks and then consolidated section
by section. The summary aims for about 20% of the summarized content, between
2,000 and 10,000 tokens (or 5% of the context window, whichever is smaller).
Maestrly checks the final summary for the required headings without another
model call. A summary that fails this check is requested once more with the
missing headings listed. If the second attempt also fails, the better attempt is
kept and the compaction still completes. Background preparation applies the same
check, and its extra attempt is billed like any other.

Compaction keeps the most recent messages verbatim after the summary. The tail
holds up to 20,000 estimated tokens, at most 12% of the context window, and is
reduced further so that the summary, the tail, the pending message and the
reserve fit in 70% of the window. The tail starts at a user message when the
latest turns fit; otherwise it starts at a step of the current turn. A step is
assistant text followed by its tool calls and their results, so a call is never
separated from its result. When the tail starts inside a turn, that turn's
request is copied verbatim (up to 4,000 characters) after the summary. The last
step always stays verbatim. When the last step alone is larger than twice the
budget, or the window leaves no room, the whole history is summarized as
before. The summary marker is placed where the tail begins, so the divider
appears there in the history. Native runtimes start a fresh session from the
summary and the tail. Compaction during a turn keeps its latest steps the same
way. Isolated review rounds and background preparation summarize their whole
source as before.

Plans submitted with `review_plan` are stored apart from the transcript, with
the person's decision on each: proposed, approved, revised, discarded, or
superseded by a newer version. Every summary ends with the conversation's
plans: an index of up to 10 plans with their ids, then the approved plan being
implemented, which is the latest plan when it was approved. That plan is kept
verbatim up to about 4,000 estimated tokens. A longer plan is reduced to its
headings and top-level items, and the agent is told to read it in full with
`plan_read` before continuing. When the message that approved the plan is still
in the tail, only the index is repeated. The summarizer never receives this
section, and background preparation leaves it out: it is added from the plan
store when the prepared summary is activated. Conversations from earlier
versions, or moved from another computer, rebuild their plans from the
transcript the first time they are needed. Deleting or clearing messages
removes the plans they held. Isolated review rounds still carry the approved
plan of their own history verbatim.

During a turn with an API key, outside the OpenAI harness, which compacts
natively, the summary is first requested by repeating the turn's last request
with the summary instructions appended. The system prompt, tools, provider
options, effort and cache breakpoints are the same, so the provider's prompt
cache covers the conversation. Tools are declared but cannot run, and no tool
choice is forced, because that would invalidate Anthropic's cache. That request
ends before the last step, which stays verbatim in the tail. It is used only
when the window still has room for at least 8,000 output tokens. If the model
calls a tool, runs out of tokens, or returns a summary that fails the structure
check, or the request fails, the summary is made in chunks as usual. Every
attempt is billed to the turn.

With an Anthropic API key, a conversation with a person keeps its prompt cache
for an hour between turns: the breakpoints on the first and the second-to-last
message last an hour, and the one on the newest message lasts five minutes.
Isolated review rounds, unattended executor runs and routines keep five
minutes, and so do subagents. One-shot requests, such as summaries and titles,
set no breakpoint, since they are never repeated.

Automatic compaction, before a message is sent or during a turn, does not stop
the conversation when the summary fails. When the summarizer reports that its
input is too large, the chunks are retried at 70%, 50% and 35% of their size.
For any other failure, the older messages are condensed without a model: the
latest requests verbatim, the previous summary, the files, tools and errors
involved, the approved plan and the to-do list, up to 12,000 characters. The
divider then warns that the summary is degraded. The originals remain in the
history and can be read with `history_search` and `history_read`. The next
compaction summarizes them again. If the result plus the pending message still
overflows, the tail is summarized as well, and only then is the request
refused. Manual compaction, cancellation, and a history that changed during the
compaction are never degraded: they fail as before, and nothing is committed.

Before summarizing ahead of a send, Maestrly first tries pruning older tool
outputs. Outputs of at least 1,000 characters are replaced by a one-line note
with the tool, its arguments, the status (with the first line of an error), and
the output's size. An output repeated later is reduced to a note, even when
shorter. The latest three user turns, unfinished tools, plans, to-do lists and
questions are never pruned. If this alone brings the next request to half the
context window, nothing is summarized. Only the model receives the note: the
history and `history_read` keep the full output. Native sessions start again
from the pruned history. When pruning is not enough, it is not kept, and the
summary goes ahead. The summarizer itself receives the start and end of older
outputs (about 1,200 characters), and an output repeated later only once.

Two automatic compactions in a row that free less than 10% of the context, or
leave it above the compaction threshold, suspend automatic compaction before
sending. It resumes once the context grows by 10% of the window, when it would
overflow, after a manual compaction, or with another model or window.
Compaction during a turn still guards against an overflow while it is
suspended.

These observations and progress states are saved with messages. Existing
conversations remain readable; older messages without observations use the
existing context estimate until the runtime reports a new sample.

When a provider change requires a fresh native session, Maestrly transfers the
available active conversation as text, including stored tool results and skill
instructions. It no longer cuts the middle of the transcript or caps each tool
result just to make the transfer smaller. Previous successful portable summaries
remain context boundaries; provider-private reasoning and session state cannot
be transferred between providers.

The next-request estimate covers this complete transfer. If it exceeds the
destination's admission budget, Maestrly first summarizes the history and checks
the result again. Codex also has a 1,048,576-character text-input limit, which
includes the imported history and pending message; exceeding that limit also
triggers compaction. A compaction that still does not fit blocks the request and
preserves the original history. A fresh Codex transfer is blocked if its context window is
unknown. Token estimates can differ from the provider's actual count.

### Context limit

Click the context meter to cap a model's context window below its real one, for
example 300k on a 1M model, to bound what each turn sends and costs. Enter a
value such as `300k`, `1M` or a plain number; **No limit** removes it. The limit
belongs to that model on that provider account and applies to every
conversation that uses them. A value above the model's real window is clamped to
it. The meter then shows the capped window with a lock, and Maestrly compacts
the conversation at the limit before a turn. API providers and the Codex,
Claude, GitHub Copilot and Grok subscriptions also compact during a turn that
reaches it; Codex additionally sends the limit to its runtime when the model
allows a configurable window. Cursor and Google AI run each turn on their own,
so the limit compacts their conversations only between turns, and a long turn
can go past it; the limit popover says so.

### Model fallback

When a model reaches its usage limit, loses its login, is unavailable or runs
out of context, a conversation can continue the same turn on another model of
an ordered list, including API-key providers. The failed response keeps its
partial output and the next turn starts on the conversation's own model again.
A destination with a smaller window compacts the conversation first. See
[Model fallback](model-failover.md).

## Background preparation

Background compaction is optional and starts disabled. In Settings → Maestrly
Chat, choose a provider/account and model for preparation, its supported effort
and Fast options, and the preparation interval (100,000 new estimated tokens by
default). The selected model receives the conversation content to summarize.
Preparation uses separate model calls and consumes that model's tokens or quota.

The interval counts new portable conversation content, including tool results,
text attachments and skill instructions, rather than cumulative billed input.
For a known conversation window, the effective interval is capped at half that
window. A summarizer with a smaller window processes the content in smaller
chunks. Preparation can run after completed steps during a long task as well as
after a response; it does not change the active context or pause the conversation.

A prepared summary covers an exact point in the history. When the next request
or a host-controlled continuation needs compaction, Maestrly checks whether that
summary **plus all subsequent content** brings the next request to half the
destination model's window. If it does, the summary is activated without another
summarization call. Otherwise, as when a long task has outgrown the preparation,
normal compaction runs: it starts from the prepared summary, summarizes only the
newer content, and keeps the usual verbatim tail. Selecting a model alone does
not activate it. Cursor can prepare during a task and uses prepared
context on a later send; provider-managed native compaction remains independent.

Only the latest ready preparation and its replacement in progress are kept.
After activation, the consumed preparation is removed, and later preparation
builds on the active summary and new content. Earlier versions are not appended
indefinitely. Original messages remain in visible history. Preparation usage is
recorded separately and is not charged again when its summary is activated.

Preparation failures appear beside the context indicator, with retry and settings
actions, without turning the conversation into an error or blocking a send.
Authentication/configuration errors pause preparation; transient failures have a
bounded retry. After an empty or oversized summary, retrying starts the round
over instead of resuming it from its completed stages. Preparation asks for a
summary of at most half its 8,000-token limit, since the limit is measured with
a conservative estimate. A ready, still-valid summary can survive a later
preparation failure. If no usable summary is available when context must be reduced, normal
foreground compaction still runs and may require waiting. The configured helper
model applies to background preparation; manual and fallback compaction retain
their existing behavior.

Turning preparation off cancels pending work and clears unused preparations,
while preserving already active context. Stopping a conversation cancels its
current preparation but preserves the latest ready candidate. Edits invalidate
summaries covering changed content. Restarting preserves valid completed work;
preparation resumes only when a conversation is used, rather than scanning and
processing every old chat.

## Maestrly tool groups

Maestrly tools are enabled by default. Existing explicit global or conversation
choices remain unchanged. **Settings → Chat → Tools** keeps the master switch
and lets you enable or disable Terminal, Browser, Notes, Memory, Conversation
history, Debugger and Artifacts separately. Expand **Maestrly tools** in
the conversation's **+** menu to change its groups. Changing one group pins only
that group's choice; the others continue to inherit the global settings.

A disabled group removes its tools from the next turn's catalog, including
delegated workers. Conversation history also covers `plan_read`. The existing mode limits and permission rules still apply.
Bots keep their Maestrly tools enabled and ignore these group choices.

The Memory group controls memory tools, including personal memory tools. Memory
recall and automatic extraction have their own settings under **Models & agents**;
turn off personal memory there to also disable context injection and background
writes.

Tools of external MCP servers are not sent with every request, on any model. The
agent knows they exist and loads a tool's description when it needs that tool, so
a server with hundreds of tools does not fill the context. On the Claude, Codex
and GitHub Copilot subscriptions the runtime does this; on every other model
`mcp_search` lists the tool names, finds tools by keyword and returns their
schemas, and `mcp_call` runs them. Maestrly's terminal, browser, notes, Debugger
and Artifacts tools are loaded the same way on those subscriptions, on the OpenAI
Responses models that support it and on Google Antigravity; other models still
receive them with every request, so turn off the groups you do not use. The tools
to save, search and read memory and conversation history stay loaded.

## Skill catalog

Every turn lists the enabled skills by name and description, and the agent loads
one with `use_skill` (or you with `/name`). The catalog keeps its order, so the
prompt prefix stays cacheable, and fits in 8,000 characters: each description is
cut at a word to 240 characters, and at most 80 skills show one. With more than
fits, the skills loaded least often show only their name, and when even the names
do not fit, the last line counts the rest. Loads are counted per profile
(`chat.skills.usage.v1`), or by each fleet bot for itself; a bot's own skills show
as `name (yours)`.

When a portable compaction summarizes skills loaded since the previous one, the
summary ends with a `<loaded_skills>` block that names them (up to ten) and asks
the agent to load them again with `use_skill` before relying on them, since their
instructions left the context with the summarized messages. A skill named by the
previous summary and not loaded again is named once more, then dropped. Native
compaction of a provider's own session keeps what that provider keeps.

## Memory core and catalog

Project conversations with memory enabled share their workspace's durable memory;
ordinary standalone chats share personal memory in the local app profile. Fleet bots have their own space (see
[bot memory](bot-fleet.md#bot-memory)). The host includes a memory core in the
model's context: pinned content and a catalog of other active memories by title.
The project **Memory Center** shows an **Automatic** source for extracted entries
and a hint explaining pinned context.

The pinned section has a 3,000-character budget, with content excerpts of up to
700 characters per entry; entries that do not fit are omitted. Catalog entries
have a 1,600-character budget, at most 40 entries and 90-character titles, ordered
by importance, use count and last update. The agent can use `memory_read` to read
an entry in full. Project and bot cores stay stable until portable compaction;
changes to included pinned content arrive as an update on the next turn. Updates
over 1,500 characters rebuild those cores. Native compaction alone does not
rebuild them. Personal cores refresh on each admitted turn so changes made by
other chats reach the bounded catalog immediately.

## Personal memory in Chats

**Settings → Chat → Models & agents → Personal memory → Manage personal memory**
opens the personal memory panel; selecting an entry in a message's memory
indicator opens the panel at that entry. The panel manages facts and preferences
that should be useful across your conversations: language, response style,
interests and recurring habits. Every ordinary chat in the same local profile uses this collection,
including chats with different native providers. Projects, bot-originated chats
and fleet bots keep their existing memory scopes. Personal memory does not sync
between devices or with the fleet gateway.

Chats on a [server's workspaces environment](remote-workspaces.md) use the
personal memory of the server's profile, apart from this computer's. When a
server runs chats, the panel has a **Memories of** selector to show either one;
**Manage personal memory** in settings opens the panel on the profile chosen in
**Settings of**, and a memory indicator opens it on the memory of the
conversation's host. Every computer paired with the server sees the same server
memory.

Create or edit an entry in the central view, or ask an assistant in Agent or
Design mode to save it. Personal memory tools remain available when the general
app-tools switch is off, unless the Memory group is also disabled. Ask and Plan
can read memories; writes retain the conversation's
permission rules. Sharing memories does not share permission approvals or other
chats' transcripts. Prefer replacing an outdated entry over saving contradictory
facts. The central view supports pinning, archiving, restoring, permanent deletion
with confirmation, and JSON/Markdown export.

The personal memory panel opens a readable detail sheet before editing. Search
and the All, Recent and Archived tabs keep the collection in one list; type,
status and pinned filters can be combined. Type, scope and tags are under a
collapsible section in the editor. Closing an edited draft asks before discarding
it, and failed saves leave the draft available. Updates from other chats preserve
fields you are editing; saving changes only the fields you touched.

Use **Settings** in the panel for personal access, recall and the extraction
model. **More options** contains separate JSON and Markdown exports and index
rebuilding. The existing project memory settings and panel remain independent.

Pinned entries enter the context; other entries appear in the bounded catalog
and can be recalled by relevance. On the next admitted turn, personal catalog
changes and corrections or removals of previously recalled entries reach other
open chats. Deleting the originating chat or a project does not delete personal
memories. Removing a memory stops future retrieval and tells chats that already
received it to stop relying on it; it does not erase historical messages or
information already sent to a provider.

Personal memory also tracks entries returned by its read, list and search tools.
If corrections exceed the update budget, a short notice invalidates all earlier
personal evidence: the rebuilt core is current, and other facts must be read
again. Assistants cannot read archived or superseded personal content; the
central view retains that history for your review and restoration.

Personal memory has separate settings from project memory. Access and automatic
recall start enabled; background saving starts disabled and requires its own
model selection. Turning off recall leaves the core and tools available.
Turning off personal memory stops new assistant reads, writes, context injection
and background extraction, while manual management remains available. Invalid
or unreadable personal settings disable assistant access until corrected.

## Automatic recall

In the desktop app, **Settings → Chat → Memory → Recall relevant memories automatically**
starts enabled. Each eligible message can recall up to three relevant memories,
with snippets of up to 400 characters and a relevance floor of 0.6. Recall uses
the first 1,000 characters of the message and excludes entries already in the
pinned core or recently recalled since compaction (up to 200 remembered IDs).
The whole recall block is capped at 1,400 characters; a hit that does not fit is
left for a later message. Short messages and slash commands do not trigger
recall. A **🧠 N memories recalled** chip under the user message opens the
recalled sources.

Turn-memory preparation has a 1,500 ms budget, including at most 800 ms for vector
retrieval. Text search remains available without vectors. A slow recall or
unavailable host memory provider skips that piece while preserving the memory
core. Unreadable project-memory settings fall back to the defaults: recall on,
automatic saving off. Personal settings fail closed as described above. Memory
failures do not prevent sending a message.

Recall and the read-only `memory_search`, `memory_list`, `memory_read`,
`history_search`, `history_read` and `plan_read` tools never prompt for
approval. Disabling
automatic recall leaves the core and manual tools available. `memory_search`
returns five hits by default, at most ten, with 300-character snippets and a
relevance floor of 0.34. Memory is presented as evidence to check before use.

## Conversation history tools

The agent can use `history_search` and `history_read` in any conversation,
including standalone chats, to revisit persisted messages, including turns
already compacted away. Both omit hidden memory blocks, internal prompts other
than the approved plan, and messages of isolated executions such as review
loops.

**Search** returns eight results by default and at most 30, each with its
position (`seq`), role, time and a 240-character snippet. It has three modes:

- **Relevance (the default).** It ranks messages by how much of the query they
  cover, weighting rare words more, with full-text rank and a small recency
  bonus (30-day half-life) breaking ties. Words match by stem regardless of
  case and accents. `"Quoted phrases"` stay together. Parts of words and
  Chinese, Japanese or Korean text are found through trigram and two-character
  indexes. Tool names, inputs (up to 500 characters) and outputs (up to 2,000
  characters, 8,000 per message) are searchable too, except those of the
  history and memory tools. A message repeated word for word appears once, the
  newest copy; of two neighbouring hits only the better one is kept, since
  reading one shows the other. Each result carries a score from 0 to 1.
- **Exact (`mode: "exact"`).** Every word of two or more characters must appear
  in the visible text; newest matches first, as search worked before relevance
  ranking.
- **Browse (no query).** It lists what the person asked and the compaction
  summaries, newest first, with 160-character snippets.

`beforeSeq` pages browse and exact results.

When the optional local ML component is already installed, relevance search
also compares meanings: it embeds the query and short passages of up to 40
candidates with the local embedding model within 800 ms. Recent compaction
summaries can then match on meaning alone, above a 0.34 relevance floor.
Messages are never embedded ahead of time; without the component, or past the
budget, text relevance applies. Search never installs the component.

In a project conversation, `scope: "workspace"` searches the other project
conversations of the same workspace as well: the 200 most recently active,
archived ones included and bot conversations excluded. Results then name their
conversation, at most three per conversation. Without a query it lists those
conversations with the last thing the person asked in each. Standalone chats,
bot conversations, delegated workers and bots running on a bot server can only
search their own history.

**Read** returns a window of three messages on either side by default, at most
ten on either side, with tool output shortened to 600 characters (8,000 with
`detail: "full"`) and total output capped at 12,000 characters. The requested
message is always included (shortened if needed), followed by the nearest
neighbours that fit. `conversationId` reads a conversation that a workspace
search could reach. Read always shows the messages as saved, whatever
compaction removed from the model's context.

Search uses a local index, kept up to date in the background and before each
search (see [Local data](local-data.md#conversation-history-index)). If a
conversation cannot be indexed within 250 ms, as can happen on the first search
of a long conversation after an upgrade, search falls back to scanning up to
20,000 recent messages for every word and reports `"index": "building"`; a
workspace search then covers what is already indexed. A SQLite build without FTS5 trigram
support always uses that scan.

## Automatic memory saving

In **Settings → Chat → Memory**, enable **Save memories from conversations** and
choose a **Memory model**. Saving starts disabled and needs a selected model.
Background extraction sends condensed conversation content and existing memory
to that model; extraction and consolidation consume its quota and record usage.
Bots use their configured compaction model instead.

Personal memory uses its own background-saving switch and model. Enabling
project extraction does not enable personal extraction. Personal extraction
accepts entries only with a reference to a user message in the processed local
transcript and focuses on durable facts or preferences about the user. Assistant
claims, tool output and task-specific details are not sources of personal facts.
This provenance check and model guidance do not prove the truth of an entry;
review saved memories in the central view. Disabling personal access or saving
cancels pending work and discards late model responses. Concurrent extractions
do not replace targets changed since the extraction began.

Extraction waits three minutes after the latest completed turn, with a maximum
wait of 30 minutes from the first pending trigger. It reads messages after the
saved cursor, in bounded pages, and needs at least 1,200 new characters. The first
run in a conversation starts from its most recent 96,000 characters of condensed
history; older history is not mined. Each run processes at most six chunks with a
48,000-character text budget per chunk and up to eight memory operations per
chunk; a longer message keeps its beginning and end. The tool calls of one message
share a 12,000-character budget: each call shows up to 1,500 characters of its input
and of its output, and never less than 200 of input and 300 of output; a failed
call shows up to 600 characters of its error. The extractor sees existing memories
as whole entries with 400-character excerpts, up to 20,000 characters. Extracted
titles are limited to 120 characters and content to 1,500, or 3,000 for a
procedure, which is written as ordered steps with the exact commands and values.
Image contents, skill bodies (calls that load or edit a skill show only the skill
and file name), compaction summaries and hidden memory blocks are excluded. New
entries have the **Automatic** source and are not pinned. In a fleet bot's space, the
same call also sees the bot's own skills (up to 3,000 characters) and may suggest up
to two [skills](bot-fleet.md#bot-skills) per run for procedures the bot worked out:
a new skill, or a note for one of its own. Each suggestion waits as a proposal from
memory review and never takes effect by itself. An answer that is not
readable JSON is retried once, then that chunk is skipped. Failed extraction
retries on later triggers, backing off for an hour after three failures; it does
not block turns or compaction.

Memories the agent saves with `memory_upsert` start with importance 60, or 70 for a
procedure, unless it sets one; automatic entries start at 0. The memory catalog
lists entries by importance first, so what was saved on purpose stays in view.

After at least 15 new automatic memories, consolidation can merge overlapping
active, unpinned **automatic** entries. Procedures and entries saved by you or by
the agent are never merged. It runs at most once per 24 hours after a recorded run,
with only one consolidation running per space and up to ten merges. It sends the
full content of up to 150 entries within 48,000 characters, one JSON object per
entry so line breaks survive, and marks which entries are new since the last run.
Every merge must include a new entry, so the entries a run merged are merged again
only with something new; with nothing new, no model call is made. A merge keeps at
least 80% of the length of its longest original, up to 3,000 characters, and the
merged entry keeps the highest importance, all tags, the shared scope and the
origin of its originals. It merges only entries it was shown, and skips a merge
when one of them changed during the call. Each merge is applied atomically. Merged
entries are superseded rather than deleted, so they can be restored in the Memory
Center.
