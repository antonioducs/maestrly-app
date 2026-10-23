import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VSCodeWarmup,
  WARMUP_FIRST_DELAY_MS,
  WARMUP_INTERVAL_MS,
  WARMUP_READY_TIMEOUT_MS,
  WARMUP_RECENT_USE_MS,
  type VSCodeWarmupDeps,
} from '../../src/main/vscode/vscode-warmup'

const LATEST = 'e646868227c3e3a9e3f24277c8c7220be42c0be7'
const PREVIOUS = '2d0b7506a36c1d6db9a466440131a8e01eab2289'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60_000

let dir = ''
const stateFile = () => path.join(dir, 'vscode-warmup.json')
const writeState = (state: object) => writeFileSync(stateFile(), JSON.stringify(state))
const readState = () => JSON.parse(readFileSync(stateFile(), 'utf8'))

function setup(overrides: Partial<VSCodeWarmupDeps> = {}) {
  let running = false
  const deps = {
    stateFile,
    now: vi.fn(() => NOW),
    cliReady: vi.fn(() => true),
    latestCommit: vi.fn(async (): Promise<string | null> => LATEST),
    running: vi.fn(() => running),
    start: vi.fn(async () => {
      running = true
    }),
    waitReady: vi.fn(async (_timeoutMs: number) => undefined),
    servedCommit: vi.fn(async (): Promise<string | null> => LATEST),
    stopIfIdle: vi.fn(() => {
      running = false
    }),
    ...overrides,
  }
  return { deps, warmup: new VSCodeWarmup(deps), setRunning: (value: boolean) => (running = value) }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vscode-warmup-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('warming up the editor server', () => {
  it('downloads a new version on a server it starts, records it and stops that server again', async () => {
    writeState({ lastUsedAt: NOW - DAY, warmedCommit: PREVIOUS })
    const { deps, warmup } = setup()
    await expect(warmup.run()).resolves.toBe('warmed')
    expect(deps.start).toHaveBeenCalledTimes(1)
    expect(deps.waitReady).toHaveBeenCalledWith(WARMUP_READY_TIMEOUT_MS)
    expect(deps.stopIfIdle).toHaveBeenCalledTimes(1)
    expect(readState()).toEqual({ lastUsedAt: NOW - DAY, warmedCommit: LATEST })
    // The next run finds it done without starting anything.
    await expect(warmup.run()).resolves.toBe('current')
    expect(deps.start).toHaveBeenCalledTimes(1)
  })

  it('skips people who never set up the editor or did not open it lately, and offline runs', async () => {
    const noCli = setup({ cliReady: () => false })
    await expect(noCli.warmup.run()).resolves.toBe('no-cli')

    await expect(setup().warmup.run()).resolves.toBe('unused')
    writeState({ lastUsedAt: NOW - WARMUP_RECENT_USE_MS - 1 })
    await expect(setup().warmup.run()).resolves.toBe('unused')

    writeState({ lastUsedAt: NOW - DAY })
    const offline = setup({ latestCommit: async () => null })
    await expect(offline.warmup.run()).resolves.toBe('offline')
    const failing = setup({ latestCommit: () => Promise.reject(new Error('ENOTFOUND')) })
    await expect(failing.warmup.run()).resolves.toBe('offline')
    for (const run of [noCli, offline, failing]) expect(run.deps.start).not.toHaveBeenCalled()
  })

  it('leaves a server it did not start running', async () => {
    writeState({ lastUsedAt: NOW - DAY })
    const { deps, warmup, setRunning } = setup()
    setRunning(true)
    await expect(warmup.run()).resolves.toBe('warmed')
    expect(deps.stopIfIdle).not.toHaveBeenCalled()
  })

  it('keeps its server up when the editor is opened meanwhile', async () => {
    writeState({ lastUsedAt: NOW - DAY })
    let clock = NOW
    const { deps, warmup } = setup({
      now: () => clock,
      waitReady: async () => {
        clock += 1000
        warmup.noteUse()
      },
    })
    await expect(warmup.run()).resolves.toBe('warmed')
    expect(deps.stopIfIdle).not.toHaveBeenCalled()
  })

  it('tries again later when the server still serves an older version, or fails', async () => {
    writeState({ lastUsedAt: NOW - DAY, warmedCommit: PREVIOUS })
    const stale = setup({ servedCommit: async () => PREVIOUS })
    await expect(stale.warmup.run()).resolves.toBe('stale')
    expect(readState().warmedCommit).toBe(PREVIOUS)
    expect(stale.deps.stopIfIdle).toHaveBeenCalledTimes(1)

    const failed = setup({ waitReady: () => Promise.reject(new Error('timed out')) })
    await expect(failed.warmup.run()).resolves.toBe('failed')
    expect(failed.deps.stopIfIdle).toHaveBeenCalledTimes(1)
    expect(readState().warmedCommit).toBe(PREVIOUS)
  })

  it('runs one warm-up at a time', async () => {
    writeState({ lastUsedAt: NOW - DAY })
    let release = () => {}
    const { deps, warmup } = setup({ waitReady: vi.fn(() => new Promise<void>((resolve) => (release = resolve))) })
    const first = warmup.run()
    const second = warmup.run()
    await vi.waitFor(() => expect(deps.waitReady).toHaveBeenCalled())
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['warmed', 'warmed'])
    expect(deps.start).toHaveBeenCalledTimes(1)
  })

  it('notes openings of the editor at most once an hour, and ignores a damaged state file', async () => {
    writeFileSync(stateFile(), '{not json')
    let clock = NOW
    const { warmup } = setup({ now: () => clock })
    warmup.noteUse()
    await vi.waitFor(() => expect(readState()).toEqual({ lastUsedAt: NOW }))
    clock += 30 * 60_000
    warmup.noteUse()
    clock += 31 * 60_000
    warmup.noteUse()
    await vi.waitFor(() => expect(readState()).toEqual({ lastUsedAt: clock }))
    await expect(warmup.run()).resolves.toBe('warmed')
    await vi.waitFor(() => expect(readState()).toEqual({ lastUsedAt: clock, warmedCommit: LATEST }))
  })

  it('runs a while after the app starts, then every few hours, until cancelled', async () => {
    vi.useFakeTimers()
    const { deps, warmup } = setup({ cliReady: vi.fn(() => false) })
    const cancel = warmup.schedule()
    await vi.advanceTimersByTimeAsync(WARMUP_FIRST_DELAY_MS - 1)
    expect(deps.cliReady).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.cliReady).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WARMUP_INTERVAL_MS)
    expect(deps.cliReady).toHaveBeenCalledTimes(2)
    cancel()
    await vi.advanceTimersByTimeAsync(WARMUP_INTERVAL_MS * 2)
    expect(deps.cliReady).toHaveBeenCalledTimes(2)
  })
})
