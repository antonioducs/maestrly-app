import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetActiveDownloads, type FleetTransfer } from '../../src/main/fleet/client/active-downloads'
import { FleetClientError } from '../../src/main/fleet/client/api'
import type { FleetDownloadEvent } from '../../src/shared/fleet-downloads'

type Control = Parameters<FleetTransfer>[0]

/** Transfers start on a microtask; fake timers must not advance while waiting for them. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function harness() {
  let now = 0
  const events: FleetDownloadEvent[] = []
  const settled = vi.fn()
  const downloads = new FleetActiveDownloads({ emit: (event) => events.push(event), settled, now: () => now })
  const controls: Control[] = []
  const finishers: { resolve: (value: { path: string; receipt: string }) => void; reject: (error: unknown) => void }[] =
    []
  const start = vi.fn<FleetTransfer>(
    (control) =>
      new Promise((resolve, reject) => {
        controls.push(control)
        finishers.push({ resolve, reject })
        control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true })
      })
  )
  return {
    downloads,
    events,
    settled,
    start,
    controls,
    finishers,
    at: (ms: number) => {
      now = ms
    },
    progress: () => events.filter((event) => event.type === 'progress'),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('fleet active downloads', () => {
  it('joins the transfer already running for a file and reports one saved event to every window', async () => {
    const h = harness()
    const connection = new AbortController().signal
    const first = h.downloads.run('bot', 'f-file', connection, h.start)
    const second = h.downloads.run('bot', 'f-file', connection, h.start)
    expect(second).toBe(first)
    // Another file of the same bot runs on its own.
    void h.downloads.run('bot', 'f-other', connection, h.start)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(2)
    expect(h.downloads.get('bot', 'f-file')).toEqual({
      botId: 'bot',
      fileId: 'f-file',
      receivedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: null,
    })
    h.finishers[0].resolve({ path: '/downloads/report.pdf', receipt: 'receipt-1' })
    await expect(first).resolves.toBe('receipt-1')
    expect(h.events.at(-1)).toEqual({ type: 'saved', botId: 'bot', fileId: 'f-file', receipt: 'receipt-1' })
    expect(h.settled).toHaveBeenCalledExactlyOnceWith({
      outcome: 'saved',
      botId: 'bot',
      fileId: 'f-file',
      name: 'report.pdf',
      path: '/downloads/report.pdf',
      receipt: 'receipt-1',
    })
    expect(h.downloads.get('bot', 'f-file')).toBeNull()
    expect(h.downloads.get('bot', 'f-other')).not.toBeNull()
    // Once saved, asking again saves another copy.
    void h.downloads.run('bot', 'f-file', connection, h.start)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(3)
  })

  it('reports the size at once, then at most four times a second, with a recent speed that drops while stalled', async () => {
    const h = harness()
    void h.downloads.run('bot', 'f-file', new AbortController().signal, h.start)
    await flush()
    const { onProgress } = h.controls[0]
    onProgress({ name: 'big.zip', receivedBytes: 0, totalBytes: 10_000 })
    expect(h.progress().at(-1)).toMatchObject({ receivedBytes: 0, totalBytes: 10_000, bytesPerSecond: null })
    const count = h.progress().length
    h.at(100)
    onProgress({ name: 'big.zip', receivedBytes: 100, totalBytes: 10_000 })
    h.at(200)
    onProgress({ name: 'big.zip', receivedBytes: 200, totalBytes: 10_000 })
    expect(h.progress()).toHaveLength(count)
    h.at(250)
    vi.advanceTimersByTime(250)
    // Too little of the transfer to measure a speed yet.
    expect(h.progress().slice(count)).toEqual([
      {
        type: 'progress',
        botId: 'bot',
        fileId: 'f-file',
        receivedBytes: 200,
        totalBytes: 10_000,
        bytesPerSecond: null,
      },
    ])
    h.at(1_000)
    onProgress({ name: 'big.zip', receivedBytes: 1_000, totalBytes: 10_000 })
    vi.advanceTimersByTime(250)
    expect(h.progress().at(-1)).toMatchObject({ receivedBytes: 1_000, bytesPerSecond: 1_000 })
    // Nothing new: no event until a second has passed, then the speed decays and finally reads 0.
    const quiet = h.progress().length
    h.at(1_250)
    vi.advanceTimersByTime(250)
    expect(h.progress()).toHaveLength(quiet)
    h.at(2_000)
    vi.advanceTimersByTime(250)
    expect(h.progress().at(-1)?.bytesPerSecond).toBe(500)
    h.at(4_500)
    vi.advanceTimersByTime(250)
    expect(h.progress().at(-1)?.bytesPerSecond).toBe(0)
    // Bytes flow again: the speed counts from the last sample before the window, not from the start.
    h.at(5_000)
    onProgress({ name: 'big.zip', receivedBytes: 3_000, totalBytes: 10_000 })
    vi.advanceTimersByTime(250)
    expect(h.progress().at(-1)).toMatchObject({ receivedBytes: 3_000, bytesPerSecond: 500 })
  })

  it('cancels only on request, removing the transfer without a notice', async () => {
    const h = harness()
    const saving = h.downloads.run('bot', 'f-file', new AbortController().signal, h.start)
    expect(h.downloads.cancel('bot', 'f-missing')).toBe(false)
    await flush()
    expect(h.downloads.cancel('bot', 'f-file')).toBe(true)
    expect(h.controls[0].signal.aborted).toBe(true)
    await expect(saving).rejects.toThrow('FLEET_DOWNLOAD_CANCELED')
    expect(h.events.at(-1)).toEqual({ type: 'canceled', botId: 'bot', fileId: 'f-file' })
    expect(h.settled).not.toHaveBeenCalled()
    expect(h.downloads.get('bot', 'f-file')).toBeNull()
    expect(h.downloads.cancel('bot', 'f-file')).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(h.events.at(-1)?.type).toBe('canceled')
  })

  it('names the failure for windows and notices it, except when the connection closed', async () => {
    const h = harness()
    const missing = h.downloads.run('bot', 'f-file', new AbortController().signal, h.start)
    await flush()
    h.controls[0].onProgress({ name: 'gone.pdf', receivedBytes: 0, totalBytes: 10 })
    h.finishers[0].reject(new FleetClientError('NOT_FOUND', 404, 'File expired'))
    await expect(missing).rejects.toThrow('FLEET_FILE_NOT_FOUND')
    expect(h.events.at(-1)).toEqual({ type: 'failed', botId: 'bot', fileId: 'f-file', error: 'FLEET_FILE_NOT_FOUND' })
    expect(h.settled).toHaveBeenCalledExactlyOnceWith({
      outcome: 'failed',
      botId: 'bot',
      fileId: 'f-file',
      name: 'gone.pdf',
      error: 'FLEET_FILE_NOT_FOUND',
    })

    // Any other failure keeps its own error for the caller.
    const broken = h.downloads.run('bot', 'f-file', new AbortController().signal, h.start)
    await flush()
    h.finishers[1].reject(new Error('Disk full'))
    await expect(broken).rejects.toThrow('Disk full')
    expect(h.events.at(-1)).toMatchObject({ type: 'failed', error: 'FLEET_DOWNLOAD_FAILED' })
    expect(h.settled).toHaveBeenLastCalledWith(expect.objectContaining({ name: null, error: 'FLEET_DOWNLOAD_FAILED' }))

    const connection = new AbortController()
    const closing = h.downloads.run('bot', 'f-file', connection.signal, h.start)
    await flush()
    connection.abort()
    // A transfer whose connection closed is never joined, even before it has wound down.
    const again = h.downloads.run('bot', 'f-file', new AbortController().signal, h.start)
    expect(again).not.toBe(closing)
    await expect(closing).rejects.toThrow()
    expect(h.events.at(-1)).toMatchObject({ type: 'failed', error: 'FLEET_DOWNLOAD_FAILED' })
    expect(h.settled).toHaveBeenCalledTimes(2)
    // The old transfer's end leaves the new one registered.
    expect(h.downloads.get('bot', 'f-file')).not.toBeNull()
    await flush()
    h.finishers[3].resolve({ path: '/downloads/gone.pdf', receipt: 'receipt-4' })
    await expect(again).resolves.toBe('receipt-4')
  })

  it('forgets a transfer that fails at once and keeps a throwing notice from changing the result', async () => {
    const events: FleetDownloadEvent[] = []
    const downloads = new FleetActiveDownloads({
      emit: (event) => events.push(event),
      settled: () => {
        throw new Error('Notifications unavailable')
      },
    })
    const failing = downloads.run('bot', 'f-file', new AbortController().signal, () => {
      throw new Error('FLEET_FILES_UNSUPPORTED')
    })
    await expect(failing).rejects.toThrow('FLEET_FILES_UNSUPPORTED')
    expect(downloads.get('bot', 'f-file')).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: 'FLEET_FILES_UNSUPPORTED' })
    const saved = downloads.run('bot', 'f-file', new AbortController().signal, async () => ({
      path: '/downloads/a.txt',
      receipt: 'r',
    }))
    await expect(saved).resolves.toBe('r')
  })
})
