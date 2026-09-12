import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

/**
 * Shared reclaimer sweep semantics (review loop round 7).
 * Partial eviction trims a cache to a target instead of emptying it.
 * Credit only the actual freed delta against working set, not the total estimate,
 * or hard sweeps would cross the soft limit while bytes remain resident.
 * Old worker deadlines must not evict a worker that became busy and then idle again.
 * Count the full TTL from the new idle epoch for both ASR pending drains
 * and RAG inFlight drains.
 */

const h = vi.hoisted(() => ({
  getAppFlag: vi.fn(() => true),
  setAppFlag: vi.fn(),
  broadcast: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getAppFlag: h.getAppFlag,
  setAppFlag: h.setAppFlag,
}))

vi.mock('../../src/main/window-ipc', () => ({
  broadcast: h.broadcast,
}))

const {
  disposeMemoryReclaimer,
  noteMemorySample,
  registerReclaimable,
  runMemoryReclaim,
  setMemoryAutoReclaimEnabledForTests,
} = await import('../../src/main/performance/memory-reclaimer')
const { memoryPressureLimits } = await import('../../src/main/performance/policy')
const { WORKER_IDLE_TTL_MS } = await import('../../src/shared/memory-policy')

const limits = memoryPressureLimits(os.totalmem())
const MiB = 1024 * 1024

beforeEach(() => {
  vi.useFakeTimers()
  h.broadcast.mockReset()
  setMemoryAutoReclaimEnabledForTests(true)
})
afterEach(() => {
  disposeMemoryReclaimer()
  setMemoryAutoReclaimEnabledForTests(null)
  vi.useRealTimers()
})

describe('partial eviction accounting', () => {
  it('credits the actual released delta from 64 to 16 MiB rather than the remaining bytes', async () => {
    // Like the tool-image cache, eviction trims an estimated 64 MiB to 16 MiB.
    let cacheBytes = 64 * MiB
    let tailEvicted = false
    registerReclaimable({
      key: 'partial-cache',
      kind: 'cache',
      lastActiveAt: () => Date.now(),
      coldTtlMs: 60_000,
      priority: 10,
      estimatedBytes: () => cacheBytes,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: () => {
        cacheBytes = 16 * MiB
      },
    })
    registerReclaimable({
      key: 'tail-cache',
      kind: 'cache',
      lastActiveAt: () => Date.now(),
      coldTtlMs: 60_000,
      priority: 20,
      estimatedBytes: () => 20 * MiB,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: () => {
        tailEvicted = true
      },
    })

    // Releasing 48 MiB crosses a soft limit exceeded by 32 MiB, preserving tail-cache.
    // Reading the remaining 16 MiB after eviction would undercount released memory,
    // incorrectly continuing the sweep and evicting tail-cache as well.
    noteMemorySample({ workingSetBytes: limits.soft + 32 * MiB })

    const result = await runMemoryReclaim('hard')
    expect(result.evicted).toContain('partial-cache')
    expect(result.evicted).not.toContain('tail-cache')
    expect(tailEvicted).toBe(false)
  })

  it('credits the full total when eviction empties a resource', async () => {
    let emptyBytes = 40 * MiB
    let midBytes = 10 * MiB
    let lastEvicted = false
    registerReclaimable({
      key: 'empty-cache',
      kind: 'cache',
      lastActiveAt: () => Date.now(),
      coldTtlMs: 60_000,
      priority: 10,
      estimatedBytes: () => emptyBytes,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: () => {
        emptyBytes = 0
      },
    })
    registerReclaimable({
      key: 'mid-cache',
      kind: 'cache',
      lastActiveAt: () => Date.now(),
      coldTtlMs: 60_000,
      priority: 20,
      estimatedBytes: () => midBytes,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: () => {
        midBytes = 0
      },
    })
    registerReclaimable({
      key: 'last-cache',
      kind: 'cache',
      lastActiveAt: () => Date.now(),
      coldTtlMs: 60_000,
      priority: 30,
      estimatedBytes: () => 5 * MiB,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: () => {
        lastEvicted = true
      },
    })

    // With 45 MiB above soft, emptying 40 MiB leaves roughly 5 MiB above soft.
    // Continue to mid-cache, then preserve last-cache. Crediting zero after emptying
    // would incorrectly evict last-cache too.
    noteMemorySample({ workingSetBytes: limits.soft + 45 * MiB })

    const result = await runMemoryReclaim('hard')
    expect(result.evicted).toContain('empty-cache')
    expect(result.evicted).toContain('mid-cache')
    expect(result.evicted).not.toContain('last-cache')
    expect(lastEvicted).toBe(false)
  })
})

describe('worker TTL starts at the new idle epoch and is not shortened by an old deadline', () => {
  // ASR drains through pending settlement; RAG drains through saveCardMemory finally.
  // Both resources stay hot while busy and update their idle epoch on draining.
  for (const busySource of ['pending', 'inFlight'] as const) {
    it(`old deadline, busy ${busySource}, then full TTL from the new idle epoch`, async () => {
      let pending = false
      let inFlight = false
      let idleSince = Date.now()
      let evictedAt: number | null = null
      const busy = (): boolean => pending || inFlight
      registerReclaimable({
        key: 'worker',
        kind: 'worker',
        lastActiveAt: () => (busy() ? Date.now() : idleSince),
        coldTtlMs: WORKER_IDLE_TTL_MS,
        priority: 12,
        protection: () => (busy() ? { protected: true, reasons: [busySource] } : { protected: false, reasons: [] }),
        prepare: async () => ({ ok: !busy() }),
        evict: () => {
          evictedAt = Date.now()
        },
      })

      // After four idle minutes, the old idleSince-plus-TTL deadline is scheduled.
      await vi.advanceTimersByTimeAsync(4 * 60_000)

      // Ten seconds of busy work starts a new idle epoch without notifying the reclaimer.
      // Even without notification, the sweep at the old deadline must preserve the worker.
      if (busySource === 'pending') pending = true
      else inFlight = true
      await vi.advanceTimersByTimeAsync(10_000)
      pending = false
      inFlight = false
      idleSince = Date.now()

      // The old deadline fires roughly fifty seconds after work ends.
      await vi.advanceTimersByTimeAsync(50_000)
      expect(evictedAt).toBeNull()

      // Count the full TTL from the new idle epoch.
      await vi.advanceTimersByTimeAsync(WORKER_IDLE_TTL_MS)
      expect(evictedAt).not.toBeNull()
      expect(evictedAt).toBeGreaterThanOrEqual(idleSince + WORKER_IDLE_TTL_MS - 1_000)
    })
  }
})
