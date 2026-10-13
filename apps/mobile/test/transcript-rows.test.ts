import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { toolHeadline, toolSummary, transcriptRows } from '../src/fleet/transcript-rows'
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

describe('transcript rows', () => {
  it('groups consecutive tools under the first one’s id', () => {
    const rows = transcriptRows([user('u1'), tool('t1', 'bash'), tool('t2', 'read'), said('a1'), tool('t3', 'edit')])
    expect(rows.map((row) => (row.kind === 'item' ? row.item.id : `${row.kind}:${row.id}`))).toEqual([
      'u1',
      'tools:t1',
      'a1',
      'tools:t3',
    ])
    const group = rows[1]
    expect(group.kind === 'tools' && group.tools.map((item) => item.id)).toEqual(['t1', 't2'])
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
    expect(rows.map((row) => (row.kind === 'item' ? row.item.id : `${row.kind}:${row.id}`))).toEqual([
      'u1',
      'todos:p1',
      'tools:t1',
      'a1',
      'u2',
      'todos:p3',
    ])
    const plan = rows[1]
    expect(plan.kind === 'todos' && plan.todos).toEqual(last)
  })

  it('passes every other item through in order', () => {
    const items: FleetTranscriptItem[] = [
      user('u1'),
      { id: 'r1', at: at(), kind: 'reasoning', text: 'hm', truncated: false, streaming: false },
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
    expect(toolHeadline(tool('a', 'bash', { target: 'npm test' }), text.t)).toEqual({
      verb: 'Running',
      target: 'npm test',
    })
  })
})
