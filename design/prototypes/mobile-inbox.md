# Mobile notifications center: implementation spec

The reference for the phone app's notifications center (`apps/mobile`): a bell with a count in the conversation
header, a notifications center screen, and the app-icon badge. The navigable prototype is
[`mobile-inbox.html`](mobile-inbox.html). Serve the folder (`python3 -m http.server 4610 -d design`) and open
`http://127.0.0.1:4610/prototypes/mobile-inbox.html`. Every state can be reached from its State switcher, or directly
with `?state=<id>&theme=light|dark&lang=en|pt&fit=1`.

All sizes are React Native points (1 px in the prototype = 1 pt). Colors use the `Palette` keys of
[`apps/mobile/src/theme/tokens.ts`](../../apps/mobile/src/theme/tokens.ts); text styles use the `AppText` variants of
[`Text.tsx`](../../apps/mobile/src/ui/primitives/Text.tsx). Behavior follows the desktop center
([`inbox-model.ts`](../../apps/desktop/src/renderer/lib/inbox/inbox-model.ts),
[`InboxPanel.tsx`](../../apps/desktop/src/renderer/components/inbox/InboxPanel.tsx)) unless this spec says otherwise.

## 1. New tokens and icons

| Proposal | Light | Dark | Why |
| --- | --- | --- | --- |
| `palette.badge` | `#d93a3f` | `#d93a3f` | The count badge and unread dots need a red. No existing key works: `brick` in dark is `#ff8288`, and white text on it is 2.39:1. White on `#d93a3f` is 4.54:1, so the 11.5 pt count passes AA. It sits on `canvas` at 4.16:1 (light) and 4.01:1 (dark), with no extra outline. |
| `palette.badgeInk` | `#ffffff` | `#ffffff` | The count text. It is its own key because no palette key is white in both themes. |
| Icon `help-circle` | — | — | The `question` kind has no glyph in `icon-paths.ts`. Add `'help-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 16.6h.01"/>'`. |

No other new tokens. Every tint below is `mix()` from `tokens.ts`.

## 2. Conversation header (the bell)

`ConversationHeader` changes:

- The menu button loses its amber `palette.cue` dot and its `home.openMenuWaiting` label. Its label is always
  `home.openMenu`. The drawer's `WaitingStrip` and tab badges stay as they are.
- A bell `IconButton` (`icon="bell"`, 44 × 44, glyph 22, `palette.ink`) goes right after the menu button:
  `[menu][bell] … title … [search][compose]`.
- Centering: the left side is now 88 pt wide. When the right side holds a single button, add a 44 pt spacer on the
  right; with none, add 88 pt. The title must stay centered on the screen. This replaces today's
  `onSearch && onNewChat` spacer.
- Pressing the bell pushes the center (`router.push('/inbox')`). `/notifications` is already the notification
  settings sheet, so the center needs its own route.

### Count badge

| Property | Value |
| --- | --- |
| Shown when | count ≥ 1. With 0, nothing is drawn (not an empty dot). |
| Position | `position: 'absolute'`, `top: 4`, `left: 22` inside the 44 pt button, so it starts at the bell's center and grows **rightward**. Do not use `IconButton`'s `badge` slot: its `right: 8` would make it grow over the bell. Allow overflow (`overflow: 'visible'`). A 99+ badge reaches 12 pt into the title gutter, which is empty. |
| Box | `height: 22`, `minWidth: 22`, `borderRadius: 11`, `paddingHorizontal: 5`, `borderWidth: 2`, `borderColor: palette.canvas` (cuts the badge out of the bell), `backgroundColor: palette.badge`, centered content. |
| Text | `fontFamily: fonts.bodySemi`, `fontSize: 11.5`, `lineHeight: 14` (the fill is 18 high), `color: palette.badgeInk`, `fontVariant: ['tabular-nums']`. |
| Text rules | 1–99: the number. 100 or more: `99+`. With 1 digit it is a 22 pt circle; wider counts make a pill. |
| What it counts | Every item in the **Waiting on you** group, read or not, plus every **unread** item in **New**, across all paired servers, before any filter. This is the desktop's `inboxCounts().waiting + .unread`. Read items and dismissed items do not count. |
| Accessibility | The badge is `aria-hidden`. The button's label is `inbox.openCount` with the real number (128, not "99+") when count ≥ 1, otherwise `inbox.open`. |
| Motion | When it appears (0 → n): scale 0.6 → 1 over 160 ms, `Easing.bezier(0.4, 0, 0.2, 1)`. Number changes do not animate. With Reduce Motion: no animation. |

