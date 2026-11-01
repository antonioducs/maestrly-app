import { describe, expect, it } from 'vitest'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { diskSize, environmentDiskBytes, environmentDiskSegments } from '../../src/renderer/lib/fleet/format'

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const at = '2026-11-01T10:00:00.000Z'
const env = (storage: FleetEnvironment['storage']) => ({ id: 'work', storage }) as FleetEnvironment
const bot = (id: string, name: string, usedBytes: number | null, environmentId = 'work') =>
  ({
    id,
    name,
    tint: '#112233',
    environmentId,
    storage: usedBytes === null ? null : { usedBytes, browserBytes: usedBytes / 2, measuredAt: at },
  }) as FleetBot

describe('fleet disk figures', () => {
  it('writes sizes in MB under a gigabyte and in GB above', () => {
    expect(diskSize(0)).toBe('0 MB')
    expect(diskSize(300 * MiB)).toBe('300 MB')
    expect(diskSize(1.5 * GiB)).toBe('1.5 GB')
  })

  it('counts a workspaces environment with its own folder', () => {
    expect(environmentDiskBytes(env(null))).toBeNull()
    expect(environmentDiskBytes(env({ homeBytes: 2 * GiB, downloadsBytes: 0, folderBytes: GiB, measuredAt: at }))).toBe(
      3 * GiB
    )
  })

  it('splits an environment into its bots, Downloads and what they share', () => {
    const segments = environmentDiskSegments(
      env({ homeBytes: 10 * GiB, downloadsBytes: GiB, folderBytes: null, measuredAt: at }),
      [bot('b', 'Zed', 3 * GiB), bot('a', 'Ana', 2 * GiB), bot('c', 'New', null), bot('x', 'Other', 5 * GiB, 'home')]
    )
    expect(segments.map((item) => [item.kind, item.name, item.bytes / GiB])).toEqual([
      ['bot', 'Ana', 2],
      ['bot', 'Zed', 3],
      ['downloads', '', 1],
      ['shared', '', 4],
    ])
    expect(segments[0].browserBytes).toBe(GiB)
    expect(segments.reduce((sum, item) => sum + item.fraction, 0)).toBeCloseTo(1)
  })

  it('keeps the bar within its width when bots were measured as larger than the home folder', () => {
    const segments = environmentDiskSegments(
      env({ homeBytes: GiB, downloadsBytes: 0, folderBytes: null, measuredAt: at }),
      [bot('a', 'Ana', 2 * GiB)]
    )
    expect(segments.map((item) => item.kind)).toEqual(['bot'])
    expect(segments[0].fraction).toBe(1)
  })
})
