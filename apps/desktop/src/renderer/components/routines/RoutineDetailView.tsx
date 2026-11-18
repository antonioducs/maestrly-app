import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  Copy,
  Folder,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  isRoutineRunSkipped,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineRunFilter,
  type RoutineSavedPermission,
} from '../../../shared/routines'
import { formatDuration, formatHHMM, formatRelative, formatRunDay, formatWhen } from '@/lib/routines/relative-time'
import { daysSummary, scheduleBigTime, scheduleSummary } from '@/lib/routines/schedule-text'
import { runTimestamp } from '@/lib/routines/timeline'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  RoutineModelLine,
  RoutineOutcomePill,
  RoutinePermBadge,
  RoutineSavedPermissionLabel,
} from './RoutineOutcomeBadge'
import { RoutineTimeline } from './RoutineTimeline'

export function RoutineDetailView({
  routine,
  runs,
  totalRuns,
  hasMoreRuns,
  timelineRuns,
  savedPermissions,
  filter,
  modelInfo,
  onFilterChange,
  onShowMore,
  onBackAgenda,
  onToggleEnabled,
  onRunNow,
  onStopRun,
  onEdit,
  onDuplicate,
  onDelete,
  onOpenRun,
  onRemoveSavedPermission,
  onOpenFolder,
  onOpenOriginChat,
}: {
  routine: LocalRoutine
  runs: readonly LocalRoutineRun[]
  totalRuns: number
  hasMoreRuns: boolean
  timelineRuns: readonly LocalRoutineRun[]
  savedPermissions: readonly RoutineSavedPermission[]
  filter: RoutineRunFilter
  modelInfo: { name: string; providerName: string }
  onFilterChange: (filter: RoutineRunFilter) => void
  onShowMore: () => void
  onBackAgenda: () => void
  onToggleEnabled: () => void
  onRunNow: () => void
  onStopRun: (runId: string) => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => Promise<void> | void
  onOpenRun: (routineId: string, runId: string) => void
  onRemoveSavedPermission: (permId: string) => void
  onOpenFolder: () => void
  onOpenOriginChat: (conversationId: string) => void
}) {
  const { t } = useTranslation('routines')
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const nowMs = Date.now()
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))

  const running =
    runs.find((run) => run.status === 'running') ?? timelineRuns.find((run) => run.status === 'running') ?? null
  const nextMs = routine.enabled ? routine.nextRunAt : null
  const remainingRuns = Math.max(0, totalRuns - runs.length)

  const scheduleLine =
    routine.schedule.kind === 'weekly'
      ? t('detail.fixedSchedule', {
          days: daysSummary(routine.schedule.days, tr),
          tz: routine.schedule.timezone,
        })
      : t('detail.intervalSchedule', { summary: scheduleSummary(routine.schedule, tr) })

  const configScheduleLine =
    routine.schedule.kind === 'weekly'
      ? t('detail.configScheduleWeekly', {
          time: routine.schedule.time,
          days: daysSummary(routine.schedule.days, tr),
          tz: routine.schedule.timezone,
        })
      : t('detail.configScheduleInterval', { summary: scheduleSummary(routine.schedule, tr) })

  const handleConfirmDelete = async () => {
    setDeleting(true)
    try {
      await onDelete()
      setConfirmDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-chat-canvas">
      <header className="drag flex h-10 shrink-0 items-center gap-2 hairline-b pl-[var(--view-header-inset)] pr-3">
        <button
          type="button"
          onClick={onBackAgenda}
          className="no-drag -ml-1 inline-flex max-w-[28vw] shrink items-center gap-1 truncate rounded-[6px] px-1 py-0.5 text-[13px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
        >
          {t('detail.crumb')}
        </button>
        <ChevronRight aria-hidden="true" className="size-[11px] shrink-0 text-[rgba(154,149,140,0.58)]" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{routine.title}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-[820px] px-7 pb-20 pt-7 max-[900px]:px-4 max-[900px]:py-5 max-[900px]:pb-20">
          <div className="mb-[18px] flex flex-wrap items-end gap-x-[18px] gap-y-2">
            <div
              className={cn(
                'routine-hero-time font-mono text-[44px] leading-[0.95] tracking-[-0.03em] tabular-nums',
                routine.enabled ? 'text-[var(--routine)]' : 'text-[rgba(154,149,140,0.58)]'
              )}
            >
              {scheduleBigTime(routine.schedule)}
            </div>

            <div className="min-w-0 pb-[3px]">
              <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em] text-foreground">{routine.title}</h1>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{scheduleLine}</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                {running ? (
                  <span className="routine-pill routine-tone-run">
                    <Loader2 aria-hidden="true" className="size-[11px] animate-spin" />
                    <span>{t('detail.runningNow')}</span>
                  </span>
                ) : nextMs ? (
                  <>
                    {t('detail.next')}{' '}
                    <span className="font-mono tabular-nums text-foreground">{formatWhen(nextMs, nowMs, tr)}</span> ·{' '}
                    {formatRelative(nextMs, nowMs, tr)}
                  </>
                ) : (
                  <span className="routine-pill is-paused">
                    <Square aria-hidden="true" className="size-[11px]" />
                    <span>
                      {routine.pausedAt
                        ? t('detail.pausedSince', { when: formatWhen(routine.pausedAt, nowMs, tr).toLowerCase() })
                        : t('detail.paused')}
                    </span>
                  </span>
                )}
              </p>
            </div>

            <div className="routine-hero-actions ml-auto flex items-center gap-1.5 pb-0.5">
              <span className="mr-1.5 inline-flex items-center gap-2 text-[12px] text-muted-foreground">
                <span>{routine.enabled ? t('detail.activeLabel') : t('detail.pausedLabel')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={routine.enabled}
                  aria-label={t('detail.toggleAria')}
                  onClick={onToggleEnabled}
                  className="routine-switch"
                />
              </span>

              {running ? (
                <button
                  type="button"
                  onClick={() => onStopRun(running.id)}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] border border-border-strong px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
                >
                  <Square aria-hidden="true" className="size-3.5" />
                  <span>{t('detail.stop')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onRunNow}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] border border-border-strong px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
                >
                  <Play aria-hidden="true" className="size-3.5" />
                  <span>{t('detail.runNow')}</span>
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('detail.moreActions')}
                    className="grid size-7 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.06] data-[state=open]:text-foreground"
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem onClick={onEdit}>
                    <Pencil aria-hidden="true" />
                    <span>{t('detail.edit')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onDuplicate}>
                    <Copy aria-hidden="true" />
                    <span>{t('detail.duplicate')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setConfirmDeleteOpen(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 aria-hidden="true" />
                    <span>{t('detail.delete')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <RoutineTimeline
            single
            routines={[routine]}
            runsByRoutine={{ [routine.id]: timelineRuns }}
            nowMs={nowMs}
            onOpenRoutine={() => {}}
            onOpenRun={onOpenRun}
          />

          <section className="mt-[26px]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('detail.runsTitle')}</h2>
              <div
                role="group"
                aria-label={t('detail.filterAria')}
                className="ml-2 inline-flex gap-0.5 rounded-[8px] bg-white/[0.04] p-0.5"
              >
                {(
                  [
                    ['all', t('detail.filterAll')],
                    ['notable', t('detail.filterNotable')],
                    ['issues', t('detail.filterIssues')],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => onFilterChange(key)}
                    className={cn(
                      'rounded-[6px] px-[9px] py-0.5 text-[11.5px] transition-colors',
                      filter === key ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-[11.5px] text-[rgba(154,149,140,0.58)]">
                {routine.retentionDays != null
                  ? t('detail.keptForDays', { count: routine.retentionDays })
                  : t('detail.keptForever')}
              </span>
            </div>

            <div className="rounded-[var(--radius)] border border-border bg-white/[0.02]">
              {runs.length === 0 ? (
                <p className="m-0 p-3.5 text-[13px] text-muted-foreground">
                  {filter !== 'all' || totalRuns > 0 ? t('detail.emptyRunsFiltered') : t('detail.emptyRunsNever')}
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {runs.map((run) => {
                    const skipped = isRoutineRunSkipped(run)
                    const at = runTimestamp(run)
                    const durSec =
                      run.startedAt != null && run.finishedAt != null
                        ? Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))
                        : null
                    const lateTime = run.trigger === 'late' && run.startedAt != null ? formatHHMM(run.startedAt) : null
                    const label = t(`outcome.${run.status}.label` as never)
                    const body = (
                      <>
                        <span className="routine-run-when whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground">
                          {formatRunDay(at, nowMs, tr, true)} {formatHHMM(run.scheduledAt)}
                          {lateTime && (
                            <span className="text-[rgba(154,149,140,0.58)]"> → {lateTime}</span>
                          )}
                          {run.trigger === 'manual' && (
                            <span className="text-[rgba(154,149,140,0.58)]"> · {t('detail.manualTag')}</span>
                          )}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 truncate text-[12.5px]',
                            skipped
                              ? 'text-[rgba(154,149,140,0.58)]'
                              : run.unread
                                ? 'font-medium text-foreground'
                                : 'text-foreground/78'
                          )}
                        >
                          {run.conversationDeleted ? t('detail.runDeletedRow') : (run.summary ?? label)}
                        </span>
                        <span className="flex items-center gap-2 text-[11px] text-[rgba(154,149,140,0.58)]">
                          {run.pinned && <Pin aria-hidden="true" className="size-[11px]" />}
                          {durSec != null && durSec > 0 && (
                            <span className="routine-run-dur font-mono tabular-nums">{formatDuration(durSec)}</span>
                          )}
                          <RoutineOutcomePill status={run.status} />
                        </span>
                      </>
                    )
                    return (
                      <li key={run.id} className="border-b border-white/[0.045] last:border-b-0">
                        {skipped ? (
                          <div className="routine-run-item">{body}</div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenRun(routine.id, run.id)}
                            className="routine-run-item hover:bg-white/[0.03]"
                          >
                            {body}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {hasMoreRuns && remainingRuns > 0 && (
                <div className="border-t border-border px-3.5 py-[9px]">
                  <button
                    type="button"
                    onClick={onShowMore}
                    className="text-[11.5px] text-[rgba(154,149,140,0.58)] hover:text-foreground"
                  >
                    {t('detail.showMore', { next: Math.min(10, remainingRuns), remaining: remainingRuns })}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="mt-[26px]">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('detail.configTitle')}</h2>
              <button
                type="button"
                onClick={onEdit}
                className="ml-auto inline-flex h-[26px] items-center gap-1.5 rounded-[8px] border border-border-strong px-[9px] text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
              >
                <Pencil aria-hidden="true" className="size-3.5" />
                <span>{t('detail.edit')}</span>
              </button>
            </div>

            <dl className="m-0 rounded-[var(--radius)] border border-border bg-white/[0.02]">
              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configInstruction')}</dt>
                <dd className="m-0 min-w-0 whitespace-pre-wrap text-[12.5px] text-foreground/78">
                  {routine.instruction}
                </dd>
              </div>

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configSchedule')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <span>{configScheduleLine}</span>
                  <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('detail.configOverlapNote')}
                  </span>
                </dd>
              </div>

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configMissed')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <span>{routine.missed === 'catchup' ? t('schedule.missedCatchup') : t('schedule.missedSkip')}</span>
                  <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('detail.configMissedNote')}
                  </span>
                </dd>
              </div>

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configPermissions')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <RoutinePermBadge mode={routine.permMode} />
                  <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t(`permMode.${routine.permMode}Routine` as never)}
                  </span>
                </dd>
              </div>

              {routine.permMode !== 'full' && (
                <div className="routine-set-row">
                  <dt className="text-[12.5px] text-muted-foreground">{t('detail.configAlwaysAllowed')}</dt>
                  <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                    {savedPermissions.length > 0 ? (
                      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                        {savedPermissions.map((perm) => (
                          <li
                            key={perm.id}
                            className="inline-flex items-center gap-1 rounded-[7px] border border-border py-0.5 pl-2 pr-0.5 text-[12px]"
                          >
                            <RoutineSavedPermissionLabel perm={perm} />
                            <button
                              type="button"
                              aria-label={t('detail.removePermissionAria', { resource: perm.resource })}
                              title={t('detail.removePermissionTitle')}
                              onClick={() => onRemoveSavedPermission(perm.id)}
                              className="grid size-5 place-items-center rounded-[5px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                            >
                              <X aria-hidden="true" className="size-[11px]" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-[rgba(154,149,140,0.58)]">{t('detail.configAlwaysAllowedNone')}</span>
                    )}
                    <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                      {t('detail.configAlwaysAllowedNote')}
                    </span>
                  </dd>
                </div>
              )}

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configModel')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <RoutineModelLine
                    model={routine.model}
                    modelName={modelInfo.name}
                    providerName={modelInfo.providerName}
                  />
                </dd>
              </div>

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configFiles')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <Folder aria-hidden="true" className="size-[13px] text-[rgba(154,149,140,0.58)]" />
                  <span>{t('detail.configFilesDesc')}</span>
                  <button
                    type="button"
                    onClick={onOpenFolder}
                    className="inline-flex h-[26px] items-center rounded-[8px] px-[9px] text-[12px] font-medium text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  >
                    {t('detail.openFolder')}
                  </button>
                  <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('detail.configFilesNote')}
                  </span>
                </dd>
              </div>

              <div className="routine-set-row">
                <dt className="text-[12.5px] text-muted-foreground">{t('detail.configNotify')}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/78">
                  <span>
                    {routine.notify === 'notable'
                      ? t('schedule.notifyNotable')
                      : routine.notify === 'all'
                        ? t('schedule.notifyAll')
                        : t('schedule.notifyNone')}
                  </span>
                  <span className="w-full text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('detail.configNotifyNote')}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <p className="mt-[26px] flex flex-wrap items-center gap-1.5 text-[12px] text-[rgba(154,149,140,0.58)]">
            <MessageSquare aria-hidden="true" className="size-[13px]" />
            {routine.origin ? (
              <>
                <span>{t('detail.originChat')}</span>
                <button
                  type="button"
                  onClick={() => onOpenOriginChat(routine.origin!.conversationId)}
                  className="text-foreground/78 underline decoration-border-strong underline-offset-[3px] hover:text-foreground"
                >
                  {routine.origin.title}
                </button>
                <span>· {formatWhen(routine.createdAt, nowMs, tr)}</span>
              </>
            ) : (
              <span>{t('detail.originRoutines')}</span>
            )}
          </p>
        </div>
      </div>

      {confirmDeleteOpen && (
        <ConfirmDialog
          title={t('detail.confirmDeleteTitle')}
          message={t('detail.confirmDeleteBody', { title: routine.title })}
          confirmLabel={t('detail.confirmDeleteOk')}
          cancelLabel={t('detail.cancel')}
          busy={deleting}
          destructive
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </div>
  )
}