### App-icon badge

- `Notifications.setBadgeCountAsync(count)` with the same count as the bell, whenever the count changes and when the
  app goes to the background. Use 0 to clear it.
- While the app is closed, the OS shows the `badge` field of each push. The server must send the same count
  (see open question 1). On Android the launcher decides between a dot and a number.

## 3. Center screen

A pushed stack screen: `slide_from_right`, the default native push, with interactive back by swipe from the edge. It
is not a form sheet, because Back must lead back to the conversation. The background is `palette.canvas` and the top
padding is `insets.top`. The list adds the bottom inset itself (see List).

### Header (52 pt)

`height: 52`, `flexDirection: 'row'`, `alignItems: 'center'`, `paddingHorizontal: 4`. The left and right sides are
each `width: 64`, which keeps the title centered.

| Part | Spec |
| --- | --- |
| Back | `IconButton icon="chev-left" size={24}`, label `common.back`. Goes back to the conversation that was open. |
| Title | `variant` display-17: `fonts.display`, 17/22, `palette.ink`, `numberOfLines={1}`, `accessibilityRole="header"`. Copy: `inbox.title`. |
| Status line | `variant="small"` (12.5/17), `tone="muted"`, 1 line, centered under the title. `inbox.counts` with the badge's two numbers (global, not filtered), or `inbox.countsNone` when both are 0. |
| Edit | Text button, right-aligned: `minHeight: 44`, `paddingHorizontal: 10`, `fonts.bodySemi` 16/23, `palette.brass`. Copy `inbox.edit` / `common.done`. Hidden when the list is empty. |

### Server filter chips

- Shown only when the owner has more than one paired server **and** the center lists at least one item. It is a
  horizontal `ScrollView` (`showsHorizontalScrollIndicator={false}`) with `contentContainerStyle`
  `{ gap: 6, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 }`, and `accessibilityRole="radiogroup"` labeled
  `inbox.filter`.
- Options in order: **All** (`inbox.all`), then each paired server in the order of the Servers list, including servers
  with 0 items.
- Each chip uses the `Pills` metrics: `minHeight: 36`, `paddingHorizontal: 14`, `borderRadius: 18`, `hitSlop: 4`
  (44 pt target), `flexDirection: 'row'`, `alignItems: 'center'`, `gap: 6`.
  - Label: `bodyMedium` at `fontSize: 14.5`.
  - Count: `small` (12.5/17), `palette.muted`, tabular.
  - Unselected: background `surface`, label `ink`.
  - Selected: background `ink`, label `canvas`, count `canvas` at `opacity: 0.7`.
  - An unreachable server leads its label with `Icon wifi-off` 14 in `brick` (`canvas` while selected).
  - Accessibility: `role="radio"`, `aria-checked`, label `"<name>, <count>"`, plus `, inbox.offline` when the
    server is unreachable.
- The filter is per session: it is not persisted, and the center reopens on All.

### List

- A `ScrollView` (`FlatList`/`SectionList` is fine) with `contentContainerStyle`
  `{ paddingHorizontal: 8, paddingBottom: insets.bottom + 12 }`. Add 60 to the bottom while the toast shows, so the
  last row can scroll above it.
- Groups in this order: **Waiting on you**, **New**, **Read · last 24h**. A group with no items is not drawn.
- Within a group: newest `at` first, ties by `key`. This is the desktop's `inboxItems` order.
- No sticky group: opening an item pops the center, so the owner never watches it move. When they come back it is
  already in its new group, unlike the desktop's `withStickyGroup`.

#### Section header

`flexDirection: 'row'`, `alignItems: 'center'`, `gap: 8`, `paddingHorizontal: 10`, `paddingTop: 14` (6 for the
first), `paddingBottom: 4`, `accessibilityRole="header"`.

