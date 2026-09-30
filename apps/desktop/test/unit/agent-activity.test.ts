import { describe, expect, it } from 'vitest'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { MessagePart, ToolState } from '../../src/shared/chat'
import {
  activityLive,
  activityMatches,
  activityRows,
  activitySummary,
  chatActivitySegments,
  chatToolStep,
  fleetActivitySegments,
  reasoningTitle,
  toolCategory,
  toolDisplayName,
  toolTarget,
  type ActivityStatus,
  type ActivityStep,
} from '../../src/renderer/lib/agent-activity'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

const tool = (id: string, toolName: string, input: unknown, state: ToolState = { status: 'completed', output: '' }) =>
  ({ type: 'tool', id, toolCallId: id, toolName, input, state }) satisfies ToolPart
const text = (id: string, value: string): MessagePart => ({ type: 'text', id, text: value })
const reasoning = (id: string, value: string): MessagePart => ({ type: 'reasoning', id, text: value })

const kinds = (segments: ReturnType<typeof chatActivitySegments>) =>
  segments.map((segment) =>
    segment.kind === 'activity'
      ? `activity[${segment.steps.map((step) => (step.kind === 'tool' ? step.toolName : step.kind)).join(',')}]`
      : segment.part.type === 'tool'
        ? segment.part.toolName
        : segment.part.type
  )

describe('tool categories and targets', () => {
  it('sorts tools by what they do, whatever prefix the runtime gives them', () => {
    expect(toolCategory('bash')).toBe('command')
    expect(toolCategory('terminal_run')).toBe('command')
    expect(toolCategory('apply_patch')).toBe('edit')
    expect(toolCategory('glob')).toBe('search')
    expect(toolCategory('webfetch')).toBe('web_fetch')
    expect(toolCategory('mcp__maestrly__browser_screenshot')).toBe('screenshot')
    expect(toolCategory('mcp__maestrly__browser_navigate')).toBe('browser')
    expect(toolCategory('computer_click')).toBe('browser')
    expect(toolCategory('task')).toBe('subagent')
    expect(toolCategory('github__list_issues')).toBe('mcp')
    expect(toolCategory('mcp__github__get_issue')).toBe('mcp')
    expect(toolCategory('notes_quick_append')).toBe('other')
    expect(toolDisplayName('mcp__github__get_issue')).toBe('github · get_issue')
    expect(toolDisplayName('mcp__maestrly__notes_read_page')).toBe('notes_read_page')
  })

  it('names what a call acts on in a few words', () => {
    expect(toolTarget('bash', { command: '\n  npm test --workspace @maestrly/desktop\necho done' })).toBe(
      'npm test --workspace @maestrly/desktop'
    )
    expect(toolTarget('read', { path: 'apps/desktop/src/renderer/styles.css', offset: 10 })).toBe('styles.css')
    expect(toolTarget('edit', { changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] })).toBe('a.ts +1')
    expect(toolTarget('edit', { changes: { 'src/only.ts': { kind: 'update' } } })).toBe('only.ts')
    expect(toolTarget('grep', { pattern: 'nearBottomRef', path: 'src' })).toBe('nearBottomRef')
    expect(toolTarget('web_search', { query: 'electron vibrancy' })).toBe('electron vibrancy')
    expect(toolTarget('web_search', { action: { query: 'codex search' } })).toBe('codex search')
    expect(toolTarget('webfetch', { url: 'https://www.electronjs.org/docs/latest/api/browser-window?x=1' })).toBe(
      'www.electronjs.org/docs/latest/api/browser-window'
    )
    expect(toolTarget('github__get_issue', { issue_number: 214 })).toBeNull()
    expect(toolTarget('bash', null)).toBeNull()
    expect(toolTarget('bash', { command: 'x'.repeat(300) })?.length).toBe(120)
  })

  it('titles reasoning by its headings, else its first line', () => {
    const summary = '**Planning the search**\n\nI will look.\n\n**Reading the results**\n\nDone.'
    expect(reasoningTitle(summary)).toBe('Planning the search')
    expect(reasoningTitle(summary, 'last')).toBe('Reading the results')
    expect(reasoningTitle('\n\n# The user wants the *scroll* fixed\nmore')).toBe('The user wants the *scroll* fixed')
    expect(reasoningTitle('   ')).toBeNull()
    expect(reasoningTitle('a'.repeat(200))?.length).toBe(90)
  })
})

