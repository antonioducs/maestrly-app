import { useTranslation } from 'react-i18next'
import { AlertTriangle, Laptop, Loader2, MessageSquare, Moon, Play, Plus, Power, Server } from 'lucide-react'
import type { HostId } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import type { LocalRoutine, LocalRoutineRun, RoutineSettings } from '../../../shared/routines'
import { hostOfKey, isRemoteKey } from '@/lib/hosts/shell-keys'
import { isRoutineHostCapable, routineHostDisplay } from '@/lib/routines/host-routines'
import { formatHHMM, formatRelative, formatUpcomingDay, formatWhen } from '@/lib/routines/relative-time'
import { outcomeTone, runTimestamp } from '@/lib/routines/timeline'
import { cn } from '@/lib/utils'
import { outcomeIcon, RoutineHostBadge, RoutineOutcomePill, toneClass } from './RoutineOutcomeBadge'
import { RoutineTimeline } from './RoutineTimeline'

export interface RoutineAttentionEntry {
  routine: LocalRoutine
  run: LocalRoutineRun
}

function ensureSentencePunctuation(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function attentionRunSubtitle(
  run: LocalRoutineRun,
  tr: (key: string, opts?: Record<string, unknown>) => string
): string | null {
  if (run.status === 'waiting') {
    const isQuestion = run.waiting?.kind === 'question'
    const prompt = run.waiting?.prompt ? ensureSentencePunctuation(run.waiting.prompt) : ''
    if (isQuestion) {
      return prompt
        ? tr('agenda.waitingQuestionWithPrompt', { prompt })
        : tr('agenda.waitingQuestionFallback')
    }
    if (prompt) {
      return tr('agenda.waitingApprovalWithPrompt', { prompt })
    }
    return run.summary || tr('agenda.waitingApprovalFallback')
  }
  if (run.status === 'failed') {
    const err = run.error?.trim()
    if (err) {
      return tr('agenda.failedWithError', { error: err })
    }
    return run.summary || null
  }
  return run.summary || null
}

export function RoutinesAgendaView({
  routines,
  runsByRoutine,
  attentionRuns,
  hosts = [],
  startingHostIds,
  settings,
  preventSleepEnabled,
  isLinux,
  onNewRoutine,
  onAskInChat,
  onOpenRoutine,
  onOpenRun,
  onViewBots,
  onStartHostEnvironment,
  onToggleKeepRunning,
  onToggleOpenAtLogin,
}: {
  routines: readonly LocalRoutine[]
  runsByRoutine: Record<string, readonly LocalRoutineRun[]>
  attentionRuns: readonly RoutineAttentionEntry[]
  hosts?: readonly HostView[]
  startingHostIds?: ReadonlySet<HostId>
  settings: RoutineSettings
  preventSleepEnabled: boolean
  isLinux: boolean
  onNewRoutine: () => void
  onAskInChat: () => void
  onOpenRoutine: (routineId: string) => void
  onOpenRun: (routineId: string, runId: string) => void
  onViewBots: () => void
  onStartHostEnvironment?: (hostId: HostId) => void
  onToggleKeepRunning: () => void
  onToggleOpenAtLogin: () => void
}) {
  const { t } = useTranslation('routines')
  const nowMs = Date.now()
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))
  const hostById = new Map(hosts.map((host) => [host.id, host]))

  const hasLocalRoutines = routines.some((r) => !isRemoteKey(r.id))
  const hasRemoteRoutines = routines.some((r) => isRemoteKey(r.id))
  const hasEnabledLocalRoutine = routines.some((r) => r.enabled && !isRemoteKey(r.id))
  const stoppedHosts = hosts
    .filter((host) => host.remote && isRoutineHostCapable(host))
    .map((host) => ({ host, info: routineHostDisplay(host, host.id, tr) }))
    .filter(({ info }) => info.stopped)

  const upcomingNexts = routines
    .filter((r): r is LocalRoutine & { nextRunAt: number } => {
      if (!r.enabled || r.nextRunAt == null) return false
      const hId = hostOfKey(r.id)
      const hInfo = routineHostDisplay(hostById.get(hId), hId, tr)
      return !hInfo.isRemote || hInfo.online
    })
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-chat-canvas">
      <header className="drag flex h-10 shrink-0 items-center justify-between gap-2 hairline-b pl-[var(--view-header-inset)] pr-3">
        <span className="truncate text-[13px] font-medium text-foreground/90">{t('agenda.title')}</span>
        <div className="no-drag flex items-center gap-1.5">
          <button
            type="button"
            onClick={onNewRoutine}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[8px] border border-border-strong px-[9px] text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            <span>{t('agenda.newRoutine')}</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-[820px] px-7 pb-20 pt-7 max-[900px]:px-4 max-[900px]:py-5 max-[900px]:pb-20">
          <div className="mb-[18px] flex flex-wrap items-end gap-3">
            <div>
              <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-foreground">
                {t('agenda.title')}
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('agenda.subtitle')}</p>
            </div>
          </div>

          {!settings.keepRunning && hasEnabledLocalRoutine && (
            <div
              role="status"
              className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-[rgba(242,180,92,0.22)] bg-[rgba(242,180,92,0.08)] px-3 py-2.5 text-[12.5px] text-[#f6ddb4]"
            >
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-[var(--artifact-warn)]" />
              <span className="min-w-0 flex-1">
                <b>{t('background.bannerLead')}</b> {t('background.bannerBody')}
              </span>
              <button
                type="button"
                onClick={onToggleKeepRunning}
                className="ml-auto inline-flex h-[26px] shrink-0 items-center justify-center rounded-[8px] border border-border-strong px-[9px] text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
              >
                {t('background.keepInBackground')}
              </button>
            </div>
          )}

          {stoppedHosts.length > 0 && (
            <div className="mb-4 flex flex-col gap-2">
              {stoppedHosts.map(({ host, info }) => {
                const starting = Boolean(startingHostIds?.has(host.id)) || info.starting
                return (
                  <div
                    key={host.id}
                    role="status"
                    className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[rgba(242,180,92,0.22)] bg-[rgba(242,180,92,0.06)] px-3 py-2.5 text-[12.5px] text-foreground/90"
                  >
                    <Server aria-hidden="true" className="size-4 shrink-0 text-[var(--artifact-warn)]" />
                    <span className="min-w-0 flex-1">
                      <b>{t('host.stoppedBannerTitle', { host: info.fullLabel })}</b>{' '}
                      <span className="text-muted-foreground">{t('host.stoppedBannerBody')}</span>
                    </span>
                    {info.canStart && onStartHostEnvironment && (
                      <button
                        type="button"
                        disabled={starting}
                        onClick={() => onStartHostEnvironment(host.id)}
                        className="ml-auto inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[8px] border border-border-strong px-[9px] text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                      >
                        {starting ? (
                          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                        ) : (
                          <Play aria-hidden="true" className="size-3" />
                        )}
                        <span>{starting ? t('host.startingAction') : t('host.startAction')}</span>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {routines.length === 0 ? (
            <div className="grid justify-items-start gap-2.5 rounded-[var(--radius)] border border-dashed border-border-strong p-[22px]">
              <h3 className="m-0 text-[14px] font-semibold text-foreground">{t('agenda.emptyTitle')}</h3>
              <p className="m-0 max-w-[520px] text-[13px] text-muted-foreground">{t('agenda.emptyBody')}</p>
              <span className="rounded-[8px] bg-[var(--routine-soft)] px-2.5 py-2 font-mono text-[12px] text-[var(--routine)]">
                {t('agenda.emptyExample')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={onAskInChat}
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-[8px] border border-primary bg-primary px-[9px] text-[12px] font-medium text-primary-foreground transition-colors hover:bg-white"
                >
                  <MessageSquare aria-hidden="true" className="size-3.5" />
                  <span>{t('agenda.askInChat')}</span>
                </button>
                <button
                  type="button"
                  onClick={onNewRoutine}
                  className="inline-flex h-[26px] items-center gap-1.5 rounded-[8px] border border-border-strong px-[9px] text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.06]"
                >
                  <Plus aria-hidden="true" className="size-3.5" />
                  <span>{t('agenda.createHere')}</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {attentionRuns.length > 0 && (
                <section className="mt-0">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('agenda.needsYou')}</h2>
                    <span className="ml-auto text-[11.5px] text-[rgba(154,149,140,0.58)]">
                      {attentionRuns.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {attentionRuns.map(({ routine, run }) => {
                      const tone = outcomeTone(run.status)
                      const at = runTimestamp(run)
                      const subtitle = attentionRunSubtitle(run, tr)
                      return (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => onOpenRun(routine.id, run.id)}
                          className={cn(
                            'routine-att flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-white/[0.045]',
                            toneClass(tone)
                          )}
                        >
                          <span
                            className="grid size-7 shrink-0 place-items-center rounded-[8px]"
                            style={{
                              color: 'var(--tone)',
                              background: 'color-mix(in srgb, var(--tone) 14%, transparent)',
                            }}
                          >
                            {outcomeIcon(run.status, 'size-[13px]')}
                          </span>
                          <span className="routine-att-main min-w-0 flex-1 leading-[1.4]">
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span className="text-[13px] font-medium text-foreground">{routine.title}</span>
                              <RoutineOutcomePill status={run.status} waitingKind={run.waiting?.kind} short />
                              <RoutineHostBadge host={hostById.get(hostOfKey(routine.id))} hostId={hostOfKey(routine.id)} compact />
                            </span>
                            {subtitle && (
                              <span className="block truncate text-[12px] text-muted-foreground">{subtitle}</span>
                            )}
                          </span>
                          <span className="routine-att-when shrink-0 text-[11px] text-[rgba(154,149,140,0.58)]">
                            {formatWhen(at, nowMs, tr)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              <section className="mt-[26px]">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('agenda.thisWeek')}</h2>
                  <span className="ml-auto text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('agenda.thisWeekHint')}
                  </span>
                </div>
                <RoutineTimeline
                  routines={routines}
                  runsByRoutine={runsByRoutine}
                  nowMs={nowMs}
                  onOpenRoutine={onOpenRoutine}
                  onOpenRun={onOpenRun}
                />
              </section>

              {upcomingNexts.length > 0 && (
                <section className="mt-[26px]">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('agenda.upNext')}</h2>
                  </div>
                  <div className="routine-upnext">
                    {upcomingNexts.map((routine) => {
                      const hId = hostOfKey(routine.id)
                      return (
                        <button
                          key={routine.id}
                          type="button"
                          onClick={() => onOpenRoutine(routine.id)}
                          className="grid grid-cols-[auto_1fr] gap-x-2.5 rounded-[10px] border border-border bg-white/[0.02] px-[11px] py-[9px] text-left transition-colors hover:border-border-strong"
                        >
                          <span className="row-span-2 font-mono text-[17px] leading-[1.2] tabular-nums text-[var(--routine)]">
                            {formatHHMM(routine.nextRunAt)}
                          </span>
                          <span className="flex items-center gap-1.5 text-[11px] text-[rgba(154,149,140,0.58)]">
                            <span className="truncate">
                              {formatUpcomingDay(routine.nextRunAt, nowMs, tr)} · {formatRelative(routine.nextRunAt, nowMs, tr)}
                            </span>
                            <RoutineHostBadge host={hostById.get(hId)} hostId={hId} compact showStatus={false} />
                          </span>
                          <span className="truncate text-[12.5px] text-foreground">{routine.title}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}
            </>
          )}

          {(hasLocalRoutines || !hasRemoteRoutines) && (
            <section className="mt-[26px]">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="m-0 text-[13px] font-semibold text-foreground">{t('agenda.thisComputer')}</h2>
              <span className="ml-auto text-[11.5px] text-[rgba(154,149,140,0.58)]">
                {t('agenda.thisComputerScope')}
              </span>
            </div>
            <div className="grid grid-cols-1 rounded-[var(--radius)] border border-border bg-white/[0.02]">
              <div className="flex items-center gap-3 border-b border-white/[0.045] px-3.5 py-[11px]">
                <Power aria-hidden="true" className="size-4 shrink-0 text-[rgba(154,149,140,0.58)]" />
                <span className="min-w-0 flex-1 text-[13px] text-foreground">
                  {t('agenda.keepRunningLabel')}
                  <small className="block text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('agenda.keepRunningDesc')}
                  </small>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.keepRunning}
                  aria-label={t('agenda.keepRunningLabel')}
                  onClick={onToggleKeepRunning}
                  className="routine-switch"
                />
              </div>

              <div className="flex items-center gap-3 border-b border-white/[0.045] px-3.5 py-[11px]">
                <Laptop aria-hidden="true" className="size-4 shrink-0 text-[rgba(154,149,140,0.58)]" />
                <span className="min-w-0 flex-1 text-[13px] text-foreground">
                  {t('agenda.openAtLoginLabel')}
                  <small className="block text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('agenda.openAtLoginDesc')}
                  </small>
                </span>
                {isLinux ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground">{t('agenda.openAtLoginLinux')}</span>
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.openAtLogin}
                    aria-label={t('agenda.openAtLoginLabel')}
                    onClick={onToggleOpenAtLogin}
                    className="routine-switch"
                  />
                )}
              </div>

              <div className="flex items-center gap-3 px-3.5 py-[11px]">
                <Moon aria-hidden="true" className="size-4 shrink-0 text-[rgba(154,149,140,0.58)]" />
                <span className="min-w-0 flex-1 text-[13px] text-foreground">
                  {t('agenda.preventSleepLabel')}
                  <small className="block text-[11.5px] text-[rgba(154,149,140,0.58)]">
                    {t('agenda.preventSleepDesc')}
                  </small>
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {preventSleepEnabled ? t('agenda.on') : t('agenda.off')}
                </span>
              </div>
            </div>

            <p className="mx-0.5 mt-2.5 text-[11.5px] text-[rgba(154,149,140,0.58)]">
              {t('agenda.botsNote')}{' '}
              <button
                type="button"
                onClick={onViewBots}
                className="text-foreground/78 underline decoration-border-strong underline-offset-[3px] hover:text-foreground"
              >
                {t('agenda.viewBots')}
              </button>
            </p>
          </section>
          )}
        </div>
      </div>
    </div>
  )
}