- Label: `variant="label"` (13/17 semibold). `tone="cue"` for Waiting, `tone="muted"` otherwise.
- Count pill: `minWidth: 20`, `height: 20`, `paddingHorizontal: 6`, `borderRadius: 10`, centered. The text is
  11.5/14, `fontWeight: '700'`, tabular.
  - Waiting: background `cue`, text `#1f201e`, copied from `WaitingStrip`.
  - New and Read: background `surface`, text `muted`.
- Caption, Waiting only: `inbox.caption.waiting`, `small`, `tone="faint"`, `marginLeft: 'auto'`.

### Row anatomy

The prototype's Row anatomy board numbers each part. A row is a swipe container (§4) holding a `Pressable` with
`accessibilityRole="button"`:

```
row: flexDirection row · alignItems flex-start · gap 12 · paddingVertical 10 · paddingLeft 10 · paddingRight 12
     minHeight 60 · borderRadius 12 · backgroundColor canvas (pressed: surface) · marginBottom 2
├─ (1) lead 40 × 40
└─ content: flex 1 · minWidth 0
   ├─ line 1: flexDirection row · alignItems center · gap 6 · height 21
   │   (2) title · (8) unread dot · (9) time
   ├─ (3) kind line          marginTop 1
   ├─ (4) summary            marginTop 2
   ├─ (5) origin · (7) place marginTop 3
   └─ (6) approval actions   marginTop 10
```

| # | Part | Spec |
| --- | --- | --- |
| 1 | Lead | **Bot:** `Avatar` size 40 with the bot's tint and `status="idle"` (static ring at tint `52` alpha). Never animate it here: a list of breathing rings is noise. **Workspace chat:** a 40 × 40 tile, `borderRadius: 12`, `backgroundColor: surface`, `Icon folder` 19 in `ink`. **Chat:** the same tile with `message`. **Routine:** the same tile with `clock`. Decorative (`aria-hidden`). |
| 2 | Title | `fonts.bodyMedium` 15.5/21 (`variant="bodyMedium"`), `ink`, `numberOfLines={1}`, `flex: 1`. Unread: `fonts.bodySemi`. The title is the conversation's or chat's name, the bot's name, or the routine's name. |
| 8 | Unread dot | `width: 8`, `height: 8`, `borderRadius: 4`, `palette.badge`, `aria-hidden`. Only when `unread`. |
| 9 | Time | `variant="small"` (12.5/17), tabular, `muted`. Waiting group: `cueInk` and `fonts.bodySemi`. Read items with less than 3 h left show `inbox.leavesIn` in `faint` instead of the age. Compact age: under 1 min `age.now`; under 60 min `age.m`; under 24 h `age.h` (floor); otherwise `age.d`. It re-renders each minute (`useNow`). |
| 3 | Kind line | `flexDirection: 'row'`, `alignItems: 'center'`, `gap: 5`. A 14 pt glyph (`strokeWidth={2}`) and a `variant="label"` (13/17 semibold) label `inbox.kind.<kind>`, 1 line. Colors are in the table below. |
| 4 | Summary | What waits or what was said (`item.summary`, or the pending question or approval title the desktop reads from the host). `variant="sub"` (13/18), `muted`. `numberOfLines`: 2 in Waiting, 1 in New. Not drawn in Read, or when null. |
| 5 | Origin | `flexDirection: 'row'`, `alignItems: 'center'`, `gap: 4`, single line, `overflow: 'hidden'`. Segments are separated by a `·` in `small`/`faint`. **Workspace:** project (`small`/`muted`, `flexShrink: 1`, `maxWidth: '50%'`), then `Icon branch` 12 `muted` and the branch in `variant="mono"` (12/17, `muted`, `flexShrink: 4`); both ellipsize at the tail, the branch first. No folder glyph: the lead already shows it. **Chat:** `Icon message` 12 + `inbox.source.chat`. **Routine:** `Icon clock` 12 + `inbox.source.routine`. **Bot:** lane glyph 12 (`bot` main, `repeat` routine, `swap` thread) + `inbox.lane.<lane>`. These segments do not shrink. |
| 7 | Place | Last segment of the origin line, `flexShrink: 0`, `small`/`muted`: the server name, followed by ` · <environment>` when that server has more than one environment. Drawn only when the owner has more than one paired server **and** no server filter is selected. While the server is unreachable, an `Icon wifi-off` 12 in `brick` leads it. |
| 6 | Approval actions | Only for `kind === 'approval'` in Waiting, when the request id is known (as on desktop). `flexDirection: 'row'`, `gap: 8`. `Button size="sm" variant="secondary"` with `inbox.deny`, then `Button size="sm" variant="primary"` with `inbox.allowOnce` (34 pt plus `hitSlop` 6, so 46 pt targets). Busy: `busy` on the pressed one, and both disabled. Disabled while the server is unreachable. On success the item resolves (§5). |