describe('chat message segments', () => {
  it('folds steps and the text between them, keeping pinned cards and the answer outside', () => {
    const parts: MessagePart[] = [
      { type: 'compaction', id: 'c', text: 'summary' } as MessagePart,
      reasoning('r1', 'Looking'),
      text('t1', 'Found it: the observer.'),
      tool('bash-1', 'bash', { command: 'npm test' }),
      tool('todo', 'todo_write', { todos: [] }),
      tool('read-1', 'read', { path: 'a.ts' }),
      text('t2', 'Fixed.'),
    ]
    const segments = chatActivitySegments(parts, false)
    expect(kinds(segments)).toEqual(['compaction', 'activity[reasoning,narration,bash,read]', 'todo_write', 'text'])
    const activity = segments[1]
    expect(activity).toMatchObject({ kind: 'activity', writing: false, waitingAnswer: false })
    // Segments keep each part's index, which the list uses for keys.
    expect(segments.map((segment) => (segment.kind === 'part' ? segment.index : 'a'))).toEqual([0, 'a', 4, 6])
  })

  it('keeps a published artifact as its own card instead of folding it into the activity', () => {
    for (const toolName of ['artifact_create', 'artifact_update', 'mcp__maestrly__artifact_create']) {
      const parts: MessagePart[] = [
        tool('read-1', 'read', { path: 'a.ts' }),
        tool('art-1', toolName, { title: 'Probe' }),
        text('t', 'Published.'),
      ]
      expect(kinds(chatActivitySegments(parts, false)), toolName).toEqual(['activity[read]', toolName, 'text'])
    }
  })

  it('leaves a message without steps as it is, with a live line only while nothing shows yet', () => {
    const answer = [text('t', 'Hello')]
    expect(kinds(chatActivitySegments(answer, false))).toEqual(['text'])
    expect(kinds(chatActivitySegments(answer, true))).toEqual(['text'])
    expect(kinds(chatActivitySegments([], true))).toEqual(['activity[]'])
    expect(kinds(chatActivitySegments([reasoning('r', '  ')], true))).toEqual(['reasoning', 'activity[]'])
    expect(kinds(chatActivitySegments([reasoning('r', '  ')], false))).toEqual(['reasoning'])
  })

  it('keeps the line in place as steps arrive: under what opens the message, above every card', () => {
    const compaction = { type: 'compaction', id: 'c', text: 'summary' } as MessagePart
    const todo = tool('todo', 'todo_write', { todos: [] })
    // Nothing but a plan yet, then a step, then the end of the turn: the line never moves.
    expect(kinds(chatActivitySegments([compaction, todo], true))).toEqual(['compaction', 'activity[]', 'todo_write'])
    const stepped = [compaction, todo, tool('b', 'bash', { command: 'ls' })]
    expect(kinds(chatActivitySegments(stepped, true))).toEqual(['compaction', 'activity[bash]', 'todo_write'])
    expect(kinds(chatActivitySegments([...stepped, text('t', 'Done.')], false))).toEqual([
      'compaction',
      'activity[bash]',
      'todo_write',
      'text',
    ])
  })

  it('knows when the answer is streaming or a question waits for the person', () => {
    const running = [tool('b', 'bash', { command: 'ls' }), text('t', 'The answer')]
    expect(chatActivitySegments(running, true)[0]).toMatchObject({ kind: 'activity', writing: true })
    expect(chatActivitySegments(running, false)[0]).toMatchObject({ kind: 'activity', writing: false })
    const asking = [
      tool('b', 'bash', { command: 'ls' }),
      tool('q', 'ask_question', { questions: [] }, { status: 'running' }),
    ]
    const segments = chatActivitySegments(asking, true)
    expect(kinds(segments)).toEqual(['activity[bash]', 'ask_question'])
    expect(segments[0]).toMatchObject({ waitingAnswer: true })
  })

  it('reads tool states for the line: running only while the turn runs', () => {
    const running = tool('a', 'bash', {}, { status: 'running' })
    expect(chatToolStep(running, true).status).toBe('running')
    expect(chatToolStep(running, false).status).toBe('interrupted')
    expect(chatToolStep(tool('b', 'bash', {}, { status: 'awaiting-permission' }), true).status).toBe('waiting')
    expect(chatToolStep(tool('c', 'bash', {}, { status: 'error', error: 'Aborted' }), false).status).toBe('interrupted')
    expect(chatToolStep(tool('d', 'bash', {}, { status: 'error', error: 'exit 1' }), false).status).toBe('failed')
    expect(chatToolStep(tool('e', 'bash', {}, { status: 'denied' }), false).status).toBe('denied')
  })

  it('keeps subagent cards outside the activity, which still says they run and that the turn worked', () => {
    const task = (id: string, status: 'running' | 'completed') =>
      tool(
        id,
        'task',
        { agent: 'explore', prompt: 'Map it' },
        status === 'running' ? { status } : { status, output: '' }
      )
    const parts: MessagePart[] = [
      reasoning('r', 'Delegating'),
      task('s1', 'completed'),
      task('s2', 'running'),
      tool('rd', 'read', { path: 'a.ts' }),
      text('t', 'Done.'),
    ]
    const live = chatActivitySegments(parts, true)
    expect(kinds(live)).toEqual(['activity[reasoning,read]', 'task', 'task', 'text'])
    expect(live[0]).toMatchObject({ subagents: { total: 2, running: 1 } })
    // A turn that ended runs nothing, whatever state a card was left in.
    expect(chatActivitySegments(parts, false)[0]).toMatchObject({ subagents: { total: 2, running: 0 } })
    // Subagents alone are no step: the cards and the answer show as they are, under a live line until text comes.
    expect(kinds(chatActivitySegments([task('s', 'completed'), text('t', 'Done.')], false))).toEqual(['task', 'text'])
    const waiting = chatActivitySegments([task('s', 'running')], true)
    expect(kinds(waiting)).toEqual(['activity[]', 'task'])
    expect(waiting[0]).toMatchObject({ subagents: { total: 1, running: 1 } })
    expect(chatActivitySegments([tool('b', 'bash', {})], true)[0]).toMatchObject({
      subagents: { total: 0, running: 0 },
    })
  })

  it('keeps a native checkpoint and Maestro delegations out of the activity', () => {
    const parts: MessagePart[] = [
      tool('a', 'read', { path: 'x' }),
      { type: 'text', id: 'cp', text: 'checkpoint', checkpoint: 'openai-native' },
      tool('d', 'delegate', {}),
      tool('b', 'bash', { command: 'ls' }),
    ]
    expect(kinds(chatActivitySegments(parts, false))).toEqual(['activity[read,bash]', 'text', 'delegate'])
  })
})

