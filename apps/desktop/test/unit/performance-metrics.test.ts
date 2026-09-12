import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Electron reports KiB; owned RSS, caches, thresholds, and the reclaimer use bytes. Verify normalization at metrics.ts for totals, webContents attribution, and pressure samples. */

const h = vi.hoisted(() => {
  const noteMemorySample = vi.fn()
  const registerPressureSampleSource = vi.fn()
  const getMemoryReclaimerSnapshot = vi.fn(() => ({
    enabled: true,
    pressure: 'normal',
    softLimitBytes: 0,
    hardLimitBytes: 0,
    workingSetBytes: 0,
    lastSweepAt: null,
    nextDeadlineAt: null,
    resources: [],
    hot: 0,
    cold: 0,
    protectedCount: 0,
  }))
  const describeReclaimableResources = vi.fn(async () => [])
  const getResourceGovernorDiagnostics = vi.fn(() => ({
    total: 0,
    fullSpeed: 0,
    throttled: 0,
    activeAgentLeases: 0,
    byKind: {
      browser: { total: 0, fullSpeed: 0, throttled: 0 },
      chatgpt: { total: 0, fullSpeed: 0, throttled: 0 },
      vscode: { total: 0, fullSpeed: 0, throttled: 0 },
      panel: { total: 0, fullSpeed: 0, throttled: 0 },
    },
  }))
  const collectOwnedProcessSnapshots = vi.fn<() => Promise<unknown[]>>(async () => [])
  const ownedProcessRegistryFingerprint = vi.fn(() => '')
  const refreshOwnedProcessTree = vi.fn<() => Promise<Map<number, number[]>>>(async () => new Map())
  const getAppMetrics = vi.fn<() => unknown[]>(() => [])
  const destroyed = new Set<object>()
  const wcRegistry: Array<{ wc: object; getOSProcessId: () => number; isDestroyed: () => boolean; once: () => void }> =
    []
  return {
    noteMemorySample,
    registerPressureSampleSource,
    getMemoryReclaimerSnapshot,
    describeReclaimableResources,
    getResourceGovernorDiagnostics,
    collectOwnedProcessSnapshots,
    ownedProcessRegistryFingerprint,
    refreshOwnedProcessTree,
    getAppMetrics,
    destroyed,
    wcRegistry,
  }
})

vi.mock('electron', () => ({
  app: { getAppMetrics: h.getAppMetrics },
}))

vi.mock('../../src/main/performance/resource-governor', () => ({
  getResourceGovernorDiagnostics: h.getResourceGovernorDiagnostics,
}))

vi.mock('../../src/main/performance/owned-processes', () => ({
  collectOwnedProcessSnapshots: h.collectOwnedProcessSnapshots,
  ownedProcessRegistryFingerprint: h.ownedProcessRegistryFingerprint,
  refreshOwnedProcessTree: h.refreshOwnedProcessTree,
}))

vi.mock('../../src/main/performance/memory-reclaimer', () => ({
  noteMemorySample: h.noteMemorySample,
  registerPressureSampleSource: h.registerPressureSampleSource,
  getMemoryReclaimerSnapshot: h.getMemoryReclaimerSnapshot,
  describeReclaimableResources: h.describeReclaimableResources,
}))

const { getPerformanceDiagnostics, registerPerformanceWebContents, unregisterPerformanceWebContents } = await import(
  '../../src/main/performance/metrics'
)
const { registerPerformanceCache, unregisterPerformanceCache } = await import('../../src/main/performance/metrics')
const { EXTERNAL_RSS_SAMPLE_INTERVAL_MS } = await import('../../src/shared/memory-policy')

/** ProcessMetric in Electron format, with memory in KiB. */
function processMetric(pid: number, name: string, workingSetKiB: number, peakKiB: number, privateKiB?: number) {
  return {
    pid,
    name,
    type: 'Tab',
    creationTime: Date.now() - 1000,
    cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0 },
    memory: {
      workingSetSize: workingSetKiB,
      peakWorkingSetSize: peakKiB,
      ...(privateKiB != null ? { privateBytes: privateKiB } : {}),
    },
  }
}

