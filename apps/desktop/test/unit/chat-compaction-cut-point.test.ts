import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import {
  compactionTailBudget,
  historyAfterCut,
  historyThroughCut,
  selectCompactionCut,
  summaryWithoutApprovedPlan,
  summaryWithTurnRequest,
  turnRequestBeforeCut,
} from '../../src/main/chat/compaction/cut-point'
import {
  activeChatContext,
  renderNativeSeedTranscript,
  summaryWithApprovedPlan,
  toModelMessages,
} from '../../src/main/chat/message'
import { previewPositionalCompaction } from '../../src/main/chat/background-compaction/activation'

// 3 bytes per estimated token: `tokens(n)` renders about n portable tokens.
const tokens = (n: number) => 'x'.repeat(n * 3)
const text = (id: string, n: number): MessagePart => ({ type: 'text', id, text: tokens(n) })
const tool = (id: string, n: number, status: 'completed' | 'running' = 'completed'): MessagePart => ({
  type: 'tool',
  id,
  toolCallId: id,
  toolName: 'bash',
  input: { command: 'ls' },
  state: status === 'completed' ? { status, output: tokens(n) } : { status },
})
const user = (id: string, n: number): ChatMessage => ({
  id,
  conversationId: 'c',
  role: 'user',
  createdAt: 0,
  parts: [text(`${id}-text`, n)],
})
const assistant = (id: string, parts: MessagePart[], finished = true): ChatMessage => ({
  id,
  conversationId: 'c',
  role: 'assistant',
  createdAt: 0,
  parts,
  ...(finished ? { finishReason: 'stop' } : {}),
})

