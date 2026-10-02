import type { FleetImageRef, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { MessagePart, ToolState } from '../../shared/chat'

/**
 * The agent activity of a turn: the reasoning, tool calls and in-between text the agent produced on its way to the
 * answer. The transcript folds it into one line that shows the current step while the turn runs and a summary once it
 * ends; the answer (the text after the last step) and whatever needs the person stay outside.
 */

export type ActivityCategory =
  | 'command'
  | 'read'
  | 'edit'
  | 'search'
  | 'web_search'
  | 'web_fetch'
  | 'browser'
  | 'screenshot'
  | 'subagent'
  | 'mcp'
  | 'image'
  | 'other'

export type ActivityStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'denied' | 'interrupted'

export interface ActivityToolStep<S> {
  kind: 'tool'
  id: string
  toolName: string
  category: ActivityCategory
  target: string | null
  status: ActivityStatus
  source: S
}

export type ActivityStep<S> =
  | { kind: 'reasoning'; id: string; text: string; source: S }
  /** Text the agent wrote between steps ("Found it: …"): part of the way, not of the answer. */
  | { kind: 'narration'; id: string; text: string; source: S }
  | ActivityToolStep<S>

const HOST_TOOL_PREFIX = /^mcp__maestrly__/

/** The tool name without the prefix a runtime puts on Maestrly's own tools. */
export function baseToolName(toolName: string): string {
  return toolName.replace(HOST_TOOL_PREFIX, '')
}

const CATEGORY_BY_NAME: Record<string, ActivityCategory> = {
  bash: 'command',
  shell: 'command',
  exec_command: 'command',
  local_shell: 'command',
  terminal_run: 'command',
  terminal_send: 'command',
  read: 'read',
  view_image: 'read',
  git_diff: 'read',
  read_execution_context: 'read',
  edit: 'edit',
  write: 'edit',
  apply_patch: 'edit',
  grep: 'search',
  glob: 'search',
  search_execution_context: 'search',
  web_search: 'web_search',
  webfetch: 'web_fetch',
  web_fetch: 'web_fetch',
  browser_screenshot: 'screenshot',
  computer_screenshot: 'screenshot',
  task: 'subagent',
  delegate: 'subagent',
  generate_image: 'image',
  image_generation: 'image',
}

export function toolCategory(toolName: string): ActivityCategory {
  const name = baseToolName(toolName)
  const known = CATEGORY_BY_NAME[name]
  if (known) return known
  if (name.startsWith('browser_') || name.startsWith('computer_')) return 'browser'
  // Other MCP servers: `server__tool` or `mcp__server__tool`.
  if (name.includes('__')) return 'mcp'
  return 'other'
}

/** `server · tool` for an MCP tool; the plain name otherwise. */
export function toolDisplayName(toolName: string): string {
  const name = baseToolName(toolName)
  const parts = name
    .replace(/^mcp__/, '')
    .split('__')
    .filter(Boolean)
  return parts.length > 1 ? `${parts[0]} · ${parts.slice(1).join('__')}` : name
}

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value

const firstLine = (value: string): string =>
  value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''

const basename = (value: string): string => value.split(/[\\/]/).filter(Boolean).pop() ?? value

function urlTarget(value: string): string {
  try {
    const url = new URL(value)
    return clip(url.host + (url.pathname === '/' ? '' : url.pathname), 80)
  } catch {
    return clip(value, 80)
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

function editedPath(input: Record<string, unknown>): string | null {
  const direct = str(input.path) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.notebook_path)
  if (direct) return basename(direct)
  // Codex file changes: a list of `{ path }`, or a map keyed by path.
  const changes = input.changes
  const paths = Array.isArray(changes)
    ? changes.map((change) => str((change as { path?: unknown } | null)?.path)).filter((path) => path !== null)
    : changes && typeof changes === 'object'
      ? Object.keys(changes)
      : []
  if (!paths.length) return null
  return basename(paths[0]) + (paths.length > 1 ? ` +${paths.length - 1}` : '')
}

function genericTarget(input: Record<string, unknown>): string | null {
  const url = str(input.url)
  if (url) return urlTarget(url)
  for (const key of ['path', 'filePath', 'file_path']) {
    const path = str(input[key])
    if (path) return basename(path)
  }
  for (const key of ['command', 'cmd', 'query', 'pattern', 'title', 'name', 'text']) {
    const value = str(input[key])
    if (value) return clip(firstLine(value), 80)
  }
  return null
}

/** What a tool call acts on, in a few words: a command, a file name, a search, a page. */
export function toolTarget(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  switch (toolCategory(toolName)) {
    case 'command': {
      const command = str(value.command) ?? str(value.cmd) ?? str(value.text)
      if (command) return clip(firstLine(command), 120)
      if (Array.isArray(value.command))
        return clip(value.command.filter((arg) => typeof arg === 'string').join(' '), 120)
      return null
    }
    case 'read':
    case 'edit':
      return editedPath(value) ?? genericTarget(value)
    case 'search': {
      const pattern = str(value.pattern) ?? str(value.query) ?? str(value.glob)
      return pattern ? clip(pattern, 80) : genericTarget(value)
    }
    case 'web_search': {
      const action = value.action as { query?: unknown } | undefined
      const queries = Array.isArray(value.queries) ? value.queries : []
      const query = str(value.query) ?? str(action?.query) ?? str(queries[0])
      return query ? clip(query, 100) : null
    }
    default:
      return genericTarget(value)
  }
}

/**
 * A short title for reasoning: the last (or first) bold heading of a reasoning summary, else its first line. Live
 * lines show the latest heading; the timeline shows the first.
 */
export function reasoningTitle(text: string, which: 'first' | 'last' = 'first'): string | null {
  const headings = [...text.matchAll(/^\s*\*\*(.+?)\*\*\s*$/gm)].map((match) => match[1].trim()).filter(Boolean)
  if (headings.length) return clip(which === 'last' ? headings[headings.length - 1] : headings[0], 90)
  const line = firstLine(text)
    .replace(/^[#>*_`\s-]+/, '')
    .replace(/[*_`]+$/, '')
    .trim()
  return line ? clip(line, 90) : null
}

function chatToolStatus(state: ToolState, live: boolean): ActivityStatus {
  switch (state.status) {
    case 'pending':
    case 'running':
      return live ? 'running' : 'interrupted'
    case 'awaiting-permission':
      return live ? 'waiting' : 'interrupted'
    case 'completed':
      return 'completed'
    case 'error':
      return state.error === 'Aborted' ? 'interrupted' : 'failed'
    case 'denied':
      return 'denied'
  }
}

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function chatToolStep(part: ToolPart, live: boolean): ActivityToolStep<MessagePart> {
  return {
    kind: 'tool',
    id: part.toolCallId,
    toolName: part.toolName,
    category: toolCategory(part.toolName),
    target: toolTarget(part.toolName, part.input),
    status: chatToolStatus(part.state, live),
    source: part,
  }
}

/**
 * Tools that render their own card outside the activity: the person answers or reads them, opens what they
 * published (an artifact), or, for a subagent, follows its progress and opens its transcript.
 */
const PINNED_TOOLS = new Set([
  'ask_question',
  'todo_write',
  'start_conversations',
  'delegate',
  'task',
  'artifact_create',
  'artifact_update',
])

const isSubagentPart = (part: MessagePart): part is ToolPart =>
  part.type === 'tool' && baseToolName(part.toolName) === 'task'

type PartClass = 'step' | 'text' | 'pinned' | 'hidden'

function classifyPart(part: MessagePart): PartClass {
  if (part.type === 'text') return part.checkpoint ? 'pinned' : part.text ? 'text' : 'hidden'
  if (part.type === 'reasoning') return part.text.trim() ? 'step' : 'hidden'
  if (part.type === 'tool') return PINNED_TOOLS.has(baseToolName(part.toolName)) ? 'pinned' : 'step'
  return 'pinned'
}

export type ChatActivitySegment =
  | {
      kind: 'activity'
      steps: ActivityStep<MessagePart>[]
      /** The answer is streaming: the agent is writing it. */
      writing: boolean
      /** A question the person has not answered yet. */
      waitingAnswer: boolean
      /** The message's subagents, whose cards sit outside the activity: how many it ran, and how many run now. */
      subagents: { total: number; running: number }
    }
  | { kind: 'part'; part: MessagePart; index: number }

/**
 * How an assistant message renders in the compact view, in order: what opens the message before the agent acts (a
 * compaction, imported context), the activity, the cards it passed (plan, questions, subagents, orchestration,
 * images), then the answer. The activity keeps that place from the first card or step on, so the line does not move
 * as steps arrive. A message with no step renders as it is, with a live line while it has no answer yet.
 */
export function chatActivitySegments(parts: readonly MessagePart[], live: boolean): ChatActivitySegment[] {
  const classes = parts.map(classifyPart)
  const last = classes.lastIndexOf('step')
  const waitingAnswer =
    live &&
    parts.some(
      (part) =>
        part.type === 'tool' &&
        baseToolName(part.toolName) === 'ask_question' &&
        (part.state.status === 'pending' ||
          part.state.status === 'running' ||
          part.state.status === 'awaiting-permission')
    )
  const tasks = parts.filter(isSubagentPart)
  const subagents = {
    total: tasks.length,
    running: tasks.filter((part) => chatToolStep(part, live).status === 'running').length,
  }
  const asParts = (from: number, to: number, keep: (index: number) => boolean = () => true): ChatActivitySegment[] =>
    parts
      .slice(from, to)
      .map((part, offset) => ({ kind: 'part' as const, part, index: from + offset }))
      .filter((segment) => keep(segment.index))
  const acted = classes.findIndex(
    (value, index) => value === 'step' || value === 'text' || (value === 'pinned' && parts[index].type === 'tool')
  )
  const first = acted < 0 ? parts.length : acted
  if (last < 0) {
    const hasText = classes.includes('text')
    if (!live || hasText) return asParts(0, parts.length)
    return [
      ...asParts(0, first),
      { kind: 'activity', steps: [], writing: false, waitingAnswer, subagents },
      ...asParts(first, parts.length),
    ]
  }
  const steps: ActivityStep<MessagePart>[] = []
  for (let index = first; index <= last; index++) {
    const part = parts[index]
    if (classes[index] === 'step') {
      if (part.type === 'reasoning') steps.push({ kind: 'reasoning', id: part.id, text: part.text, source: part })
      else if (part.type === 'tool') steps.push(chatToolStep(part, live))
    } else if (classes[index] === 'text' && part.type === 'text')
      steps.push({ kind: 'narration', id: part.id, text: part.text, source: part })
  }
  const writing = live && classes.slice(last + 1).includes('text')
  return [
    ...asParts(0, first, (index) => classes[index] === 'pinned'),
    { kind: 'activity', steps, writing, waitingAnswer, subagents },
    ...asParts(first, last + 1, (index) => classes[index] === 'pinned'),
    ...asParts(last + 1, parts.length),
  ]
}

export type ActivityRow<S> =
  | { kind: 'reasoning'; id: string; step: Extract<ActivityStep<S>, { kind: 'reasoning' }> }
  | { kind: 'narration'; id: string; step: Extract<ActivityStep<S>, { kind: 'narration' }> }
  | { kind: 'tool'; id: string; step: ActivityToolStep<S> }
  | { kind: 'group'; id: string; category: ActivityCategory; steps: ActivityToolStep<S>[] }

const GROUPABLE = new Set<ActivityCategory>(['read', 'search', 'web_search', 'web_fetch'])

/** Timeline rows: consecutive reads, searches and page visits of the same kind merge into one row. */
export function activityRows<S>(steps: readonly ActivityStep<S>[]): ActivityRow<S>[] {
  const rows: ActivityRow<S>[] = []
  for (const step of steps) {
    if (step.kind === 'reasoning') rows.push({ kind: 'reasoning', id: step.id, step })
    else if (step.kind === 'narration') rows.push({ kind: 'narration', id: step.id, step })
    else {
      const previous = rows[rows.length - 1]
      const groupable = GROUPABLE.has(step.category) && step.status !== 'waiting'
      if (groupable && previous?.kind === 'group' && previous.category === step.category) previous.steps.push(step)
      else if (
        groupable &&
        previous?.kind === 'tool' &&
        previous.step.category === step.category &&
        previous.step.status !== 'waiting'
      )
        rows[rows.length - 1] = {
          kind: 'group',
          id: `group:${previous.step.id}`,
          category: step.category,
          steps: [previous.step, step],
        }
      else rows.push({ kind: 'tool', id: step.id, step })
    }
  }
  return rows
}

/** The status a merged row shows: running while any runs, failed when any failed. */
export function groupStatus<S>(steps: readonly ActivityToolStep<S>[]): ActivityStatus {
  if (steps.some((step) => step.status === 'running')) return 'running'
  if (steps.some((step) => step.status === 'failed')) return 'failed'
  if (steps.some((step) => step.status === 'interrupted')) return 'interrupted'
  return 'completed'
}

const SUMMARY_ORDER: readonly ActivityCategory[] = [
  'command',
  'edit',
  'subagent',
  'read',
  'screenshot',
  'browser',
  'web_search',
  'web_fetch',
  'mcp',
  'search',
  'image',
  'other',
]

export interface ActivitySummary {
  tools: number
  /** Tool calls by category, most telling first; denied calls are counted apart. */
  counts: Array<{ category: ActivityCategory; count: number }>
  failed: number
  denied: number
}

export function activitySummary<S>(steps: readonly ActivityStep<S>[]): ActivitySummary {
  const tools = steps.filter((step): step is ActivityToolStep<S> => step.kind === 'tool')
  const counts = new Map<ActivityCategory, number>()
  for (const step of tools)
    if (step.status !== 'denied') counts.set(step.category, (counts.get(step.category) ?? 0) + 1)
  return {
    tools: tools.length,
    counts: SUMMARY_ORDER.filter((category) => counts.has(category)).map((category) => ({
      category,
      count: counts.get(category)!,
    })),
    failed: tools.filter((step) => step.status === 'failed').length,
    denied: tools.filter((step) => step.status === 'denied').length,
  }
}

export type ActivityLive<S> =
  | { kind: 'waiting-permission' }
  | { kind: 'waiting-answer' }
  | { kind: 'writing' }
  | { kind: 'thinking'; title: string | null }
  | { kind: 'step'; step: ActivityToolStep<S> }
  | { kind: 'subagents'; count: number }

/**
 * What the live line says: whatever waits for the person first, then the running step, then the subagents running
 * in their own cards.
 */
export function activityLive<S>(
  steps: readonly ActivityStep<S>[],
  options: { writing: boolean; waitingAnswer: boolean; runningSubagents?: number }
): ActivityLive<S> {
  const tools = steps.filter((step): step is ActivityToolStep<S> => step.kind === 'tool')
  if (tools.some((step) => step.status === 'waiting')) return { kind: 'waiting-permission' }
  if (options.waitingAnswer) return { kind: 'waiting-answer' }
  if (options.writing) return { kind: 'writing' }
  const running = tools.filter((step) => step.status === 'running')
  if (running.length) return { kind: 'step', step: running[running.length - 1] }
  if (options.runningSubagents) return { kind: 'subagents', count: options.runningSubagents }
  const last = steps[steps.length - 1]
  return { kind: 'thinking', title: last?.kind === 'reasoning' ? reasoningTitle(last.text, 'last') : null }
}

/** Whether a search query appears in the activity's text (reasoning and in-between text are searchable). */
export function activityMatches<S>(step: ActivityStep<S>, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle || step.kind === 'tool') return false
  return step.text.toLowerCase().includes(needle)
}

// ---------- bot transcripts ----------

const MESSAGE_ITEM_ID = /^(.*):(\d+)$/

type FleetStepItem = Extract<FleetTranscriptItem, { kind: 'assistant' | 'tool' | 'reasoning' }>

const isStepItem = (item: FleetTranscriptItem): item is FleetStepItem =>
  item.kind === 'assistant' || item.kind === 'tool' || item.kind === 'reasoning'

const FLEET_STATUS: Record<Extract<FleetTranscriptItem, { kind: 'tool' }>['state'], ActivityStatus> = {
  running: 'running',
  done: 'completed',
  error: 'failed',
  interrupted: 'interrupted',
}

/** A bot's to-do list renders as its checklist outside the activity, like a chat's; an older bot sends no list. */
const pinnedFleetItem = (item: FleetStepItem): boolean =>
  item.kind === 'tool' &&
  ((baseToolName(item.name) === 'todo_write' && !!item.todos) ||
    !!item.files?.length ||
    ['artifact_create', 'artifact_update'].includes(baseToolName(item.name)))

export type FleetActivitySegment =
  | { kind: 'item'; item: FleetTranscriptItem }
  | {
      kind: 'activity'
      key: string
      steps: ActivityStep<FleetTranscriptItem>[]
      live: boolean
      writing: boolean
      images: FleetImageRef[]
    }

/**
 * A bot transcript for the compact view. The items one chat message produced (assistant text, tools, reasoning) fold
 * like a chat message: steps and the text between them into an activity, the text after the last step stays. The
 * newest message's activity is live while the bot works on it.
 */
export function fleetActivitySegments(
  items: readonly FleetTranscriptItem[],
  options: { working: boolean }
): FleetActivitySegment[] {
  const runs: Array<{ message: string | null; items: FleetStepItem[] } | { message: null; item: FleetTranscriptItem }> =
    []
  for (const item of items) {
    const previous = runs[runs.length - 1]
    const message = isStepItem(item) ? (MESSAGE_ITEM_ID.exec(item.id)?.[1] ?? item.id) : null
    if (message !== null && previous && 'items' in previous && previous.message === message)
      previous.items.push(item as FleetStepItem)
    else if (message !== null) runs.push({ message, items: [item as FleetStepItem] })
    else runs.push({ message: null, item })
  }
  let newestRun = -1
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]
    if ('items' in run) {
      newestRun = index
      break
    }
    if (run.item.kind === 'user') break
  }
  const segments: FleetActivitySegment[] = []
  runs.forEach((run, index) => {
    if (!('items' in run)) {
      segments.push({ kind: 'item', item: run.item })
      return
    }
    const live = options.working && index === newestRun
    const group = run.items
    const last = group.map((item) => item.kind !== 'assistant' && !pinnedFleetItem(item)).lastIndexOf(true)
    if (last < 0) {
      for (const item of group) segments.push({ kind: 'item', item })
      return
    }
    const passed = group.slice(0, last + 1)
    const pinned = passed.filter(pinnedFleetItem)
    const steps: ActivityStep<FleetTranscriptItem>[] = passed
      .filter((item) => !pinnedFleetItem(item))
      .flatMap((item): ActivityStep<FleetTranscriptItem>[] => {
        if (item.kind === 'assistant')
          return item.text.trim() ? [{ kind: 'narration', id: item.id, text: item.text, source: item }] : []
        if (item.kind === 'reasoning')
          return item.text.trim() ? [{ kind: 'reasoning', id: item.id, text: item.text, source: item }] : []
        return [
          {
            kind: 'tool',
            id: item.id,
            toolName: item.name,
            category: toolCategory(item.name),
            target: item.target,
            // The bot marks tools a finished turn left open as interrupted; one still running may be paused.
            status: FLEET_STATUS[item.state],
            source: item,
          },
        ]
      })
    const rest = group.slice(last + 1)
    if (!steps.length && !live) {
      for (const item of [...pinned, ...rest]) segments.push({ kind: 'item', item })
      return
    }
    segments.push({
      kind: 'activity',
      key: `activity:${run.message}`,
      steps,
      live,
      writing: live && rest.some((item) => item.kind === 'assistant' && item.text.trim().length > 0),
      images: group.flatMap((item) => (item.kind === 'tool' ? item.images : [])),
    })
    for (const item of [...pinned, ...rest]) segments.push({ kind: 'item', item })
  })
  return segments
}
