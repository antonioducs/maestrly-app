# Using the Maestrly desktop design system

## Read order

1. [`design.json`](design.json): what the package is and where each component lives in the renderer.
2. [`DESIGN.md`](DESIGN.md): direction and the do and don't rules, including the surface patterns (rail, sidebar,
   Settings, dialogs, drawer).
3. [`tokens.css`](tokens.css): every value. Use the tokens; do not copy hex codes or pixel sizes out of it.
4. [`components.html`](components.html): open it in a browser. The first board is the chat screen at 1440 px; the
   sections below show each component once with `data-ds-main`, then its variants with `data-ds-props`.
5. The real component in the renderer, from the table below, when the detail matters (states, behavior, copy).

## Composing a new screen

Start from the app shell on the first board of `components.html` and change only the main area.

1. Copy [`tokens.css`](tokens.css) and the parts of [`components.html`](components.html) you need (its `<style>` block,
   the icon sprite at the top of `<body>`, and the markup of each component) into the prototype folder. Prototypes are
   self-contained artifacts, so copy rather than link.
2. Keep the frame: the 48 px `Rail`, the 248 px sidebar panel with `SidebarHeader`, `SearchField`, `WorkspaceHeader`
   and `SidebarItem` rows, and a 40 px `ViewHeader` above the main area.
3. Pick the main-area pattern from `DESIGN.md`: the chat canvas (messages column plus `Composer`), a Settings page
   (`SettingsView` with `SettingsNavItem` and `SettingsSection`), or a panel with an `EmptyState`. Open the `Drawer` at
   the right when the screen needs a tool beside the chat.
4. Build content from the catalog: `Card`, `ListGroup` and `ListRow` for settings, `Button` and `IconButton` for
   actions, `Input`, `Select` and `Combobox` for forms, `Menu` and `ChatPopover` for choices, `Dialog` and
   `ConfirmDialog` for decisions, `Toast` for results.
5. Mark every instance with `data-ds="Name"` and its `data-ds-props` so the viewer's Inspect can relate it to the main
   component, and write styles with `var(--token)` only.
6. When the screen needs something the catalog lacks, compose it from tokens and existing parts, name it, and list it
   in the prototype's `HANDOFF.md` as new.

Keep these from the app: one ivory primary per surface, indigo only on the chat surface, opaque popovers, 13 px rows,
sentence-case copy without exclamation marks, and realistic data.

## Component map

Paths are relative to `apps/desktop/src/renderer/`. `design.json` holds the same map for tools.

