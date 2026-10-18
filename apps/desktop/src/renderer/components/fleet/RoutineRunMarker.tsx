import { useTranslation } from 'react-i18next'
import { AlertTriangle, CornerDownRight, FileText, Film, Image as ImageIcon, Repeat, X } from 'lucide-react'
import type { FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { runSummary, runTitle } from '@/lib/fleet/runs'
import { cn } from '@/lib/utils'

/** What a run's conversation holds, as small counts: images, videos and other files. */
export function RunMediaCounts({ run, className }: { run: FleetRoutineRun; className?: string }) {
  const { t } = useTranslation('fleet')
  const media = run.media
  if (!media || !(media.images || media.videos || media.files)) return null
  const items = [
    { count: media.images, icon: ImageIcon, label: t('runs.meta.images', { count: media.images }) },
    { count: media.videos, icon: Film, label: t('runs.meta.videos', { count: media.videos }) },
    { count: media.files, icon: FileText, label: t('runs.meta.files', { count: media.files }) },
  ].filter((item) => item.count > 0)
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {items.map(({ count, icon: Icon, label }) => (
        <span key={label} className="inline-flex items-center gap-0.5" title={label} aria-label={label}>
          <Icon aria-hidden="true" className="size-3" />
          {count}
        </span>
      ))}
    </span>
  )
}

/**
 * A run that finished, where the bot's conversation shows it: a notice for the owner that the bot never reads, with
 * what the run did and a way to open it.
 */
export function RoutineRunMarker({
  run,
  botName,
  onOpen,
}: {
  run: FleetRoutineRun
  botName: string
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const failed = run.status === 'failed'
  const title = runTitle(run, t('transcript.routine.label'))
  const at = new Date(run.finishedAt ?? run.deliveredAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const summary = run.conversation === 'deleted' ? t('runs.summary.deleted') : runSummary(run)
  return (
    <div
      role="note"
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-xl border border-dashed px-3 py-2 text-[12.5px]',
        failed ? 'border-red-400/30 bg-red-400/[0.03]' : 'border-sky-400/30 bg-sky-400/[0.035]'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-[26px] shrink-0 items-center justify-center rounded-lg',
          failed ? 'bg-red-400/10 text-red-300' : 'bg-sky-400/10 text-sky-300'
        )}
      >
        {failed ? <AlertTriangle className="size-3.5" /> : <Repeat className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-foreground">
          <span className="font-medium">{t(failed ? 'runs.marker.failed' : 'runs.marker.finished', { title })}</span>
          <span className="text-xs text-muted-foreground">
            {' · '}
            {at}
            {' · '}
            <span
              className="cursor-help border-b border-dotted border-muted-foreground/60"
              title={t('runs.marker.outsideTitle', { name: botName })}
            >
              {t('runs.marker.outside')}
            </span>
          </span>
        </p>
        {summary && <p className="truncate text-xs text-muted-foreground">{summary}</p>}
      </div>
      <RunMediaCounts run={run} className="hidden shrink-0 text-xs text-muted-foreground @md:inline-flex" />
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('runs.marker.openLabel', { title, time: at })}
        className="shrink-0 rounded-md border border-border-strong px-2.5 py-1 text-xs text-foreground hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('runs.marker.open')}
      </button>
    </div>
  )
}

/** The routine run an owner's message refers to: on its bubble, and above the composer before it is sent. */
export function RunCitationChip({
  title,
  at,
  onOpen,
  onRemove,
  composing,
}: {
  title: string
  at: string
  onOpen?: () => void
  onRemove?: () => void
  /** Above the composer, before the message is sent. */
  composing?: boolean
}) {
  const { t, i18n } = useTranslation('fleet')
  const when = new Date(at).toLocaleString(i18n.language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const text = t(composing ? 'runs.cite.chip' : 'runs.cite.bubble', { title, when })
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-sky-400/30 bg-sky-400/[0.08] px-2 py-0.5 text-xs text-sky-300">
      <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={t('runs.cite.open')}
          className="truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text}
        </button>
      ) : (
        <span className="truncate">{text}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('runs.cite.remove')}
          title={t('runs.cite.remove')}
          className="rounded p-0.5 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  )
}