beforeEach(() => {
  h.noteMemorySample.mockReset()
  // Keep registerPressureSampleSource history: registration happens once on module load.
  // Its dedicated assertion relies on the calls accumulated since import.
  h.getAppMetrics.mockReset()
  h.collectOwnedProcessSnapshots.mockReset().mockResolvedValue([])
  h.ownedProcessRegistryFingerprint.mockReset().mockReturnValue('')
  h.refreshOwnedProcessTree.mockReset().mockResolvedValue(new Map())
  h.describeReclaimableResources.mockReset().mockResolvedValue([])
  h.destroyed.clear()
  h.wcRegistry.length = 0
})

describe('getPerformanceDiagnostics — memory units', () => {
  it('normalizes Electron KiB to bytes in totals and per-process metrics', async () => {
    h.getAppMetrics.mockReturnValue([
      processMetric(101, 'main', 250_000, 300_000, 100_000),
      processMetric(202, 'renderer', 125_000, 150_000),
    ])

    const diagnostics = await getPerformanceDiagnostics()

    // 250_000 + 125_000 KiB
    expect(diagnostics.totals.workingSetTotal).toBe(375_000 * 1024)
    // 300_000 + 150_000 KiB
    expect(diagnostics.totals.peakWorkingSetTotal).toBe(450_000 * 1024)
    expect(diagnostics.totals.byProcessType['Tab']).toEqual({
      count: 2,
      workingSet: 375_000 * 1024,
      peakWorkingSet: 450_000 * 1024,
    })
    // Per-process metrics also use bytes for webContents attribution.
    expect(diagnostics.processMetrics[0]!.memory.workingSetSize).toBe(250_000 * 1024)
    expect(diagnostics.processMetrics[0]!.memory.privateBytes).toBe(100_000 * 1024)
    expect(diagnostics.processMetrics[1]!.memory.workingSetSize).toBe(125_000 * 1024)
    expect(diagnostics.processMetrics[1]!.memory.privateBytes).toBeUndefined()
  })

  it('attributes workingSet bytes to registered webContents', async () => {
    h.getAppMetrics.mockReturnValue([
      processMetric(101, 'main', 250_000, 300_000),
      processMetric(202, 'renderer', 125_000, 150_000),
    ])
    const wc = { id: 1, getOSProcessId: () => 202, isDestroyed: () => h.destroyed.has(wc), once: () => {} }
    h.wcRegistry.push({ wc, getOSProcessId: wc.getOSProcessId, isDestroyed: wc.isDestroyed, once: wc.once })
    registerPerformanceWebContents(wc as never, { kind: 'chat', convId: 'c1' })

    const diagnostics = await getPerformanceDiagnostics()
    unregisterPerformanceWebContents(wc as never)

    expect(diagnostics.webContents).toHaveLength(1)
    expect(diagnostics.webContents[0]).toMatchObject({ kind: 'chat', convId: 'c1', pid: 202 })
    expect(diagnostics.webContents[0]!.workingSet).toBe(125_000 * 1024)
    expect(diagnostics.totals.byWebContentsKind['chat']).toEqual({ count: 1, workingSet: 125_000 * 1024 })
  })

  it('feeds noteMemorySample the aggregate in bytes', async () => {
    h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 250_000, 300_000)])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      { key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 },
    ])
    h.getMemoryReclaimerSnapshot.mockReturnValue({
      enabled: true,
      pressure: 'normal',
      softLimitBytes: 0,
      hardLimitBytes: 0,
      workingSetBytes: 0,
      lastSweepAt: null,
      nextDeadlineAt: null,
      resources: [],
      hot: 0,
      cold: 0,
      protectedCount: 0,
    })

    await getPerformanceDiagnostics()

    // 250_000 KiB process memory plus 10 MiB owned RSS and zero cache bytes, converted to bytes.
    expect(h.noteMemorySample).toHaveBeenCalledWith({
      workingSetBytes: 250_000 * 1024 + 10 * 1024 * 1024,
    })
  })

  it('does not double-count owned process RSS also reported as an Electron Utility process', async () => {
    // ASR and embeddings use utilityProcess.fork, so their PIDs appear in both registries.
    // Their RSS is already included in workingSetTotal.
    h.getAppMetrics.mockReturnValue([
      processMetric(101, 'main', 250_000, 300_000),
      processMetric(501, 'Utility', 40_000, 50_000),
    ])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      { key: 'asr', kind: 'asr', pid: 501, state: 'idle', rss: 41 * 1024 * 1024 },
      { key: 'embeddings', kind: 'embeddings', pid: 501, state: 'idle', rss: 39 * 1024 * 1024 },
      { key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 },
    ])

    const diagnostics = await getPerformanceDiagnostics()

    // Only PID 999 is external; PID 501 is included in workingSetTotal.
    expect(diagnostics.totals.externalRssTotal).toBe(10 * 1024 * 1024)
    expect(diagnostics.totals.workingSetTotal).toBe((250_000 + 40_000) * 1024)
    expect(h.noteMemorySample).toHaveBeenCalledWith({
      workingSetBytes: (250_000 + 40_000) * 1024 + 10 * 1024 * 1024,
    })
  })

  it('registers the periodic pressure sample source with the reclaimer', async () => {
    expect(h.registerPressureSampleSource).toHaveBeenCalledTimes(1)
    expect(typeof h.registerPressureSampleSource.mock.calls[0]![0]).toBe('function')
  })

  it('does not add in-process caches to pressure totals; attribution is not resident memory', async () => {
    // The tool-image Map/Uint8Array cache lives in main and is already in its working set.
    // Adding cacheBytesTotal again would inflate pressure by the cache budget.
    h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 250_000, 300_000)])
    registerPerformanceCache('test-cache', () => ({
      id: 'test-cache',
      kind: 'binary-image-lru',
      entries: 3,
      bytes: 32 * 1024 * 1024,
      oldestAgeMs: 1000,
    }))
    try {
      const diagnostics = await getPerformanceDiagnostics()

      // Preserve diagnostic attribution.
      expect(diagnostics.totals.cacheBytesTotal).toBe(32 * 1024 * 1024)
      expect(diagnostics.caches).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'test-cache', bytes: 32 * 1024 * 1024 })])
      )
      // Pressure includes only the working set and external RSS.
      expect(h.noteMemorySample).toHaveBeenCalledWith({ workingSetBytes: 250_000 * 1024 })
    } finally {
      unregisterPerformanceCache('test-cache')
    }
  })

  it('pressure sampling reuses cached external RSS without spawning ps every 30 seconds', async () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    try {
      // Earlier tests sampled in real time, well before this tick, so the first tick refreshes.
      // Subsequent ticks within the slow cadence reuse the sample without spawning.
      vi.setSystemTime(realNow + EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 100_000, 120_000)])
      h.collectOwnedProcessSnapshots
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 }])
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 20 * 1024 * 1024 }])
      const source = h.registerPressureSampleSource.mock.calls[0]![0] as () => Promise<{
        workingSetBytes: number
      }>

      // Tick 1: stale cache requires a fresh sample and spawn.
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Tick 2, 30 seconds later: reuse the cached sample.
      vi.setSystemTime(realNow + EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 30_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Tick 3, after the slow cadence: refresh RSS.
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 20 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(2)
      expect(h.refreshOwnedProcessTree).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates cached RSS when an owned process spawns', async () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    try {
      // Refresh the stale cache on the first tick; reuse it within the cadence.
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 100_000, 120_000)])
      h.ownedProcessRegistryFingerprint.mockReturnValue('pty-1:999')
      h.collectOwnedProcessSnapshots
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 }])
        .mockResolvedValueOnce([
          { key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 },
          {
            key: 'vscode-serve-web',
            kind: 'vscode-serve-web',
            pid: 700,
            state: 'ready',
            rss: 80 * 1024 * 1024,
            pids: [700, 701],
          },
        ])
      const source = h.registerPressureSampleSource.mock.calls[0]![0] as () => Promise<{
        workingSetBytes: number
      }>

      // Tick 1: fresh sample includes only the PTY.
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Tick 2: unchanged registry within the cadence reuses the cache.
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 30_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Spawn changes registry identity; the next tick refreshes even within the cadence.
      // The new serve-web process contributes pressure immediately.
      h.ownedProcessRegistryFingerprint.mockReturnValue('pty-1:999|vscode-serve-web:700')
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 60_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + (10 + 80) * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates cached RSS when an owned process exits', async () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(realNow + 4 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 100_000, 120_000)])
      h.ownedProcessRegistryFingerprint.mockReturnValue('pty-1:999|vscode-serve-web:700')
      h.collectOwnedProcessSnapshots
        .mockResolvedValueOnce([
          { key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 },
          {
            key: 'vscode-serve-web',
            kind: 'vscode-serve-web',
            pid: 700,
            state: 'ready',
            rss: 80 * 1024 * 1024,
            pids: [700, 701],
          },
        ])
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 }])
      const source = h.registerPressureSampleSource.mock.calls[0]![0] as () => Promise<{
        workingSetBytes: number
      }>

      // Tick 1: fresh sample includes PTY and serve-web pressure.
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + (10 + 80) * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Tick 2: unchanged registry within the cadence reuses the cache.
      vi.setSystemTime(realNow + 4 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 30_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + (10 + 80) * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Exit changes identity; the next tick refreshes and excludes the dead process.
      // Its old snapshot must not contribute pressure until the slow cadence expires.
      h.ownedProcessRegistryFingerprint.mockReturnValue('pty-1:999')
      vi.setSystemTime(realNow + 4 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 60_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts tree RSS from root and descendants once as external memory', async () => {
    h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 250_000, 300_000)])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      {
        key: 'vscode-serve-web',
        kind: 'vscode-serve-web',
        pid: 700,
        state: 'ready',
        rss: 60 * 1024 * 1024,
        pids: [700, 701, 702],
      },
    ])

    const diagnostics = await getPerformanceDiagnostics()

    expect(diagnostics.totals.externalRssTotal).toBe(60 * 1024 * 1024)
    expect(diagnostics.totals.workingSetTotal).toBe(250_000 * 1024)
  })

  it('does not double-count a tree whose descendant is an Electron PID', async () => {
    // Child PID 701 also appears as an Electron Utility process.
    // Its RSS is already in workingSetTotal; excluding the snapshot conservatively avoids double counting.
    h.getAppMetrics.mockReturnValue([
      processMetric(101, 'main', 250_000, 300_000),
      processMetric(701, 'Utility', 40_000, 50_000),
    ])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      {
        key: 'vscode-serve-web',
        kind: 'vscode-serve-web',
        pid: 700,
        state: 'ready',
        rss: 60 * 1024 * 1024,
        pids: [700, 701],
      },
      { key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 },
    ])

    const diagnostics = await getPerformanceDiagnostics()

    expect(diagnostics.totals.externalRssTotal).toBe(10 * 1024 * 1024)
    expect(diagnostics.totals.workingSetTotal).toBe((250_000 + 40_000) * 1024)
  })

  it('counts PTY tree RSS from root and child once as external memory', async () => {
    // PTY trees include shells, MCP servers, and subprocesses in externalRssTotal.
    h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 250_000, 300_000)])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      {
        key: 'pty:term-1',
        kind: 'pty',
        pid: 100,
        state: 'busy',
        rss: 30 * 1024 * 1024,
        pids: [100, 110],
        rssByPid: { '100': 10 * 1024 * 1024, '110': 20 * 1024 * 1024 },
      },
    ])

    const diagnostics = await getPerformanceDiagnostics()

    expect(diagnostics.totals.externalRssTotal).toBe(30 * 1024 * 1024)
    expect(h.noteMemorySample).toHaveBeenCalledWith({
      workingSetBytes: 250_000 * 1024 + 30 * 1024 * 1024,
    })
  })

  it('deduplicates overlapping PIDs across records by PID, not by record', async () => {
    // PID 110 belongs to both trees; count its RSS once: 10+20+15 MiB.
    h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 250_000, 300_000)])
    h.collectOwnedProcessSnapshots.mockResolvedValue([
      {
        key: 'pty:term-1',
        kind: 'pty',
        pid: 100,
        state: 'busy',
        rss: 30 * 1024 * 1024,
        pids: [100, 110],
        rssByPid: { '100': 10 * 1024 * 1024, '110': 20 * 1024 * 1024 },
      },
      {
        key: 'vscode-serve-web',
        kind: 'vscode-serve-web',
        pid: 700,
        state: 'ready',
        rss: 35 * 1024 * 1024,
        pids: [700, 110],
        rssByPid: { '700': 15 * 1024 * 1024, '110': 20 * 1024 * 1024 },
      },
    ])

    const diagnostics = await getPerformanceDiagnostics()

    expect(diagnostics.totals.externalRssTotal).toBe((10 + 20 + 15) * 1024 * 1024)
  })

  it('keeps a stable tree between ticks and discovers descendants on the next slow collection', async () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 100_000, 120_000)])
      h.ownedProcessRegistryFingerprint.mockReturnValue('vscode-serve-web:700:[701]')
      h.collectOwnedProcessSnapshots
        .mockResolvedValueOnce([
          {
            key: 'vscode-serve-web',
            kind: 'vscode-serve-web',
            pid: 700,
            state: 'ready',
            rss: 60 * 1024 * 1024,
            pids: [700, 701],
          },
        ])
        .mockImplementationOnce(async () => {
          // Periodic enumeration discovers new descendants before publishing the fingerprint.
          h.ownedProcessRegistryFingerprint.mockReturnValue('vscode-serve-web:700:[701,702]')
          return [
            {
              key: 'vscode-serve-web',
              kind: 'vscode-serve-web',
              pid: 700,
              state: 'ready',
              rss: 100 * 1024 * 1024,
              pids: [700, 701, 702],
            },
          ]
        })
      const source = h.registerPressureSampleSource.mock.calls[0]![0] as () => Promise<{
        workingSetBytes: number
      }>
      // Tick 1: the previous cache has expired; collect the tree and RSS.
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 60 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)

      // Tick 2: within the cadence, reuse the known snapshot without enumeration.
      vi.setSystemTime(realNow + 2 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 30_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 60 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)
      expect(h.refreshOwnedProcessTree).not.toHaveBeenCalled()

      // Tick 3: after the cadence, enumerate and include the new descendant.
      vi.setSystemTime(realNow + 3 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 100 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(2)
      expect(h.refreshOwnedProcessTree).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps root-only samples cached between pressure ticks', async () => {
    const realNow = Date.now()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(realNow + 3 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 1000)
      h.getAppMetrics.mockReturnValue([processMetric(101, 'main', 100_000, 120_000)])
      h.ownedProcessRegistryFingerprint.mockReturnValue('pty-1:999')
      h.collectOwnedProcessSnapshots
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 10 * 1024 * 1024 }])
        .mockResolvedValueOnce([{ key: 'pty-1', kind: 'pty', pid: 999, state: 'idle', rss: 20 * 1024 * 1024 }])
      const source = h.registerPressureSampleSource.mock.calls[0]![0] as () => Promise<{
        workingSetBytes: number
      }>

      // Tick 1: fresh sample.
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)

      // Tick 2: stable root-only identity reuses the sample.
      vi.setSystemTime(realNow + 3 * EXTERNAL_RSS_SAMPLE_INTERVAL_MS + 30_000)
      expect((await source()).workingSetBytes).toBe(100_000 * 1024 + 10 * 1024 * 1024)
      expect(h.collectOwnedProcessSnapshots).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