Kind colors and glyphs:

| Kind | Glyph | Waiting or New: glyph / label | Read |
| --- | --- | --- | --- |
| `approval` | `shield` | `cueInk` / `cueInk` | `muted` / `muted` |
| `question` | `help-circle` (new) | `cueInk` / `cueInk` | `muted` / `muted` |
| `plan` | `clipboard` | `cueInk` / `cueInk` | `muted` / `muted` |
| `help` | `hand` | `cueInk` / `cueInk` | `muted` / `muted` |
| `error` | `alert` | `brick` / `brick` | `muted` / `muted` |
| `finished` | `check` | `moss` / `ink` | `muted` / `muted` |
| `activity` | `sparkles` | `muted` / `ink` | `muted` / `muted` |

Read rows: the title is regular weight (never semibold), and there is no summary and no dot. They are not faded:
`muted` already carries the hierarchy and keeps 5.3:1.

### Unreachable server

When a server's connection is not `open` (the same states `ConnectionBanner` reports), its items stay listed from
the last snapshot.

- A banner is the first child of the list, above the first section. It shows while that server's items are visible
  (All, or that server's filter). It reuses `ConnectionBanner`'s box: `marginHorizontal: 4` (12 from the screen edge
  inside the list padding), `marginBottom: 6`, `paddingVertical: 8`, `paddingLeft: 12`, `paddingRight: 8`,
  `borderRadius: 12`, `backgroundColor: mix(brick, raised, 0.12)`, `Icon wifi-off` 18 `brick`, `gap: 10`.
  - Title: `conn.offline` at 13.5/18.
  - Detail: `inbox.staleSince` (`small`/`muted`), with the age of the server's last snapshot.
  - Action: `Button size="sm" variant="secondary"` with `conn.retryNow`.
  - While retrying: `conn.reconnecting`, with no detail and no button.
  - Role: `accessibilityRole="alert"`, `accessibilityLiveRegion="polite"`. With several servers unreachable, one
    banner per server, in the Servers order.
- Rows of that server: their lead and content are drawn at `opacity: 0.55`. Dim the children, not the row, or the
  swipe action shows through. Approval actions are disabled, and the place gets the `wifi-off` glyph. Rows can
  still be opened and dismissed.
- Its chip gets the `wifi-off` glyph. Its items still count in the badge.

### Empty states

Centered column: `alignItems: 'center'`, `paddingTop: 96`, `paddingHorizontal: 32`, text centered.

- Tile: 52 × 52, `borderRadius: 16`. Nothing listed: `mix(moss, canvas, 0.14)` with `Icon check` 24 in `moss`
  (`strokeWidth` 2). Filter with no match: `surface` with `Icon server` 24 in `muted`.
- Title: `variant="heading"` (17/22 semibold), `marginTop: 14`.
- Body: `sub` at 13.5/19, `muted`, `marginTop: 6`, `maxWidth: 300`.
- Button, `marginTop: 16`: `Button size="sm" variant="secondary"`. When nothing is listed: `icon="bell"` and
  `inbox.settings`, which opens `/notifications`. When the filter matches nothing: `inbox.showAll`, which resets the
  filter to All.
- Copy: when nothing is listed, `inbox.emptyTitle` and `inbox.emptyBody`, and the header hides Edit. When the filter
  matches nothing, `inbox.emptyFilteredTitle` with the server and `inbox.emptyFilteredBody` with the hidden count.

## 4. Dismiss: swipe, Edit, Undo

### Swipe

This builds on [`SwipeToDelete.tsx`](../../apps/mobile/src/ui/primitives/SwipeToDelete.tsx): the same thresholds and
spring, with a different action and a full-swipe commit.

- The container has `overflow: 'hidden'` and `borderRadius: 12`; the row inside has `backgroundColor: canvas`.
- The action sits under the row on the right, `width: 88`, full height: `backgroundColor: palette.brass` (dismissing
  can be undone, so it is not `brick`). `Icon x` 20 and `inbox.dismiss` in `fonts.bodySemi` 13.5, both
  `palette.canvas`, `gap: 3`. It is hidden at rest (`opacity: 0`), as in `SwipeToDelete`.
- Gesture: it claims the move when `|dx| > 10` and `|dx| > 1.5·|dy|`; the row follows the finger, clamped at 0
  on the right.
- On release:
  - Past 60 % of the row width to the left: commit. The row slides out to `-width`, then collapses.
  - Otherwise it opens to `-88` when `vx < -0.4`, or when `vx <= 0.4` and it is past `-44`; else it closes.
  - The spring is `Animated.spring` with `bounciness: 0` and `speed: 18`.
- One row open at a time. Scrolling, tapping elsewhere, or a filter change closes it.
- Disabled in Edit mode.

### Edit mode (the visible alternative)

Edit in the header turns the list into editing:

- Each row drops its time and approval actions and gains a trailing 44 × 44 button: a 28 pt circle in `surface` with
  `Icon x` 16 in `muted`, centered vertically. Its label is `inbox.dismissItem`. In edit mode the row's
  `paddingRight` is 0.
- Tapping the row body does nothing in Edit.
- A bottom bar sits under the list, which shrinks to make room: `borderTopWidth: 1`, `borderTopColor: line`, `paddingTop: 4`,
  `paddingHorizontal: 8`, `paddingBottom: insets.bottom + 4`. It holds a text button `inbox.markAllRead` (same style
  as Edit), disabled at `opacity: 0.35` when nothing is unread. Mark all as read moves every unread New item to Read
  and clears unread on Waiting items, which stay in Waiting.
- Done, or Back, leaves Edit.

### Screen readers

Every row exposes `accessibilityActions`: `[{ name: 'dismiss', label: inbox.dismiss }]`, plus
`{ name: 'markRead', label: inbox.markRead }` while unread. The row label is
`"<title>, <kind>, <summary>, <origin…>, <place>[, Offline], <time>[, Unread]"`. The summary is left out in Read.

### Collapse, toast and Undo

- **Collapse:** after a commit or a tap on Dismiss, the row's height and `marginBottom` go to 0 and opacity to 0 over
  200 ms (`Easing.bezier(0.4, 0, 0.2, 1)`). Then the item is dismissed: the desktop's `dismissInboxItem` hides it
  until something newer happens, and reads it. Use `LayoutAnimation` or Reanimated layout transitions.
- **Toast:** `position: 'absolute'`, `left: 12`, `right: 12`, `bottom: insets.bottom + 12`, `minHeight: 48`,
  `borderRadius: 14`, `backgroundColor: palette.ink`, `paddingLeft: 16`, `paddingRight: 4`, `gap: 8`, and
  `shadow 0 8 24 rgba(0,0,0,0.18)`.
  - Message: 14.5/20 in `mix(canvas, ink, 0.82)`, built from `inbox.dismissed`. Split the template around
    `{title}`: the text before and after it does not shrink, and only the title truncates (`numberOfLines={1}`,
    tail), so the word "dismissed" never disappears.
  - Undo: a text button `minHeight: 44`, `paddingHorizontal: 14`, `fonts.bodySemi` 15, `palette.canvas`, copy
    `inbox.undo`.
  - Accessibility: `accessibilityLiveRegion="polite"`.
- **Timing:** the toast fades in and rises 8 pt over 200 ms, and stays **6 s**. Undo puts the entry back as it was
  (`restoreInboxEntry`) and hides the toast at once. A new dismissal replaces the toast and restarts the 6 s; the
  previous dismissal stays done.

## 5. Behavior

| Action | Result |
| --- | --- |
| Tap a New or Read row | Opens its target (conversation, bot lane or routine run) as the home screen's current conversation, and pops the center. The item is read: a New item moves to Read, so the badge drops by one. |
| Tap a Waiting row | Opens it the same way. The dot clears, but it **stays in Waiting and stays counted** until the owner answers. Then it becomes Read, as `finished` (or `error`, by the conversation's status, as `resolvedKind` does). |
| Deny or Allow once on a row | Answers in place. The item resolves to Read and the count drops. The center stays open. |
| Back, or the edge swipe | Returns to the conversation. The filter and Edit reset. |
| A new event on a dismissed item | It comes back, unread (desktop parity). |
| Read items | Stay 24 h after being read, then drop out (`INBOX_READ_TTL_MS`). |

The ledger, sources and reconciliation are the implementer's (task scope). The UI only needs the desktop's
`InboxItem` shape, plus the server and environment of each place.

## 6. Motion summary

| What | Duration and easing | Reduce Motion |
| --- | --- | --- |
| Push and pop of the center | Native stack default | Native stack (the OS fades) |
| Badge appear | 160 ms, scale 0.6 → 1, standard | None |
| Row press | Background to `surface` at once, as other rows | Same |
| Swipe settle | Spring, bounciness 0, speed 18 | `setValue` at once, as `SwipeToDelete` |
| Commit slide and collapse | 200 ms, standard | Removed at once |
| Toast in and out | 200 ms opacity + 8 pt translateY | Opacity only, 0 ms |
| Banner | No animation | — |

Use `useReducedMotion()`. Nothing in the center loops.

## 7. Hit targets

Bell, Back, menu and the Edit-mode dismiss buttons are 44 × 44. Edit, Mark all as read and Undo are at least 44 pt
high. Chips are 36 + 2 × 4 `hitSlop`. Small buttons are 34 + 2 × 6 `hitSlop`. Rows are at least 60 pt.

## 8. Copy

New keys go in `apps/mobile/src/i18n/catalogs.ts` in both languages. Keys marked *existing* are reused as they are.
The mobile catalog uses `{name}` placeholders.

| Key | English | Português (BR) |
| --- | --- | --- |
| `inbox.open` | Notifications | Notificações |
| `inbox.openCount` | Notifications, {count} pending | Notificações, {count} pendentes |
| `inbox.title` | Notifications | Notificações |
| `inbox.counts` | {waiting} waiting on you · {new} new | {waiting} esperando por você · {new} novas |
| `inbox.countsNone` | Nothing pending | Nada pendente |
| `inbox.edit` | Edit | Editar |
| `common.done` *existing* | Done | OK |
| `common.back` *existing* | Back | Voltar |
| `inbox.filter` | Filter by server | Filtrar por servidor |
| `inbox.all` | All | Tudo |
| `inbox.group.waiting` | Waiting on you | Esperando por você |
| `inbox.caption.waiting` | until you act | até você agir |
| `inbox.group.new` | New | Novas |
| `inbox.group.read` | Read · last 24h | Lidas · últimas 24h |
| `inbox.kind.approval` | Needs your approval | Precisa da sua aprovação |
| `inbox.kind.question` | Has a question | Tem uma pergunta |
| `inbox.kind.plan` | Plan to review | Plano para revisar |
| `inbox.kind.help` | Asks for help | Pede ajuda |
| `inbox.kind.error` | Failed | Falhou |
| `inbox.kind.finished` | Finished | Terminou |
| `inbox.kind.activity` | Something new | Tem novidades |
| `inbox.source.chat` | Chat | Chat |
| `inbox.source.routine` | Routine | Rotina |
| `inbox.lane.main` | Conversation | Conversa |
| `inbox.lane.routine` | Routine | Rotina |
| `inbox.lane.thread` | Between bots | Entre bots |
| `inbox.unread` | Unread | Não lida |
| `inbox.offline` | Offline | Sem conexão |
| `inbox.leavesIn` | Leaves in {time} | Sai em {time} |
| `age.now` | now | agora |
| `age.m` | {n}m | {n}min |
| `age.h` | {n}h | {n}h |
| `age.d` | {n}d | {n}d |
| `inbox.deny` | Deny | Negar |
| `inbox.allowOnce` | Allow once | Permitir uma vez |
| `inbox.dismiss` | Dismiss | Dispensar |
| `inbox.dismissItem` | Dismiss {title} | Dispensar {title} |
| `inbox.dismissed` | “{title}” dismissed | “{title}” dispensada |
| `inbox.undo` | Undo | Desfazer |
| `inbox.markRead` | Mark as read | Marcar como lida |
| `inbox.markAllRead` | Mark all as read | Marcar tudo como lido |
| `inbox.emptyTitle` | You’re all caught up | Tudo em dia |
| `inbox.emptyBody` | What needs you, and what ended in your chats, workspaces and bots, shows up here. Read items stay for 24 hours. | O que precisa de você, e o que terminou nos seus chats, workspaces e bots, aparece aqui. Itens lidos ficam por 24 horas. |
| `inbox.emptyFilteredTitle` | Nothing on {server} | Nada em {server} |
| `inbox.emptyFilteredBody` (plural: one) | {count} notification is on your other servers. | {count} notificação está nos seus outros servidores. |
| `inbox.emptyFilteredBody` (plural: other) | {count} notifications are on your other servers. | {count} notificações estão nos seus outros servidores. |
| `inbox.showAll` | Show all servers | Mostrar todos os servidores |
| `inbox.settings` | Notification settings | Ajustes de notificações |
| `inbox.staleSince` | Showing what it sent {time} ago. | Mostrando o que ele enviou há {time}. |
| `conn.offline` *existing* | Can’t reach {server} | Sem acesso a {server} |
| `conn.retryNow` *existing* | Retry now | Tentar agora |
| `conn.reconnecting` *existing* | Reconnecting to {server}… | Reconectando a {server}… |
| `home.openMenu` *existing* | Open menu | Abrir menu |

Copy decisions:

- The mobile app already says **"Waiting on you"** in the drawer and on cue cards, so the group uses it. The desktop
  says "Waiting for you".
- In pt-BR the items are *notificações*, feminine: "Novas", "Lidas", "dispensada", "Não lida". The desktop's
  "Novos" and "dispensado" refer to "itens".
- `age.*` mirrors the desktop's `sidebar.age*`. The mobile app had no compact age.

## 9. States to check against the prototype

| `?state=` | What it shows |
| --- | --- |
| `bell0` | Header, bell without a badge |
| `bell3` | Header, badge 3 |
| `bell99` | Header, badge 99+ (128 pending; the app icon shows 128) |
| `center` | All three groups, two servers, approval actions |
| `filtered` | Work server selected: the place is hidden on rows, and the header counts stay global |
| `offline` | Work server unreachable: banner, dimmed rows, disabled actions, chip glyph |
| `swipe` | A row swiped open to its Dismiss action |
| `toast` | After a dismissal: the toast with Undo |
| `edit` | Edit mode with per-row dismiss and Mark all as read |
| `emptyf` | A filter with no items |
| `empty` | Nothing listed |

Each state can be shown with `theme=light|dark` and `lang=en|pt`.

## 10. Open questions for the implementer

1. **Push badge while the app is closed.** The OS badge only matches the bell if each push carries the server's
   pending count. With several paired servers, each server only knows its own items. Choose between a per-server
   count (simple, undercounts), the phone resetting the badge on every foreground (the prototype's assumption), or
   the server tracking it.
2. **Should Waiting items count once seen?** This spec keeps every Waiting item counted until answered (desktop
   parity). Use unread-only if the badge should mean "new to me".
3. **Where read state lives.** The desktop ledger is per computer. Should the phone keep its own ledger (in `prefs`)
   or sync read and dismiss state with the server, so reading on the desktop clears the phone?
4. **Approve from the row for bots.** The desktop answers bot requests from the row with `resolveBotRequest`. Confirm
   the phone's fleet controller exposes the same call; if not, approval rows open the conversation.
5. **Environment in the place.** The prototype shows only the server. Confirm that `server · environment` is wanted
   when a server has several environments, or whether the environment belongs in the chips.
