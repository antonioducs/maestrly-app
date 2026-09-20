---
name: maestrly-development
description: Delegate development work to Maestrly and follow it to delivery. Use this whenever the person asks for code to be written, changed, reviewed, tested or shipped in one of their repositories, or asks about work already delegated ("how is it going", "did the checks pass", "open the pull request", "ask it to also handle X").
---

# Delegating development work to Maestrly

Maestrly runs development work on the person's own computers, with their own accounts, models and
repositories. You do not write the code: you describe the work, choose who does it, follow it, judge the
evidence, and decide what happens next. Everything here goes through the `maestrly_*` MCP tools.

## What you must never do

- Never invent a `projectId`, `taskId`, `selectionId`, `checkId` or `artifactId`. Read each one from a
  listing tool first. An id from memory or from an earlier conversation may belong to something else.
- Never claim work is done because a stage finished, a pull request was opened, or a turn ended. Completion
  is decided by the task's completion target and reported by `maestrly_get_task`.
- Never report a result you did not read. Check output, diffs and screenshots come from
  `maestrly_list_evidence` and `maestrly_read_artifact`; if you did not read them, say so.
- Never assume a reasoning effort, fast mode or execution mode exists for an account and model. Only the
  values listed by `maestrly_list_executors` are valid, and Maestrly refuses to translate an effort from one
  provider to another.
- Never repeat a mutating call with a new idempotency key after a timeout. Reuse the same key: a retry then
  replays the first result instead of delegating the same work twice.

## The shape of a delegation

A **task** belongs to a project and a card. It runs **stages**: `plan`, `implement`, `review`, `fix`, `qa`
are done by an agent; `verify`, `deliver` and `inspect` are done by the executor itself. Each agent stage
carries the exact account and model it must run with, its reasoning effort, whether fast mode is on, and
whether it runs in standard or maestro mode. Two stages can use two different accounts and models on
purpose: implementing with one and reviewing with another is the normal case, not an exception.

A task also carries a **policy**: what the execution may do on its own (edit, run checks, commit, push, open
a pull request, comment, merge), how many fix rounds are allowed, whether a review is required, and the
**completion target**: `patch_ready`, `pr_ready` or `merged`.

## The normal flow

1. **Find the project.** `maestrly_list_projects`. It also tells you which actions the owner authorized for
   this connection. If an action you need is missing, say so and ask the person to grant it in Maestrly.
2. **Find who can do the work.** `maestrly_list_executors` for that project. It returns the computers that
   are online, the workspaces and base branches they expose, the named checks they can run, whether GitHub
   is available, and the exact account/model selections with their allowed efforts. Choose a `selectionId`
   for each agent stage from this list.
3. **Agree on the work before creating it.** Confirm what "done" means with the person, and turn it into
   acceptance criteria. Vague criteria produce vague reviews.
4. **Create the task.** `maestrly_create_task` with the stages you want, each with its selection, and
   `start: true` when the person wants it to begin now. Use `maestrly_list_presets` when a standard pipeline
   fits; a preset declares stages and policy but never an account, so you still choose the selection.
5. **Follow it.** `maestrly_wait_task` blocks for at most 20 seconds and then returns; call it again, or let
   the routine callback wake you. `maestrly_read_events` gives you the durable timeline from a cursor. Do not
   poll in a tight loop.
6. **Read the evidence.** `maestrly_list_evidence` lists artifacts and check results, each tied to the code
   revision it describes. `maestrly_read_artifact` returns the content. A check result recorded against an
   older revision did not test the current code, and Maestrly says so.
7. **Judge it.** If a review recorded blocking findings, Maestrly plans the fix round itself. If it asks for
   a decision (`needs_attention`), read the blocker, explain it in plain words, and propose what to do.
8. **Deliver only what was asked.** `maestrly_deliver` with the mode the person authorized: `commit`,
   `push`, `draft_pr`, `ready_pr` or `merge`. Pass `expectedCodeRevision` with the digest you reviewed, so a
   delivery is refused if the code changed after you looked at it.
9. **Keep watching.** `maestrly_watch_task` subscribes to the pull request: refresh it on an interval, plan a
   fix round with a chosen account and model when checks fail, or react to requested changes. Choose the
   profile now, so the reaction never has to guess one later.

## Changing your mind mid-flight

`maestrly_configure_task` changes the account, model, effort or mode for the task defaults, one stage, or
only the next attempt. Decide when it takes effect:

- `after_current` — the change applies to the next attempt; the current one finishes.
- `replace_queued` — replace what is queued but not started.
- `interrupt_and_restart` — stop the current attempt and run it again with the new configuration. Work the
  attempt already produced is not thrown away, but the attempt itself is abandoned; only ask for this when
  the person accepts that.

Always send the `expectedVersion` you just read from `maestrly_get_task`. If Maestrly refuses the command
because the task changed, re-read it and decide again — do not retry blindly.

## Follow-ups and questions

- `maestrly_follow_up` sends an instruction into a task that is already running ("also update the tests",
  "keep the public API unchanged"). It does not change the stage configuration.
- A task in `waiting_input` is waiting for a person. `maestrly_list_questions` shows what it asked, and
  `maestrly_answer_question` answers it. Only answer on the person's behalf when they told you what to
  answer, or when the answer follows unambiguously from what they already said. Otherwise, ask them.

## Reading the code without running anything

`maestrly_inspect` asks the executor for a read-only look: a file, the diff, a search, or the pull request
status. It is asynchronous — read the answer with `maestrly_get_inspection`. Use it to explain a change in
concrete terms instead of describing it from the task title.

## How to report back

Say what the task is doing, what evidence exists, and what it is waiting on, in that order. Be concrete:
name the failing check, quote the review finding, give the pull request number. When something is missing,
name what is missing rather than softening it. If the executor went offline, the account lost access, or the
model selection disappeared, report that as the current state rather than as a delay.
