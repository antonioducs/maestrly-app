import type { FleetBackupRun } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import { FleetBackupNotices } from '../../src/main/notifications/backup-notices'
import type { SystemNotice } from '../../src/main/notifications/system-notices'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import type { NotificationTarget } from '../../src/shared/notifications'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const AT = '2026-11-07T03:00:00.000Z'
function run(overrides: Partial<FleetBackupRun> = {}): FleetBackupRun {
  return {
    id: '0b7a3c52-9d41-4c2e-8f60-1a2b3c4d5e6f',
    kind: 'backup',
    environmentId: 'work',
    environmentName: 'Work',
    trigger: 'schedule',
    state: 'failed',
    phase: 'finish',
    progress: null,
    snapshotId: null,
    bytesAdded: null,
    bytesTotal: null,
    error: { code: 'storage-full', message: '' },
    startedAt: AT,
    finishedAt: AT,
    ...overrides,
  }
}
function setup(serverName: string | null = null) {
  const shown: SystemNotice[] = []
  const opened: NotificationTarget[] = []
  const notices = new FleetBackupNotices({
    notices: { show: vi.fn((notice: SystemNotice) => void shown.push(notice)) },
    serverName: () => serverName,
    open: (target) => void opened.push(target),
  })
  return { notices, shown, opened }
}

describe('backup notifications', () => {
  it('notifies a scheduled backup that failed, and opens the server backups when clicked', () => {
    const f = setup('Home server')
    f.notices.run(SERVER, run())
    expect(f.shown).toHaveLength(1)
    expect(f.shown[0]).toMatchObject({
      key: `backup:${SERVER}:${run().id}`,
      title: 'Backup of Work failed',
      subtitle: 'Home server',
      body: 'The backup storage is full.',
    })
    f.shown[0].onClick()
    expect(f.opened).toEqual([{ kind: 'backups', serverId: SERVER }])
  })

  it('leaves out backups that succeeded, manual runs and restores', () => {
    const f = setup()
    f.notices.run(SERVER, run({ state: 'succeeded', error: null }))
    f.notices.run(SERVER, run({ state: 'running', error: null }))
    f.notices.run(SERVER, run({ trigger: 'manual' }))
    f.notices.run(SERVER, run({ kind: 'restore' }))
    expect(f.shown).toEqual([])
  })

  it('notifies a run once, however often it is told', () => {
    const f = setup()
    f.notices.run(SERVER, run())
    f.notices.run(SERVER, run())
    f.notices.run(SERVER, run({ id: 'f1e2d3c4-0000-4000-8000-000000000001', error: null }))
    expect(f.shown.map((notice) => notice.body)).toEqual(['The backup storage is full.', 'Open Settings to see why.'])
    expect(f.shown[0]).not.toHaveProperty('subtitle')
  })
})
