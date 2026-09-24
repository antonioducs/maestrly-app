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
attachments and is removed with its message. The context meter counts at least
2,000 tokens per page, because native documents cost far more than their text.

Click a PDF in a sent message to open it in the system's default PDF viewer. The
viewer receives a read-only copy named after the attachment, kept in the
application profile until its message or conversation is deleted or Maestrly
restarts; changes saved from the viewer never alter the attachment.

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

In an Agent or Design turn you can ask for new conversations in plain language,
for example:

- "Open one conversation for each of these cards and start development with
  Opus, high effort, Fast off."
- "Abra uma conversa para cada card e comece o desenvolvimento."
- "Send this plan to a new conversation."

The agent starts conversations only when your latest message explicitly asks for
them. It does not start them when you ask for analysis or planning, ask whether
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
same checkout instead. Each new conversation receives a self-contained task
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
Starting conversations requires a local project conversation. It is unavailable
in standalone chats, bot conversations, Kanban web chats, archived
conversations, conversations with an unfinished migration and multi-repository
conversations, and the app gives the reason. A review loop blocks only the
**Same checkout** option. Card contents come from whatever the agent can
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
