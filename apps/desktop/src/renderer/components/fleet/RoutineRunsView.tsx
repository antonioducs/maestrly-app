import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronRight,
  Clock,
  FileText,
  Film,
  Folder,
  History,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Moon,
  Pin,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_ROUTINE_RUN_RETENTION_DAYS,
  type FleetBot,
  type FleetRoutineRun,
  type FleetRoutineRunSettings,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import {
  runDayLabel,
  runDays,
  runExpiresInDays,
  runRoutines,
  runSettingsOf,
  runState,
  runSummary,
  runTitle,
  type RunState,
} from '@/lib/fleet/runs'
import { emptyRuns } from '@/lib/fleet/state'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { RoutineRunConversation } from './RoutineRunConversation'
import { SettingsSwitch } from './SettingsSwitch'

const STATE_ICON: Record<RunState, { icon: typeof Check; className: string }> = {
  running: {
    icon: Loader2,
    className: 'bg-sky-400/10 text-sky-300 [&>svg]:animate-spin motion-reduce:[&>svg]:animate-none',
  },
  queued: { icon: Clock, className: 'bg-sky-400/10 text-sky-300' },
  ok: { icon: Check, className: 'bg-emerald-400/10 text-emerald-300' },
  quiet: { icon: Moon, className: 'text-muted-foreground/70' },
  failed: { icon: X, className: 'bg-red-400/10 text-red-300' },
  cancelled: { icon: Square, className: 'bg-white/[0.05] text-muted-foreground' },
  deleted: { icon: Trash2, className: 'bg-white/[0.05] text-muted-foreground' },
  unknown: { icon: Clock, className: 'bg-white/[0.05] text-muted-foreground' },
}
/** How long the owner can undo a deletion before it reaches the bot. */
const UNDO_MS = 6_000

