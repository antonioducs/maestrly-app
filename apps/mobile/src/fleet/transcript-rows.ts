import type { FleetFileRef, FleetTodo, FleetTranscriptItem, MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { artifactPublication, type ArtifactPublication } from '../artifacts/artifacts'
import type { Pluralize, PluralKey, Translate } from '../i18n/translate'

export type ToolItem = Extract<FleetTranscriptItem, { kind: 'tool' }>
export type TranscriptRow =
  | { kind: 'item'; item: MobileChatItem }
  | { kind: 'tools'; id: string; tools: ToolItem[] }
  | { kind: 'todos'; id: string; todos: FleetTodo[] }
  | { kind: 'artifact'; id: string; artifact: ArtifactPublication }
  /** What a tool shared with the owner: videos to play and files to save, in place of the tool's own row. */
  | { kind: 'files'; id: string; files: FleetFileRef[] }

const isPlan = (item: MobileChatItem): item is ToolItem & { todos: FleetTodo[] } =>
  item.kind === 'tool' && item.name === 'todo_write' && Array.isArray(item.todos)

/**
 * The rows a conversation shows: tools in a row become one collapsible group, a turn's plan shows once, with its
 * latest list, where it first appeared, and a published page shows as its own card.
 */
export function transcriptRows(items: MobileChatItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let plan: Extract<TranscriptRow, { kind: 'todos' }> | null = null
  for (const item of items) {
    if (item.kind === 'user') plan = null
    if (isPlan(item)) {
      if (plan) plan.todos = item.todos
      else {
        plan = { kind: 'todos', id: item.id, todos: item.todos }
        rows.push(plan)
      }
      continue
    }
    const artifact = artifactPublication(item)
    if (artifact) {
      rows.push({ kind: 'artifact', id: item.id, artifact })
      continue
    }
    if (item.kind === 'tool' && item.files?.length) {
      rows.push({ kind: 'files', id: item.id, files: item.files })
      continue
    }
    const last = rows.at(-1)
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(item)
      else rows.push({ kind: 'tools', id: item.id, tools: [item] })
      continue
    }
    rows.push({ kind: 'item', item })
  }
  return rows
}

type ToolKind = 'bash' | 'read' | 'edit' | 'browser' | 'grep' | 'other'
const KINDS: Record<string, ToolKind> = {
  bash: 'bash',
  shell: 'bash',
  exec_command: 'bash',
  read: 'read',
  read_file: 'read',
  view: 'read',
  edit: 'edit',
  write: 'edit',
  multi_edit: 'edit',
  apply_patch: 'edit',
  str_replace: 'edit',
  browser: 'browser',
  web_fetch: 'browser',
  fetch: 'browser',
  grep: 'grep',
  glob: 'grep',
  search: 'grep',
  web_search: 'grep',
}
export const toolKind = (name: string): ToolKind => KINDS[name.toLowerCase()] ?? 'other'

/** What a group of tools did, such as “Ran 2 commands, read 1 file”. */
export function toolSummary(tools: ToolItem[], plural: Pluralize): string {
  const counts = new Map<ToolKind, number>()
  for (const tool of tools) counts.set(toolKind(tool.name), (counts.get(toolKind(tool.name)) ?? 0) + 1)
  const text = [...counts].map(([kind, count]) => plural(`tool.past.${kind}` as PluralKey, count)).join(', ')
  return text.slice(0, 1).toUpperCase() + text.slice(1)
}

/** What a running tool is doing: a verb and, apart, what it acts on. */
export function toolHeadline(tool: ToolItem, t: Translate): { verb: string; target: string | null } {
  return { verb: t(`tool.now.${toolKind(tool.name)}`), target: tool.target }
}
