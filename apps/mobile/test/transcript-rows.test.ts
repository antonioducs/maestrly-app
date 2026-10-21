import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { rowFileIds, toolHeadline, toolSummary, transcriptRows } from '../src/fleet/transcript-rows'
import { translator } from '../src/i18n/translate'

const text = translator('en')
let second = 0
const at = () => `2026-10-12T12:00:${String(second++).padStart(2, '0')}.000Z`
type Tool = Extract<FleetTranscriptItem, { kind: 'tool' }>
const tool = (id: string, name: string, extra: Partial<Tool> = {}): Tool => ({
  id,
  at: at(),
  kind: 'tool',
  name,
  target: null,
  state: 'done',
  output: null,
  images: [],
  ...extra,
})
const user = (id: string): FleetTranscriptItem => ({
  id,
  at: at(),
  kind: 'user',
  text: 'hi',
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})
const said = (id: string): FleetTranscriptItem => ({ id, at: at(), kind: 'assistant', text: 'ok', streaming: false })

const label = (row: ReturnType<typeof transcriptRows>[number]) =>
  row.kind === 'item' ? row.item.id : `${row.kind}:${row.id}`
const thought = (id: string, streaming = false): FleetTranscriptItem => ({
  id,
  at: at(),
  kind: 'reasoning',
  text: 'hm',
  truncated: false,
  streaming,
})

