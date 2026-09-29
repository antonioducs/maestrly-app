import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type RecycleStatus,
  RuntimeRecycleScheduler,
  blocksRuntimeRecycle,
} from '../../src/main/fleet/instance/runtime-recycle'

function idle(): RecycleStatus {
  return { turn: { state: 'idle', startedAt: null, inputId: null }, queue: [], pending: [], compaction: null }
}

function compaction(
  progress: 'running' | 'retrying' | 'completed' | null,
  background: 'idle' | 'running' = 'idle'
): RecycleStatus['compaction'] {
  return {
    configured: true,
    problem: null,
    background: { status: background, error: null },
    progress: progress
      ? {
          id: 'compaction-1',
          status: progress,
          phase: null,
          completed: null,
          total: null,
          attempt: null,
          beforeTokens: null,
          afterTokens: null,
          afterQuality: null,
          error: null,
          updatedAt: '2026-09-29T12:00:00.000Z',
        }
      : null,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('blocksRuntimeRecycle', () => {
  it('blocks while a bot has a turn, a queue, a pending request or a compaction in progress', () => {
    expect(blocksRuntimeRecycle(idle())).toBe(false)
    expect(blocksRuntimeRecycle({ ...idle(), turn: { state: 'running', startedAt: null, inputId: null } })).toBe(true)
    expect(blocksRuntimeRecycle({ ...idle(), turn: { state: 'cancelling', startedAt: null, inputId: null } })).toBe(
      true
    )
    expect(blocksRuntimeRecycle({ ...idle(), queue: [{ inputId: 'input-1', source: 'owner', preview: 'Hi' }] })).toBe(
      true
    )
    expect(blocksRuntimeRecycle({ ...idle(), pending: [{} as RecycleStatus['pending'][number]] })).toBe(true)
    expect(blocksRuntimeRecycle({ ...idle(), compaction: compaction('running') })).toBe(true)
    expect(blocksRuntimeRecycle({ ...idle(), compaction: compaction('retrying') })).toBe(true)
    expect(blocksRuntimeRecycle({ ...idle(), compaction: compaction(null, 'running') })).toBe(true)
    expect(blocksRuntimeRecycle({ ...idle(), compaction: compaction('completed') })).toBe(false)
  })
})

describe('RuntimeRecycleScheduler', () => {
  function harness(initial: RecycleStatus[], results: boolean[] = [true]) {
    let statuses = initial
    const recycle = vi.fn(async () => results.shift() ?? true)
    const scheduler = new RuntimeRecycleScheduler({ statuses: async () => statuses, recycle, intervalMs: 30_000 })
    return {
      scheduler,
      recycle,
      set(next: RecycleStatus[]) {
        statuses = next
      },
    }
  }

  it('waits until every bot is idle, then recycles once', async () => {
    const busy = { ...idle(), turn: { state: 'running' as const, startedAt: null, inputId: null } }
    const { scheduler, recycle, set } = harness([idle(), busy])
    scheduler.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(recycle).not.toHaveBeenCalled()

    set([idle(), idle()])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(recycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recycle).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(recycle).toHaveBeenCalledTimes(1)
  })

  it('tries again at the next interval when a connection could not be recycled', async () => {
    const { scheduler, recycle } = harness([idle()], [false, true])
    scheduler.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(recycle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(recycle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(recycle).toHaveBeenCalledTimes(2)
  })

  it('stops checking once disposed', async () => {
    const busy = { ...idle(), pending: [{} as RecycleStatus['pending'][number]] }
    const { scheduler, recycle, set } = harness([busy])
    scheduler.request()
    await vi.advanceTimersByTimeAsync(0)
    scheduler.dispose()
    set([idle()])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(recycle).not.toHaveBeenCalled()
    scheduler.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(recycle).not.toHaveBeenCalled()
  })
})
