import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Pause, Play } from 'lucide-react'
import type { Conversation } from '../../../shared/conversation'
import { Button } from '../ui/button'

export function BotConversationBadge({
  conversation,
  compact = false,
}: {
  conversation: Conversation
  compact?: boolean
}) {
  const { t } = useTranslation('ui')
  if (!conversation.botOrigin) return null
  const state = conversation.botManagementState ?? 'revoked'
  const label = t(state === 'active' ? 'bots.managedBy' : 'bots.createdBy', { name: conversation.botOrigin.botName })
  return (
    <span
      data-bot-origin={conversation.botOrigin.connectionId}
      data-testid={compact ? 'conversation-bot-badge' : 'chat-bot-badge'}
      aria-label={`${label} · ${t(`bots.states.${state}`)}`}
      title={`${label} · ${t(`bots.states.${state}`)}`}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-sky-400/25 bg-sky-400/[0.08] px-1 py-0.5 text-[10px] font-medium text-sky-300"
    >
      <Bot className="size-3.5" aria-hidden="true" />
      {compact && <span className="sr-only">{conversation.botOrigin.botName}</span>}
      {!compact && <span className="max-w-44 truncate">{label}</span>}
      {!compact && state !== 'active' && <span className="text-muted-foreground">· {t(`bots.states.${state}`)}</span>}
    </span>
  )
}

export function BotManagementControls({ conversation }: { conversation: Conversation }) {
  const { t } = useTranslation('ui')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!conversation.botOrigin || conversation.botManagementState === 'revoked') return null
  const active = conversation.botManagementState === 'active'
  const label = t(active ? 'bots.pause' : 'bots.resume')
  return (
    <div className="flex shrink-0 items-center gap-1">
      {error && (
        <span role="alert" title={error} className="max-w-40 truncate text-xs text-destructive">
          {error}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        disabled={busy}
        title={label}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            await window.api.botSetManagement(conversation.id, active ? 'paused' : 'active')
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          } finally {
            setBusy(false)
          }
        }}
      >
        {active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {label}
      </Button>
    </div>
  )
}
