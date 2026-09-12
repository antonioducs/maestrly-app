import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, Loader2, TriangleAlert, X } from 'lucide-react'
import type { SubagentSessionSummary } from '../../../shared/chat'
import { useOpenSubagentSession } from './SubagentSessionContext'

function live(session: SubagentSessionSummary): boolean {
  return session.status === 'preparing' || session.status === 'running'
}

export function SubagentActivityPill({ sessions }: { sessions: SubagentSessionSummary[] }) {
  const { t } = useTranslation('chat')
  const openSession = useOpenSubagentSession()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = sessions.filter(live)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!sessions.length || !openSession) return null
  return (
    <div
      ref={rootRef}
      className="absolute bottom-3 right-[max(0.75rem,calc((100%_-_var(--container-3xl))/2))] z-10"
    >
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[min(25rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-violet-400/20 bg-[#15131d]/95 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
            <Bot className="size-4 text-violet-300" />
            <span className="text-xs font-medium text-foreground">{t('subagentSession.activity')}</span>
            <span className="text-[10px] text-muted-foreground">{sessions.length}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="max-h-[55vh] overflow-y-auto p-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  void openSession({
                    conversationId: session.conversationId,
                    parentMessageId: session.parentMessageId,
                    toolCallId: session.toolCallId,
                  })
                  setOpen(false)
                }}
                className="mb-1 flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-black/15 px-2.5 py-2 text-left last:mb-0 hover:bg-white/[0.05]"
              >
                {live(session) ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-300" />
                ) : session.status === 'completed' ? (
                  <Check className="size-3.5 shrink-0 text-emerald-400" />
                ) : (
                  <TriangleAlert className="size-3.5 shrink-0 text-amber-300" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium text-foreground">{session.agentName}</span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {session.currentTool ?? session.phase ?? session.status}
                  </span>
                </span>
                <span className="text-[9px] text-muted-foreground">
                  {t(`subagentSession.status.${session.status}`)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-[min(22rem,calc(100vw-3rem))] items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-400/[0.11] px-2.5 py-1 text-[11px] text-violet-100 shadow-lg backdrop-blur hover:bg-violet-400/[0.17]"
      >
        <Bot className="size-3.5" />
        {active.length > 0 && <Loader2 className="size-3 animate-spin" />}
        <span>
          {active.length > 0 ? t('subagentSession.active', { count: active.length }) : t('subagentSession.activity')}
        </span>
      </button>
    </div>
  )
}