const step = (id: string, toolName: string, status: ActivityStatus): ActivityStep<null> => ({
  ...chatToolStep(tool(id, toolName, { path: `${id}.ts` }), false),
  status,
  source: null,
})

describe('timeline rows and summary', () => {
  it('merges consecutive reads, searches and page visits of the same kind', () => {
    const steps = [
      step('a', 'read', 'completed'),
      step('b', 'read', 'completed'),
      step('c', 'bash', 'completed'),
      step('d', 'read', 'completed'),
      step('e', 'read', 'waiting'),
      step('f', 'grep', 'completed'),
      step('g', 'grep', 'running'),
      step('h', 'grep', 'completed'),
    ]
    const rows = activityRows(steps)
    expect(rows.map((row) => (row.kind === 'group' ? `${row.category}×${row.steps.length}` : row.id))).toEqual([
      'read×2',
      'c',
      'd',
      'e',
      'search×3',
    ])
    expect(rows[0].id).toBe('group:a')
  })

  it('counts calls by what matters most, apart from denied ones', () => {
    const steps: ActivityStep<null>[] = [
      { kind: 'reasoning', id: 'r', text: 'x', source: null },
      step('a', 'grep', 'completed'),
      step('b', 'read', 'completed'),
      step('c', 'bash', 'failed'),
      step('d', 'bash', 'completed'),
      step('e', 'bash', 'denied'),
      step('f', 'edit', 'completed'),
    ]
    expect(activitySummary(steps)).toEqual({
      tools: 6,
      counts: [
        { category: 'command', count: 2 },
        { category: 'edit', count: 1 },
        { category: 'read', count: 1 },
        { category: 'search', count: 1 },
      ],
      failed: 1,
      denied: 1,
    })
  })

  it('says first what waits for the person, then the running step', () => {
    const thinking: ActivityStep<null> = {
      kind: 'reasoning',
      id: 'r',
      text: '**Plan**\n\n**Check tests**',
      source: null,
    }
    const running = step('a', 'bash', 'running')
    const off = { writing: false, waitingAnswer: false }
    expect(activityLive([running, step('b', 'bash', 'waiting')], off)).toEqual({ kind: 'waiting-permission' })
    expect(activityLive([running], { writing: true, waitingAnswer: true })).toEqual({ kind: 'waiting-answer' })
    expect(activityLive([running], { writing: true, waitingAnswer: false })).toEqual({ kind: 'writing' })
    expect(activityLive([step('c', 'read', 'running'), running, step('d', 'read', 'completed')], off)).toMatchObject({
      kind: 'step',
      step: { id: 'a' },
    })
    expect(activityLive([step('d', 'read', 'completed'), thinking], off)).toEqual({
      kind: 'thinking',
      title: 'Check tests',
    })
    expect(activityLive([thinking, step('d', 'read', 'completed')], off)).toEqual({ kind: 'thinking', title: null })
    // Subagents run in their own cards: the line names them unless a step of its own runs.
    const delegating = { ...off, runningSubagents: 2 }
    expect(activityLive([thinking], delegating)).toEqual({ kind: 'subagents', count: 2 })
    expect(activityLive([], delegating)).toEqual({ kind: 'subagents', count: 2 })
    expect(activityLive([running], delegating)).toMatchObject({ kind: 'step', step: { id: 'a' } })
    expect(activityLive([thinking], { ...delegating, writing: true })).toEqual({ kind: 'writing' })
  })

  it('finds a search query in reasoning and in-between text only', () => {
    expect(
      activityMatches({ kind: 'reasoning', id: 'r', text: 'The ResizeObserver jumps', source: null }, 'resize')
    ).toBe(true)
    expect(activityMatches({ kind: 'narration', id: 'n', text: 'Found it', source: null }, 'missing')).toBe(false)
    expect(activityMatches(step('a', 'bash', 'completed'), 'a')).toBe(false)
    expect(activityMatches({ kind: 'narration', id: 'n', text: 'Found it', source: null }, '  ')).toBe(false)
  })
})

