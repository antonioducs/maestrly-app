# Maestrly desktop design system

This package describes the interface of the Maestrly desktop app as it exists in
[`apps/desktop/src/renderer`](../apps/desktop/src/renderer). It is extracted: the renderer is the source of truth, and
this package follows it. Prototypes of this repository start from [`tokens.css`](tokens.css) and
[`components.html`](components.html) so that they look like Maestrly without rebuilding it. Read
[`USAGE.md`](USAGE.md) for the order to read things in and the mapping to the real files.

## Direction

A quiet, dark workbench for long sessions with agents. Content leads; chrome recedes into near-black surfaces, hairline
borders and white at very low opacity. One warm ivory (`--color-primary`, `#edeae3`) carries brand, selection and focus.
Color appears only when it means something: a status, a chat mode, a warning.

- Do keep surfaces dark and flat, separated by 0.5 to 1 px lines rather than by color blocks.
- Do let the person's content (messages, code, files) be the brightest thing on screen.
- Don't add gradients, illustrations or brand color to ordinary screens. The only ambient treatments in the app are the
  Design and Ultra modes of the chat canvas.
- Don't introduce a light theme. The app has one theme, dark, and every token assumes it.

## Color

The palette is three layers: near-black surfaces, white-alpha fills and lines on top of them, and a few semantic hues.

