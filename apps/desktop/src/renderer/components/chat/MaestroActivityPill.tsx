import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerUpRight, Loader2, OctagonX, Route, ShieldCheck, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OpenFileReference } from '@/components/MarkdownViewer'
import { delegateSnapshot, delegateStatus, OrchestrationGroups, type DelegatePart } from './OrchestrationRun'
import type { MaestroLiveState } from '../../../shared/maestro-live'
import { useSubagentSessions } from './SubagentSessionContext'

export interface MaestroRun {
  messageId: string
  parts: DelegatePart[]
}

function summarize(run: MaestroRun, sessions: ReturnType<typeof useSubagentSessions>) {
  let running = 0
  let done = 0
  let failed = 0
  let activeLabel: string | undefined
  for (const part of run.parts) {
    const value = delegateStatus(part, sessions, run.messageId)
    if (value === 'running' || value === 'queued') {
      running++
      if (!activeLabel && value === 'running') {
        const snapshot = delegateSnapshot(part)
        activeLabel = snapshot?.resource.label ?? snapshot?.resource.id
      }
      continue
    }
    done++
    if (value === 'error' || value === 'aborted') failed++
  }
  return { running, done, failed, total: run.parts.length, activeLabel }
}

export function MaestroActivityPill({
  runs,
  conversationId,
  onOpenMention,
  onJumpToMessage,
  liveState,
}: {
  runs: MaestroRun[]
  conversationId: string
  onOpenMention?: OpenFileReference
  onJumpToMessage?: (messageId: string) => void
  liveState?: MaestroLiveState | null
}) {
  const { t } = useTranslation('chat')
  const sessions = useSubagentSessions()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const latest = runs.length > 0 ? runs[runs.length - 1] : undefined
  const summary = useMemo(() => (latest ? summarize(latest, sessions) : undefined), [latest, sessions])
  const active = liveState?.run.status === 'active' || (!!summary && summary.running > 0)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (runs.length === 0 && !active) return null

  const ordered = [...runs].reverse()

  return (
    <div ref={rootRef} className="absolute bottom-3 right-3 z-10">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex max-h-[60vh] w-[min(30rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-white/[0.1] bg-[#15151a]/95 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
            <Route className="size-4 text-amber-300" />
            <span className="text-xs font-medium text-foreground">{t('maestro.run.activity.title')}</span>
            <span className="text-[10px] text-muted-foreground">
              {t('maestro.run.activity.runs', { count: runs.length })}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              title={t('maestro.run.activity.close')}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {liveState?.run.status === 'active' && (
              <div className="mb-2 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] p-2 text-[11px]">
                <div className="font-medium text-amber-100">{t('maestro.run.live.title')}</div>
                <div className="mt-0.5 text-muted-foreground">
                  {summary
                    ? t('maestro.run.live.status', {
                        done: summary.done,
                        total: summary.total,
                        running: summary.running,
                      })
                    : t('maestro.run.live.starting')}
                </div>
                {liveState.run.pendingCount > 0 && (
                  <div className="mt-1 text-amber-200">
                    {t('maestro.run.live.pending', { count: liveState.run.pendingCount })}
                  </div>
                )}
                {liveState.messages.length > 0 && (
                  <div className="mt-1.5 space-y-1 border-t border-amber-400/10 pt-1.5">
                    {liveState.messages.slice(-5).map((message) => (
                      <div key={message.id} className="flex items-center gap-2 text-[10px]">
                        <span className="min-w-0 flex-1 truncate text-foreground/80">{message.text}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {t(`maestro.run.live.messageStatus.${message.status}`)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {ordered.map((run, index) => {
              const runSummary = summarize(run, sessions)
              const number = runs.length - index
              return (
                <details
                  key={run.messageId}
                  open={index === 0}
                  className="mb-1.5 overflow-hidden rounded-lg border border-white/[0.06] bg-black/20 last:mb-0"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[11px]">
                    {runSummary.running > 0 ? (
                      <Loader2 className="size-3.5 animate-spin text-sky-300" />
                    ) : runSummary.failed > 0 ? (
                      <OctagonX className="size-3.5 text-red-400" />
                    ) : (
                      <ShieldCheck className="size-3.5 text-emerald-400" />
                    )}
                    <span className="font-medium text-foreground">
                      {t('maestro.run.activity.runLabel', { index: number })}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {t('maestro.run.delegations', { count: runSummary.total })}
                      {runSummary.failed > 0 && ` · ${t('maestro.run.activity.failed', { count: runSummary.failed })}`}
                    </span>
                    {onJumpToMessage && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onJumpToMessage(run.messageId)
                          setOpen(false)
                        }}
                        className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                        title={t('maestro.run.activity.jump')}
                      >
                        <CornerUpRight className="size-3.5" />
                      </button>
                    )}
                  </summary>
                  <OrchestrationGroups
                    parts={run.parts}
                    conversationId={conversationId}
                    messageId={run.messageId}
                    onOpenMention={onOpenMention}
                    className="border-t border-white/[0.05] p-2"
                  />
                </details>
              )
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={t('maestro.run.activity.open')}
        aria-expanded={open}
        className={cn(
          'flex max-w-[min(22rem,calc(100vw-3rem))] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-lg backdrop-blur transition',
          active
            ? 'border-amber-400/35 bg-amber-400/[0.12] text-amber-100 hover:bg-amber-400/[0.18]'
            : 'border-white/[0.1] bg-[#1a1a1f]/95 text-muted-foreground hover:bg-[#26262d] hover:text-foreground'
        )}
      >
        <Route className={cn('size-3.5 shrink-0', active ? 'text-amber-300' : 'text-muted-foreground')} />
        {active ? (
          <>
            <Loader2 className="size-3 shrink-0 animate-spin" />
            {summary ? (
              <span className="shrink-0 font-medium tabular-nums">
                {summary.done}/{summary.total}
              </span>
            ) : (
              <span className="shrink-0 font-medium">{t('maestro.run.live.starting')}</span>
            )}
            {summary?.activeLabel && <span className="min-w-0 truncate opacity-80">{summary.activeLabel}</span>}
            {!!liveState?.run.pendingCount && (
              <span className="shrink-0 rounded bg-amber-300/15 px-1 text-[10px]">+{liveState.run.pendingCount}</span>
            )}
          </>
        ) : (
          <span className="min-w-0 truncate">{t('maestro.run.activity.runs', { count: runs.length })}</span>
        )}
      </button>
    </div>
  )
}