describe('transcript rows', () => {
  it('folds a turn’s tools, reasoning and earlier text into one activity, under its newest text', () => {
    const rows = transcriptRows([
      user('u1'),
      tool('t1', 'bash'),
      thought('r1'),
      tool('t2', 'read'),
      said('a1'),
      thought('r2'),
      tool('t3', 'edit'),
      said('a2'),
      user('u2'),
      tool('t4', 'bash'),
    ])
    expect(rows.map(label)).toEqual(['u1', 'a2', 'activity:t1', 'u2', 'activity:t4'])
    const group = rows[2]
    expect(
      group.kind === 'activity' &&
        group.steps.map((step) => `${step.kind}:${step.kind === 'tool' ? step.tool.id : step.item.id}`)
    ).toEqual(['tool:t1', 'reasoning:r1', 'tool:t2', 'narration:a1', 'reasoning:r2', 'tool:t3'])
  })

  it('keeps what the agent said last in view while it still works', () => {
    const rows = transcriptRows([user('u1'), said('a1'), tool('t1', 'bash'), said('a2'), tool('t2', 'bash')])
    expect(rows.map(label)).toEqual(['u1', 'a2', 'activity:a1'])
    const group = rows[2]
    expect(group.kind === 'activity' && group.steps.map((step) => step.kind)).toEqual(['narration', 'tool', 'tool'])
  })

  it('treats only the conversation’s last item as streaming', () => {
    const rows = transcriptRows([
      user('u1'),
      thought('r1', true),
      tool('t1', 'bash'),
      { id: 'a1', at: at(), kind: 'assistant', text: 'x', streaming: true },
      thought('r2', true),
    ])
    expect(rows.map(label)).toEqual(['u1', 'a1', 'activity:r1'])
    const said = rows[1]
    expect(said.kind === 'item' && said.item.kind === 'assistant' && said.item.streaming).toBe(false)
    const group = rows[2]
    expect(group.kind === 'activity' && group.steps.map((step) => step.kind !== 'tool' && step.item.streaming)).toEqual(
      [false, false, true]
    )
  })

  it('leaves a turn without steps as it is, and folds reasoning alone too', () => {
    expect(transcriptRows([user('u1'), said('a1')]).map(label)).toEqual(['u1', 'a1'])
    expect(transcriptRows([user('u1'), thought('r0'), said('a1')]).map(label)).toEqual(['u1', 'a1', 'activity:r0'])
  })

  it('shows a turn’s plan once, with its latest list, where the plan first appeared', () => {
    const first = [{ content: 'Run tests', status: 'in_progress' as const }]
    const last = [{ content: 'Run tests', status: 'completed' as const }]
    const rows = transcriptRows([
      user('u1'),
      tool('p1', 'todo_write', { todos: first }),
      tool('t1', 'bash'),
      tool('p2', 'todo_write', { todos: last }),
      said('a1'),
      user('u2'),
      tool('p3', 'todo_write', { todos: first }),
    ])
    expect(rows.map(label)).toEqual(['u1', 'todos:p1', 'a1', 'activity:t1', 'u2', 'todos:p3'])
    const plan = rows[1]
    expect(plan.kind === 'todos' && plan.todos).toEqual(last)
  })

  it('passes every other item through in order', () => {
    const items: FleetTranscriptItem[] = [
      user('u1'),
      said('a1'),
      {
        id: 'p1',
        at: at(),
        kind: 'permission',
        requestId: 'q',
        title: 'Run',
        detail: null,
        tool: null,
        state: 'pending',
        resolvedAt: null,
      },
      { id: 'q1', at: at(), kind: 'question', toolCallId: 'c', questions: [], state: 'pending', answers: null },
      { id: 'h1', at: at(), kind: 'help', helpId: 'h', reason: 'x', state: 'pending', resolvedAt: null, note: null },
      { id: 's1', at: at(), kind: 'system', code: 'paused', text: null, durationMs: null },
      { id: 'c1', at: at(), kind: 'compaction', origin: 'manual', summary: null, truncated: false },
    ]
    expect(transcriptRows(items).map((row) => row.kind === 'item' && row.item.id)).toEqual(items.map((item) => item.id))
  })

  it('summarizes what a group of tools did', () => {
    expect(toolSummary([tool('a', 'bash'), tool('b', 'bash'), tool('c', 'read')], text.plural)).toBe(
      'Ran 2 commands, read 1 file'
    )
    expect(toolSummary([tool('a', 'edit')], text.plural)).toBe('Edited 1 file')
    expect(toolSummary([tool('a', 'mcp__linear__create')], text.plural)).toBe('Used 1 tool')
    expect(toolSummary([tool('a', 'mcp__maestrly__bash'), tool('b', 'browser_click')], text.plural)).toBe(
      'Ran 1 command, opened 1 page'
    )
    expect(toolHeadline(tool('a', 'bash', { target: 'npm test' }), text.t)).toEqual({
      verb: 'Running',
      target: 'npm test',
    })
  })

  it('shows the files a tool shared as their own row, apart from the activity', () => {
    const shared = tool('t2', 'share_file', {
      files: [{ id: 'f1', name: 'walkthrough.mp4', mediaType: 'video/mp4', byteSize: 4_000_000 }],
    })
    const rows = transcriptRows([tool('t1', 'bash'), shared, tool('t3', 'read')])
    expect(rows.map(label)).toEqual(['files:t2', 'activity:t1'])
    const files = rows[0]
    expect(files.kind === 'files' && files.files.map((item) => item.name)).toEqual(['walkthrough.mp4'])
  })

  it('names the files a row shows, so a file can be found in the conversation', () => {
    const file = (id: string) => ({ id, name: `${id}.pdf`, mediaType: 'application/pdf', byteSize: 10 })
    const sent: FleetTranscriptItem = { ...user('u-files'), files: [file('mine')] } as FleetTranscriptItem
    const rows = transcriptRows([
      sent,
      tool('share', 'share_file', { files: [file('f-1'), file('f-2')] }),
      tool('read', 'read'),
      said('a1'),
    ])
    const byLabel = Object.fromEntries(rows.map((row) => [label(row), rowFileIds(row)]))
    expect(byLabel['u-files']).toEqual(['mine'])
    expect(byLabel['files:share']).toEqual(['f-1', 'f-2'])
    expect(byLabel.a1).toEqual([])
    expect(byLabel['activity:read']).toEqual([])
  })
})
