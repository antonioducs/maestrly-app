import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import { isContextOverflowError } from '../../src/main/chat/compaction/overflow'
import {
  FALLBACK_SUMMARY_MAX_CHARS,
  FALLBACK_SUMMARY_NOTICE,
  fallbackCompactionSummary,
} from '../../src/main/chat/compaction/fallback-summary'
import { auditCompactionSummary } from '../../src/main/chat/compaction/summary-prompt'
import {
  automaticCompactionSuspended,
  compactionBreakerKey,
  recordAutomaticCompaction,
  resetCompactionBreaker,
} from '../../src/main/chat/compaction/breaker'

const message = (id: string, role: 'user' | 'assistant', parts: MessagePart[]): ChatMessage => ({
  id,
  conversationId: 'c',
  role,
  createdAt: 0,
  parts,
})
const text = (id: string, value: string): MessagePart => ({ type: 'text', id, text: value })

describe('context overflow classification', () => {
  it.each([
    new Error("This model's maximum context length is 128000 tokens"),
    new Error('prompt is too long: 210000 tokens > 200000 maximum'),
    Object.assign(new Error('Request failed'), { statusCode: 413 }),
    Object.assign(new Error('bad request'), { code: 'context_length_exceeded' }),
    new Error('wrapped', { cause: new Error('input is too long for requested model') }),
  ])('recognizes %s', (error) => {
    expect(isContextOverflowError(error)).toBe(true)
  })

  it.each([new Error('rate limit reached'), new Error('Unauthorized'), Object.assign(new Error('x'), { status: 500 })])(
    'leaves other failures alone: %s',
    (error) => {
      expect(isContextOverflowError(error)).toBe(false)
    }
  )
})

describe('fallback compaction summary', () => {
  const history = [
    message('u1', 'user', [text('u1-t', 'First request: migrate `db.ts`.')]),
    message('a1', 'assistant', [
      text('a1-t', 'Working.'),
      {
        type: 'tool',
        id: 't1',
        toolCallId: 't1',
        toolName: 'mcp__maestrly__read',
        input: { path: 'src/db.ts' },
        state: { status: 'completed', output: 'contents' },
      },
      {
        type: 'tool',
        id: 't2',
        toolCallId: 't2',
        toolName: 'bash',
        input: { command: 'npm test' },
        state: { status: 'error', error: 'Error: 3 tests failed\nstack' },
      },
    ]),
    message('u2', 'user', [text('u2-t', 'Second request: keep the old API.')]),
  ]

  it('keeps the structured sections, the latest requests verbatim, files, tools and errors', () => {
    const summary = fallbackCompactionSummary(history)
    expect(summary.startsWith(FALLBACK_SUMMARY_NOTICE)).toBe(true)
    expect(summary).toContain('history_search')
    expect(auditCompactionSummary(summary)).toEqual([])
    expect(summary).toContain('"First request: migrate `db.ts`."')
    expect(summary).toContain('"Second request: keep the old API."')
    expect(summary).toContain('`src/db.ts`')
    expect(summary).toContain('read, bash')
    expect(summary).toContain('bash: Error: 3 tests failed')
    expect(summary).not.toContain('stack')
  })

  it('carries the previous summary, demoting its headings, within the size cap', () => {
    const previous: MessagePart = {
      type: 'compaction',
      id: 'old',
      text: `## Objective\nEARLIER_OBJECTIVE\n${'detail '.repeat(5_000)}`,
      strategy: 'summary',
    }
    const summary = fallbackCompactionSummary([message('a0', 'assistant', [previous]), ...history])
    expect(summary).toContain('Previous summary, carried over unchanged:')
    expect(summary).toContain('#### Objective\nEARLIER_OBJECTIVE')
    expect(summary.length).toBeLessThanOrEqual(FALLBACK_SUMMARY_MAX_CHARS)
    expect(auditCompactionSummary(summary)).toEqual([])
  })
})

describe('automatic compaction breaker', () => {
  const key = compactionBreakerKey('provider', 'model', 100_000)
  const ineffective = { before: 95_000, after: 92_000, threshold: 90_000 }

  it('suspends after two ineffective rounds until the context grows by 10% of the window', () => {
    resetCompactionBreaker('a')
    expect(recordAutomaticCompaction('a', key, ineffective)).toEqual({ ineffective: true, suspended: false })
    expect(recordAutomaticCompaction('a', key, ineffective)).toEqual({ ineffective: true, suspended: true })
    expect(
      automaticCompactionSuspended('a', key, { usedTokens: 95_000, contextWindow: 100_000, overflow: false })
    ).toBe(true)
    expect(
      automaticCompactionSuspended('a', key, { usedTokens: 102_000, contextWindow: 100_000, overflow: false })
    ).toBe(false)
    // Lifting the suspension starts the count over.
    expect(recordAutomaticCompaction('a', key, ineffective).suspended).toBe(false)
  })

  it('never suspends on an overflow, an effective round, a manual compaction or another model', () => {
    resetCompactionBreaker('b')
    recordAutomaticCompaction('b', key, ineffective)
    expect(recordAutomaticCompaction('b', key, { before: 95_000, after: 40_000, threshold: 90_000 }).ineffective).toBe(
      false
    )
    expect(recordAutomaticCompaction('b', key, ineffective).suspended).toBe(false)
    recordAutomaticCompaction('b', key, ineffective)
    expect(automaticCompactionSuspended('b', key, { usedTokens: 92_000, contextWindow: 100_000, overflow: true })).toBe(
      false
    )
    recordAutomaticCompaction('b', key, ineffective)
    recordAutomaticCompaction('b', key, ineffective)
    const other = compactionBreakerKey('provider', 'other-model', 100_000)
    expect(
      automaticCompactionSuspended('b', other, { usedTokens: 92_000, contextWindow: 100_000, overflow: false })
    ).toBe(false)
    recordAutomaticCompaction('b', key, ineffective)
    recordAutomaticCompaction('b', key, ineffective)
    resetCompactionBreaker('b')
    expect(
      automaticCompactionSuspended('b', key, { usedTokens: 92_000, contextWindow: 100_000, overflow: false })
    ).toBe(false)
  })

  it('counts a round that saves less than 10% as ineffective even below the threshold', () => {
    resetCompactionBreaker('c')
    expect(recordAutomaticCompaction('c', key, { before: 80_000, after: 75_000, threshold: 90_000 }).ineffective).toBe(
      true
    )
  })
})
