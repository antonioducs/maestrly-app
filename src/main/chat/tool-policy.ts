import type { ChatBehavior } from '../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../shared/chat-mode'

/** "Allowed" is a product capability for Plan/Ask, not a guarantee of zero side effects. */
export interface AppToolPolicy {
  allowedInPlanAsk: boolean
  readOnly: boolean
  parallelSafe: boolean
}

export interface McpToolAnnotations {
  title?: unknown
  readOnlyHint?: unknown
  destructiveHint?: unknown
  idempotentHint?: unknown
  openWorldHint?: unknown
  [key: string]: unknown
}

const policy = (allowedInPlanAsk: boolean, readOnly: boolean, parallelSafe: boolean): AppToolPolicy => ({
  allowedInPlanAsk,
  readOnly,
  parallelSafe,
})

/** Exhaustive product policy for the app-tool universe registered by buildServer. */
export const APP_TOOL_POLICY = {
  browser_navigate: policy(true, false, false),
  browser_back: policy(true, false, false),
  browser_forward: policy(true, false, false),
  browser_reload: policy(true, false, false),
  browser_wait_for: policy(true, true, false),
  browser_snapshot: policy(true, true, false),
  browser_click: policy(false, false, false),
  browser_double_click: policy(false, false, false),
  browser_right_click: policy(false, false, false),
  browser_drag: policy(false, false, false),
  browser_type: policy(false, false, false),
  browser_press_key: policy(false, false, false),
  browser_read_text: policy(true, true, false),
  browser_screenshot: policy(true, true, false),
  browser_evaluate: policy(false, false, false),
  browser_mouse_move: policy(false, false, false),
  browser_scroll: policy(true, false, false),
  browser_console_logs: policy(true, true, false),
  browser_network_logs: policy(true, true, false),
  browser_clear_logs: policy(false, false, false),
  browser_set_dialog_behavior: policy(false, false, false),
  browser_tabs: policy(true, true, false),
  browser_switch_tab: policy(true, false, false),
  browser_new_tab: policy(true, false, false),
  browser_close_tab: policy(true, false, false),
  terminal_create: policy(false, false, false),
  terminal_list: policy(true, true, false),
  terminal_send: policy(false, false, false),
  terminal_run: policy(false, false, false),
  terminal_read: policy(true, true, false),
  terminal_snapshot: policy(true, true, false),
  terminal_signal: policy(false, false, false),
  terminal_close: policy(false, false, false),
  terminal_resize: policy(false, false, false),
  terminal_focus: policy(false, false, false),
  terminal_clear: policy(false, false, false),
  notes_list_pages: policy(true, true, false),
  notes_create_page: policy(true, false, false),
  notes_read_page: policy(true, true, false),
  notes_write_page: policy(true, false, false),
  notes_append_page: policy(true, false, false),
  notes_delete_page: policy(false, false, false),
  notes_quick_append: policy(true, false, false),
  project_notes_list_pages: policy(true, true, false),
  project_notes_create_page: policy(true, false, false),
  project_notes_read_page: policy(true, true, false),
  project_notes_write_page: policy(true, false, false),
  project_notes_append_page: policy(true, false, false),
  project_notes_delete_page: policy(false, false, false),
  project_notes_quick_append: policy(true, false, false),
  memory_search: policy(true, true, false),
  memory_list: policy(true, true, false),
  memory_read: policy(true, true, false),
  memory_upsert: policy(false, false, false),
  memory_archive: policy(false, false, false),
  memory_restore: policy(false, false, false),
  memory_forget: policy(false, false, false),
  memory_promote_to_shared: policy(false, false, false),
  memory_write: policy(false, false, false),
  memory_append: policy(false, false, false),
  debug_status: policy(false, true, false),
  debug_start: policy(false, false, false),
  debug_stop: policy(false, false, false),
  debug_restart: policy(false, false, false),
  debug_pause: policy(false, false, false),
  debug_continue: policy(false, false, false),
  debug_step: policy(false, false, false),
  debug_set_breakpoint: policy(false, false, false),
  debug_remove_breakpoint: policy(false, false, false),
  debug_clear_breakpoints: policy(false, false, false),
  debug_list_breakpoints: policy(false, true, false),
  debug_stack: policy(false, true, false),
  debug_inspect: policy(false, true, false),
  debug_variables: policy(false, true, false),
  debug_evaluate: policy(false, false, false),
} as const satisfies Record<string, AppToolPolicy>

export type AppToolName = keyof typeof APP_TOOL_POLICY

const KNOWN_ANNOTATION_TYPES = {
  title: 'string',
  readOnlyHint: 'boolean',
  destructiveHint: 'boolean',
  idempotentHint: 'boolean',
  openWorldHint: 'boolean',
} as const

function validKnownAnnotations(annotations: Record<string, unknown>): boolean {
  return Object.entries(KNOWN_ANNOTATION_TYPES).every(
    ([name, expected]) => !(name in annotations) || typeof annotations[name] === expected
  )
}

export function externalMcpToolAllowed(mode: ChatBehavior, annotations: unknown): boolean {
  if (capabilityBehaviorFor(mode) === 'agent') return true
  return externalMcpToolReadOnly(annotations)
}

export function externalMcpToolReadOnly(annotations: unknown): boolean {
  if (typeof annotations !== 'object' || annotations === null || Array.isArray(annotations)) return false
  const value = annotations as Record<string, unknown>
  return validKnownAnnotations(value) && value.readOnlyHint === true && value.destructiveHint !== true
}

/** True only for host tools whose read-only contract is known to Maestrly. */
export function isHostToolReadOnly(name: string, metadata?: unknown): boolean {
  const appPolicy = APP_TOOL_POLICY[name as AppToolName]
  if (appPolicy) return appPolicy.readOnly
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false
  const value = metadata as Record<string, unknown>
  return value.readOnly === true && value.destructive !== true
}

export function appToolAllowed(mode: ChatBehavior, name: string): boolean {
  if (name === 'review_plan') return false
  if (capabilityBehaviorFor(mode) === 'agent') return true
  const entry = APP_TOOL_POLICY[name as AppToolName]
  // Plan/Ask retain their product allowlist, including safe recording/navigation side effects. Maestro is a
  // stricter structural boundary: its parent receives only entries that are both allowlisted and proven read-only.
  return entry?.allowedInPlanAsk === true && (mode !== 'maestro' || entry.readOnly)
}

export function appToolMetadata(name: string): Pick<AppToolPolicy, 'readOnly' | 'parallelSafe'> | undefined {
  const entry = APP_TOOL_POLICY[name as AppToolName]
  return entry == null ? undefined : { readOnly: entry.readOnly, parallelSafe: entry.parallelSafe }
}

export const EXTERNAL_MCP_RESTRICTED_METADATA = { readOnly: true, parallelSafe: false } as const
