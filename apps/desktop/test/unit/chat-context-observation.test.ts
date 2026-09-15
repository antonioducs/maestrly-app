import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import { applyChatEvent } from '../../src/shared/chat'
import type { ChatCompactionProgress, ChatContextSnapshot, ChatHistoryStats, ChatMessage } from '../../src/shared/chat'
import { resources } from '../../src/shared/i18n/resources'
import {
  compactionStatusText,
  contextMeterReading,
  formatContextTokens,
  selectContextObservation,
} from '../../src/renderer/components/chat/context-observation'

const model = { providerId: 'logical-provider', modelId: 'model-a' }
const target = { conversationId: 'conversation', model, streaming: true }
const snapshot = (patch: Partial<ChatContextSnapshot> = {}): ChatContextSnapshot => ({
  model,
  usedTokens: 80_100,
  modelContextWindow: 100_000,
  quality: 'measured',
  observedAt: 100,
  sequence: 1,
  ...patch,
})
const progress = (patch: Partial<ChatCompactionProgress> = {}): ChatCompactionProgress => ({
  id: 'compaction',
  status: 'running',
  phase: 'chunk',
  completed: 2,
  total: 5,
  updatedAt: 200,
  ...patch,
})
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'assistant',
  conversationId: target.conversationId,
  model,
  role: 'assistant',
  parts: [],
  createdAt: 1,
  contextSnapshot: snapshot(),
  ...patch,
})
const history: ChatHistoryStats = {
  lastUsage: null,
  perModel: [],
  modelIds: [],
  bytesSaved: 0,
  contextProjection: {
    usedTokens: 40_000,
    modelContextWindow: 200_000,
    quality: 'estimated',
    source: 'portable-transcript',
  },
}

