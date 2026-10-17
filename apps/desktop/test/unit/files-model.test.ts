import { describe, expect, it } from 'vitest'
import {
  defaultRoot,
  formatDuration,
  transferDetail,
  transferProgress,
  transferStageLabel,
  transfersOfHost,
  uploadsLandedIn,
} from '../../src/renderer/components/files/files-model'
import type { HostTransferView } from '../../src/shared/host-transfers'

const MiB = 1024 * 1024
const view = (overrides: Partial<HostTransferView>): HostTransferView => ({
  id: 't',
  hostId: 'direct/host',
  direction: 'upload',
  purpose: 'save',
  kind: 'file',
  stage: null,
  stageProgress: null,
  name: 'x.bin',
  remotePath: '/srv/x.bin',
  localPath: null,
  size: 4 * MiB,
  doneBytes: 0,
  state: 'running',
  error: null,
  errorMessage: null,
  bytesPerSecond: null,
  remainingMs: null,
  sha256: null,
  createdAt: 1,
  finishedAt: null,
  ...overrides,
})

describe('files panel model', () => {
  it("lists a host's transfers, newest first", () => {
    const all = [
      view({ id: 'old', createdAt: 1 }),
      view({ id: 'other', hostId: 'server/workspaces', createdAt: 5 }),
      view({ id: 'new', createdAt: 9 }),
    ]
    expect(transfersOfHost(all, 'direct/host').map((item) => item.id)).toEqual(['new', 'old'])
  })

  it('notices an upload that just landed in the folder on screen', () => {
    const before = [view({ id: 'a' }), view({ id: 'b', state: 'done' })]
    expect(uploadsLandedIn(before, [view({ id: 'a', state: 'done' })], '/srv')).toBe(true)
    expect(uploadsLandedIn(before, [view({ id: 'a', state: 'done' })], '/home')).toBe(false)
    expect(uploadsLandedIn(before, [view({ id: 'b', state: 'done' })], '/srv')).toBe(false)
    expect(
      uploadsLandedIn(
        [view({ id: 'd', direction: 'download' })],
        [view({ id: 'd', direction: 'download', state: 'done' })],
        '/srv'
      )
    ).toBe(false)
  })

  it("opens on the server's workspaces folder, else the first folder it allows", () => {
    expect(
      defaultRoot([
        { path: '/home/maestrly', label: 'home' },
        { path: '/srv/maestrly', label: 'workspaces' },
      ])
    ).toBe('/srv/maestrly')
    expect(defaultRoot([{ path: '/home/maestrly', label: 'home' }])).toBe('/home/maestrly')
    expect(defaultRoot([])).toBeNull()
  })

  it('says how long is left in short units', () => {
    expect(formatDuration(15_000, 'en')).toBe('15 sec')
    expect(formatDuration(185_000, 'en')).toBe('3 min')
    expect(formatDuration(3_900_000, 'en')).toBe('1 hr 5 min')
  })

  it('sums up a transfer as done of total, speed and time left', () => {
    const t = (key: string, values: Record<string, string>) =>
      key === 'files.transfers.progress' ? `${values.done} of ${values.total}` : `${values.time} left`
    expect(transferDetail(view({ doneBytes: MiB, bytesPerSecond: MiB, remainingMs: 3_000 }), 'en', t)).toBe(
      '1.0 MB of 4.0 MB · 1.0 MB/s · 3 sec left'
    )
    expect(transferDetail(view({ doneBytes: 2 * MiB }), 'en', t)).toBe('2.0 MB of 4.0 MB')
  })

  it('shows a folder being packed or extracted by its own progress, not by bytes moved', () => {
    const t = () => 'bytes'
    const folder = (overrides: Partial<HostTransferView>) => view({ kind: 'folder', size: 0, ...overrides })
    const packing = folder({ direction: 'download', stage: 'packing', stageProgress: null })
    expect(transferStageLabel(packing)).toBe('packingRemote')
    expect(transferProgress(packing)).toBeNull()
    expect(transferDetail(packing, 'en', t)).toBe('')
    const local = folder({ stage: 'packing', stageProgress: 0.25 })
    expect(transferStageLabel(local)).toBe('packingLocal')
    expect(transferProgress(local)).toBe(25)
    expect(transferDetail(local, 'en', t)).toBe('25%')
    // Paused while packing: nothing moves, and nothing pretends to.
    expect(transferProgress(folder({ stage: 'packing', state: 'paused' }))).toBe(0)
    expect(transferStageLabel(folder({ stage: 'packing', state: 'paused' }))).toBeNull()
    const extracting = folder({ direction: 'download', stage: 'extracting', size: 4 * MiB, stageProgress: 0.5 })
    expect(transferStageLabel(extracting)).toBe('extractingLocal')
    expect(transferProgress(extracting)).toBe(50)
    expect(transferStageLabel(folder({ stage: 'transferring', state: 'verifying', size: 4 * MiB }))).toBe(
      'extractingRemote'
    )
    const moving = folder({ stage: 'transferring', size: 4 * MiB, doneBytes: MiB })
    expect([transferStageLabel(moving), transferProgress(moving), transferDetail(moving, 'en', t)]).toEqual([
      null,
      25,
      'bytes',
    ])
    const done = folder({
      direction: 'download',
      stage: 'extracting',
      state: 'done',
      size: 4 * MiB,
      doneBytes: 4 * MiB,
    })
    expect(transferProgress(done)).toBe(100)
    expect(transferStageLabel(view({ state: 'verifying' }))).toBeNull()
  })
})
