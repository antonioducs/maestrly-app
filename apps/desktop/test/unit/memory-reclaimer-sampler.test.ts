import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

/**
 * Reclaimer pressure sampling regression (review loop round 2).
 * Pressure events, renderer hard-pressure eviction and pressure-based reclaim must update
 * without opening Settings or manually requesting a snapshot.
 * The reclaimer owns one unreferenced 30-second interval.
 * Registration samples immediately before the first tick.
 * Sampling is single-flight so slow ticks never accumulate.
 * The kill switch pauses sampling and dispose stops it.
 * Falling working-set size restores normal pressure instead of leaving hardPressure sticky.
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
  getMemoryReclaimerSnapshot,
  registerPressureSampleSource,
  setMemoryAutoReclaimEnabled,
  setMemoryAutoReclaimEnabledForTests,
} = await import('../../src/main/performance/memory-reclaimer')
const { memoryPressureLimits, PRESSURE_SAMPLE_INTERVAL_MS } = await import('../../src/main/performance/policy')

const limits = memoryPressureLimits(os.totalmem())

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

describe('reclaimer memory-pressure sampler', () => {
  it('samples immediately on registration and every tick, updating pressure and working set', async () => {
    let sample = { workingSetBytes: 0 }
    registerPressureSampleSource(() => sample)
    await vi.advanceTimersByTimeAsync(0)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('normal')

    // Rising hard pressure broadcasts an event.
    sample = { workingSetBytes: limits.hard }
    await vi.advanceTimersByTimeAsync(PRESSURE_SAMPLE_INTERVAL_MS)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('hard')
    expect(getMemoryReclaimerSnapshot().workingSetBytes).toBe(limits.hard)
    expect(h.broadcast).toHaveBeenCalledWith('performance:memory-pressure', expect.objectContaining({ level: 'hard' }))

    // Falling memory use restores normal pressure and clears renderer hardPressure.
    sample = { workingSetBytes: 0 }
    await vi.advanceTimersByTimeAsync(PRESSURE_SAMPLE_INTERVAL_MS)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('normal')
    expect(h.broadcast).toHaveBeenCalledWith(
      'performance:memory-pressure',
      expect.objectContaining({ level: 'normal' })
    )
  })

  it('skips ticks while a sample is already in flight', async () => {
    let calls = 0
    registerPressureSampleSource(
      () =>
        new Promise<{ workingSetBytes: number }>(() => {
          calls++ // Never resolve, keeping the tick busy.
        })
    )
    await vi.advanceTimersByTimeAsync(PRESSURE_SAMPLE_INTERVAL_MS * 5)
    expect(calls).toBe(1)
  })

  it('normalizes pressure when disabled and samples immediately when reenabled', async () => {
    let calls = 0
    let sample = { workingSetBytes: limits.hard }
    registerPressureSampleSource(() => {
      calls++
      return sample
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('hard')
    expect(getMemoryReclaimerSnapshot().workingSetBytes).toBe(limits.hard)
    const afterHardSample = calls
    h.broadcast.mockClear()

    setMemoryAutoReclaimEnabledForTests(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('normal')
    expect(getMemoryReclaimerSnapshot().workingSetBytes).toBe(limits.hard)
    expect(h.broadcast).toHaveBeenCalledWith(
      'performance:memory-pressure',
      expect.objectContaining({ level: 'normal', workingSetBytes: limits.hard })
    )

    await vi.advanceTimersByTimeAsync(PRESSURE_SAMPLE_INTERVAL_MS * 3)
    expect(calls).toBe(afterHardSample) // No ticks while reclaim is disabled.

    sample = { workingSetBytes: 0 }
    setMemoryAutoReclaimEnabledForTests(true)
    expect(calls).toBe(afterHardSample + 1) // Reenabling samples immediately.
    await vi.advanceTimersByTimeAsync(0)
    expect(getMemoryReclaimerSnapshot().pressure).toBe('normal')
  })

  it('publishes kill-switch changes to renderers', async () => {
    setMemoryAutoReclaimEnabled(false)

    await vi.waitFor(() => {
      expect(h.broadcast).toHaveBeenCalledWith('performance:auto-reclaim-changed', { enabled: false })
    })
  })

  it('stops permanently on disposal', async () => {
    let calls = 0
    registerPressureSampleSource(() => {
      calls++
      return { workingSetBytes: 0 }
    })
    await vi.advanceTimersByTimeAsync(0)
    const beforeDispose = calls

    disposeMemoryReclaimer()
    await vi.advanceTimersByTimeAsync(PRESSURE_SAMPLE_INTERVAL_MS * 3)
    expect(calls).toBe(beforeDispose)
  })
})
