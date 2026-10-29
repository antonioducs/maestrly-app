import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDown, Check, Copy, Loader2 } from 'lucide-react'
import type { FleetRunnerJobLogPage } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import {
  applyRunnerLogPage,
  EMPTY_RUNNER_LOG,
  followRunnerLog,
  runnerLogPath,
  type RunnerLogCursor,
  type RunnerLogState,
} from '@/lib/runner-log'
import { cn } from '@/lib/utils'

/** How near the bottom still counts as following it. */
const BOTTOM_SLACK_PX = 24
const COPIED_MS = 2_000

/**
 * Reads a job's log: its end first, then, while `live`, what is written after it every 1.5 seconds. When `live` turns
 * false it reads once more, to catch the last lines. A failed read is shown and, while live, tried again.
 */
export function useRunnerLog(read: (offset: number | null) => Promise<FleetRunnerJobLogPage>, live: boolean) {
  const [state, setState] = useState<RunnerLogState>(EMPTY_RUNNER_LOG)
  const readRef = useRef(read)
  readRef.current = read
  const cursor = useRef<RunnerLogCursor>({ next: null })
  useEffect(
    () =>
      followRunnerLog({
        read: (offset) => readRef.current(offset),
        live,
        cursor: cursor.current,
        onPage: (page, first) => setState((current) => applyRunnerLogPage(current, page, first)),
        onError: (cause) => setState((current) => ({ ...current, error: fleetErrorMessage(cause) })),
      }),
    [live]
  )
  return state
}

/** What the log says, in a scrolling box that follows the bottom until the person scrolls up. */
export function RunnerLogPane({ state, live, jobId }: { state: RunnerLogState; live: boolean; jobId?: string }) {
  const { t } = useTranslation('fleet')
  const box = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  useLayoutEffect(() => {
    const element = box.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [state.text])
  const { text, earlier, loaded, error } = state
  // Nothing to show yet: the first read is under way, or the log is empty, or it could not be read (the error says so).
  const emptyKey = loaded ? (live ? 'waiting' : 'noOutput') : error ? null : 'loading'
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="runner-log">
      {earlier && (
        <p className="text-[11.5px] leading-snug text-muted-foreground" data-testid="runner-log-earlier">
          {t(live ? 'botSettings.runners.log.earlier' : 'botSettings.runners.log.earlierEnded', {
            path: runnerLogPath(jobId),
          })}
        </p>
      )}
      <div className="relative min-h-0">
        <div
          ref={box}
          tabIndex={0}
          role="log"
          aria-label={t('botSettings.runners.log.title')}
          data-testid="runner-log-text"
          className="h-[min(55vh,26rem)] overflow-auto rounded-md border border-border bg-black/30 px-3 py-2"
          onScroll={() => {
            const element = box.current
            if (!element) return
            const near = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK_PX
            following.current = near
            setAtBottom(near)
          }}
        >
          {text ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground">
              {text}
            </pre>
          ) : (
            emptyKey && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="runner-log-empty">
                {emptyKey === 'loading' && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
                {t(`botSettings.runners.log.${emptyKey}`)}
              </p>
            )
          )}
        </div>
        {!atBottom && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-2 right-4 h-7 gap-1 text-[11.5px] shadow-md"
            onClick={() => {
              const element = box.current
              if (!element) return
              following.current = true
              setAtBottom(true)
              element.scrollTop = element.scrollHeight
            }}
          >
            <ArrowDown className="size-3" aria-hidden="true" />
            {t('botSettings.runners.log.latest')}
          </Button>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 break-words text-xs text-destructive"
          data-testid="runner-log-error"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('botSettings.runners.log.error', { error })}
            {live ? ` ${t('botSettings.runners.log.retrying')}` : ''}
          </span>
        </p>
      )}
    </div>
  )
}

export interface RunnerLogDialogProps {
  title: string
  subtitle?: string
  /** One piece of the log: from the byte `offset` (the `next` of the piece before) or, when null, from the end. */
  read(offset: number | null): Promise<FleetRunnerJobLogPage>
  /** The job still writes: the log is read again and again until this turns false, which reads it once more. */
  live: boolean
  /** The job, to name the file its whole log is saved in. */
  jobId?: string
  onClose(): void
}

/**
 * A job's log as it is written: the dialog is open while this is rendered, and polling stops when it closes. The text
 * is monospace, wraps, and keeps the last half megabyte.
 */
export function RunnerLogDialog({ title, subtitle, read, live, jobId, onClose }: RunnerLogDialogProps) {
  const { t } = useTranslation('fleet')
  const state = useRunnerLog(read, live)
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" data-testid="runner-log-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={cn(!subtitle && 'sr-only')}>
            {subtitle ?? t('botSettings.runners.log.title')}
          </DialogDescription>
        </DialogHeader>
        <RunnerLogPane state={state} live={live} jobId={jobId} />
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground" aria-live="polite">
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', live ? 'animate-pulse bg-status-ready' : 'bg-muted-foreground/70')}
            />
            {t(live ? 'botSettings.runners.log.live' : 'botSettings.runners.log.ended')}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[12px]"
            disabled={!state.text}
            onClick={() =>
              void navigator.clipboard
                .writeText(state.text)
                .then(() => setCopied('done'))
                .catch(() => setCopied('failed'))
            }
          >
            {copied === 'done' ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {t(
              copied === 'done'
                ? 'botSettings.runners.log.copied'
                : copied === 'failed'
                  ? 'botSettings.runners.log.copyFailed'
                  : 'botSettings.runners.log.copy'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
