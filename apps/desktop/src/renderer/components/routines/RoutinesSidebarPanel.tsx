import { useTranslation } from 'react-i18next'
import { AlertTriangle, CalendarClock, ChevronRight } from 'lucide-react'
import type { HostView } from '../../../shared/hosts'
import { isRoutineRunSkipped, type LocalRoutine, type LocalRoutineRun } from '../../../shared/routines'
import { hostOfKey, isRemoteKey } from '@/lib/hosts/shell-keys'
import { routineHostDisplay, routineHostStatusLabel } from '@/lib/routines/host-routines'
import type { RoutinesMainView } from '@/lib/use-main-panels'
import { formatHHMM, formatRunDay, formatShortIn } from '@/lib/routines/relative-time'
import { daysSummary, scheduleSummary } from '@/lib/routines/schedule-text'
import { outcomeTone, runTimestamp } from '@/lib/routines/timeline'
import { cn } from '@/lib/utils'
import { RoutineDot, RoutineHostBadge } from './RoutineOutcomeBadge'

export function RoutinesSidebarPanel({
  routines,
  runsByRoutine,
  hosts = [],
  query,
  view,
  activeConversationId,
  backgroundEnabled,
  expandedIds,
  flashRoutineId,
  onToggleExpanded,
  onOpenAgenda,
  onOpenRoutine,
  onOpenRun,
  onEnableBackground,
}: {
  routines: readonly LocalRoutine[]
  runsByRoutine: Record<string, readonly LocalRoutineRun[]>
  hosts?: readonly HostView[]
  query: string
  view: RoutinesMainView | null
  activeConversationId: string | null
  backgroundEnabled: boolean
  expandedIds: ReadonlySet<string>
  flashRoutineId?: string | null
  onToggleExpanded: (routineId: string) => void
  onOpenAgenda: () => void
  onOpenRoutine: (routineId: string) => void
  onOpenRun: (routineId: string, runId: string) => void
  onEnableBackground: () => void
}) {
  const { t } = useTranslation('routines')
  const { t: tUi } = useTranslation('ui')
  const nowMs = Date.now()
  const q = query.trim().toLowerCase()
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
  const hostById = new Map(hosts.map((host) => [host.id, host]))

  const filtered = q
    ? routines.filter((r) => {
        const hostId = hostOfKey(r.id)
        const hostInfo = routineHostDisplay(hostById.get(hostId), hostId, tr)
        return (
          r.title.toLowerCase().includes(q) ||
          r.instruction.toLowerCase().includes(q) ||
          scheduleSummary(r.schedule, tr).toLowerCase().includes(q) ||
          hostInfo.fullLabel.toLowerCase().includes(q)
        )
      })
    : routines

  const active = filtered.filter((r) => r.enabled)
  const paused = filtered.filter((r) => !r.enabled)

  const renderRoutineRow = (routine: LocalRoutine) => {
    const routineHostId = hostOfKey(routine.id)
    const routineHost = hostById.get(routineHostId)
    const hostInfo = routineHostDisplay(routineHost, routineHostId, tr)
    const hostOffline = hostInfo.isRemote && !hostInfo.online
    const isOpen = expandedIds.has(routine.id)
    const allRuns = runsByRoutine[routine.id] ?? []
    const running = allRuns.find((run) => run.status === 'running')
    const last = allRuns.find((run) => !isRoutineRunSkipped(run))
    const isCurrentRoutine = view?.kind === 'routine' && view.id === routine.id
    const hasUnread = allRuns.some((run) => run.unread)
    const tone = running ? 'run' : last ? outcomeTone(last.status) : 'skip'
    const nextMs = routine.enabled && !hostOffline ? routine.nextRunAt : null

    const visibleRuns = allRuns.slice(0, 5)
    const activeRun =
      activeConversationId != null ? allRuns.find((run) => run.conversationId === activeConversationId) : undefined
    if (activeRun && !visibleRuns.some((run) => run.id === activeRun.id)) {
      visibleRuns.push(activeRun)
    }

    const lastTitle = last
      ? t('list.lastRunTitle', { label: t(`outcome.${last.status}.label` as never) })
      : t('list.lastRunTitle', { label: t('list.lastRunNone') })

    return (
      <div
        key={routine.id}
        className={cn('rounded-[8px]', flashRoutineId === routine.id && 'routine-flash', hostOffline && 'opacity-65')}
      >
        <div
          aria-current={isCurrentRoutine ? 'true' : undefined}
          className={cn(
            'group flex w-full items-start gap-2 rounded-[8px] px-2 py-[7px] text-left transition-colors',
            isCurrentRoutine
              ? 'bg-[rgba(237,234,227,0.09)] text-foreground'
              : 'text-foreground/78 hover:bg-white/[0.04]',
            hasUnread && 'text-foreground'
          )}
        >
          <button
            type="button"
            aria-expanded={isOpen}
            aria-label={
              isOpen
                ? t('list.hideRuns', { title: routine.title })
                : t('list.showRuns', { title: routine.title })
            }
            onClick={() => onToggleExpanded(routine.id)}
            className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[rgba(154,149,140,0.58)] transition-transform duration-150 hover:bg-white/[0.07] hover:text-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn('size-[11px] transition-transform duration-150', isOpen && 'rotate-90')}
            />
          </button>

          <button
            type="button"
            onClick={() => onOpenRoutine(routine.id)}
            className="min-w-0 flex-1 text-left"
          >
            <span
              className={cn(
                'block truncate text-[13px]',
                hasUnread && 'font-semibold text-foreground'
              )}
            >
              {routine.title}
            </span>
            <span className="block truncate text-[11.5px] text-[rgba(154,149,140,0.58)]">
              <span className="font-mono tabular-nums">
                {routine.schedule.kind === 'weekly'
                  ? routine.schedule.time
                  : scheduleSummary(routine.schedule, tr)}
              </span>
              {routine.schedule.kind === 'weekly' && ` · ${daysSummary(routine.schedule.days, tr)}`}
            </span>
            {hostInfo.isRemote && (
              <span className="mt-0.5 block">
                <RoutineHostBadge host={routineHost} hostId={routineHostId} compact showStatus={false} />
              </span>
            )}
          </button>

          <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-[rgba(154,149,140,0.58)]">
            {hostOffline ? (
              <span className={hostInfo.stopped ? 'text-[var(--artifact-warn)]' : undefined}>
                {routineHostStatusLabel(hostInfo.status, tr)}
              </span>
            ) : running ? (
              <span className="text-foreground">{t('list.running')}</span>
            ) : nextMs ? (
              <span>{t('list.inShort', { time: formatShortIn(nextMs, nowMs, tr) })}</span>
            ) : (
              <span>{t('list.pausedAside')}</span>
            )}
            <RoutineDot tone={tone} title={lastTitle} />
          </span>
        </div>

        {isOpen && (
          <div className="mb-1.5 ml-[26px] border-l border-border pl-1">
            {visibleRuns.length === 0 ? (
              <p className="px-2 pb-1 pt-2 text-[11px] text-[rgba(154,149,140,0.58)]">{t('list.emptyRuns')}</p>
            ) : (
              <>
                {visibleRuns.map((run) => {
                  const at = runTimestamp(run)
                  const skipped = isRoutineRunSkipped(run)
                  const isCurrentRun =
                    (activeConversationId != null && run.conversationId === activeConversationId) ||
                    (view?.kind === 'run-gone' && view.runId === run.id)
                  const label = t(`outcome.${run.status}.label` as never)
                  const short = t(`outcome.${run.status}.short` as never)
                  const runTone = outcomeTone(run.status)
                  return (
                    <button
                      key={run.id}
                      type="button"
                      disabled={skipped}
                      aria-current={isCurrentRun ? 'true' : undefined}
                      title={label}
                      onClick={() => onOpenRun(routine.id, run.id)}
                      className={cn(
                        'flex min-h-[27px] w-full items-center gap-2 rounded-[8px] px-2 py-[3px] text-left text-[12px] transition-colors',
                        isCurrentRun
                          ? 'bg-[rgba(237,234,227,0.09)] text-foreground'
                          : 'text-foreground/78 hover:bg-white/[0.04]',
                        skipped && 'cursor-default opacity-60 hover:bg-transparent',
                        run.unread && 'text-foreground'
                      )}
                    >
                      <span className="w-[92px] shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {formatRunDay(at, nowMs, tr)} {formatHHMM(at)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className={cn('block truncate', run.unread && 'font-semibold text-foreground')}>
                          {short}
                        </span>
                      </span>
                      <RoutineDot tone={runTone} />
                    </button>
                  )
                })}
                {allRuns.length > 5 && (
                  <button
                    type="button"
                    onClick={() => onOpenRoutine(routine.id)}
                    className="px-2 py-[3px] text-left text-[11.5px] text-[rgba(154,149,140,0.58)] hover:text-foreground"
                  >
                    {t('list.viewAllRuns', { count: allRuns.length })}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  const hasEnabledLocalRoutine = routines.some((r) => r.enabled && !isRemoteKey(r.id))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-4">
      {!backgroundEnabled && hasEnabledLocalRoutine && view?.kind !== 'agenda' && (
        <div
          role="status"
          className="mx-1 mb-2 flex flex-col items-start gap-1.5 rounded-[10px] border border-[rgba(242,180,92,0.22)] bg-[rgba(242,180,92,0.08)] px-3 py-2.5 text-[12px] text-[#f6ddb4]"
        >
          <strong className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle aria-hidden="true" className="size-[13px] shrink-0 text-[var(--artifact-warn)]" />
            <span>{t('background.sideTitle')}</span>
          </strong>
          <span>{t('background.sideDesc')}</span>
          <button
            type="button"
            onClick={onEnableBackground}
            className="inline-flex h-[26px] items-center justify-center rounded-[8px] border border-border-strong px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
          >
            {t('background.keepInBackground')}
          </button>
        </div>
      )}

      <button
        type="button"
        aria-current={view?.kind === 'agenda' ? 'true' : undefined}
        onClick={onOpenAgenda}
        className={cn(
          'flex min-h-8 w-full items-center gap-2 rounded-[8px] px-2 py-[5px] text-left text-[13px] transition-colors',
          view?.kind === 'agenda'
            ? 'bg-[rgba(237,234,227,0.09)] text-foreground'
            : 'text-foreground/78 hover:bg-white/[0.04]'
        )}
      >
        <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-[rgba(154,149,140,0.58)]" />
        <span className="min-w-0 flex-1 truncate">{t('list.agenda')}</span>
      </button>

      {active.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-3 text-[11px] text-[rgba(154,149,140,0.58)]">{t('list.active')}</div>
          {active.map(renderRoutineRow)}
        </>
      )}

      {paused.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-3 text-[11px] text-[rgba(154,149,140,0.58)]">{t('list.paused')}</div>
          {paused.map(renderRoutineRow)}
        </>
      )}

      {routines.length === 0 ? (
        <p className="px-2 pb-1 pt-3 text-[11px] text-[rgba(154,149,140,0.58)]">{t('list.empty')}</p>
      ) : (
        q &&
        filtered.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">{tUi('sidebar.nothingFound')}</p>
        )
      )}
    </div>
  )
}