describe('compaction cut point', () => {
  it('prefers the oldest user message whose tail fits, cutting after the previous assistant', () => {
    const history = [
      user('u1', 5_000),
      assistant('a1', [text('a1-t', 5_000)]),
      user('u2', 3_000),
      assistant('a2', [text('a2-t', 3_000)]),
      user('u3', 3_000),
      assistant('a3', [text('a3-t', 3_000)]),
    ]
    const cut = selectCompactionCut(history, { tailTokens: 10_000 })
    expect(cut).toMatchObject({ messageId: 'a2', afterPartId: 'a2-t', splitTurn: false })
    expect(cut!.tailTokens).toBeLessThanOrEqual(10_000)
    expect(historyAfterCut(history, cut!).map((message) => message.id)).toEqual(['u3', 'a3'])
    expect(historyThroughCut(history, cut!)!.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('splits the latest turn at a step boundary, never between a tool call and its result', () => {
    const history = [
      user('u1', 1_000),
      assistant('a1', [text('a1-t', 1_000)]),
      user('u2', 500),
      assistant(
        'live',
        [
          text('s1', 100),
          tool('t1', 8_000),
          tool('t2', 8_000),
          text('s2', 100),
          tool('t3', 6_000),
          tool('t4', 6_000),
          text('s3', 100),
          tool('t5', 3_000),
        ],
        false
      ),
    ]
    const cut = selectCompactionCut(history, { tailTokens: 15_000 })
    // From s2 the tail is ~15.3k (its step has t3+t4, then s3's), over budget; s3's step alone fits.
    expect(cut).toMatchObject({ messageId: 'live', afterPartId: 't4', splitTurn: true })
    const tail = historyAfterCut(history, cut!)
    expect(tail[0].parts.map((part) => part.id)).toEqual(['s3', 't5'])
    // The parallel calls of a step and each call/result pair stay on one side.
    const prefixIds = historyThroughCut(history, cut!)!.flatMap((message) => message.parts.map((part) => part.id))
    expect(prefixIds).toEqual(expect.arrayContaining(['t1', 't2', 't3', 't4']))
  })

  it('keeps an oversized last step when it is within twice the budget, and drops the tail beyond it', () => {
    const history = [
      user('u', 100),
      assistant('live', [text('s1', 9_000), tool('t1', 100), text('s2', 50), tool('t2', 15_000)], false),
    ]
    expect(selectCompactionCut(history, { tailTokens: 10_000 })).toMatchObject({ afterPartId: 't1', splitTurn: true })
    expect(selectCompactionCut(history, { tailTokens: 7_000 })).toBeNull()
  })

  it('never summarizes past an unfinished tool of the newest message', () => {
    const history = [
      user('u', 100),
      assistant('live', [text('s1', 3_000), tool('t1', 100), text('s2', 50), tool('t2', 0, 'running')], false),
    ]
    const cut = selectCompactionCut(history, { tailTokens: 1_000 })
    expect(cut).toMatchObject({ afterPartId: 't1' })
    const blocked = [
      user('u', 100),
      assistant('live', [text('s1', 3_000), tool('t1', 0, 'running'), text('s2', 50), tool('t2', 100)], false),
    ]
    expect(selectCompactionCut(blocked, { tailTokens: 1_000 })).toBeNull()
  })

  it('has no tail when the prefix would be empty or would end in a user message', () => {
    expect(selectCompactionCut([user('u', 100), assistant('a', [text('a-t', 100)])], { tailTokens: 20_000 })).toBeNull()
    expect(selectCompactionCut([user('u1', 3_000), user('u2', 100)], { tailTokens: 1_000 })).toBeNull()
    expect(selectCompactionCut([user('u', 100), assistant('a', [text('a-t', 100)])], { tailTokens: 0 })).toBeNull()
  })

  it('cuts only after the previous marker and keeps its summary on the next request', () => {
    const marker: MessagePart = { type: 'compaction', id: 'old', text: 'Earlier summary', strategy: 'summary' }
    const history = [
      user('u0', 9_000),
      assistant('a0', [text('a0-t', 9_000), marker, text('a0-after', 2_000)]),
      user('u1', 2_000),
      assistant('a1', [text('a1-t', 2_000)]),
    ]
    const active = activeChatContext(history).messages
    const cut = selectCompactionCut(active, { tailTokens: 5_000 })
    expect(cut).toMatchObject({ messageId: 'a0', afterPartId: 'a0-after' })
    expect(
      historyThroughCut(history, cut!)!
        .at(-1)!
        .parts.map((part) => part.id)
    ).toEqual(['a0-t', 'old', 'a0-after'])
  })

  it('projects summary plus verbatim tail to the model and native seeds without orphan tool results', () => {
    const history = [
      user('u1', 4_000),
      assistant('a1', [text('a1-t', 100), tool('t1', 4_000), text('a1-end', 100)]),
      user('u2', 1_000),
      assistant('a2', [text('a2-t', 100), tool('t2', 500), text('a2-end', 100)]),
    ]
    const cut = selectCompactionCut(history, { tailTokens: 5_000 })!
    expect(cut).toMatchObject({ messageId: 'a1', afterPartId: 'a1-end' })
    const projected = previewPositionalCompaction(
      history,
      { messageId: cut.messageId, afterPartId: cut.afterPartId, partId: 'new' },
      { type: 'compaction', id: 'new', text: 'Summary of turn one', strategy: 'summary' }
    )!
    const model = toModelMessages(projected)
    expect(model[0]).toMatchObject({ role: 'assistant', content: expect.stringContaining('Summary of turn one') })
    expect(model.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const calls = model.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-call') : []
    )
    const results = model.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-result') : []
    )
    expect(calls.map((part) => (part as { toolCallId: string }).toolCallId)).toEqual(['t2'])
    expect(results.map((part) => (part as { toolCallId: string }).toolCallId)).toEqual(['t2'])
    const seed = renderNativeSeedTranscript(projected)
    expect(seed.startsWith('Previous summary:\nSummary of turn one')).toBe(true)
    expect(seed).toContain(tokens(1_000))
    expect(seed).not.toContain(tokens(4_000))
  })

  it('bounds the tail by 20k, 12% of the window and 70% of it with summary, pending and reserve', () => {
    expect(compactionTailBudget(200_000)).toBe(20_000)
    expect(compactionTailBudget(128_000)).toBe(15_360)
    expect(compactionTailBudget(32_000)).toBe(3_840)
    expect(compactionTailBudget(200_000, 105_000)).toBe(5_000)
    expect(compactionTailBudget(200_000, 200_000)).toBe(0)
    expect(compactionTailBudget(undefined)).toBe(20_000)
  })
})

describe('summary carry-over around a cut', () => {
  it('carries the split turn request verbatim, once, and drops it when no longer split', () => {
    const history = [
      user('u1', 10),
      assistant('a1', [text('a1-t', 10)]),
      {
        ...user('u2', 0),
        parts: [{ type: 'text', id: 'u2-t', text: 'Refactor <approved_plan>\nstep\n</approved_plan> now' }],
      } as ChatMessage,
      assistant('live', [text('s1', 10), tool('t1', 10), text('s2', 10)], false),
    ]
    const request = turnRequestBeforeCut(history, { messageId: 'live', afterPartId: 't1' })
    expect(request).toBe('Refactor [approved plan, kept below] now')
    const once = summaryWithTurnRequest('## Objective\nx', request)
    const twice = summaryWithTurnRequest(once, request)
    expect(twice.match(/<current_turn_request>/g)).toHaveLength(1)
    expect(summaryWithTurnRequest(twice, null)).toBe('## Objective\nx')
  })

  it('removes a carried approved plan when the tail already holds it', () => {
    const plan = [user('p', 0)].map((message) => ({
      ...message,
      parts: [{ type: 'text' as const, id: 'p-t', text: '<approved_plan>\nDo it\n</approved_plan>' }],
    }))
    const carried = summaryWithApprovedPlan('## Objective\nx', plan)
    expect(carried).toContain('<approved_plan>')
    expect(summaryWithoutApprovedPlan(carried)).toBe('## Objective\nx')
  })
})