describe('bot transcript segments', () => {
  const at = '2026-09-29T10:00:00.000Z'
  const assistant = (id: string, value: string): FleetTranscriptItem => ({
    kind: 'assistant',
    id,
    at,
    text: value,
    streaming: false,
  })
  const botTool = (id: string, name: string, extra: Partial<Extract<FleetTranscriptItem, { kind: 'tool' }>> = {}) =>
    ({
      kind: 'tool',
      id,
      at,
      name,
      target: null,
      state: 'done',
      output: null,
      images: [],
      ...extra,
    }) as FleetTranscriptItem
  const botReasoning = (id: string, value: string): FleetTranscriptItem => ({
    kind: 'reasoning',
    id,
    at,
    text: value,
    truncated: false,
    streaming: false,
  })
  const user = (id: string): FleetTranscriptItem => ({
    kind: 'user',
    id,
    at,
    text: 'Hi',
    source: 'owner',
    queued: false,
    memories: [],
    images: [],
  })
  const shot = { id: 'shot', mediaType: 'image/png' as const, byteSize: 10, name: 'Screen' }

  it('folds the items of one message like a chat message', () => {
    const items = [
      user('input:1'),
      assistant('m1:0', 'I will check the deploy.'),
      botTool('m1:1', 'bash', { target: 'gh run list' }),
      botReasoning('m1:2', 'It passed.'),
      botTool('m1:3', 'browser_screenshot', { images: [shot] }),
      assistant('m1:4', 'Staging is up.'),
    ]
    const segments = fleetActivitySegments(items, { working: false })
    expect(segments.map((segment) => (segment.kind === 'item' ? segment.item.id : segment.key))).toEqual([
      'input:1',
      'activity:m1',
      'm1:4',
    ])
    const activity = segments[1]
    if (activity.kind !== 'activity') throw new Error('expected an activity')
    expect(activity.steps.map((entry) => entry.kind)).toEqual(['narration', 'tool', 'reasoning', 'tool'])
    expect(activity.steps[1]).toMatchObject({ category: 'command', target: 'gh run list', status: 'completed' })
    expect(activity.images).toEqual([shot])
    expect(activity.live).toBe(false)
  })

  it('is live for the newest message while the bot works, until the owner writes again', () => {
    const items = [
      assistant('m1:0', 'Old answer'),
      botTool('m2:0', 'bash', { state: 'running' }),
      assistant('m2:1', 'Writing…'),
    ]
    const live = fleetActivitySegments(items, { working: true })
    expect(live.at(-2)).toMatchObject({ kind: 'activity', live: true, writing: true })
    expect(fleetActivitySegments(items, { working: false }).at(-2)).toMatchObject({ live: false, writing: false })
    const answered = fleetActivitySegments([...items, user('input:2')], { working: true })
    expect(answered.find((segment) => segment.kind === 'activity')).toMatchObject({ live: false })
  })

  it("keeps a bot's to-do checklist outside the activity, as chats keep theirs", () => {
    const todos = [{ content: 'Check the deploy', status: 'in_progress' as const }]
    const items = [
      botTool('m1:0', 'todo_write', { todos }),
      botTool('m1:1', 'bash', { target: 'ls' }),
      assistant('m1:2', 'Done.'),
      // An older bot sends no list: its todo_write stays a step.
      botTool('m2:0', 'mcp__maestrly__todo_write'),
    ]
    const segments = fleetActivitySegments(items, { working: false })
    expect(segments.map((segment) => (segment.kind === 'item' ? segment.item.id : segment.key))).toEqual([
      'activity:m1',
      'm1:0',
      'm1:2',
      'activity:m2',
    ])
    const first = segments[0]
    if (first.kind !== 'activity') throw new Error('expected an activity')
    expect(first.steps.map((step) => step.id)).toEqual(['m1:1'])
  })

  it('leaves messages without steps as items', () => {
    expect(
      fleetActivitySegments([assistant('m1:0', 'Plain'), botReasoning('m2:0', ' ')], { working: false }).map(
        (segment) => segment.kind
      )
    ).toEqual(['item'])
  })
})
