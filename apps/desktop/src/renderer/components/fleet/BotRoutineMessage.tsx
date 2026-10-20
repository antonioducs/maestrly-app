import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Repeat, X } from 'lucide-react'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import { cn } from '@/lib/utils'

/** A routine run: one line about the run, with the routine's instructions folded under it. */
export function BotRoutineMessage({
  title,
  schedule,
  at,
  text,
  repeated,
  memories,
  queued,
  stopped,
  onRemoveQueued,
  onExpand,
  searchQuery,
  currentSearchMatch,
}: {
  title: string
  /** How the routine runs; null when it is unknown, or was deleted since. */
  schedule: string | null
  at: string
  text: string
  /** The instructions are the same as the previous run's. */
  repeated: boolean
  memories: Array<{ title: string }>
  queued: boolean
  /** Queued in a conversation the owner stopped: it waits for them to write there. */
  stopped?: boolean
  onRemoveQueued?: () => void
  /** The card grows where the owner reads: the transcript should stay there. */
  onExpand?: () => void
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const { t } = useTranslation('fleet')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // A search match inside the instructions shows them.
  const shown = open || !!searchQuery
  return (
    <div className="@container overflow-hidden rounded-xl border border-border border-l-2 border-l-sky-400/50 bg-gradient-to-r from-sky-400/[0.05] to-transparent">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={shown ? bodyId : undefined}
          onClick={() => {
            if (!shown) onExpand?.()
            setOpen(!shown)
          }}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
        >
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300"
          >
            <Repeat className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2 leading-snug">
              <span className="truncate text-[13.5px] font-medium">{title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{at}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
              <span>{schedule ? t('transcript.routine.scheduled', { schedule }) : t('transcript.routine.label')}</span>
              {queued && (
                <>
                  <span aria-hidden="true">·</span>
                  {stopped ? (
                    <span title={t('transcript.stoppedHint')} className="text-amber-300">
                      {t('transcript.stopped')}
                    </span>
                  ) : (
                    <span>{t('transcript.queued')}</span>
                  )}
                </>
              )}
              {repeated && (
                <span className="rounded-full border border-border-strong px-2 text-[11px] leading-[18px]">
                  {t('transcript.routine.repeated')}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="hidden @sm:inline">{t('transcript.routine.instructions')}</span>
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 transition-transform motion-reduce:transition-none', shown && 'rotate-90')}
            />
          </span>
        </button>
        {queued && onRemoveQueued && (
          <button
            type="button"
            aria-label={t('transcript.removeQueued')}
            className="mr-2 rounded p-1 text-muted-foreground hover:text-destructive"
            onClick={onRemoveQueued}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      {shown && (
        <div id={bodyId} className="border-t border-border px-4 py-3 text-sm [overflow-wrap:anywhere] @md:pl-[52px]">
          <MarkdownViewer markdown={text} breaks searchQuery={searchQuery} currentSearchMatch={currentSearchMatch} />
          {memories.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('conversation.recalled', { titles: memories.map((memory) => memory.title).join(', ') })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