describe('composer context observations', () => {
  it('shows manual progress on a completed assistant while keeping the last measured sample', () => {
    const current = progress({ scope: 'conversation', model })
    const result = selectContextObservation([message({ finishReason: 'stop', compactionProgress: current })], {
      ...target,
      streaming: false,
      compacting: true,
    })
    expect(result.progress?.status).toBe('running')
    expect(result.snapshot).toEqual(snapshot())
    expect(
      selectContextObservation([message({ finishReason: 'stop', compactionProgress: current })], {
        ...target,
        streaming: false,
        compacting: false,
      }).progress?.status
    ).toBe('cancelled')
  })

  it('shows a conversation compaction for the selected model on an older model message', () => {
    const current = progress({ scope: 'conversation', model })
    const result = selectContextObservation(
      [
        message({
          model: { ...model, modelId: 'old-model' },
          contextSnapshot: snapshot({ model: { ...model, modelId: 'old-model' } }),
          finishReason: 'stop',
          compactionProgress: current,
        }),
      ],
      { ...target, streaming: false, compacting: true }
    )
    expect(result.progress).toEqual(current)
    expect(result.snapshot).toBeUndefined()
  })

  it('updates from streamed events without waiting for a history stats refresh', () => {
    let messages = [message()]
    messages = applyChatEvent(messages, {
      kind: 'context-usage',
      messageId: 'assistant',
      snapshot: snapshot({ usedTokens: 80_900, sequence: 2, observedAt: 101 }),
    })
    const observed = selectContextObservation(messages, target)
    const reading = contextMeterReading(history, null, observed.snapshot, model)
    expect(reading.used).toBe(80_900)
    expect(reading.window).toBe(100_000)
    // A slower stats response remains a separately labelled next-request estimate.
    expect(
      contextMeterReading(
        { ...history, contextProjection: { ...history.contextProjection!, usedTokens: 41_000 } },
        null,
        observed.snapshot,
        model
      ).used
    ).toBe(80_900)
    expect(reading.projection?.usedTokens).toBe(40_000)
  })

  it('accepts lower measured context after compaction', () => {
    const messages = applyChatEvent(
      [message({ compactionProgress: progress({ status: 'completed', afterTokens: 20_000 }) })],
      {
        kind: 'context-usage',
        messageId: 'assistant',
        snapshot: snapshot({ usedTokens: 19_500, sequence: 2, observedAt: 201 }),
      }
    )
    expect(selectContextObservation(messages, target).snapshot).toMatchObject({
      usedTokens: 19_500,
      quality: 'measured',
    })
  })

  it('shows the reported post-compaction estimate while waiting for a measured sample', () => {
    const result = selectContextObservation(
      [
        message({
          compactionProgress: progress({ status: 'completed', afterTokens: 20_000 }),
        }),
      ],
      target
    )
    expect(result.snapshot).toMatchObject({ usedTokens: 20_000, quality: 'estimated', observedAt: 200 })
  })

  it('uses completion metadata on a fresh assistant without resurrecting the previous context', () => {
    const result = selectContextObservation(
      [
        message(),
        message({
          id: 'compact-assistant',
          contextSnapshot: undefined,
          compactionProgress: progress({ status: 'completed', afterTokens: 10_000 }),
        }),
      ],
      target
    )
    expect(result.snapshot).toMatchObject({ usedTokens: 10_000, quality: 'estimated' })
    expect(result.snapshot?.modelContextWindow).toBeUndefined()
  })

  it('does not reuse a pre-compaction observation when completion has no reduction sample', () => {
    expect(
      selectContextObservation([message({ compactionProgress: progress({ status: 'completed' }) })], target).snapshot
    ).toBeUndefined()
  })

  it('invalidates pre-compaction context even when completion shares its millisecond timestamp', () => {
    expect(
      selectContextObservation(
        [
          message({
            compactionProgress: progress({ status: 'completed', updatedAt: 100 }),
          }),
        ],
        target
      ).snapshot
    ).toBeUndefined()
  })

  it('keeps the final measured sample and failed stage after an error and JSON reload', () => {
    let messages = [message({ compactionProgress: progress({ status: 'retrying', attempt: 2 }) })]
    messages = applyChatEvent(messages, { kind: 'error', messageId: 'assistant', message: 'compaction failed' })
    const result = selectContextObservation(JSON.parse(JSON.stringify(messages)), { ...target, streaming: false })
    expect(result.snapshot).toEqual(snapshot())
    expect(result.progress).toMatchObject({ status: 'failed', completed: 2, total: 5, attempt: 2 })
    expect(messages[0].compactionProgress?.status).toBe('retrying')
  })

  it('retains measured context after a successful finish and reload', () => {
    const messages = applyChatEvent([message()], {
      kind: 'finish',
      messageId: 'assistant',
      finishReason: 'stop',
      responseDurationMs: 100,
    })
    expect(
      selectContextObservation(JSON.parse(JSON.stringify(messages)), { ...target, streaming: false }).snapshot
    ).toEqual(snapshot())
  })

  it.each(['running', 'retrying'] as const)('ends stale %s status after stream shutdown', (status) => {
    expect(
      selectContextObservation([message({ compactionProgress: progress({ status }) })], {
        ...target,
        streaming: false,
      }).progress?.status
    ).toBe('cancelled')
  })

  it('allows manual compaction progress while no response is streaming', () => {
    expect(
      selectContextObservation([message({ compactionProgress: progress() })], {
        ...target,
        streaming: false,
        compacting: true,
      }).progress?.status
    ).toBe('running')
  })

  it('does not revive an older unfinished compaction during the next response', () => {
    const result = selectContextObservation(
      [message({ compactionProgress: progress() }), message({ id: 'next', contextSnapshot: undefined })],
      target
    )
    expect(result.progress?.status).toBe('cancelled')
  })

  it.each([
    { ...model, modelId: 'model-b' },
    { ...model, providerId: 'another-provider' },
  ])('rejects observations after switching identity to %j', (other) => {
    expect(selectContextObservation([message()], { ...target, model: other }).snapshot).toBeUndefined()
    expect(contextMeterReading(null, null, snapshot(), other)).toMatchObject({ used: 0, window: undefined })
  })

  it('stops at a later model boundary even if an older sample matches the selected model', () => {
    expect(
      selectContextObservation(
        [
          message(),
          message({ id: 'other-model', model: { ...model, modelId: 'model-b' }, contextSnapshot: undefined }),
        ],
        target
      ).snapshot
    ).toBeUndefined()
  })

  it('rejects a mismatched snapshot even when the message model matches', () => {
    expect(
      selectContextObservation(
        [message({ contextSnapshot: snapshot({ model: { ...model, modelId: 'model-b' } }) })],
        target
      ).snapshot
    ).toBeUndefined()
  })

  it('does not restore an old sample when the picker switches away and back', () => {
    expect(selectContextObservation([message()], { ...target, after: 150 }).snapshot).toBeUndefined()
    expect(
      selectContextObservation([message({ contextSnapshot: snapshot({ observedAt: 151 }) })], {
        ...target,
        after: 150,
      }).snapshot?.observedAt
    ).toBe(151)
  })

  it('does not cross a later compaction marker', () => {
    const marker = message({
      id: 'summary',
      role: 'user',
      contextSnapshot: undefined,
      parts: [{ type: 'compaction', id: 'marker', text: 'Summary' }],
    })
    expect(selectContextObservation([message(), marker], target).snapshot).toBeUndefined()
  })

  it('does not reuse a legacy marker message’s attached pre-compaction observation', () => {
    expect(
      selectContextObservation(
        [
          message({
            parts: [{ type: 'compaction', id: 'marker', text: 'Summary' }],
          }),
        ],
        target
      ).snapshot
    ).toBeUndefined()
  })

  it('ignores observations from another conversation', () => {
    expect(
      selectContextObservation([message()], { ...target, conversationId: 'new-conversation' }).snapshot
    ).toBeUndefined()
  })

  it.each<Partial<ChatMessage>>([
    { internal: true },
    { executionScope: { kind: 'host', executionId: 'subagent-execution' } },
    { source: 'chatgpt-web-review-loop' },
    { source: 'maestrly-review-loop' },
    { reviewLoop: { loopId: 'loop', executionId: 'exec', iteration: 1, maxIterations: 2 } },
    { executionScope: { kind: 'review-loop', loopId: 'loop', executionId: 'exec', iteration: 1, maxIterations: 2 } },
  ])('ignores internal/review observations: %j', (scope) => {
    const result = selectContextObservation(
      [
        message(),
        message({
          ...scope,
          id: 'internal',
          model: { ...model, modelId: 'other' },
          contextSnapshot: snapshot({ usedTokens: 999_999 }),
          compactionProgress: progress(),
        }),
      ],
      target
    )
    expect(result.snapshot).toEqual(snapshot())
    expect(result.progress).toBeUndefined()
  })

  it('does not borrow the stale projection denominator for a new sample with no ceiling', () => {
    expect(
      contextMeterReading(history, null, snapshot({ modelContextWindow: undefined }), model).window
    ).toBeUndefined()
  })

  it('distinguishes estimates and accepts measured zero instead of reverting to old history', () => {
    expect(contextMeterReading(history, null, snapshot({ quality: 'estimated' }), model).quality).toBe('estimated')
    expect(contextMeterReading(history, null, snapshot({ usedTokens: 0 }), model).used).toBe(0)
  })
})

