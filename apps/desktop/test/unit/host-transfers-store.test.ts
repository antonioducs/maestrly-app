import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planRanges } from '../../src/main/host-transfers/ranges'
import {
  deleteHostTransfer,
  finishHostTransferRange,
  getHostTransfer,
  insertHostTransfer,
  listHostTransfers,
  type NewHostTransfer,
  pendingHostTransferRanges,
  recoverInterruptedHostTransfers,
  restartHostTransfer,
  updateHostTransfer,
} from '../../src/main/host-transfers/store'
import { getDb } from '../../src/main/store'
import { closeDb, freshDb, restartDb } from '../helpers/db'

beforeEach(freshDb)
afterEach(closeDb)

const transfer = (id: string, overrides: Partial<NewHostTransfer> = {}): NewHostTransfer => ({
  id,
  hostId: 'direct/host',
  direction: 'download',
  purpose: 'save',
  name: 'report.csv',
  remotePath: '/srv/report.csv',
  remoteDirectory: null,
  localPath: null,
  localDirectory: '/downloads',
  partialPath: `/downloads/.maestrly-${id}.download`,
  size: 10,
  identity: '10:1:2',
  overwrite: false,
  createdAt: 1_000,
  ...overrides,
})

describe('host transfer queue', () => {
  it('plans the ranges of a file', () => {
    expect(planRanges(0, 4)).toEqual([])
    expect(planRanges(10, 4)).toEqual([
      { index: 0, start: 0, length: 4 },
      { index: 1, start: 4, length: 4 },
      { index: 2, start: 8, length: 2 },
    ])
  })

  it('counts the bytes of finished ranges, and lists the ones left', () => {
    insertHostTransfer(transfer('a'), planRanges(10, 4))
    finishHostTransferRange('a', 1)
    expect(getHostTransfer('a')).toMatchObject({ id: 'a', state: 'queued', doneBytes: 4, overwrite: false })
    expect(pendingHostTransferRanges('a').map((range) => range.index)).toEqual([0, 2])
    expect(listHostTransfers().map((item) => [item.id, item.doneBytes])).toEqual([['a', 4]])
  })

  it('records what a transfer learns as it runs', () => {
    insertHostTransfer(transfer('a', { direction: 'upload', localPath: '/l/a.csv' }), planRanges(10, 4))
    updateHostTransfer('a', { state: 'failed', error: 'exists', uploadId: 'u'.repeat(24), overwrite: true })
    expect(getHostTransfer('a')).toMatchObject({
      state: 'failed',
      error: 'exists',
      uploadId: 'u'.repeat(24),
      overwrite: true,
    })
    updateHostTransfer('a', { overwrite: false, ignored: 'x' } as never)
    expect(getHostTransfer('a')?.overwrite).toBe(false)
    expect(listHostTransfers({ states: ['failed'] })).toHaveLength(1)
    expect(listHostTransfers({ states: ['queued'] })).toHaveLength(0)
  })

  it('starts a transfer over with new ranges and no session or checksums', () => {
    insertHostTransfer(transfer('a'), planRanges(10, 4))
    finishHostTransferRange('a', 0)
    updateHostTransfer('a', { uploadId: 'u'.repeat(24), remoteSha256: 'r'.repeat(64), localSha256: 'l'.repeat(64) })
    restartHostTransfer('a', { size: 6, identity: '6:2:2' }, planRanges(6, 4))
    expect(getHostTransfer('a')).toMatchObject({
      size: 6,
      identity: '6:2:2',
      doneBytes: 0,
      uploadId: null,
      remoteSha256: null,
      localSha256: null,
    })
    expect(pendingHostTransferRanges('a').map((range) => range.length)).toEqual([4, 2])
  })

  it('queues again what an app that quit was doing, but not what the person paused', () => {
    for (const [id, state] of [
      ['r', 'running'],
      ['w', 'waiting'],
      ['v', 'verifying'],
      ['p', 'paused'],
    ] as const) {
      insertHostTransfer(transfer(id), planRanges(10, 4))
      updateHostTransfer(id, { state })
    }
    restartDb()
    expect(recoverInterruptedHostTransfers()).toBe(3)
    expect(Object.fromEntries(listHostTransfers().map((item) => [item.id, item.state]))).toEqual({
      r: 'queued',
      w: 'queued',
      v: 'queued',
      p: 'paused',
    })
  })

  it('removes a transfer with its ranges', () => {
    insertHostTransfer(transfer('a'), planRanges(10, 4))
    deleteHostTransfer('a')
    expect(getHostTransfer('a')).toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM host_transfer_ranges').get()).toEqual({ n: 0 })
  })
})
