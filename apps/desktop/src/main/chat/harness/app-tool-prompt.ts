import { APP_TOOL_GROUPS, APP_TOOL_GROUP_PATTERNS, type AppToolGroup } from '../../../shared/app-tool-groups'

/** English list: "a", "a and b", "a, b, and c". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export interface AppToolPromptGroups {
  /** Drawer groups the prompt names, minus the ones the user turned off. */
  listed: AppToolGroup[]
  /** Groups the prompt recommends over native tools, minus the ones turned off. */
  preferred: AppToolGroup[]
  /** Restricted-mode (Plan/Ask/Maestro) catalog fragments of the groups still on. */
  restricted: string[]
  /** Sentence naming the groups the user turned off, or '' when none is off. */
  disabledNote: string
}

/**
 * Tool descriptions in the prompt must match the actual toolset, so the group lists drop what the user turned
 * off. With nothing turned off the lists are exactly the historical ones, keeping default prompts unchanged.
 */
export function appToolPromptGroups(
  hasNotesTab: boolean,
  mode: string,
  disabledGroups: readonly AppToolGroup[] = []
): AppToolPromptGroups {
  const disabled = new Set(disabledGroups)
  const on = (group: AppToolGroup) => !disabled.has(group)
  const notes = hasNotesTab && on('notes')
  const maestro = mode === 'maestro'
  const off = APP_TOOL_GROUPS.filter((group) => disabled.has(group))
  return {
    listed: (
      ['terminal', 'browser', ...(hasNotesTab ? ['notes' as const] : []), 'memory', 'debug'] as AppToolGroup[]
    ).filter(on),
    preferred: (['terminal', 'memory', ...(hasNotesTab ? ['notes' as const] : [])] as AppToolGroup[]).filter(on),
    restricted: [
      notes ? (maestro ? 'notes list/read' : 'notes list/read/create/write/append') : '',
      on('memory') ? 'memory search/list/read' : '',
      on('browser') ? (maestro ? 'browser inspection/read' : 'browser navigation/read') : '',
      on('terminal') ? 'terminal read' : '',
    ].filter(Boolean),
    disabledNote: off.length
      ? ` The user turned off ${listJoin(off.map((group) => APP_TOOL_GROUP_PATTERNS[group]))} in this conversation, so those tools are not in your tool set. If the task genuinely needs one of them, ask the user to turn it back on.`
      : '',
  }
}
