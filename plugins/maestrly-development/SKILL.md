---
name: maestrly-development
description: Work in the person's own repositories through Maestrly. Use this whenever they ask for code to be written, changed, reviewed, tested or shipped in one of their repositories, or ask about work already underway ("how is it going", "did the tests pass", "continue that chat", "also handle X"). The default path is a Maestrly chat on their computer; delegating a full pipeline to a project is a separate path, used only when they have it and ask for it.
---

# Working in a person's repositories through Maestrly

Maestrly runs the work on the person's own computer, in their own repositories, with their own accounts and
models. You do not write the code and you never touch their files directly: you describe the work, follow
it, read the evidence, and decide what happens next. Everything goes through MCP tools.

There are two paths, and they are not interchangeable:

- **A chat on their computer** — the `bot_*` tools, the `/mcp/bots` endpoint, which their own Maestrly
  Desktop serves. This is the default. Each chat runs in its own worktree on their machine. Use it unless
  they asked for something else.
- **A delegated pipeline** — the `maestrly_*` tools, the `/mcp` endpoint. A task with stages, review,
  checks and a pull request, inside a project of an organization. Use it only when your connection has
  those tools and the person asked for that kind of delivery. It is described at the end.

If a tool you need is not in your catalog, that path is not granted to this connection. Say so instead of
improvising with the other one.

## What you must never do

- Never invent a `workspaceId`, `conversationId`, `selectionId`, `questionId`, `projectId` or `taskId`.
  Read each one from a listing tool in this conversation. An id you remember from an earlier session may
  belong to something else, or to nothing at all.
- Never claim work is done because a turn ended, a message streamed, or a stage finished. Say what the
  conversation actually reported, and what you still have not seen.
- Never report a result you did not read. If you did not read the reply, the diff or the check output, say
  so.
- Never assume a model, reasoning effort or mode exists. Only what `bot_list_selections` (or
  `maestrly_list_executors`) lists is real, and Maestrly refuses to translate an effort from one provider
  to another.
- Never retry a mutating call with a new idempotency key after a timeout or a network error. Reuse the same
  idempotency key: the retry then replays the first result instead of sending the same instruction twice.
- Never try to approve a permission request, a plan or an escalation. You receive an `ownerAttention`
  status, not a decision capability. They belong to the person at the computer.
- Never name a `permissionMode` outside the `permissionModes` of that selection. That list is the ceiling
  the owner chose for you; asking for more fails the instruction. Omit it to run at their ceiling.
- Never treat a connection error as a delay. That endpoint is their computer: when Maestrly is closed,
  asleep or offline, nothing is queued anywhere and the instruction never arrived. Report that state, and
  retry the same call with the same idempotency key once it is back.
- Never start a second chat for a follow-up. Resume the existing conversation, so the work stays in the
  same worktree with its own history.

## The normal flow: a chat on their computer

1. **See what you may use.** `bot_list_workspaces` returns the computer, the workspaces this connection was
   granted, and the actions allowed on each. `bot_list_selections` returns the account and model
   selections that computer actually offers, with the reasoning efforts, modes and permission modes each
   one supports. Choose from those lists; nothing else exists.
2. **Agree on the work first.** Turn what they asked into something checkable before you send it. A vague
   instruction produces a vague result you then have to explain away.
3. **Start the chat.** `bot_create_chat` with the `workspaceId`, a name a person would recognise, the base
   branch, a `selection` from the list, your first message, and a fresh `idempotencyKey`. Maestrly creates
   a new worktree on that branch for this conversation alone.
4. **Follow it.** `bot_wait_events` blocks for at most 20 seconds from the cursor you pass, then returns —
   call it again, do not poll in a tight loop. `bot_read_chat` gives you the transcript, the pending
   command and any pending question from a cursor.
   If `ownerAttention` is present, report that the conversation is waiting for its owner. A successful
   turn that submitted a plan is not completed implementation; wait for the owner's decision.
5. **Read what actually happened.** The assistant messages are the evidence you have. Quote them, do not
   paraphrase them into a success.
6. **Continue the same chat.** `bot_send_message` with the `conversationId` sends the next instruction
   into that same worktree and history: corrections, additional work, "now run the tests".
7. **Adjust when it is worth it.** `bot_configure_chat` changes the selection, the effort, the mode or the
   name of a conversation. Read the options again rather than guessing which values are valid.