| Role | Tokens | Rule |
| --- | --- | --- |
| Window | `--color-window` | Behind everything. Linux and Windows paint `#0a0a0b`; macOS shows dark vibrancy here. |
| Panels | `--color-sidebar`, `--color-surface`, `--color-chat-canvas` | Sidebar and drawer are translucent glass over the window; the chat is opaque `#0d0d10`. |
| Floating | `--color-popover`, `--color-popover-chat`, `--color-floating` | Opaque, always. Menus, selects, tooltips, toasts and dialogs use `--color-popover`; the composer's pickers use `--color-popover-chat`. |
| Text | `--color-foreground`, `--color-foreground-soft`, `--color-muted-foreground` and its `-soft` and `-faint` steps | Ivory at 96%, 86% and a warm grey. |
| Fills | `--color-fill-card` (2%) to `--color-fill-strong` (10%), `--color-accent`, `--color-sidebar-accent` | Hover, selection and cards are white or ivory at a few percent. |
| Lines | `--color-border` (8%), `--color-border-strong` (14%), `--color-input` (10%), `--color-ring` | Hairlines everywhere; strong only for tooltips, empty-state icons and checkbox outlines. |
| Actions | `--color-primary`, `--color-action`, `--color-destructive` | Ivory app-wide; indigo only on the chat surface (send, chat settings' main action); coral for destructive. |
| Status | `--color-status-*`, `--color-tool-*`, `--color-warn`, `--color-routine`, `--color-attention` | Green ready, sky running, amber waiting, red error, periwinkle routines, a red dot for unread. |
| Modes | `--color-mode-plan`, `--color-reasoning`, `--color-subagent`, `--color-design*` | Indigo for Plan and Ask, violet for reasoning and subagents, amber for Design. |

- Do derive tints with `color-mix(in oklab, var(--token) N%, transparent)`, as the renderer's `bg-primary/15` does.
- Do use `--color-primary` for selection: the selected conversation, the active rail tab, the chosen option, focus rings.
- Don't use indigo outside the chat. A Settings page's main action is the ivory `Button`, except inside the chat
  settings, which use `ActionButton`.
- Don't use a status hue as decoration. Green means ready or succeeded; amber means waiting for the person or risky.
- Don't make popovers, menus or dialogs translucent; content behind them must not show through.

## Typography

One system sans stack (`--font-sans`, SF Pro Text first) and one mono stack (`--font-mono`; Markdown code uses
`--font-mono-prose`). There are no web fonts. Sizes are small and dense; most of the app is 13 px.

| Use | Token | Weight |
| --- | --- | --- |
| Empty-state heading | `--text-display` 19 px | semibold, tight tracking |
| Dialog title | `--text-lg` 18 px | semibold, line height 1 |
| Chat answers and messages | `--text-chat` 14.5 px, `--text-leading-prose` 1.65 | regular, `--color-prose-text` |
| Composer text | `--text-input` 15 px, relaxed | regular |
| Buttons, inputs, menu items, settings labels | `--text-sm` 14 px / 20 px | medium for buttons and labels |
| Sidebar rows, view titles, tool cards, picker items | `--text-row` 13 px | medium for titles |
| Descriptions, composer chips | `--text-xs` 12 px | regular, muted |
| Timestamps, hints, tool status | `--text-meta` 11 px | regular, muted, tabular numbers |
| Uppercase section labels, branch chip | `--text-micro` 10 px | regular, `--font-tracking-wide` |

- Do keep a view to two or three sizes; hierarchy comes from weight and muted color, not size.
- Do use tabular numbers (`font-variant-numeric: tabular-nums`) for counts, durations and costs.
- Do set file names, branches, commands and tool names in `--font-mono`.
- Don't go above 19 px anywhere in the app chrome, and don't use bold (700) except in rail badges.
- Don't use uppercase except for 10 to 11 px section labels with wide tracking.

## Spacing and layout

Spacing follows the Tailwind 4 px scale; token names keep the step (`--space-2-5` is 10 px).

- Every view has a 40 px title bar (`--size-header`) with a bottom hairline; titles start 12 px in.
- The left edge is the 48 px icon rail (`--size-rail`); with the sidebar open, rail and sidebar take 296 px together.
- The chat column is 768 px (`--size-chat-column`), centered, with 12 px side padding and 20 px between turns.
- Settings content is a centered 672 px column with 24 px padding and 28 px between sections.
- Rows are dense: sidebar rows are 32 px, menu items 32 px, controls 36 px (`--size-control`), small controls 32 or
  28 px.
- Do align icons and text on one line with 6 to 8 px gaps; icons are 16 px in buttons and menus, 14 px in rows and
  chips, 12 px for chevrons, 18 px in the rail.
- Don't add outer margins to cards in a list; group rows in one `ListGroup` with dividers.
- Don't center content in wide empty space except for empty states.

## Shape and elevation

`--radius` is 12 px and the scale is derived from it: 8 px menu items, 10 px buttons, inputs, menus and rows, 12 px
cards, dialogs and bubbles, 16 px the composer and empty-state icons, full for badges, the send button and switches.

- Do separate with hairlines: `--shadow-hairline-right` on the sidebar, `--shadow-hairline-bottom` under title bars,
  1 px `--color-border` around cards.
- Do give floating layers a shadow: `--shadow-md` for menus and selects, `--shadow-xl` for tooltips and dialogs,
  `--shadow-2xl` for toasts, confirmations and composer popovers.
- Don't put shadows on cards, rows or buttons that sit in the page.
- Don't mix radii inside one component: a 12 px card holds 10 px controls.

## Motion

Short and functional. Colors change in 150 ms (`--duration-base`, `--ease-standard`); sidebar rows in 160 ms on
`--ease-emphasized`; menus, dialogs and toasts fade in 200 ms; sheets slide 260 ms.

- Do animate state, not decoration: the breathing glow of a working conversation, the turning arc and light sweep of the
  live activity step, the spinning ring of the send button while a turn runs.
- Do honor `prefers-reduced-motion`: the app turns off every looping animation, and so must a prototype.
- Don't animate layout on hover beyond a 1 px lift on quick-pick cards.
- Don't loop anything that is not live work.

## Components

[`components.html`](components.html) renders every component with its variants; [`USAGE.md`](USAGE.md) maps them to
the renderer. The rules that keep them recognizable:

- `Button`: ivory `default` for the one primary action of a surface, `ghost` for cancel and toolbars, `outline` for
  secondary actions in empty states, `destructive` only for irreversible actions. Icons inside are always 16 px.
- `IconButton`: a ghost button sized to its place (28 px in title bars, 26 px in the sidebar header, 24 px in rows),
  with an `aria-label`. An open state uses the `secondary` fill.
- `Input`, `Select`, `Combobox`: transparent, 10% white border, `--shadow-sm`, 1 px ivory ring on focus.
- `SidebarItem`: status icon, truncated title, relative time that turns into a menu button on hover; selected rows get
  the ivory tint, an inset 0.5 px line and the glowing 2.5 px bar.
- `Menu` and `MenuItem`: 14 px items with 16 px icons; destructive items last, after a separator, in coral.
- `ChatPopover`: the composer's pickers. Title and one-line description per item, a check on the selected one.
- `UserMessage` is a tinted bubble across the column; `AssistantMessage` is bare prose. Never put answers in bubbles.
- `ActivityLine`: one line per turn that summarizes the agent's work and expands into a timeline; tool arguments and
  results open inside it as `ToolDetails`. Use `ToolCard` only outside the activity line.
- `Composer`: a 16 px-radius shell with the editor on top and chips below; the send button is the only indigo in it.
- `PermissionPrompt` is amber and sits above the composer; `ConfirmDialog` is compact, with the decision focused.

## Surfaces

How a Maestrly screen is put together. A prototype of the desktop app uses these frames as they are.

- **Rail**: 48 px column at the far left on `--color-rail` over the sidebar glass. A collapse button, a divider, the
  view tabs (Inbox, Chats, Workspaces, Bots, Routines) with an ivory bar on the active one, and at the bottom
  Artifacts, Usage, Settings and Help. Counts are 16 px badges cut out of the icon by a ring.
- **Sidebar**: 248 px panel beside the rail, glass on `--color-sidebar`. A 40 px header with the view title and ghost
  icon buttons, a 30 px search field, then the list: workspace headers (chevron, folder, name, actions on hover) and
  their conversations on a thin vertical guide line.
- **Main area**: a 40 px header with the conversation title, branch chip and icon buttons, over the chat canvas. The
  messages column and the composer share the 768 px width.
- **Settings**: replaces the main area and collapses the sidebar to the rail. A 40 px header with a gear icon, the title
  and a close button; a 192 px nav column of 13 px items with icons (active is a 6% fill); a centered 672 px content
  column of sections separated by a hairline, each with a 14 px semibold title, a 12 px muted description and cards or
  grouped rows with switches.
- **Dialogs**: centered on a 60% black backdrop, 512 px wide, opaque popover color, 24 px padding, 18 px title, footer
  with ghost Cancel and the primary action at the right. Confirmations are a 400 px compact variant on a 50% backdrop.
- **Drawer**: a glass panel at the right of the chat. A 40 px tab bar of the open tools (28 px tabs with an ivory
  underline on the active one, a `+` to open more), then the tool. With nothing open it shows the panel empty state
  with three quick picks.

- Do keep the rail and the 40 px title bars on every screen; they are what makes a screen read as Maestrly.
- Don't invent page headers with large titles, hero banners or breadcrumbs; views title themselves in the 40 px bar.

## Accessibility

Measured on the real colors: foreground on the chat canvas is 14.9:1, prose 13.1:1, muted text 5.0:1 (4.4:1 on
popovers), ivory buttons 16.5:1 and white on indigo 4.6:1.

- Do use `--color-muted-foreground` at full strength for any text a person must read; its `-soft` (3.6:1) and `-faint`
  (2.5:1) steps are only for timestamps, counts and uppercase labels that repeat nearby information.
- Do give every icon-only button an `aria-label` and a tooltip, and keep the 1 px `--color-ring` focus ring
  (`--shadow-focus`) on `:focus-visible`.
- Do mark tab bars with `role="tablist"`, the selected conversation and rail tab with `aria-selected`, and the settings
  nav item with `aria-current`.
- Do close dialogs and popovers with Escape and return focus to what opened them; a confirmation starts focused on its
  decision.
- Don't rely on color alone: every status icon has its own shape (circle, dot, shield, question, spinner).
- Known gap: `destructive` buttons put white on `#ff7a85`, 2.5:1. Prefer destructive menu items (coral text, 6.6:1 on
  the popover) and keep destructive button labels short.

## Voice and microcopy

The app's English catalog is plain, calm and specific. Write prototypes the same way.

- Do use sentence case for everything: titles, buttons, menu items, tabs ("New conversation", "Delete permanently").
- Do start actions with a verb and name the object: "Open chat in new window", "Allow once", "Revoke all".
- Do end the labels of actions that open more choices, and of work in progress, with a real ellipsis:
  "Open in…", "Filter conversations…", "Validating…".
- Do say what happened and what did not: "The artifact host on the bot server stopped. Nothing was deleted."
- Do make empty states say what is missing and how to get it: "No plan waiting. Enable plan mode in the terminal
  (shift+tab) and ask the agent for a plan."
- Do put keyboard hints in parentheses at the end: "End the call (Esc)".
- Don't use exclamation marks, emoji, "Oops" or "Successfully"; the catalog has none.
- Don't use placeholders such as "Lorem ipsum"; use realistic repository, branch and file names.
- Don't write user-facing text in the components themselves in the real app: it goes in the shared translation
  catalogs under `apps/desktop/src/shared/i18n`.
