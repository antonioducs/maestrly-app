import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Circle, Loader2, OctagonX, Route, ShieldCheck } from 'lucide-react'
import type { MessagePart, SubagentSessionSummary } from '../../../shared/chat'
import { cn } from '@/lib/utils'
import { SubagentCard } from './SubagentCard'
import type { OpenFileReference } from '@/components/MarkdownViewer'
import { useSubagentSessions } from './SubagentSessionContext'

export type DelegatePart = Extract<MessagePart, { type: 'tool' }>

export type DelegateStatus = 'queued' | 'running' | 'success' | 'error' | 'aborted'

export function delegateStatus(
  part: DelegatePart,
  sessions: readonly SubagentSessionSummary[] = [],
  parentMessageId?: string
): DelegateStatus {
  const session = sessions.find(
    (item) => item.toolCallId === part.toolCallId && (!parentMessageId || item.parentMessageId === parentMessageId)
  )
  if (session?.status === 'preparing' || session?.status === 'running') return 'running'
  if (session?.status === 'completed') return 'success'
  if (session?.status === 'cancelled' || session?.status === 'interrupted') return 'aborted'
  if (session?.status === 'failed') return 'error'
  if (part.state.status === 'completed') return 'success'
  if (part.state.status === 'error') return /abort/i.test(part.state.error) ? 'aborted' : 'error'
  if (part.state.status === 'denied') return 'error'
  if (part.state.status === 'running') return 'running'
  return 'queued'
}

export function delegateSnapshot(part: DelegatePart) {
  return 'sub' in part.state ? part.state.sub?.maestro : undefined
}

function StatusIcon({ value }: { value: DelegateStatus }) {
  if (value === 'success') return <Check className="size-3.5 text-emerald-400" />
  if (value === 'error' || value === 'aborted') return <OctagonX className="size-3.5 text-red-400" />
  if (value === 'running') return <Loader2 className="size-3.5 animate-spin text-sky-300" />
  return <Circle className="size-3.5 text-muted-foreground" />
}

export function OrchestrationGroups({
  parts,
  conversationId,
  messageId,
  onOpenMention,
  className,
}: {
  parts: DelegatePart[]
  conversationId: string
  messageId: string
  onOpenMention?: OpenFileReference
  className?: string
}) {
  const { t } = useTranslation('chat')
  const sessions = useSubagentSessions()
  const groups = new Map<string, DelegatePart[]>()
  for (const part of parts) {
    const key = delegateSnapshot(part)?.kind || 'general'
    const entries = groups.get(key) ?? []
    entries.push(part)
    groups.set(key, entries)
  }
  return (
    <div className={cn('space-y-2 p-2.5', className)}>
      {[...groups.entries()].map(([kind, entries]) => (
        <div key={kind} className="rounded-lg border border-white/[0.06] bg-black/15 p-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <ChevronRight className="size-3" /> {kind}
            {entries.length > 1 && (
              <span className="normal-case tracking-normal">
                · {t('maestro.run.delegations', { count: entries.length })}
              </span>
            )}
          </div>
          <div className="space-y-1">
            {entries.map((part) => {
              const snapshot = delegateSnapshot(part)
              const value = delegateStatus(part, sessions, messageId)
              return (
                <details key={part.toolCallId} className="group rounded-md border border-white/[0.05] bg-white/[0.02]">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[11px]">
                    <StatusIcon value={value} />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {snapshot?.resource.label ?? snapshot?.resource.id ?? t('maestro.run.routing')}
                    </span>
                    {snapshot && (
                      <span className="truncate text-[9px] text-muted-foreground">
                        {snapshot.domain} · {t('maestro.run.parentSelected')}
                      </span>
                    )}
                    <span
                      className={cn(
                        'text-[9px]',
                        value === 'success'
                          ? 'text-emerald-300'
                          : value === 'error'
                            ? 'text-red-300'
                            : 'text-muted-foreground'
                      )}
                    >
                      {t(`maestro.run.status.${value}`)}
                    </span>
                  </summary>
                  <div className="border-t border-white/[0.05] p-1.5">
                    <SubagentCard
                      part={part}
                      conversationId={conversationId}
                      messageId={messageId}
                      onOpenMention={onOpenMention}
                    />
                  </div>
                </details>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export function OrchestrationRun({
  parts,
  conversationId,
  messageId,
  onOpenMention,
}: {
  parts: DelegatePart[]
  conversationId: string
  messageId: string
  onOpenMention?: OpenFileReference
}) {
  const { t } = useTranslation('chat')
  const sessions = useSubagentSessions()
  const running = parts.some(
    (part) =>
      delegateStatus(part, sessions, messageId) === 'running' || delegateStatus(part, sessions, messageId) === 'queued'
  )
  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-amber-400/15 bg-amber-400/[0.035]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <Route className="size-4 text-amber-300" />
        <span className="text-xs font-medium text-foreground">{t('maestro.run.title')}</span>
        <span className="text-[10px] text-muted-foreground">
          {t('maestro.run.delegations', { count: parts.length })}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          {running ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3 text-emerald-400" />}
          {running ? t('maestro.run.running') : t('maestro.run.settled')}
        </span>
      </div>
      <OrchestrationGroups
        parts={parts}
        conversationId={conversationId}
        messageId={messageId}
        onOpenMention={onOpenMention}
      />
    </div>
  )
}