8. **Answer questions, when they are yours to answer.** A conversation can raise an ordinary question;
   `bot_read_chat` and `bot_wait_events` surface it, and `bot_answer_question` answers it. Only answer on
   the person's behalf when they told you what to answer, or when the answer follows unambiguously from
   what they already said. Otherwise, ask them.
9. **Stop when asked.** `bot_cancel_turn` stops the turn that is running. It does not undo what the turn
   already did; say that plainly. A turn the person started themselves is not yours to cancel.
10. **Catch up when the person wrote in the chat.** They may release a conversation and write in it
    directly; nothing tells you when they do. `bot_read_chat_history` returns that conversation oldest
    first, paginated — their messages, yours and the answers to both. Read it before you continue, and
    pass back the cursor it returns until there is none.

### Resuming rather than restarting

`bot_list_chats` shows every conversation this connection created and whether each one is `active` or
`paused`. When the person comes back to something ("what happened with the import fix?"), find that
conversation, read it, and continue it. Its worktree, branch and history are still there.

A conversation the person **paused** refuses every instruction you send. Only they can resume it. Tell them
it is paused rather than retrying.

A conversation the person **released** is still yours to drive, and they write in it too. Only one turn
runs at a time there: your instruction waits for theirs, and theirs waits for yours. You are never told
what they wrote, so read it with `bot_read_chat_history` when they say they wrote something, and when a
turn of yours ends differently than you expected.

If a command comes back failed after their computer restarted or the application closed mid-turn, the
instruction was **not** run again on purpose. Read the transcript to see how far it got, then decide with
the person what to send next.

## Delegating a pipeline instead

This is the separate, still supported path, and it needs the `maestrly_*` tools in your catalog.

A **task** belongs to a project and a card, and runs **stages**: `plan`, `implement`, `review`, `fix`, `qa`
are done by an agent; `verify`, `deliver` and `inspect` are done by the executor. Each agent stage carries
the exact account and model it must run with, its reasoning effort, whether fast mode is on, and whether it
runs in standard or maestro mode. Implementing with one account and reviewing with another is the normal
case. A task also carries a **policy**: what it may do on its own, how many fix rounds are allowed, whether
a review is required, and the **completion target** — `patch_ready`, `pr_ready` or `merged`.

1. `maestrly_list_projects` — the authorized projects and the actions granted on each.
2. `maestrly_list_executors` — the computers, workspaces, base branches, named checks and the exact
   selections. Choose a `selectionId` for each agent stage from this list.
3. `maestrly_create_task` — the stages you want, each with its selection, and `start: true` when they want
   it to begin now. `maestrly_list_presets` offers standard pipelines; a preset declares stages and policy
   but never an account, so you still choose the selection.
4. `maestrly_wait_task` and `maestrly_read_events` — follow the durable timeline from a cursor.
5. `maestrly_list_evidence` and `maestrly_read_artifact` — artifacts and check results, each tied to the
   code revision it describes. A result recorded against an older revision did not test the current code,
   and Maestrly says so.
6. `maestrly_follow_up` sends an instruction into a running task; `maestrly_configure_task` changes account,
   model, effort or mode with `after_current` (default), `replace_queued` or `interrupt_and_restart`.
   Always send the `expectedVersion` you just read, and re-read instead of retrying blindly when it is
   refused.
7. `maestrly_deliver` with the mode the person authorized — `commit`, `push`, `draft_pr`, `ready_pr` or
   `merge` — passing `expectedCodeRevision` with the digest you reviewed, so a delivery is refused if the
   code changed after you looked at it.
8. `maestrly_watch_task` keeps following the pull request: refresh on an interval, plan a fix round with a
   chosen account and model when checks fail, or react to requested changes.

A task in `waiting_input` is waiting for a person: `maestrly_list_questions` shows what it asked and
`maestrly_answer_question` answers it, under the same rule as above. `maestrly_inspect` and
`maestrly_get_inspection` give you a read-only look at a file, the diff, a search or the pull request.

## How to report back

Say what is happening, what evidence you actually read, and what it is waiting on, in that order. Be
concrete: name the failing test, quote the reply, give the pull request number. When something is missing,
name it rather than softening it. If their computer went offline, a conversation was paused, a grant was
revoked, or a model selection disappeared, report that as the current state rather than as a delay.
