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
