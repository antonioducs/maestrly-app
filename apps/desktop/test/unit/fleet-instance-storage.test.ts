import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageMeter, duDiskUsage, parseDuOutput, type DiskUsage } from '../../src/main/fleet/instance/storage'

const targets = async (folder: string | null) => ({
  home: '/home/bot',
  downloads: '/home/bot/Downloads',
  folder,
  bots: [{ botId: 'ads', browser: '/b/ads', others: ['/s/ads', '/w/ads'] }],
})
const sizes: Record<string, number> = {
  '/home/bot': 9000,
  '/home/bot/Downloads': 1000,
  '/srv/ws': 5000,
  '/b/ads': 2000,
  '/s/ads': 300,
  '/w/ads': 700,
}
const fakeUsage = (): DiskUsage & { active: number; most: number } => {
  const usage = Object.assign(
    vi.fn(async (paths: readonly string[]) => {
      usage.active++
      usage.most = Math.max(usage.most, usage.active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      usage.active--
      return paths.reduce((sum, item) => sum + (sizes[item] ?? 0), 0)
    }),
    { active: 0, most: 0 }
  )
  return usage
}

describe('disk usage', () => {
  it('sums the KiB du prints for each path', () => {
    expect(parseDuOutput('12\t/a\n30\t/b with\ttab\n')).toBe(42)
    expect(parseDuOutput('du: cannot read directory\n')).toBeNull()
    expect(parseDuOutput('')).toBeNull()
  })

  it('answers the latest figures at once and measures one folder at a time in the background', async () => {
    let now = Date.parse('2026-11-01T10:00:00.000Z')
    const usage = fakeUsage()
    const meter = new StorageMeter({ targets, usage, now: () => now })
    expect(meter.read(null)).toEqual({ environment: null, bots: [] })
    await meter.settled()
    expect(usage.most).toBe(1)
    const at = new Date(now).toISOString()
    expect(meter.read(null)).toEqual({
      environment: { homeBytes: 9000, downloadsBytes: 1000, folderBytes: null, measuredAt: at },
      bots: [{ botId: 'ads', usedBytes: 3000, browserBytes: 2000, measuredAt: at }],
    })
    // Fresh figures are not measured again; old ones are, and answer the call after.
    now += 60_000
    meter.read(null)
    await meter.settled()
    expect(usage).toHaveBeenCalledTimes(4)
    now += 10 * 60_000
    meter.read(null)
    await meter.settled()
    expect(usage).toHaveBeenCalledTimes(8)
    // A server folder asked for is measured at once.
    meter.read('/srv/ws')
    await meter.settled()
    expect(meter.read('/srv/ws').environment?.folderBytes).toBe(5000)
  })

  it('keeps the previous figures when a measurement fails, and tries again only once they are old', async () => {
    let now = 0
    let fail = false
    const onError = vi.fn()
    const meter = new StorageMeter({
      targets,
      usage: async (paths) => {
        if (fail) throw new Error('du failed')
        return paths.length
      },
      now: () => now,
      onError,
    })
    meter.read(null)
    await meter.settled()
    const before = meter.read(null)
    fail = true
    now += 10 * 60_000
    meter.read(null)
    await meter.settled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(meter.read(null)).toEqual(before)
    await meter.settled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('measures nothing once disposed', async () => {
    const usage = fakeUsage()
    const meter = new StorageMeter({ targets, usage })
    meter.dispose()
    expect(meter.read(null)).toEqual({ environment: null, bots: [] })
    await meter.settled()
    expect(usage).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('du', () => {
  let dir = ''
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  it('measures real folders, and a missing one as nothing', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-storage-'))
    await mkdir(path.join(dir, 'a'))
    await writeFile(path.join(dir, 'a', 'data'), Buffer.alloc(256 * 1024, 1))
    const signal = new AbortController().signal
    const one = await duDiskUsage([path.join(dir, 'a')], signal)
    expect(one).toBeGreaterThanOrEqual(256 * 1024)
    expect(await duDiskUsage([path.join(dir, 'a'), path.join(dir, 'missing')], signal)).toBe(one)
    expect(await duDiskUsage([path.join(dir, 'missing')], signal)).toBe(0)
  })
})
