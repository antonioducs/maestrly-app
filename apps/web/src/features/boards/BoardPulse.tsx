import { t, useLocale, number } from '../../i18n/index.js'
import type { BoardSnapshot } from './BoardView.js'
import type { Operation } from '../executions/types.js'

/** One-line board vitals: where the work is, what runs now, what waits for a person. */
export function BoardPulse({ snapshot, executions }: { snapshot: BoardSnapshot; executions: Operation[] }) {
  useLocale()
  const open = snapshot.cards.filter((c) => !c.parentCardId).length
  const running = executions.filter((e) => e.runState === 'running' || e.jobState === 'active').length
  const waiting = executions.filter((e) => e.approvalStatus === 'pending' || e.informationRequestId).length
  return (
    <p className="board-pulse" role="status">
      <span>{t('{count} open', { count: number(open) })}</span>
      <span className={running ? 'live' : ''}>{t('{count} running now', { count: number(running) })}</span>
      <span className={waiting ? 'attention' : ''}>
        {waiting ? t('{count} waiting for you', { count: number(waiting) }) : t('Nothing waiting for you')}
      </span>
    </p>
  )
}