/** A bot's settings for its runs' conversations: saved as each one changes. */
function RunSettingsDialog({ bot, open, onClose }: { bot: FleetBot; open: boolean; onClose: () => void }) {
  const { t } = useTranslation('fleet')
  const [settings, setSettings] = useState<FleetRoutineRunSettings>(() => runSettingsOf(bot))
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read when the dialog opens: a bot update while it is open (its status, its usage) must not undo a choice.
  const currentRef = useRef(runSettingsOf(bot))
  currentRef.current = runSettingsOf(bot)
  useEffect(() => {
    if (open) {
      setSettings(currentRef.current)
      setSaved(false)
      setError(null)
    }
  }, [open])
  const save = async (next: FleetRoutineRunSettings) => {
    const previous = settings
    setSettings(next)
    setSaved(false)
    setError(null)
    try {
      await window.api.fleetSetRunSettings(bot.id, next)
      setSaved(true)
    } catch (cause) {
      setSettings(previous)
      setError(fleetErrorMessage(cause))
    }
  }
  const segment = (selected: boolean) =>
    cn(
      'h-7 rounded-md px-3 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground'
    )
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('runs.settings.title')}</DialogTitle>
          <DialogDescription>{t('runs.settings.description', { name: bot.name })}</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border text-sm">
          <div className="pb-3">
            <p className="font-medium">{t('runs.settings.retentionLabel')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('runs.settings.retentionHint')}</p>
            <div
              role="radiogroup"
              aria-label={t('runs.settings.retentionLabel')}
              className="mt-2 inline-flex gap-0.5 rounded-lg border border-border bg-white/[0.03] p-0.5"
            >
              {[...FLEET_ROUTINE_RUN_RETENTION_DAYS, null].map((days) => (
                <button
                  key={String(days)}
                  type="button"
                  role="radio"
                  aria-checked={settings.retentionDays === days}
                  className={segment(settings.retentionDays === days)}
                  onClick={() => void save({ ...settings, retentionDays: days })}
                >
                  {days === null ? t('runs.settings.never') : t('runs.settings.days', { count: days })}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <div className="flex-1">
              <p className="font-medium">
                {t('runs.settings.cap', { count: FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine })}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('runs.settings.capHint')}</p>
            </div>
            <SettingsSwitch
              checked={settings.capPerRoutine}
              label={t('runs.settings.cap', { count: FLEET_ROUTINE_RUN_LIMITS.keepPerRoutine })}
              onChange={() => void save({ ...settings, capPerRoutine: !settings.capPerRoutine })}
            />
          </div>
          <div className="flex items-start gap-3 py-3">
            <div className="flex-1">
              <p className="font-medium">{t('runs.settings.quiet')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('runs.settings.quietHint', { count: FLEET_ROUTINE_RUN_LIMITS.quietRetentionDays })}
              </p>
            </div>
            <SettingsSwitch
              checked={settings.quietEarly}
              label={t('runs.settings.quiet')}
              onChange={() => void save({ ...settings, quietEarly: !settings.quietEarly })}
            />
          </div>
          <div className="pt-3">
            <p className="font-medium">{t('runs.settings.notify')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('runs.settings.notifyHint', { name: bot.name })}</p>
            <div
              role="radiogroup"
              aria-label={t('runs.settings.notify')}
              className="mt-2 inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-white/[0.03] p-0.5"
            >
              {(['notable', 'all', 'none'] as const).map((notify) => (
                <button
                  key={notify}
                  type="button"
                  role="radio"
                  aria-checked={settings.notify === notify}
                  className={segment(settings.notify === notify)}
                  onClick={() => void save({ ...settings, notify })}
                >
                  {t(`runs.settings.${notify}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-1 flex gap-2 rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
          <Folder aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('runs.settings.note', { name: bot.name })}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-3">
          {saved && (
            <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-300">
              <Check aria-hidden="true" className="size-3" />
              {t('runs.settings.saved')}
            </span>
          )}
          <Button size="sm" onClick={onClose}>
            {t('runs.settings.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What deleting a run's conversation removes and what it keeps, before the owner confirms. */
function DeleteRunDialog({
  bot,
  run,
  onCancel,
  onConfirm,
}: {
  bot: FleetBot
  run: FleetRoutineRun | null
  onCancel: () => void
  onConfirm: (run: FleetRoutineRun) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const images = run?.media?.images ?? 0
  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('runs.delete.title')}</DialogTitle>
          {run && (
            <DialogDescription>
              {runTitle(run, t('transcript.routine.label'))} ·{' '}
              {new Date(run.deliveredAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}
            </DialogDescription>
          )}
        </DialogHeader>
        <ul className="space-y-2.5 text-[13px] text-foreground/85">
          <li className="flex gap-2.5">
            <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-red-300" />
            <span>
              {t('runs.delete.goes')}
              <span className="block text-xs text-muted-foreground">{t('runs.delete.goesDetail')}</span>
            </span>
          </li>
          {images > 0 && (
            <li className="flex gap-2.5">
              <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
              <span>{t('runs.delete.stays', { count: images, name: bot.name })}</span>
            </li>
          )}
          <li className="flex gap-2.5">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
            <span>{t('runs.delete.staysFiles', { name: bot.name })}</span>
          </li>
          <li className="flex gap-2.5">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
            <span>
              {t('runs.delete.report')}
              <span className="block text-xs text-muted-foreground">{t('runs.delete.reportDetail')}</span>
            </span>
          </li>
        </ul>
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('runs.delete.cancel')}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => run && onConfirm(run)}>
            {t('runs.delete.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One run in the history: its state, routine, time, what it did, and what its conversation holds. */
function RunRow({
  bot,
  run,
  selected,
  fresh,
  nested,
  pendingDelete,
  onOpen,
}: {
  bot: FleetBot
  run: FleetRoutineRun
  selected: boolean
  fresh: boolean
  nested?: boolean
  pendingDelete: boolean
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const state = pendingDelete ? 'deleted' : runState(run, bot)
  const { icon: Icon, className } = STATE_ICON[state]
  const time = new Date(run.deliveredAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
  const activity = bot.activity?.kind === 'tool' ? bot.activity.tool : null
  const summary =
    state === 'running'
      ? activity
        ? t('runs.summary.running', { activity })
        : t('runs.summary.runningStart')
      : state === 'queued'
        ? t('runs.summary.queued')
        : state === 'deleted'
          ? [t('runs.summary.deleted'), runSummary(run)].filter(Boolean).join(' ')
          : state === 'cancelled'
            ? t('runs.summary.cancelled')
            : runSummary(run)
  const expires = runExpiresInDays(run, Date.now())
  const media = run.media
  const meta: Array<{ key: string; icon?: typeof Check; text: string; className?: string }> = [
    ...(media?.images ? [{ key: 'images', icon: ImageIcon, text: String(media.images) }] : []),
    ...(media?.videos ? [{ key: 'videos', icon: Film, text: String(media.videos) }] : []),
    ...(media?.files ? [{ key: 'files', icon: FileText, text: String(media.files) }] : []),
    ...(run.trigger === 'manual' ? [{ key: 'manual', text: t('runs.meta.manual') }] : []),
    ...(run.adjustments
      ? [{ key: 'adjustments', icon: MessageSquare, text: t('runs.meta.adjustments', { count: run.adjustments }) }]
      : []),
    ...(run.pinned ? [{ key: 'pinned', icon: Pin, text: t('runs.meta.kept'), className: 'text-sky-300' }] : []),
    ...(expires !== null && expires <= 7 && !run.quiet && state !== 'deleted'
      ? [
          {
            key: 'expires',
            icon: Clock,
            text: expires === 0 ? t('runs.meta.expiresToday') : t('runs.meta.expires', { count: expires }),
            className: 'text-amber-300',
          },
        ]
      : []),
    ...(state === 'deleted' && run.kept?.files.length
      ? [{ key: 'kept', icon: Folder, text: t('runs.meta.filesKept') }]
      : []),
  ]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected}
      className={cn(
        'relative flex w-full gap-2.5 py-2.5 pr-3.5 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        nested ? 'pl-8' : 'pl-3.5',
        selected &&
          'bg-white/[0.07] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded before:bg-sky-400'
      )}
    >
      <span className={cn('mt-px flex size-5 shrink-0 items-center justify-center rounded-md', className)}>
        <Icon aria-hidden="true" className="size-3" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] font-medium',
              state === 'deleted' && 'text-muted-foreground'
            )}
          >
            {runTitle(run, t('transcript.routine.label'))}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{time}</span>
        </span>
        {summary && (
          <span
            className={cn(
              'line-clamp-2 text-[12.5px]',
              state === 'running'
                ? 'text-sky-300'
                : state === 'deleted'
                  ? 'text-muted-foreground'
                  : 'text-foreground/75'
            )}
          >
            {summary}
          </span>
        )}
        {meta.length > 0 && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
            {meta.map(({ key, icon: MetaIcon, text, className: metaClass }) => (
              <span key={key} className={cn('inline-flex items-center gap-1', metaClass)}>
                {MetaIcon && <MetaIcon aria-hidden="true" className="size-3" />}
                {text}
              </span>
            ))}
          </span>
        )}
      </span>
      {fresh && (
        <span
          aria-label={t('runs.newCount', { count: 1 })}
          className="mt-1.5 size-[7px] shrink-0 rounded-full bg-sky-400"
        />
      )}
    </button>
  )
}

/**
 * A bot's routine runs (`routine-conversations`): its history by day, the runs of a routine that found nothing new
 * folded, and the run the owner opened, with its whole conversation.
 */
export function RoutineRunsView({
  bot,
  fleet,
  selectedRunId,
  onSelect,
  onCite,
  onOpenBot,
  onOpenScreen,
  visible,
  seen,
}: {
  bot: FleetBot
  fleet: FleetController
  selectedRunId: string | null
  /** The runs the owner has opened; the others that ended with something new are marked new. */
  seen: ReadonlySet<string> | null
  onSelect: (runId: string | null) => void
  onCite: (run: FleetRoutineRun) => void
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  visible: boolean
}) {
  const { t, i18n } = useTranslation('fleet')
  const runsState = fleet.state.runs[bot.id] ?? emptyRuns
  const { ensureRuns, loadRuns, dispatch } = fleet
  useEffect(() => {
    ensureRuns(bot.id)
  }, [bot.id, ensureRuns])
  const [filter, setFilter] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState<FleetRoutineRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Deletions wait a moment for an undo, then reach the bot; leaving the view sends them at once.
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const commit = useCallback(
    async (runId: string) => {
      const timer = pending.current.get(runId)
      if (timer) clearTimeout(timer)
      pending.current.delete(runId)
      setPendingIds([...pending.current.keys()])
      try {
        const run = await window.api.fleetDeleteRunConversation(bot.id, runId)
        dispatch({ type: 'runs.upsert', botId: bot.id, run })
      } catch (cause) {
        setError(String(cause).includes('FLEET_RUN_CONFLICT') ? t('runs.delete.conflict') : fleetErrorMessage(cause))
      }
    },
    [bot.id, dispatch, t]
  )
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const timers = pending.current
    return () => {
      for (const runId of [...timers.keys()]) void commitRef.current(runId)
    }
  }, [])
  const undo = (runId: string) => {
    const timer = pending.current.get(runId)
    if (timer) clearTimeout(timer)
    pending.current.delete(runId)
    setPendingIds([...pending.current.keys()])
  }

  const routines = useMemo(() => runRoutines(runsState.runs), [runsState.runs])
  const shown = useMemo(
    () => (filter ? runsState.runs.filter((run) => run.routineId === filter) : runsState.runs),
    [filter, runsState.runs]
  )
  const days = useMemo(() => runDays(shown, bot), [bot, shown])
  const selected = runsState.runs.find((run) => run.id === selectedRunId) ?? null
  const settings = runSettingsOf(bot)
  const now = Date.now()

  // One column at a time when the pane is narrow: the list, or the run opened.
  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setNarrow(node.clientWidth < 760))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const chip = (selectedChip: boolean) =>
    cn(
      'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selectedChip
        ? 'border-border-strong bg-white/[0.07] text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    )

  const list = (
    <div
      className={cn('flex min-h-0 min-w-0 flex-col', !narrow && 'w-[min(372px,42%)] shrink-0 border-r border-border')}
    >
      <div className="border-b border-border px-3.5 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('runs.title')}</h2>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t('runs.settings.button')}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-xs text-foreground hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Clock aria-hidden="true" className="size-3" />
            {settings.retentionDays === null
              ? t('runs.retention.never')
              : t('runs.retention.days', { count: settings.retentionDays })}
          </button>
        </div>
        {routines.length > 1 && (
          <div
            role="group"
            aria-label={t('runs.filters')}
            className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5 [mask-image:linear-gradient(90deg,#000_88%,transparent)] [scrollbar-width:none]"
          >
            <button
              type="button"
              aria-pressed={filter === null}
              className={chip(filter === null)}
              onClick={() => setFilter(null)}
            >
              {t('runs.all')} <span className="text-[11px] text-muted-foreground">{runsState.runs.length}</span>
            </button>
            {routines.map((routine) => (
              <button
                key={routine.id}
                type="button"
                aria-pressed={filter === routine.id}
                className={chip(filter === routine.id)}
                onClick={() => setFilter(routine.id)}
              >
                {routine.title || t('transcript.routine.label')}{' '}
                <span className="text-[11px] text-muted-foreground">{routine.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="list">
        {runsState.error && !runsState.runs.length && (
          <div role="alert" className="p-4 text-xs text-destructive">
            {t('runs.loadFailed')}{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => void loadRuns(bot.id).catch(() => {})}
            >
              {t('runs.retry')}
            </button>
          </div>
        )}
        {runsState.loaded && !runsState.runs.length && (
          <div className="mx-auto max-w-xs px-6 py-10 text-center text-[13px] text-muted-foreground">
            <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
              <History aria-hidden="true" className="size-4" />
            </span>
            <p className="mb-1 text-sm font-semibold text-foreground">{t('runs.empty.title')}</p>
            <p>{t('runs.empty.body', { name: bot.name })}</p>
          </div>
        )}
        {!runsState.loaded && runsState.loading && (
          <Loader2
            aria-hidden="true"
            className="mx-auto mt-8 size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
        {days.map((day) => (
          <div key={day.key} role="listitem">
            <div className="sticky top-0 z-[1] bg-chat-canvas/95 px-3.5 pb-1.5 pt-2.5 text-[11px] tracking-wide text-muted-foreground backdrop-blur">
              {runDayLabel(day.day, now, i18n.language, { today: t('runs.today'), yesterday: t('runs.yesterday') })}
            </div>
            {day.entries.map((entry) => {
              if (entry.kind === 'run')
                return (
                  <RunRow
                    key={entry.run.id}
                    bot={bot}
                    run={entry.run}
                    selected={entry.run.id === selectedRunId}
                    fresh={!!seen && !seen.has(entry.run.id) && ['ok', 'failed'].includes(runState(entry.run, bot))}
                    pendingDelete={pendingIds.includes(entry.run.id)}
                    onOpen={() => onSelect(entry.run.id)}
                  />
                )
              const expanded = open.has(entry.key) || entry.runs.some((run) => run.id === selectedRunId)
              const last = new Date(entry.runs[0].deliveredAt).toLocaleTimeString(i18n.language, {
                hour: '2-digit',
                minute: '2-digit',
              })
              return (
                <div key={entry.key}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen((previous) => {
                        const next = new Set(previous)
                        if (next.has(entry.key)) next.delete(entry.key)
                        else next.add(entry.key)
                        return next
                      })
                    }
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/70">
                      <Moon aria-hidden="true" className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground/80">
                        {entry.title || t('transcript.routine.label')}
                      </span>
                      {' · '}
                      {t('runs.quietGroup', { count: entry.runs.length })}
                    </span>
                    <span className="shrink-0 text-[11.5px] tabular-nums">{last}</span>
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
                        expanded && 'rotate-90'
                      )}
                    />
                  </button>
                  {expanded &&
                    entry.runs.map((run) => (
                      <RunRow
                        key={run.id}
                        bot={bot}
                        run={run}
                        nested
                        selected={run.id === selectedRunId}
                        fresh={false}
                        pendingDelete={pendingIds.includes(run.id)}
                        onOpen={() => onSelect(run.id)}
                      />
                    ))}
                </div>
              )
            })}
          </div>
        ))}
        {runsState.before && (
          <div className="p-3 text-center">
            <button
              type="button"
              disabled={runsState.loading}
              className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50"
              onClick={() => void loadRuns(bot.id, runsState.before).catch(() => {})}
            >
              {t('runs.loadOlder')}
            </button>
          </div>
        )}
        {runsState.runs.length > 0 && (
          <p className="mt-1.5 border-t border-border p-3.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {t('runs.footer', { name: bot.name })}
            {settings.quietEarly && ' ' + t('runs.footerQuiet', { count: FLEET_ROUTINE_RUN_LIMITS.quietRetentionDays })}
          </p>
        )}
      </div>
    </div>
  )

  const detail = selected ? (
    <RoutineRunConversation
      key={selected.id}
      bot={bot}
      fleet={fleet}
      run={
        pendingIds.includes(selected.id)
          ? { ...selected, conversation: 'deleted', conversationDeletedAt: new Date().toISOString() }
          : selected
      }
      narrow={narrow}
      visible={visible}
      onBack={() => onSelect(null)}
      onOpenBot={onOpenBot}
      onOpenScreen={onOpenScreen}
      onCite={() => onCite(selected)}
      onDelete={() => setDeleting(selected)}
    />
  ) : (
    <div className="m-auto max-w-sm px-6 py-10 text-center text-[13px] text-muted-foreground">
      <span className="mx-auto mb-3.5 flex size-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
        <History aria-hidden="true" className="size-4" />
      </span>
      <p className="mb-1.5 text-sm font-semibold text-foreground">{t('runs.pick.title')}</p>
      <p>{t('runs.pick.body', { name: bot.name })}</p>
    </div>
  )

  return (
    <div ref={rootRef} className="@container relative flex min-h-0 min-w-0 flex-1">
      {narrow ? (
        selected ? (
          detail
        ) : (
          list
        )
      ) : (
        <>
          {list}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </>
      )}
      <RunSettingsDialog bot={bot} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DeleteRunDialog
        bot={bot}
        run={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={(run) => {
          setDeleting(null)
          setError(null)
          pending.current.set(
            run.id,
            setTimeout(() => void commitRef.current(run.id), UNDO_MS)
          )
          setPendingIds([...pending.current.keys()])
        }}
      />
      <div
        aria-live="polite"
        className="pointer-events-none absolute bottom-4 left-4 z-20 flex w-[min(340px,calc(100%-2rem))] flex-col gap-2"
      >
        {pendingIds.map((runId) => (
          <div
            key={runId}
            role="status"
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border-strong bg-popover px-3 py-2.5 text-[13px] shadow-2xl"
          >
            <Trash2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1">{t('runs.delete.done')}</span>
            <button type="button" className="text-xs text-sky-300 hover:underline" onClick={() => undo(runId)}>
              {t('runs.delete.undo')}
            </button>
          </div>
        ))}
        {error && (
          <div
            role="alert"
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-red-400/30 bg-popover px-3 py-2.5 text-[13px] text-red-200 shadow-2xl"
          >
            <span className="flex-1">{error}</span>
            <button type="button" aria-label={t('runs.notice.dismiss')} onClick={() => setError(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
