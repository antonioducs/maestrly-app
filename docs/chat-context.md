# Context usage and compaction

## Chats and projects

Use **Chats → New chat** for a general conversation, explanations, or work with
attachments. A project is not required. Projects keep their existing repository,
branch and worktree workflows; standalone chats do not join a project or inherit
its instructions, memory, Kanban links or saved permissions.

New standalone chats start in Standard with Ask mode and Ask permissions. Saved
“always allow” decisions belong to that chat alone. Agent, Plan and Design can
use their usual generic capabilities under the selected permission policy.
Maestro, Git review, branch operations and project-memory tools require a project.
Browser, MCPs and other optional tools retain their existing enablement settings.
Online research requires an available search tool; `webfetch` reads a supplied
URL and does not provide a general search engine.

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

## Task lists

The task card shows valid entries from the agent's latest task list. Malformed
or incomplete task data is omitted instead of interrupting the chat interface;
valid entries appear when the agent supplies them. This also applies when
reopening saved conversations and does not change the stored tool input.

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

## Voice dictation

Click the microphone in a chat or bot composer to speak, and click it again to
stop; with **Hold to record** on, hold the button while you speak. Speech never
leaves the computer: Maestrly transcribes it locally with whisper.cpp and the
Whisper large-v3-turbo model, and a voice-activity check discards recordings with
no speech, so silence or room noise never becomes a message.

With **Send automatically** on (the default), the transcription is sent as your
message, after any text already in the composer and together with its
attachments. During a running turn it is queued or steers the agent, exactly
like pressing Enter. Turn the switch off in the microphone menu to place the text
in the composer instead, for example to review it first. When the composer cannot
send (no provider, or a conversation managed by a bot), the text always goes to
the composer.

The microphone menu also chooses the dictation language: **App language** (the
default) transcribes in the language Maestrly is displayed in, which is the most
accurate choice; **Detect automatically** lets the model identify the language
and takes about twice as long.

