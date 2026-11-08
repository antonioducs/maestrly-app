import type { FleetBackupRun } from '@maestrly/bot-fleet-protocol'
import type { FleetServerId } from '../../shared/fleet-servers'
import type { NotificationTarget } from '../../shared/notifications'
import { tMain } from '../i18n'
import type { SystemNotices } from './system-notices'

export interface FleetBackupNoticesDeps {
  notices: Pick<SystemNotices, 'show'>
  /** The server's name when the owner pairs several, to tell their backups apart; null otherwise. */
  serverName(serverId: FleetServerId): string | null
  open(target: NotificationTarget): void
}

/** Runs already notified, so that the same run told again (on every reconnection) notifies once. */
const NOTIFIED_MAX = 200

/**
 * System notifications of servers' backups. A scheduled backup that failed notifies once: nobody is watching it run.
 * Manual runs and restores are followed in the app, where they were started.
 */
export class FleetBackupNotices {
  private readonly notified = new Set<string>()

  constructor(private readonly deps: FleetBackupNoticesDeps) {}

  run(serverId: FleetServerId, run: FleetBackupRun): void {
    if (run.kind !== 'backup' || run.trigger !== 'schedule' || run.state !== 'failed') return
    const key = `backup:${serverId}:${run.id}`
    if (this.notified.has(key)) return
    this.notified.add(key)
    if (this.notified.size > NOTIFIED_MAX) this.notified.delete(this.notified.values().next().value!)
    const t = tMain('main')
    const subtitle = this.deps.serverName(serverId)
    this.deps.notices.show({
      key,
      title: t('notices.backup.failedTitle', { environment: run.environmentName || run.environmentId }),
      ...(subtitle ? { subtitle } : {}),
      body: t(`notices.backup.${run.error?.code ?? 'failed'}`),
      onClick: () => this.deps.open({ kind: 'backups', serverId }),
    })
  }
}