| Component | Real implementation | Notes |
| --- | --- | --- |
| `Button` | [`components/ui/button.tsx`](../apps/desktop/src/renderer/components/ui/button.tsx) | `variant` and `size` match the `cva` variants. |
| `IconButton` | [`components/ui/button.tsx`](../apps/desktop/src/renderer/components/ui/button.tsx) | `variant="ghost" size="icon"` with a size class (`size-7`, `size-[26px]`, `size-6`). |
| `ActionButton` | [`components/chat/ApiKeySettings.tsx`](../apps/desktop/src/renderer/components/chat/ApiKeySettings.tsx) | Inline `bg-indigo-500` buttons of the chat settings and dictation cards. |
| `CompactButton` | [`components/ui/confirm-dialog.tsx`](../apps/desktop/src/renderer/components/ui/confirm-dialog.tsx) | The confirm dialog's 12 px buttons. |
| `Input` | [`components/ui/input.tsx`](../apps/desktop/src/renderer/components/ui/input.tsx) | With `Label` from `components/ui/label.tsx`. |
| `SearchField` | [`components/sidebar/SidebarHeader.tsx`](../apps/desktop/src/renderer/components/sidebar/SidebarHeader.tsx) | The sidebar filter. |
| `NumberField` | [`components/settings/fields.tsx`](../apps/desktop/src/renderer/components/settings/fields.tsx) | `SettingLimitField`. |
| `Checkbox` | [`styles.css`](../apps/desktop/src/renderer/styles.css) | Native `input[type=checkbox]` restyled globally. |
| `Switch` | [`components/settings/AppearanceSections.tsx`](../apps/desktop/src/renderer/components/settings/AppearanceSections.tsx) | The settings toggle; the plus menu has a smaller green one. |
| `Select`, `SelectList` | [`components/ui/select.tsx`](../apps/desktop/src/renderer/components/ui/select.tsx) | Radix Select; `components/ui/option-select.tsx` wraps it. |
| `Combobox`, `ComboboxList` | [`components/ui/search-select.tsx`](../apps/desktop/src/renderer/components/ui/search-select.tsx) | `components/ui/branch-combo.tsx` is the editable branch variant. |
| `BranchChip` | [`components/ConversationBranchChip.tsx`](../apps/desktop/src/renderer/components/ConversationBranchChip.tsx) | |
| `Count` | [`components/Sidebar.tsx`](../apps/desktop/src/renderer/components/Sidebar.tsx) | Group and pinned counts. |
| `Kbd` | [`components/chat/QuestionComposer.tsx`](../apps/desktop/src/renderer/components/chat/QuestionComposer.tsx) | |
| `RailBadge`, `RailButton`, `Rail` | [`components/sidebar/SidebarRail.tsx`](../apps/desktop/src/renderer/components/sidebar/SidebarRail.tsx) | |
| `AttentionDot`, `SidebarItem` | [`components/sidebar/conv-rows.tsx`](../apps/desktop/src/renderer/components/sidebar/conv-rows.tsx) | `.conv-item` and `.conv-selected` live in `styles.css`. |
| `StatusIcon` | [`components/sidebar/StatusIcon.tsx`](../apps/desktop/src/renderer/components/sidebar/StatusIcon.tsx) | |
| `SidebarHeader` | [`components/sidebar/SidebarHeader.tsx`](../apps/desktop/src/renderer/components/sidebar/SidebarHeader.tsx) | |
| `WorkspaceHeader` | [`components/Sidebar.tsx`](../apps/desktop/src/renderer/components/Sidebar.tsx) | `renderWorkspace`. |
| `ToolStatus`, `ToolCard`, `ToolDetails` | [`components/chat/ToolCallCard.tsx`](../apps/desktop/src/renderer/components/chat/ToolCallCard.tsx) | `ToolDetails` is `ToolCallDetails`, boxed by `ChatAgentActivity.tsx` inside the activity line. |
| `FileChip`, `Composer`, `SendButton` | [`components/chat/ChatComposer.tsx`](../apps/desktop/src/renderer/components/chat/ChatComposer.tsx) | The editor is `MentionEditor.tsx`; the working ring is in `composer-dictation.tsx`; the mic is `ChatMicButton.tsx`. |
| `ComposerChip`, `ChatPopover` | [`components/chat/ChatModePicker.tsx`](../apps/desktop/src/renderer/components/chat/ChatModePicker.tsx) | Same pattern in `ChatModelChip.tsx`, `ChatReasoningPicker.tsx`, `ChatPermModePicker.tsx` and `ChatPlusMenu.tsx`. |
| `TurnChanges` | [`components/chat/TurnChanges.tsx`](../apps/desktop/src/renderer/components/chat/TurnChanges.tsx) | |
| `SegmentedControl` | [`components/plugins/PluginsSettings.tsx`](../apps/desktop/src/renderer/components/plugins/PluginsSettings.tsx) | The `bar` variant is the chat settings tab bar in `ApiKeySettings.tsx`. |
| `Tabs` | [`components/fleet/BotSettings.tsx`](../apps/desktop/src/renderer/components/fleet/BotSettings.tsx) | Underline tabs. |
| `DrawerTab`, `Drawer`, `EmptyState` | [`components/Drawer.tsx`](../apps/desktop/src/renderer/components/Drawer.tsx) | `EmptyState` variants also come from `notes/NotesPanel.tsx` and `chat/ChatMessageList.tsx`. |
| `TerminalTab` | [`components/TerminalTabs.tsx`](../apps/desktop/src/renderer/components/TerminalTabs.tsx) | |
| `Card`, `ListGroup`, `ListRow`, `OptionButton`, `SettingsSection` | [`components/settings/AppearanceSections.tsx`](../apps/desktop/src/renderer/components/settings/AppearanceSections.tsx) | |
| `ChoiceCard` | [`components/NewConversationDialog.tsx`](../apps/desktop/src/renderer/components/NewConversationDialog.tsx) | `ModeCard`. |
| `Dialog` | [`components/ui/dialog.tsx`](../apps/desktop/src/renderer/components/ui/dialog.tsx) | |
| `ConfirmDialog` | [`components/ui/confirm-dialog.tsx`](../apps/desktop/src/renderer/components/ui/confirm-dialog.tsx) | |
| `Menu`, `MenuItem` | [`components/ui/dropdown-menu.tsx`](../apps/desktop/src/renderer/components/ui/dropdown-menu.tsx) | `components/ui/context-menu.tsx` has the same classes. |
| `Tooltip` | [`components/sidebar/use-quick-tooltip.tsx`](../apps/desktop/src/renderer/components/sidebar/use-quick-tooltip.tsx) | |
| `Toast` | [`components/ui/toaster.tsx`](../apps/desktop/src/renderer/components/ui/toaster.tsx) | |
| `PermissionPrompt` | [`components/chat/PermissionPrompt.tsx`](../apps/desktop/src/renderer/components/chat/PermissionPrompt.tsx) | |
| `TodoList` | [`components/chat/TodoCard.tsx`](../apps/desktop/src/renderer/components/chat/TodoCard.tsx) | |
| `UserMessage`, `AssistantMessage` | [`components/chat/ChatMessageList.tsx`](../apps/desktop/src/renderer/components/chat/ChatMessageList.tsx) | Prose is `MarkdownViewer.tsx` with `.dark-glass-prose` from `styles.css`. |
| `ActivityLine` | [`components/chat/AgentActivity.tsx`](../apps/desktop/src/renderer/components/chat/AgentActivity.tsx) | |
| `ScrollToBottom` | [`components/chat/ChatView.tsx`](../apps/desktop/src/renderer/components/chat/ChatView.tsx) | |
| `ViewHeader` | [`DesktopApp.tsx`](../apps/desktop/src/renderer/DesktopApp.tsx) | The chat header; the Settings variant is in `SettingsView.tsx`. |
| `SettingsView`, `SettingsNavItem` | [`components/SettingsView.tsx`](../apps/desktop/src/renderer/components/SettingsView.tsx) | Nav icons come from `components/settings/nav.tsx`. |

