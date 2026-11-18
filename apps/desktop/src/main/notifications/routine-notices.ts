import type { NotificationTarget } from '../../shared/notifications'
import type { LocalRoutine, LocalRoutineRun } from '../../shared/routines'
import { tMain } from '../i18n'
import type { SystemNotice } from './system-notices'

export interface RoutineNoticesDeps {
  notices: { show(notice: SystemNotice): void; dismiss(key: string): void }
  sees(conversationId: string): boolean
  open(target: NotificationTarget): void
}

const noticeKey = (runId: string) => `routine-run:${runId}`

export class RoutineNotices {
  constructor(private readonly deps: RoutineNoticesDeps) {}

  notifyRun(run: LocalRoutineRun, routine: Pick<LocalRoutine, 'id' | 'title'>): void {
    if (run.conversationId && this.deps.sees(run.conversationId)) return
    const t = tMain('main')
    let body: string
    if (run.status === 'waiting') {
      body = t('notices.routine.waiting')
    } else if (run.status === 'failed') {
      body = run.error ? t('notices.routine.failedWithError', { error: run.error }) : t('notices.routine.failed')
    } else if (run.summary) {
      body = run.summary
    } else if (run.status === 'notable') {
      body = t('notices.routine.notable')
    } else {
      body = t('notices.routine.finished')
    }

    this.deps.notices.show({
      key: noticeKey(run.id),
      title: routine.title,
      body,
      onClick: () =>
        this.deps.open({
          kind: 'routine-run',
          routineId: routine.id,
          runId: run.id,
          conversationId: run.conversationId,
        }),
    })
  }

  seen(runId: string): void {
    this.deps.notices.dismiss(noticeKey(runId))
  }
}
