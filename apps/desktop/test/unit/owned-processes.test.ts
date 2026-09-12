import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Owned process registry: aggregate live descendant RSS, enumerate all roots in one call with root-only fallback, and invalidate the metrics fingerprint on spawn, exit, or PID changes. */

const h = vi.hoisted(() => {
  const execFile = vi.fn()
  // Real execFile has promisify.custom and resolves { stdout, stderr }.
  // The mock must preserve that shape because the module destructures stdout.
  const customPromisify = Symbol.for('nodejs.util.promisify.custom')
  ;(execFile as unknown as Record<PropertyKey, unknown>)[customPromisify] = (
    file: string,
    args: string[],
    opts: { timeout?: number; windowsHide?: boolean }
  ) =>
    new Promise((resolve, reject) => {
      execFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  const listDescendantPids = vi.fn<() => Promise<Map<number, number[]>>>(async () => new Map())
  return { execFile, listDescendantPids }
})

vi.mock('node:child_process', () => ({ execFile: h.execFile }))

vi.mock('../../src/main/platform', () => ({
  listDescendantPids: h.listDescendantPids,
}))

const {
  collectOwnedProcessSnapshots,
  disposeOwnedProcesses,
  ownedProcessRegistryFingerprint,
  refreshOwnedProcessTree,
  registerOwnedProcess,
  unregisterOwnedProcess,
} = await import('../../src/main/performance/owned-processes')

/** Mock ps RSS output using the real execFile callback signature. */
function fakePsRss(lines: string): void {
  h.execFile.mockImplementation(
    (
      _file: string,
      _args: unknown[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      cb(null, lines, '')
    }
  )
}

beforeEach(() => {
  disposeOwnedProcesses()
  h.listDescendantPids.mockReset().mockResolvedValue(new Map())
  h.execFile.mockReset()
})

describe('collectOwnedProcessSnapshots — process tree aggregation', () => {
  it('aggregates RSS from the root and live descendants in one spawn', async () => {
    registerOwnedProcess({ key: 'pty-1', kind: 'pty', pid: () => 999, state: () => 'idle' })
    registerOwnedProcess({
      key: 'vscode-serve-web',
      kind: 'vscode-serve-web',
      pid: () => 700,
      state: () => 'ready',
      includeDescendants: true,
    })
    h.listDescendantPids.mockResolvedValue(new Map([[700, [701, 702]]]))
    fakePsRss('999 1024\n700 2048\n701 4096\n702 8192\n')

    const snapshots = await collectOwnedProcessSnapshots({ platform: 'darwin' })

    // Enumerate all tree roots in one call.
    expect(h.listDescendantPids).toHaveBeenCalledTimes(1)
    expect(h.listDescendantPids).toHaveBeenCalledWith([700], expect.objectContaining({ platform: 'darwin' }))
    // Root-only records expose root RSS; tree records expose root plus children (2+4+8 MiB) and their PIDs.
    expect(snapshots).toEqual([
      expect.objectContaining({ key: 'pty-1', pid: 999, rss: 1 * 1024 * 1024 }),
      expect.objectContaining({
        key: 'vscode-serve-web',
        pid: 700,
        rss: (2 + 4 + 8) * 1024 * 1024,
        pids: [700, 701, 702],
      }),
    ])
    // Sample all tree PIDs in one ps call.
    const sampledArgs = h.execFile.mock.calls.map((call) => call[1])
    expect(sampledArgs).toEqual([['-o', 'pid=,rss=', '-p', '999,700,701,702']])
  })

  it('falls back to root-only sampling when tree enumeration fails', async () => {
    registerOwnedProcess({
      key: 'vscode-serve-web',
      kind: 'vscode-serve-web',
      pid: () => 700,
      state: () => 'ready',
      includeDescendants: true,
    })
    h.listDescendantPids.mockResolvedValue(new Map()) // Failed enumeration or empty tree.
    fakePsRss('700 2048\n')

    const snapshots = await collectOwnedProcessSnapshots({ platform: 'darwin' })

    expect(snapshots[0]).toMatchObject({ key: 'vscode-serve-web', rss: 2 * 1024 * 1024, pids: [700] })
  })

  it('does not enumerate trees when no record requests descendants', async () => {
    registerOwnedProcess({ key: 'pty-1', kind: 'pty', pid: () => 999, state: () => 'idle' })
    fakePsRss('999 1024\n')

    await collectOwnedProcessSnapshots({ platform: 'darwin' })

    expect(h.listDescendantPids).not.toHaveBeenCalled()
    expect(h.execFile).toHaveBeenCalledTimes(1) // Only the root RSS sample.
  })

  it('excludes dead PIDs from tree RSS', async () => {
    registerOwnedProcess({
      key: 'vscode-serve-web',
      kind: 'vscode-serve-web',
      pid: () => 700,
      state: () => 'ready',
      includeDescendants: true,
    })
    h.listDescendantPids.mockResolvedValue(new Map([[700, [701]]]))
    // PID 700 is alive (2 MiB); dead PID 701 is absent from ps output.
    fakePsRss('700 2048\n')

    const snapshots = await collectOwnedProcessSnapshots({ platform: 'darwin' })

    expect(snapshots[0]).toMatchObject({ key: 'vscode-serve-web', rss: 2 * 1024 * 1024, pids: [700, 701] })
  })

  it('PTY tree records sum root and descendant RSS and expose rssByPid for deduplication', async () => {
    // PTY trees include shells, CLIs, MCP servers, agent subprocesses, and compilers.
    registerOwnedProcess({
      key: 'pty:term-1',
      kind: 'pty',
      pid: () => 100,
      state: () => 'busy',
      includeDescendants: true,
    })
    h.listDescendantPids.mockResolvedValue(new Map([[100, [101, 102]]]))
    fakePsRss('100 1024\n101 2048\n102 4096\n')

    const snapshots = await collectOwnedProcessSnapshots({ platform: 'darwin' })

    expect(snapshots[0]).toMatchObject({
      key: 'pty:term-1',
      pid: 100,
      rss: (1 + 2 + 4) * 1024 * 1024,
      pids: [100, 101, 102],
      // Per-PID attribution lets metrics.ts deduplicate overlapping trees.
      rssByPid: { '100': 1 * 1024 * 1024, '101': 2 * 1024 * 1024, '102': 4 * 1024 * 1024 },
    })
    // Sample all tree PIDs in one ps call.
    expect(h.execFile.mock.calls[0]![1]).toEqual(['-o', 'pid=,rss=', '-p', '100,101,102'])
  })
})

describe('refreshOwnedProcessTree — tree identity and epoch', () => {
  it('a new descendant changes the fingerprint without changing the root', async () => {
    registerOwnedProcess({ key: 'pty:term-1', kind: 'pty', pid: () => 100, includeDescendants: true })

    h.listDescendantPids.mockResolvedValue(new Map([[100, [101]]]))
    await refreshOwnedProcessTree()
    const before = ownedProcessRegistryFingerprint()
    expect(before).toBe('pty:term-1:100:[101]')

    // A descendant spawn keeps the root but changes identity, as when Claude starts an MCP server.
    h.listDescendantPids.mockResolvedValue(new Map([[100, [101, 102]]]))
    await refreshOwnedProcessTree()
    expect(ownedProcessRegistryFingerprint()).toBe('pty:term-1:100:[101,102]')
    expect(ownedProcessRegistryFingerprint()).not.toBe(before)
  })

  it('a descendant exit changes identity and removes its memory pressure', async () => {
    registerOwnedProcess({ key: 'pty:term-1', kind: 'pty', pid: () => 100, includeDescendants: true })

    h.listDescendantPids.mockResolvedValue(new Map([[100, [101, 102]]]))
    await refreshOwnedProcessTree()
    expect(ownedProcessRegistryFingerprint()).toBe('pty:term-1:100:[101,102]')

    h.listDescendantPids.mockResolvedValue(new Map([[100, [101]]]))
    await refreshOwnedProcessTree()
    expect(ownedProcessRegistryFingerprint()).toBe('pty:term-1:100:[101]')
  })

  it('does not spawn when no record requests tree sampling', async () => {
    registerOwnedProcess({ key: 'pty-1', kind: 'pty', pid: () => 999 })

    await refreshOwnedProcessTree()

    expect(h.listDescendantPids).not.toHaveBeenCalled()
    expect(ownedProcessRegistryFingerprint()).toBe('pty-1:999')
  })

  it('collection updates tree identity so the fingerprint reflects the sampled snapshot', async () => {
    registerOwnedProcess({
      key: 'vscode-serve-web',
      kind: 'vscode-serve-web',
      pid: () => 700,
      state: () => 'ready',
      includeDescendants: true,
    })
    h.listDescendantPids.mockResolvedValue(new Map([[700, [701]]]))
    fakePsRss('700 2048\n701 4096\n')

    await collectOwnedProcessSnapshots({ platform: 'darwin' })

    expect(ownedProcessRegistryFingerprint()).toBe('vscode-serve-web:700:[701]')
  })
})

describe('ownedProcessRegistryFingerprint', () => {
  it('changes on registry spawn, exit, and PID replacement', () => {
    expect(ownedProcessRegistryFingerprint()).toBe('')

    registerOwnedProcess({ key: 'pty-1', kind: 'pty', pid: () => 999 })
    registerOwnedProcess({ key: 'vscode-serve-web', kind: 'vscode-serve-web', pid: () => 700 })
    expect(ownedProcessRegistryFingerprint()).toBe('pty-1:999|vscode-serve-web:700')

    unregisterOwnedProcess('vscode-serve-web') // exit
    expect(ownedProcessRegistryFingerprint()).toBe('pty-1:999')

    registerOwnedProcess({ key: 'pty-1', kind: 'pty', pid: () => 1000 }) // Restarted with a new PID.
    expect(ownedProcessRegistryFingerprint()).toBe('pty-1:1000')
  })
})
