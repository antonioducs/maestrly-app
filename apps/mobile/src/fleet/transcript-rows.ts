import type { FleetFileRef, FleetTodo, FleetTranscriptItem, MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { artifactPublication, type ArtifactPublication } from '../artifacts/artifacts'
import type { Pluralize, PluralKey, Translate } from '../i18n/translate'

export type ToolItem = Extract<FleetTranscriptItem, { kind: 'tool' }>
export type ReasoningItem = Extract<FleetTranscriptItem, { kind: 'reasoning' }>
export type AssistantItem = Extract<FleetTranscriptItem, { kind: 'assistant' }>
/** One thing the agent did while it worked: a tool, its reasoning, or something it said on the way. */
export type ActivityStep =
  | { kind: 'tool'; tool: ToolItem }
  | { kind: 'reasoning'; item: ReasoningItem }
  | { kind: 'narration'; item: AssistantItem }
export type TranscriptRow =
  | { kind: 'item'; item: MobileChatItem }
  /** What the agent did in a turn, folded into one line as on the desktop. */
  | { kind: 'activity'; id: string; steps: ActivityStep[] }
  | { kind: 'todos'; id: string; todos: FleetTodo[] }
  | { kind: 'artifact'; id: string; artifact: ArtifactPublication }
  /** What a tool shared with the owner: videos to play and files to save, in place of the tool's own row. */
  | { kind: 'files'; id: string; files: FleetFileRef[] }

const isPlan = (item: MobileChatItem): item is ToolItem & { todos: FleetTodo[] } =>
  item.kind === 'tool' && item.name === 'todo_write' && Array.isArray(item.todos)

type Entry = { item: MobileChatItem; row: TranscriptRow | null; part: 'step' | 'text' | 'pinned' | 'hidden' }

/**
 * The rows a conversation shows. In each turn, what the agent did (its tools, its reasoning and what it said before
 * its newest text) folds into one activity row, as on the desktop: what opened the turn, the cards it passed (plans,
 * pages, files, requests) and its newest text stay outside in the order they came, then the activity, always last
 * so its live line sits under everything the turn shows. A turn's plan shows once, with its latest list, where it
 * first appeared.
 *
 * A host marks every part of a message that streams as streaming; only the conversation's last item really is.
 */
export function transcriptRows(items: MobileChatItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let turn: Entry[] = []
  let plan: Extract<TranscriptRow, { kind: 'todos' }> | null = null
  const lastIndex = items.length - 1
  items.forEach((raw, index) => {
    const item =
      (raw.kind === 'assistant' || raw.kind === 'reasoning') && raw.streaming && index !== lastIndex
        ? { ...raw, streaming: false }
        : raw
    if (item.kind === 'user') {
      flushTurn(turn, rows)
      turn = []
      plan = null
      rows.push({ kind: 'item', item })
      return
    }
    if (isPlan(item)) {
      if (plan) plan.todos = item.todos
      else {
        plan = { kind: 'todos', id: item.id, todos: item.todos }
        turn.push({ item, row: plan, part: 'pinned' })
      }
      return
    }
    const artifact = artifactPublication(item)
    if (artifact) return turn.push({ item, row: { kind: 'artifact', id: item.id, artifact }, part: 'pinned' })
    if (item.kind === 'tool' && item.files?.length)
      return turn.push({ item, row: { kind: 'files', id: item.id, files: item.files }, part: 'pinned' })
    if (item.kind === 'tool') return turn.push({ item, row: null, part: 'step' })
    if (item.kind === 'reasoning') return turn.push({ item, row: null, part: item.text.trim() ? 'step' : 'hidden' })
    if (item.kind === 'assistant')
      return turn.push({ item, row: { kind: 'item', item }, part: item.text || item.streaming ? 'text' : 'hidden' })
    turn.push({ item, row: { kind: 'item', item }, part: 'pinned' })
  })
  flushTurn(turn, rows)
  return rows
}

function flushTurn(turn: Entry[], rows: TranscriptRow[]): void {
  const parts = turn.map((entry) => entry.part)
  const last = parts.lastIndexOf('step')
  if (last < 0) {
    for (const entry of turn) if (entry.row && entry.part !== 'hidden') rows.push(entry.row)
    return
  }
  const first = parts.findIndex((part) => part === 'step' || part === 'text')
  const newestText = parts.lastIndexOf('text')
  const steps: ActivityStep[] = []
  for (let index = first; index <= last; index++) {
    const { item, part } = turn[index]
    if (part === 'step' && item.kind === 'tool') steps.push({ kind: 'tool', tool: item })
    else if (part === 'step' && item.kind === 'reasoning') steps.push({ kind: 'reasoning', item })
    else if (part === 'text' && index !== newestText && item.kind === 'assistant')
      steps.push({ kind: 'narration', item })
  }
  turn.forEach((entry, index) => {
    if (entry.row && entry.part !== 'hidden' && (index > last || index === newestText || entry.part === 'pinned'))
      rows.push(entry.row)
  })
  rows.push({ kind: 'activity', id: turn[first].item.id, steps })
}

/**
 * The rows with what a conversation adds to them, in conversation order: one with `at` (a notice, such as a routine
 * run that ended) goes before the first message from the owner, a routine or a bot that came after it, so it never
 * splits a turn; the others (messages still on the phone) go last.
 */
export function withExtras<T extends { at?: string }>(
  rows: TranscriptRow[],
  extras: T[]
): Array<TranscriptRow | { kind: 'extra'; row: T }> {
  const timed = extras.filter((extra) => extra.at).sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : 1))
  const out: Array<TranscriptRow | { kind: 'extra'; row: T }> = []
  let next = 0
  for (const row of rows) {
    if (row.kind === 'item' && row.item.kind === 'user')
      while (next < timed.length && (timed[next].at ?? '') < row.item.at)
        out.push({ kind: 'extra', row: timed[next++] })
    out.push(row)
  }
  for (; next < timed.length; next++) out.push({ kind: 'extra', row: timed[next] })
  for (const extra of extras) if (!extra.at) out.push({ kind: 'extra', row: extra })
  return out
}

/** The tools among an activity's steps. */
export const activityTools = (steps: ActivityStep[]): ToolItem[] =>
  steps.flatMap((step) => (step.kind === 'tool' ? [step.tool] : []))

type ToolKind = 'bash' | 'read' | 'edit' | 'browser' | 'grep' | 'other'
const KINDS: Record<string, ToolKind> = {
  bash: 'bash',
  shell: 'bash',
  exec_command: 'bash',
  terminal_run: 'bash',
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
  webfetch: 'browser',
  fetch: 'browser',
  grep: 'grep',
  glob: 'grep',
  search: 'grep',
  web_search: 'grep',
}
/** A tool's kind by its own name, without the MCP server it comes from (`mcp__maestrly__bash` is `bash`). */
export const toolKind = (name: string): ToolKind => {
  const base = (name.split(/__|\./).at(-1) ?? name).toLowerCase()
  return KINDS[base] ?? (base.startsWith('browser_') ? 'browser' : 'other')
}

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
