# Bot-created conversations on the phone — design

Date: 2026-10-20 · Status: proposed

## Goal

A fleet bot with access to a workspaces environment starts development
conversations there (`desktop_*` tools, `host-desktop-calls`). The desktop lists
them with the bot's badge and lets the person pause or resume the bot, and
release the chat for their own messages or block them again. The phone does not
list them at all: the mobile API leaves out every conversation with a
`botOrigin` (`mobile-api.ts`, `visible`), and chat attention skips them
(`chat-attention.ts`).

Show these conversations on the phone with the same controls and indicators as
the desktop, and the same rules, which the host already enforces.

## What the desktop does today

| Piece | Desktop | Rule on the host |
| --- | --- | --- |
| List | Bot icon on the conversation's row | — |
| Header | "Managed by X", or "Created by X · Paused/Revoked"; **Pause bot** / **Resume bot** | `bot:management`; resuming fails for a revoked bot or a project the bot lost |
| Composer | Held: disabled, "X is running this conversation. Release the chat to write in it too." with **Release chat** after a confirmation. Released: "Shared with X…" with **Block my messages** | `bot:manual-chat`; `chat:send`, `chat:steer` and `chat:resend` refuse while held |
| Messages | "Sent by X" on the messages the bot sent (`ChatMessage.botName`) | — |
| Stop, plan decision | In a held chat they pause the bot first; in a released chat they do not | `chat:stop`, `plan:decide` |
| Plan elsewhere | Never built in another conversation or by Maestro | `plan:decide` refuses |

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Full parity: list indicator, header indicator, release/block, pause/resume, "Sent by X". |
| Notifications | Bot conversations notify like any chat (approvals, questions, plans, finished and failed turns). `watchChatAttention` stops skipping them. |
| Protocol version | Additive only; `MOBILE_API_VERSION` stays 1. |
| Conversation field | `MobileConversation.bot`: `{ name, state: 'active' \| 'paused' \| 'revoked', shared }`, optional and nullable. `shared` is true only while the bot is active and the chat is released. An unknown state reads as `revoked`: the phone offers no control, and the host still enforces its rules. |
| Bot-sent messages | A user item with `sentByBot: { name }`, a new member of `mobileChatItemSchema` (as `fromConversation` is). Older phones match the plain user item and drop the field. |
| New channels | `mobile:v1:bot:manual-chat` `{ conversationId, enabled }` and `mobile:v1:bot:management` `{ conversationId, state: 'active' \| 'paused' }`. Both run the host's own `bot:manual-chat` and `bot:management` handlers and answer the updated `MobileConversation`. A host refusal (revoked, project no longer granted, turn still stopping) answers code `bot-refused` with the host's message. |
| Refused sends | When `chat:send` or `chat:resend` refuses a held chat, the API answers code `bot-locked`. The phone's outbox shows "X is running this chat; release it to send". |
| Held chat on the phone | The composer is replaced by a notice: bot icon, "X is running this conversation", "Release the chat to write in it too", and **Release** behind the desktop's confirmation text. Permission and question cards keep working, as on the desktop. |
| Released chat on the phone | The composer shows a strip above the field: "Shared with X. It is not told what you write here." with **Block**, no confirmation. |
| Paused, revoked | Normal composer; the indicators show the state. |
| Pause and resume | In the chat's details (tap on the title): a **Bot** group with "Managed by X" or "Created by X", the state, and **Pause bot** or **Resume bot** (none when revoked). No confirmation, as on the desktop. Stopping a turn in a held chat goes through **Pause bot**, since the notice replaces the Stop button. |
| Drawer indicator | `ChatRow` shows a bot icon before the name, as it shows Maestro's sparkles; its accessibility label adds "Managed by X" or "Created by X · Paused/Revoked". |
| Header indicator | `ChatTitle` leads with a bot icon. |
| Editing | No edit while held. A message the bot sent is never editable on the phone, as messages from other conversations are not: it is the bot's instruction, not the person's. |
| Plan options | A bot conversation answers `newConversation: false` and `maestro: null`. |
| Lists refresh | The `lists` reducer refreshes the `conversation` of open views from the new lists, so a lock, release, pause or resume done elsewhere reaches the header and the composer. Today an open view keeps the conversation it was opened with until it opens again. |

## Compatibility

- **New phone, older host:** the host lists no bot conversation and sends no
  `bot` field. Nothing changes.
- **Older phone, newer host:** bot conversations appear as plain chats, without
  indicators or controls. A message to a held chat fails with the host's refusal
  (the outbox shows a generic failure), and Stop pauses the bot, as Stop does on
  the desktop. The host enforces every rule, so nothing unsafe happens; the
  experience is complete once the app updates. Gating the lists by app version
  was rejected: the host compares no phone versions today, and builds outside
  the stores carry arbitrary versions.

## Adjacent fix

`chatOutboxEntriesSchema` lacks `blockedByHook`, which `ChatOutboxErrorKey`
has. A message a plugin hook refused is persisted with that error, and the next
launch fails to parse the stored outbox and drops it entirely. The schema takes
`blockedByHook` and the new `botLocked`.

## Testing

- Protocol: a conversation with and without `bot`, an unknown state, and a
  `sentByBot` item, each parsed by the current schemas.
- Host (`remote-mobile-api.test.ts`): bot conversations listed and opened with
  each state; `sentByBot` projection; both channels call the bot handlers and
  answer the updated conversation; host refusals map to `bot-refused`; refused
  sends and edits map to `bot-locked`; plan options of a bot conversation.
- Chat attention: a bot conversation notifies like any chat.
- Phone units: the lists reducer refreshes open views; `editableItemId` skips
  `sentByBot`; outbox mapping and the persisted schema; the controller's two new
  calls.
- Phone web flows: in the demo, a bot-managed chat opens held, is released,
  takes a message, is blocked again, and is paused and resumed from its details.

## Documentation

`docs/mobile.md` (bot-created chats and their controls), `docs/bot-fleet.md`
(the phone in "Work in the projects of your computers"), and
`docs/security-model.md` (what a phone may call).
