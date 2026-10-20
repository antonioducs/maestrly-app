import { afterEach, describe, expect, it, vi } from 'vitest'
import { tFor } from '../../src/shared/i18n'
import { attendFleetFile, downloadStatusLabel, fileSizeLabel } from '../../src/renderer/lib/fleet/downloads'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const DOWNLOAD_SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId

const MB = 1024 * 1024

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bot file download progress in the renderer', () => {
  it('shows bytes, then speed and time left once measurable, and says when data stops', () => {
    const en = tFor('en', 'fleet')
    const pt = tFor('pt-BR', 'fleet')
    expect(downloadStatusLabel({ receivedBytes: 0, totalBytes: 80 * MB, bytesPerSecond: null }, 'en', en)).toBe(
      '0 MB of 80 MB'
    )
    expect(
      downloadStatusLabel({ receivedBytes: 32.4 * MB, totalBytes: 80 * MB, bytesPerSecond: 4 * MB }, 'en', en)
    ).toBe('32.4 MB of 80 MB · 4 MB/s · ~12 sec left')
    expect(
      downloadStatusLabel({ receivedBytes: 32.4 * MB, totalBytes: 80 * MB, bytesPerSecond: 4 * MB }, 'pt-BR', pt)
    ).toBe('32,4 MB de 80 MB · 4 MB/s · ~12 s restantes')
    expect(
      downloadStatusLabel({ receivedBytes: 10 * MB, totalBytes: 100 * MB, bytesPerSecond: 200 * 1024 }, 'en', en)
    ).toBe('10 MB of 100 MB · 200 kB/s · ~8 min left')
    expect(downloadStatusLabel({ receivedBytes: MB, totalBytes: 80 * MB, bytesPerSecond: 0 }, 'pt-BR', pt)).toBe(
      '1 MB de 80 MB · Aguardando dados…'
    )
    // Every byte arrived: no time left to show while the file is published.
    expect(downloadStatusLabel({ receivedBytes: MB, totalBytes: MB, bytesPerSecond: MB }, 'en', en)).toBe(
      '1 MB of 1 MB · 1 MB/s'
    )
    expect(fileSizeLabel(1536, 'en')).toBe('1.5 kB')
  })

  it('reports the files a window shows once per batch, until every view of them is gone', async () => {
    vi.useFakeTimers()
    const attend = vi.fn(async () => {})
    vi.stubGlobal('window', { api: { fleetAttendDownloads: attend } })
    const first = attendFleetFile(DOWNLOAD_SERVER, 'bot', 'f-a')
    const again = attendFleetFile(DOWNLOAD_SERVER, 'bot', 'f-a')
    const other = attendFleetFile(DOWNLOAD_SERVER, 'bot', 'f-b')
    vi.runAllTimers()
    expect(attend.mock.calls).toEqual([
      [
        [
          { serverId: DOWNLOAD_SERVER, botId: 'bot', fileId: 'f-a' },
          { serverId: DOWNLOAD_SERVER, botId: 'bot', fileId: 'f-b' },
        ],
      ],
    ])
    first()
    vi.runAllTimers()
    expect(attend).toHaveBeenLastCalledWith([
      { serverId: DOWNLOAD_SERVER, botId: 'bot', fileId: 'f-a' },
      { serverId: DOWNLOAD_SERVER, botId: 'bot', fileId: 'f-b' },
    ])
    again()
    other()
    vi.runAllTimers()
    expect(attend).toHaveBeenLastCalledWith([])
    expect(attend).toHaveBeenCalledTimes(3)
    // A failed report never surfaces.
    attend.mockRejectedValueOnce(new Error('IPC blocked'))
    const last = attendFleetFile(DOWNLOAD_SERVER, 'bot', 'f-c')
    vi.runAllTimers()
    await Promise.resolve()
    last()
    vi.runAllTimers()
  })
})
