import { useTranslation } from 'react-i18next'
import { ArrowUpRight, CircleAlert, CircleCheck, Loader2, MessagesSquare, MinusCircle } from 'lucide-react'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import {
  parseConversationDispatchBatchResult,
  type ConversationDispatchItemResult,
} from '../../../shared/conversation-dispatch'
import { cn } from '@/lib/utils'
import { ToolCallCard } from './ToolCallCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Ask the app shell to focus a conversation (handled in use-main-panels). */
export function openConversationById(conversationId: string): void {
  window.dispatchEvent(new CustomEvent('maestrly:open-conversation', { detail: { conversationId } }))
}

function StatusIcon({ status }: { status: ConversationDispatchItemResult['status'] }) {
  if (status === 'started') return <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
  if (status === 'skipped') return <MinusCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  return <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
}

/** Result of start_conversations: one row per task with its status and a link to the new conversation. */
export function ConversationDispatchCard({
  part,
  conversationId,
  messageId,
}: {
  part: ToolPart
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('chat')
  if (part.state.status === 'pending' || part.state.status === 'running' || part.state.status === 'awaiting-permission') {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> {t('dispatch.cardRunning')}
      </div>
    )
  }
  const result =
    part.state.status === 'completed' ? parseConversationDispatchBatchResult(toolOutputText(part.state.output)) : null
  if (!result) return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />

  return (
    <div
      data-testid="conversation-dispatch-card"
      className="min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <MessagesSquare className="size-3.5" />
        {t('dispatch.cardTitle')}
      </div>
      {result.error && (
        <p className={cn('mb-2 text-[12px]', result.items.length ? 'text-muted-foreground' : 'text-amber-200/90')}>
          {!result.ok && !result.items.some((item) => item.status === 'started') && (
            <span className="font-medium">{t('dispatch.cardRefused')}: </span>
          )}
          {result.error}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {result.items.map((item) => (
          <li key={item.requestKey} className="flex items-start gap-2 text-[13px]">
            <StatusIcon status={item.status} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-foreground">{item.conversationName ?? item.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(`dispatch.status.${item.status}`)}
                  {item.replayed ? ` · ${t('dispatch.replayed')}` : ''}
                </span>
              </div>
              {(item.settings || item.branch) && (
                <p className="truncate text-[11px] text-muted-foreground">
                  {[
                    item.settings?.modelId,
                    item.settings && item.settings.reasoning !== 'off' ? item.settings.reasoning : null,
                    item.settings?.fastMode ? 'Fast' : null,
                    item.branch,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {item.error && <p className="break-words text-[11px] text-amber-200/80">{item.error}</p>}
            </div>
            {item.conversationId && item.status !== 'failed' && (
              <button
                type="button"
                onClick={() => openConversationById(item.conversationId!)}
                className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-white/[0.06]"
              >
                {t('dispatch.open')} <ArrowUpRight className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {result.notes?.map((note) => (
        <p key={note} className="mt-2 text-[11px] text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  )
}
