import { hostKey, type HostId } from '../../shared/host-key'
import type { NotificationTarget } from '../../shared/notifications'
import type { LocalRoutine, LocalRoutineRun } from '../../shared/routines'
import { tMain } from '../i18n'
import type { SystemNotice } from './system-notices'

export interface RoutineNoticesDeps {
  notices: { show(notice: SystemNotice): void; dismiss(key: string): void }
  sees(conversationId: string): boolean
  open(target: NotificationTarget): void
}

export interface RoutineNoticeHost {
  hostId: HostId
  label?: string | null
}

const noticeKey = (runId: string) => `routine-run:${runId}`

export class RoutineNotices {
  constructor(private readonly deps: RoutineNoticesDeps) {}

  notifyRun(
    run: LocalRoutineRun,
    routine: Pick<LocalRoutine, 'id' | 'title'>,
    host?: RoutineNoticeHost
  ): void {
    const routineId = host ? hostKey(host.hostId, routine.id) : routine.id
    const runId = host ? hostKey(host.hostId, run.id) : run.id
    const conversationId = run.conversationId
      ? host
        ? hostKey(host.hostId, run.conversationId)
        : run.conversationId
      : null
    if (conversationId && this.deps.sees(conversationId)) return
    const t = tMain('main')
    let body: string
    if (run.status === 'waiting') {
      body = run.waiting?.kind === 'question' ? t('notices.routine.waitingQuestion') : t('notices.routine.waiting')
    } else if (run.status === 'failed') {
      body = run.error ? t('notices.routine.failedWithError', { error: run.error }) : t('notices.routine.failed')
    } else if (run.summary) {
      body = run.summary
    } else if (run.status === 'notable') {
      body = t('notices.routine.notable')
    } else {
      body = t('notices.routine.finished')
    }

    const hostLabel = host?.label?.trim()
    const title = hostLabel ? `${routine.title} · ${hostLabel}` : routine.title

    this.deps.notices.show({
      key: noticeKey(runId),
      title,
      body,
      onClick: () =>
        this.deps.open({
          kind: 'routine-run',
          routineId,
          runId,
          conversationId,
        }),
    })
  }

  seen(runId: string): void {
    this.deps.notices.dismiss(noticeKey(runId))
  }
}
