import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ChatCompactionProgress, ChatStreamEvent } from '../../src/shared/chat'

const source = readFileSync(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const runCompactAsync = useCallback')
const body = source.slice(source.indexOf('\n', start), source.indexOf('\n  }, [', start))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Execute the actual callback with controlled IPC/history promises to cover ordering races.
function setup() {
  const compact = deferred<{ ok: boolean; error?: string }>()
  const history = deferred<void>()
  const dependencies = {
    streamingRef: { current: false },
    compactingRef: { current: false },
    localManualCompactionRef: { current: false },
    compactionRevisionRef: { current: 0 },
    visibleRef: { current: true },
    conversationId: 'conversation',
    window: { api: { chatCompact: vi.fn(() => compact.promise) } },
    setCompacting: vi.fn(),
    reloadLatestPage: vi.fn(() => history.promise),
    setCompactDismissed: vi.fn(),
    pushAssistantError: vi.fn(),
    t: (key: string) => key,
    setStreaming: vi.fn(),
    finishTurn: vi.fn(),
  }
  const run = new Function(...Object.keys(dependencies), `return async () => {${body}\n}`)(
    ...Object.values(dependencies)
  ) as () => Promise<boolean>
  return { ...dependencies, compact, history, run }
}

describe('manual compaction queue lifecycle', () => {
  it.each([
    { ok: true },
    { ok: false, error: 'too-short' },
  ])('releases queued sends once after IPC and history complete: %j', async (result) => {
    const h = setup()
    const pending = h.run()
    expect(h.compactingRef.current).toBe(true)
    expect(await h.run()).toBe(false)
    expect(h.window.api.chatCompact).toHaveBeenCalledTimes(1)
    h.compact.resolve(result)
    await Promise.resolve()
    expect(h.reloadLatestPage).toHaveBeenCalledOnce()
    expect(h.compactingRef.current).toBe(true)
    expect(h.finishTurn).not.toHaveBeenCalled()
    h.visibleRef.current = false
    h.history.resolve()
    expect(await pending).toBe(true)
    expect(h.compactingRef.current).toBe(false)
    expect(h.finishTurn).toHaveBeenCalledExactlyOnceWith(true)
    expect(h.compactionRevisionRef.current).toBe(2)
  })

  it('retains the queue on compaction failure', async () => {
    const h = setup()
    const pending = h.run()
    h.compact.resolve({ ok: false, error: 'failed' })
    expect(await pending).toBe(false)
    expect(h.finishTurn).not.toHaveBeenCalled()
    expect(h.compactingRef.current).toBe(false)
    expect(h.pushAssistantError).toHaveBeenCalledOnce()
  })

  it('retains the queue when history hydration rejects', async () => {
    const h = setup()
    h.reloadLatestPage.mockImplementationOnce(() => Promise.reject(new Error('history failed')))
    const pending = h.run()
    h.compact.resolve({ ok: true })
    expect(await pending).toBe(false)
    expect(h.finishTurn).not.toHaveBeenCalled()
    expect(h.compactingRef.current).toBe(false)
  })

  it('queues before steering and ignores done events during local manual compaction', () => {
    const submit = source.slice(
      source.indexOf('  const submitDraft = useCallback'),
      source.indexOf('  const searchFiles')
    )
    const compactBranch = submit.slice(
      submit.indexOf('if (compactingRef.current)'),
      submit.indexOf('if (streamingRef.current)')
    )
    expect(compactBranch).toContain('setQueueState((q) => [...q,')
    expect(compactBranch).toContain('return')
    expect(source).toContain('if (localManualCompactionRef.current) return')
    expect(source).toContain(
      'if (!localManualCompactionRef.current && compactionRevision === compactionRevisionRef.current)'
    )
  })
})

function setupStream() {
  const dependencies = {
    localManualCompactionRef: { current: false },
    compactingRef: { current: true },
    compactionRevisionRef: { current: 0 },
    streamingRef: { current: true },
    stoppedRef: { current: false },
    queueRef: { current: [{ text: 'queued', attachments: [], agentMentions: [] }] },
    setCompacting: vi.fn(),
    setStreaming: vi.fn(),
    setStopPending: vi.fn(),
    setQueueState: vi.fn(),
    doSend: vi.fn(),
  }
  const finishStart = source.indexOf('    (hidden = false) => {', source.indexOf('  const finishTurn'))
  const finishBody = source.slice(source.indexOf('\n', finishStart), source.indexOf('\n    },', finishStart))
  const finishTurn = new Function(...Object.keys(dependencies), `return (hidden = false) => {${finishBody}\n}`)(
    ...Object.values(dependencies)
  ) as (hidden?: boolean) => void
  const eventStart = source.indexOf("      if (event.kind === 'compaction-finished') {")
  const eventBody = source.slice(eventStart, source.indexOf("      if (kind === 'done')", eventStart))
  const onEvent = new Function(
    ...Object.keys(dependencies),
    'finishTurn',
    `return (event, hidden = false) => {${eventBody}}`
  )(...Object.values(dependencies), finishTurn) as (event: ChatStreamEvent, hidden?: boolean) => void
  return { ...dependencies, finishTurn, onEvent }
}

describe('hydrated compaction lifecycle', () => {
  it('drains preflight compaction on normal done', () => {
    const h = setupStream()
    h.finishTurn()
    expect(h.compactingRef.current).toBe(false)
    expect(h.doSend).toHaveBeenCalledOnce()
    expect(h.compactionRevisionRef.current).toBeGreaterThan(0)
  })

  it('drains manual compaction without a local promise, including hidden views', () => {
    const h = setupStream()
    h.onEvent({ kind: 'compaction-finished', status: 'completed' }, true)
    expect(h.compactingRef.current).toBe(false)
    expect(h.doSend).toHaveBeenCalledExactlyOnceWith('queued', [], [], false)
    expect(h.compactionRevisionRef.current).toBeGreaterThan(0)
  })

  it.each([
    'completed',
    'failed',
    'cancelled',
  ] as const)('leaves local manual completion to its promise: %s', (status) => {
    const h = setupStream()
    h.localManualCompactionRef.current = true
    h.onEvent({ kind: 'compaction-finished', status })
    h.finishTurn()
    expect(h.compactingRef.current).toBe(true)
    expect(h.doSend).not.toHaveBeenCalled()
    expect(h.compactionRevisionRef.current).toBe(0)
  })

  it.each(['failed', 'cancelled'] as const)('retains queued messages after hydrated manual %s', (status) => {
    const h = setupStream()
    h.onEvent({ kind: 'compaction-finished', status })
    expect(h.compactingRef.current).toBe(false)
    expect(h.streamingRef.current).toBe(false)
    expect(h.doSend).not.toHaveBeenCalled()
    expect(h.setQueueState).not.toHaveBeenCalled()
  })
})

describe('external preflight compaction lifecycle', () => {
  it.each([false, true])('reserves an idle composer until done (hidden=%s)', (hidden) => {
    const h = setupStream()
    h.compactingRef.current = false
    h.streamingRef.current = false
    // Approved-plan execution starts outside this view, before any user-saved event.
    const progress = {
      kind: 'compaction-progress',
      messageId: 'previous-assistant',
      progress: { id: 'preflight', scope: 'conversation', status: 'running', updatedAt: 1 },
    } satisfies ChatStreamEvent
    h.onEvent(progress, hidden)
    expect(h.compactingRef.current).toBe(true)
    expect(h.streamingRef.current).toBe(true)
    expect(h.compactionRevisionRef.current).toBeGreaterThan(0)
    if (!hidden) expect(h.setStreaming).toHaveBeenCalledWith(true)

    const submit = source.slice(source.indexOf('  const submitDraft = useCallback'))
    const compactBranch = submit.slice(
      submit.indexOf('      if (compactingRef.current)'),
      submit.indexOf('      if (streamingRef.current)')
    )
    const queue = vi.fn()
    const sendOrSteer = vi.fn()
    const route = new Function(
      'compactingRef',
      'setQueueState',
      'sendOrSteer',
      'text',
      'atts',
      'agentMentions',
      `${compactBranch}\nsendOrSteer()`
    )
    route(h.compactingRef, queue, sendOrSteer, 'follow-up', [], [])
    expect(queue).toHaveBeenCalledOnce()
    expect(queue.mock.calls[0][0]([])).toEqual([expect.objectContaining({ text: 'follow-up' })])
    expect(sendOrSteer).not.toHaveBeenCalled()

    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      h.onEvent({ ...progress, progress: { ...progress.progress, status } }, hidden)
      expect(h.compactingRef.current).toBe(true)
      expect(h.streamingRef.current).toBe(true)
      expect(h.doSend).not.toHaveBeenCalled()
    }
    h.finishTurn(hidden)
    expect(h.compactingRef.current).toBe(false)
    expect(h.streamingRef.current).toBe(false)
    expect(h.doSend).toHaveBeenCalledExactlyOnceWith('queued', [], [], !hidden)
  })

  it('does not reserve an idle composer for turn-scoped or completed progress', () => {
    const h = setupStream()
    h.compactingRef.current = false
    h.streamingRef.current = false
    const observations: ChatCompactionProgress[] = [
      { id: 'turn', scope: 'turn', status: 'running', updatedAt: 1 },
      { id: 'preflight', scope: 'conversation', status: 'completed', updatedAt: 2 },
    ]
    for (const progress of observations) {
      h.onEvent({ kind: 'compaction-progress', messageId: 'previous-assistant', progress })
    }
    expect(h.compactingRef.current).toBe(false)
    expect(h.streamingRef.current).toBe(false)
    expect(h.setStreaming).not.toHaveBeenCalled()
  })
})