describe('localized compaction presentation', () => {
  const i18n = createInstance()
  void i18n.init({ resources, lng: 'en', fallbackLng: 'en', initAsync: false, defaultNS: 'chat' })
  const en = i18n.getFixedT('en', 'chat')
  const pt = i18n.getFixedT('pt-BR', 'chat')

  it('separates chunk progress, consolidation, and native compaction', () => {
    expect(compactionStatusText(progress(), en).label).toBe('Compacting — step 3/5')
    expect(compactionStatusText(progress({ phase: 'consolidate' }), en).label).toBe(
      'Compacting — consolidating summaries'
    )
    expect(compactionStatusText(progress({ phase: 'native' }), en).label).toBe('Compacting')
    expect(compactionStatusText(progress({ phase: 'chunk', completed: 5 }), en).label).toBe('Compacting — step 5/5')
  })

  it('shows the retry attempt at the same stage', () => {
    expect(compactionStatusText(progress({ status: 'retrying', attempt: 2 }), en).label).toBe(
      'Compacting — step 3/5 · Retrying this stage (attempt 2)'
    )
    expect(compactionStatusText(progress({ status: 'retrying', phase: 'consolidate' }), en).label).toBe(
      'Compacting — consolidating summaries · Retrying this stage'
    )
  })

  it('labels terminal states explicitly and marks estimated reductions', () => {
    expect(compactionStatusText(progress({ status: 'failed' }), en).label).toBe('Context compaction failed')
    expect(compactionStatusText(progress({ status: 'cancelled' }), en).label).toBe('Context compaction cancelled')
    const completed = progress({ status: 'completed', beforeTokens: 80_100, afterTokens: 20_300 })
    expect(compactionStatusText(completed, en)).toEqual({
      label: 'Context compacted',
      reduction: '80.1k → ~20.3k tokens',
    })
    expect(compactionStatusText({ ...completed, afterQuality: 'measured' }, en).reduction).toBe('80.1k → 20.3k tokens')
  })

  it('shows the original failure diagnostic in the visible status', () => {
    const failed = progress({ status: 'failed', error: 'The context compactor stage timed out' })
    expect(compactionStatusText(failed, en).label).toBe(
      'Context compaction failed: The context compactor stage timed out'
    )
    expect(compactionStatusText(failed, pt).label).toBe(
      'Falha ao compactar o contexto: The context compactor stage timed out'
    )
  })

  it('keeps token reduction changes outside the live announcement label', () => {
    const first = progress({ status: 'completed', beforeTokens: 80_100, afterTokens: 20_300 })
    const second = { ...first, afterTokens: 20_400, updatedAt: 201 }
    expect(compactionStatusText(first, en).label).toBe(compactionStatusText(second, en).label)
    expect(compactionStatusText(first, en).reduction).not.toBe(compactionStatusText(second, en).reduction)
  })

  it('translates phase, retry, completion, failure and cancellation in Portuguese', () => {
    expect(compactionStatusText(progress(), pt).label).toBe('Compactando — etapa 3/5')
    expect(compactionStatusText(progress({ phase: 'consolidate' }), pt).label).toBe(
      'Compactando — consolidando resumos'
    )
    expect(compactionStatusText(progress({ status: 'retrying', attempt: 2 }), pt).label).toContain('tentativa 2')
    expect(compactionStatusText(progress({ status: 'completed' }), pt).label).toBe('Contexto compactado')
    expect(compactionStatusText(progress({ status: 'failed' }), pt).label).toBe('Falha ao compactar o contexto')
    expect(compactionStatusText(progress({ status: 'cancelled' }), pt).label).toBe('Compactação do contexto cancelada')
  })

  it.each([
    [999, '999'],
    [80_100, '80.1k'],
    [80_900, '80.9k'],
    [999_900, '999.9k'],
    [1_200_000, '1.2M'],
  ] as const)('formats %i tokens as %s', (tokens, expected) => expect(formatContextTokens(tokens)).toBe(expected))
})