## Mapping tokens to the renderer

- `--color-*` tokens with a renderer counterpart have the same name without the prefix in `styles.css`
  (`--color-sidebar-accent` is `--sidebar-accent`, used as `bg-sidebar-accent`). Fill and line tokens name the
  arbitrary values the components repeat (`--color-fill-hover` is `bg-white/[0.04]`).
- Chat and status hues are the Tailwind palette the components use (`--color-action` is `indigo-500`,
  `--color-tool-running` is `sky-400`); their comments in `tokens.css` say which.
- `--radius-sm`, `--radius-md` and `--radius-lg` are `rounded-sm`, `rounded-md` and `rounded-lg`, derived from
  `--radius: 0.75rem`. `--radius-xs` is Tailwind's bare `rounded`.
- `--space-*` names are Tailwind steps; `--text-*` names are roles because the renderer mostly uses arbitrary sizes
  (`--text-row` is `text-[13px]`).

## Keeping the package current

The package follows the renderer. When `styles.css` or a mapped component changes, update the token or the
component's markup here, then compare `components.html` at 1440 px with a capture of the app built from the same
commit, side by side. The icon symbols in `components.html` are copied from the installed `lucide-react` (the version
is in the license comment above them); add a symbol the same way when a component needs a new icon, and keep the
license notice with them.
