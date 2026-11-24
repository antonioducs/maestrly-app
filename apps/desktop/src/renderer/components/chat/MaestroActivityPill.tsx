import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Bot, Loader2, Route, Square, X } from 'lucide-react'
import { useChatDocument, useChatOwnerWindow, useChatSourceFocus } from '@/lib/chat-window-context'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { useMaestroSwarm } from '@/lib/use-maestro-swarm'
import { cn } from '@/lib/utils'
import {
  SWARM_PHASE_DOT_CLASS,
  SWARM_PHASE_TEXT_CLASS,
  swarmPhaseLabel,
} from '@/components/sidebar/SwarmPhaseBadge'
import type { SubagentSessionSummary } from '../../../shared/chat'
import { openConversationById } from './ConversationDispatchCard'
import { isSubagentSessionActive, SubagentActivityList } from './SubagentActivityPill'

export function MaestroActivityPill({
  conversationId,
  subagentSessions,
}: {
  conversationId: string
  subagentSessions: SubagentSessionSummary[]
}) {
  const ownerDocument = useChatDocument()
  const ownerWindow = useChatOwnerWindow()
  const focusSource = useChatSourceFocus()
  const hostId = useHostId()
  const api = useHostApi()
  const { t } = useTranslation('chat')
  const tasks = useMaestroSwarm(conversationId)
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const orderedTasks = useMemo(() => [...tasks].sort((a, b) => a.createdAt - b.createdAt), [tasks])
  const activeSubagents = useMemo(() => subagentSessions.filter(isSubagentSessionActive), [subagentSessions])
  const hasImplementing = tasks.some((task) => task.phase === 'implementing')
  const merged = tasks.filter((task) => task.phase === 'merged').length
  const total = tasks.length
  const active = hasImplementing || activeSubagents.length > 0

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    ownerDocument.addEventListener('mousedown', onPointerDown)
    ownerDocument.addEventListener('keydown', onKeyDown)
    return () => {
      ownerDocument.removeEventListener('mousedown', onPointerDown)
      ownerDocument.removeEventListener('keydown', onKeyDown)
    }
  }, [ownerDocument, open])

  if (total === 0 && activeSubagents.length === 0) return null

  const handleStopSwarm = async () => {
    if (stopping) return
    if (!ownerWindow.confirm(t('maestro.swarm.confirmStop'))) return
    setStopping(true)
    try {
      await api.chatMaestroSwarmStop(conversationId)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div ref={rootRef} className="absolute bottom-3 right-3 z-10">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex max-h-[60vh] w-[min(30rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-white/[0.1] bg-[#15151a] shadow-xl">
          {total > 0 ? (
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
              <Route className="size-4 shrink-0 text-amber-300" />
              <span className="text-xs font-medium text-foreground">{t('maestro.swarm.title')}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {t('maestro.swarm.progress', { merged, total })}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {hasImplementing && (
                  <button
                    type="button"
                    disabled={stopping}
                    onClick={() => void handleStopSwarm()}
                    className="inline-flex items-center gap-1 rounded-md border border-red-400/25 bg-red-400/[0.08] px-2 py-0.5 text-[10px] font-medium text-red-300 transition hover:bg-red-400/[0.16] disabled:opacity-50"
                  >
                    <Square className="size-2.5 fill-current" />
                    {t('maestro.swarm.stop')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  title={t('maestro.close')}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
              <Bot className="size-4 shrink-0 text-violet-300" />
              <span className="text-xs font-medium text-foreground">{t('maestro.swarm.subagents')}</span>
              <span className="text-[10px] text-muted-foreground">{subagentSessions.length}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                title={t('maestro.close')}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {orderedTasks.length > 0 && (
              <div className="space-y-1">
                {orderedTasks.map((task) => {
                  const rowContent = (
                    <>
                      <span
                        className={cn('size-2 shrink-0 rounded-full', SWARM_PHASE_DOT_CLASS[task.phase])}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-foreground">{task.title}</span>
                        {task.resourceId && (
                          <span className="block truncate text-[9px] text-muted-foreground">{task.resourceId}</span>
                        )}
                      </span>
                      <span className={cn('shrink-0 text-[10px] font-medium', SWARM_PHASE_TEXT_CLASS[task.phase])}>
                        {swarmPhaseLabel(t, task)}
                      </span>
                      {task.conversationId && (
                        <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </>
                  )

                  if (task.conversationId) {
                    const targetConversationId = task.conversationId
                    return (
                      <button
                        key={task.key}
                        type="button"
                        onClick={() => {
                          openConversationById(hostId, targetConversationId)
                          focusSource()
                          setOpen(false)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-black/15 px-2.5 py-2 text-left transition hover:bg-white/[0.05]"
                      >
                        {rowContent}
                      </button>
                    )
                  }

                  return (
                    <div
                      key={task.key}
                      className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-black/15 px-2.5 py-2 text-left"
                    >
                      {rowContent}
                    </div>
                  )
                })}
              </div>
            )}

            {subagentSessions.length > 0 && (
              <div className={cn(orderedTasks.length > 0 && 'mt-2.5 border-t border-white/[0.07] pt-2')}>
                {orderedTasks.length > 0 && (
                  <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
                    <Bot className="size-3.5 text-violet-300" />
                    <span>{t('maestro.swarm.subagents')}</span>
                    <span className="text-[10px] opacity-75">{subagentSessions.length}</span>
                  </div>
                )}
                <SubagentActivityList sessions={subagentSessions} onSelectSession={() => setOpen(false)} />
              </div>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex max-w-[min(22rem,calc(100vw-3rem))] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-lg transition',
          active
            ? 'border-amber-400/35 bg-[color-mix(in_oklab,var(--color-amber-400)_12%,#1a1a1f)] text-amber-100 hover:bg-[color-mix(in_oklab,var(--color-amber-400)_18%,#1a1a1f)]'
            : 'border-white/[0.1] bg-[#1a1a1f] text-muted-foreground hover:bg-[#26262d] hover:text-foreground'
        )}
      >
        <Route className={cn('size-3.5 shrink-0', active ? 'text-amber-300' : 'text-muted-foreground')} />
        {active && <Loader2 className="size-3 shrink-0 animate-spin" />}
        {total > 0 ? (
          <>
            <span className="shrink-0 font-medium">{t('maestro.swarm.title')}</span>
            <span className="shrink-0 tabular-nums opacity-85">
              {t('maestro.swarm.progress', { merged, total })}
            </span>
            {activeSubagents.length > 0 && (
              <span className="min-w-0 truncate opacity-80">
                · {t('maestro.swarm.subagentsCount', { count: activeSubagents.length })}
              </span>
            )}
          </>
        ) : (
          <span className="shrink-0 font-medium">
            {t('maestro.swarm.subagentsCount', { count: activeSubagents.length })}
          </span>
        )}
      </button>
    </div>
  )
}
