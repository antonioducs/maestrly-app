import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSync, type SyncDeps, type SyncElement } from '../src/sync'

const el = (id: string, version: number, extra: Record<string, unknown> = {}): SyncElement => ({
  id,
  version,
  ...extra,
})

function setup(overrides: Partial<SyncDeps> = {}) {
  const pushes: SyncElement[][] = []
  const applied: SyncElement[][] = []
  const onReadOnly = vi.fn()
  const deps: SyncDeps = {
    push: vi.fn(async (elements: readonly SyncElement[]) => {
      pushes.push([...elements])
      return { revision: pushes.length, kept: [] }
    }),
    apply: (elements) => applied.push([...elements]),
    onReadOnly,
    ...overrides,
  }
  return { sync: createSync(deps), deps, pushes, applied, onReadOnly }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('canvas sync', () => {
  it('sends the newest copy of what changed once, after the interval', async () => {
    const { sync, pushes } = setup()
    sync.local([el('a', 2), el('b', 1)])
    await vi.advanceTimersByTimeAsync(100)
    sync.local([el('a', 3), el('b', 1)])
    await vi.advanceTimersByTimeAsync(299)
    expect(pushes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(pushes).toEqual([[el('a', 3), el('b', 1)]])
    sync.local([el('a', 3), el('b', 1)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(pushes).toHaveLength(1)
  })

  it('never sends back what it received from the host', async () => {
    const { sync, pushes, applied } = setup()
    sync.remote([el('a', 5)])
    expect(applied).toEqual([[el('a', 5)]])
    sync.local([el('a', 5)])
    await vi.advanceTimersByTimeAsync(1000)
    expect(pushes).toEqual([])
    sync.local([el('a', 6)])
    await vi.advanceTimersByTimeAsync(400)
    expect(pushes).toEqual([[el('a', 6)]])
  })

  it('sends one batch at a time, and what changed meanwhile after it', async () => {
    let release: () => void = () => {}
    const calls: SyncElement[][] = []
    let active = 0
    let most = 0
    const { sync } = setup({
      push: async (elements) => {
        calls.push([...elements])
        active++
        most = Math.max(most, active)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        active--
        return { revision: calls.length, kept: [] }
      },
    })
    sync.local([el('a', 2)])
    await vi.advanceTimersByTimeAsync(400)
    expect(calls).toHaveLength(1)
    sync.local([el('b', 2)])
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(400)
    expect(calls).toEqual([[el('a', 2)], [el('b', 2)]])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(most).toBe(1)
  })

  it('splits what it sends into batches of at most a thousand elements', async () => {
    const { sync, pushes } = setup()
    sync.local(Array.from({ length: 2500 }, (_, i) => el(`e${i}`, 2)))
    await vi.advanceTimersByTimeAsync(400)
    expect(pushes.map((batch) => batch.length)).toEqual([1000, 1000, 500])
  })

  it('splits batches by size too', async () => {
    const { sync, pushes } = setup({ maxBytes: 1000 })
    sync.local(Array.from({ length: 6 }, (_, i) => el(`e${i}`, 2, { text: 'x'.repeat(280) })))
    await vi.advanceTimersByTimeAsync(400)
    expect(pushes.map((batch) => batch.length)).toEqual([3, 3])
  })

  it('applies the host copy of what it refused', async () => {
    const { sync, applied } = setup({
      push: async () => ({ revision: 9, kept: [el('a', 7, { x: 1 })] }),
    })
    sync.local([el('a', 2)])
    await vi.advanceTimersByTimeAsync(400)
    expect(applied).toEqual([[el('a', 7, { x: 1 })]])
  })

  it('stops sending once the board is read-only', async () => {
    const push = vi.fn(async () => {
      throw Object.assign(new Error('maestrly: read_only'), { code: 'read_only' })
    })
    const { sync, onReadOnly } = setup({ push })
    sync.local([el('a', 2)])
    await vi.advanceTimersByTimeAsync(400)
    expect(onReadOnly).toHaveBeenCalledTimes(1)
    sync.local([el('a', 3)])
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).toHaveBeenCalledTimes(1)
    expect(onReadOnly).toHaveBeenCalledTimes(1)
  })

  it('keeps what it could not send and tries again later', async () => {
    let fail = true
    const sent: SyncElement[][] = []
    const { sync } = setup({
      push: async (elements) => {
        if (fail) throw Object.assign(new Error('maestrly: failed'), { code: 'failed' })
        sent.push([...elements])
        return { revision: 1, kept: [] }
      },
    })
    sync.local([el('a', 2)])
    await vi.advanceTimersByTimeAsync(400)
    expect(sent).toEqual([])
    fail = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([[el('a', 2)]])
  })

  it('flushes at once when asked', async () => {
    const { sync, pushes } = setup()
    sync.local([el('a', 2)])
    await sync.flush()
    expect(pushes).toEqual([[el('a', 2)]])
  })
})
