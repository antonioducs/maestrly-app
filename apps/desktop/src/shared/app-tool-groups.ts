/**
 * User-facing groups of Maestrly app tools. A group is derived from the stable tool-name prefix, so new tools
 * join their group without extra wiring. Bot-only tools (computer, peers, routines, owner help) belong to no
 * group: bots always run with them.
 */
export const APP_TOOL_GROUPS = [
  'terminal',
  'browser',
  'notes',
  'memory',
  'history',
  'debug',
  'artifacts',
  'board',
] as const

export type AppToolGroup = (typeof APP_TOOL_GROUPS)[number]

/** Enabled state of every group; a missing entry counts as enabled. */
export type AppToolGroupState = Record<AppToolGroup, boolean>

/** Tool-name patterns of each group, as the model sees them. */
export const APP_TOOL_GROUP_PATTERNS: Record<AppToolGroup, string> = {
  terminal: 'terminal_*',
  browser: 'browser_*',
  notes: 'notes_*/project_notes_*',
  memory: 'memory_*',
  history: 'history_*',
  debug: 'debug_*',
  artifacts: 'artifact_*',
  board: 'board_*',
}

const PREFIXES: ReadonlyArray<readonly [string, AppToolGroup]> = [
  ['terminal_', 'terminal'],
  ['browser_', 'browser'],
  ['notes_', 'notes'],
  ['project_notes_', 'notes'],
  ['memory_', 'memory'],
  ['history_', 'history'],
  ['debug_', 'debug'],
  ['artifact_', 'artifacts'],
  ['board_', 'board'],
]

export function appToolGroupOf(name: string): AppToolGroup | null {
  if (name === 'get_linked_kanban') return 'board'
  for (const [prefix, group] of PREFIXES) if (name.startsWith(prefix)) return group
  return null
}

export function isAppToolGroup(value: unknown): value is AppToolGroup {
  return typeof value === 'string' && (APP_TOOL_GROUPS as readonly string[]).includes(value)
}

/** Keeps only known groups with a boolean value; anything else is dropped. */
export function sanitizeAppToolGroupPatch(value: unknown): Partial<AppToolGroupState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const patch: Partial<AppToolGroupState> = {}
  for (const [group, enabled] of Object.entries(value)) {
    if (isAppToolGroup(group) && typeof enabled === 'boolean') patch[group] = enabled
  }
  return patch
}