The first click offers to download the voice model once (547 MB). Nothing is
downloaded before you confirm. The model appears as **Voice model** in
**Settings › Maestrly Chat › Components**, where it can be removed; see
[Local data](local-data.md#voice-model). Dictation requires macOS 15 or later on
Apple silicon, where it uses the GPU, or Windows x64 or Linux x64 (glibc 2.34 or
later), where it runs on the CPU and is slower.

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

Ask exposes these handoff tools only when your message explicitly asks to start
conversations or send work to a project. Your current chat stays in Ask mode;
the development conversation starts in Agent mode. File editing and shell
commands remain unavailable in the source Ask chat.

The agent starts conversations only when your latest message explicitly asks for
them, including an explicit handoff such as “Send this plan for development in
workspace Example, on a new branch feat/example from main.” It does not start
them when you ask for analysis or planning, ask whether
it is possible, give an example, describe a feature, or quote text, code or card
content. If you state a number ("open 3 conversations"), no more than that are
started for that message. When the request is not explicit, the agent tells you
why and does nothing.

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
it in that conversation.

### Limits

Up to 20 conversations can be started per request; ask again for more.
Starting conversations is available in Agent/Design mode in local standalone
and project chats. It is unavailable in Plan and Maestro modes,
bot conversations, Kanban web chats, archived
conversations, conversations with an unfinished migration and multi-repository
conversations, and the app gives the reason. A review loop blocks only the
**Same checkout** option. Missing or unknown workspace IDs, invalid or existing
branch names, unresolved base branches, and targets combined with **Same
checkout** are reported as errors rather than silently choosing another target.
Results identify the destination workspace and resolved base revision.
Card contents come from whatever the agent can
already read, such as a connected MCP server or text you paste; no Jira
integration is added. Nothing is pushed, opened as a pull request or merged
automatically.

The request history is stored in the local database and is removed by a local
data reset. Worktrees follow the usual conversation rules: deleting a
conversation removes the worktree and branch it created.

## Context meter

The context meter shows how much of the model's working context is occupied.
For Codex (including Astra) and Claude subscriptions, it updates as the runtime
reports new samples, grouping updates within one second. It does not count every
generated character, and the value can decrease after compaction.

Hover over the meter to distinguish the last runtime measurement from the
estimate for the next request. Estimates have a `~` prefix. The next-request
estimate can differ when a native session cannot be resumed. Context occupancy
is separate from accumulated token usage and cost, including subagent work.

Compaction status appears beside the meter. Portable compaction shows the current
chunk or consolidation stage and any retry. Codex native compaction also reports
its lifecycle. After completion, the reduction is shown when a new context sample
or estimate is available. A failure shows its diagnostic and preserves the last
available context observation; it does not mean the context was reduced.

Portable summaries use a three-minute deadline per stage, with one retry for a
stage timeout, empty summary, or transient provider error. Completed stages are
reused within that operation. The total time budget scales with the number of
chunks, up to one hour. Cancellation and authentication/configuration failures
do not trigger retries. The new summary becomes a context boundary only after
all stages finish successfully; original messages remain in visible history.

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
triggers compaction. A failed compaction blocks the request and preserves the
original history. A fresh Codex transfer is blocked if its context window is
unknown. Token estimates can differ from the provider's actual count.

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
summary **plus all subsequent content** fits the destination model. If it does,
the summary is activated without another summarization call. Selecting a model
alone does not activate it. Cursor can prepare during a task and uses prepared
context on a later send; provider-managed native compaction remains independent.

Only the latest ready preparation and its replacement in progress are kept.
After activation, the consumed preparation is removed, and later preparation
builds on the active summary and new content. Earlier versions are not appended
indefinitely. Original messages remain in visible history. Preparation usage is
recorded separately and is not charged again when its summary is activated.

Preparation failures appear beside the context indicator, with retry and settings
actions, without turning the conversation into an error or blocking a send.
Authentication/configuration errors pause preparation; transient failures have a
bounded retry. A ready, still-valid summary can survive a later preparation
failure. If no usable summary is available when context must be reduced, normal
foreground compaction still runs and may require waiting. The configured helper
model applies to background preparation; manual and fallback compaction retain
their existing behavior.

Turning preparation off cancels pending work and clears unused preparations,
while preserving already active context. Stopping a conversation cancels its
current preparation but preserves the latest ready candidate. Edits invalidate
summaries covering changed content. Restarting preserves valid completed work;
preparation resumes only when a conversation is used, rather than scanning and
processing every old chat.

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

Create or edit an entry in the central view, or ask an assistant in Agent or
Design mode to save it. Memory tools remain available when general app tools are
disabled. Ask and Plan can read memories; writes retain the conversation's
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

ChatGPT Web/Companion requires its own **Personal memory** permission: Off,
Read, or Write. It defaults to Off; project-memory permission does not grant
personal access. Read permits retrieval, and Write additionally permits changes
subject to the session's mode and permission policy. Changing or revoking the
capability invalidates the corresponding session access.

Companion background saving additionally requires Write and Agent/Design mode.
It processes only user messages already persisted in the local conversation;
it does not scrape the browser's ChatGPT history. Ending the session or revoking
access cancels pending extraction and discards late results.

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
`history_search` and `history_read` tools never prompt for approval. Disabling
automatic recall leaves the core and manual tools available. `memory_search`
returns five hits by default, at most ten, with 300-character snippets and a
relevance floor of 0.34. Memory is presented as evidence to check before use.

## Conversation history tools

The agent can use `history_search` and `history_read` in any conversation,
including standalone chats, to revisit persisted messages before compaction.
They read only the calling conversation and omit hidden memory blocks.
Search returns newest matches first, eight by default and at most 30, with
240-character snippets. It scans at most 20,000 recent messages.
Read returns a window of three messages on either side by default, at most ten
on either side, with tool output shortened to 600 characters and total output
capped at 12,000 characters. The requested message is always included (shortened
if needed), followed by the nearest neighbours that fit.

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
chunk; a longer message keeps its beginning and end. Extracted titles are limited
to 120 characters and content to 1,500. Image contents, skill bodies, compaction
summaries and hidden memory blocks are excluded. New entries have the **Automatic**
source and are not pinned. An answer that is not readable JSON is retried once,
then that chunk is skipped. Failed extraction retries on later triggers, backing
off for an hour after three failures; it does not block turns or compaction.

After at least 15 new automatic memories, consolidation can merge overlapping
active, unpinned entries. It runs at most once per 24 hours after a recorded run,
with only one consolidation running per space and up to ten merges. It sends the
full content of up to 150 entries within 48,000 characters, merges only entries it
was shown, and skips a merge when one of them changed during the call. Each merge
is applied atomically. Merged entries are superseded rather than deleted, so they
can be restored in the Memory Center.
