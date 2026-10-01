import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ArrowUpRight, Loader2 } from 'lucide-react'
import { parseArtifactToolResult, type ArtifactToolResult } from '../../../shared/artifacts'
import { toolOutputText, type MessagePart } from '../../../shared/chat'
import { ToolCallCard } from '../chat/ToolCallCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Result of artifact_create or artifact_update: the page and version, with a button that opens it in the drawer. */
export function ArtifactCard({
  part,
  conversationId,
  messageId,
  result: suppliedResult,
  onOpen,
}: {
  part?: ToolPart
  conversationId?: string
  messageId?: string
  result?: ArtifactToolResult
  onOpen?: () => Promise<unknown>
}) {
  const { t } = useTranslation('chat')
  const [failed, setFailed] = useState(false)
  if (part && (part.state.status === 'pending' || part.state.status === 'running')) {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> {t('artifacts.publishing')}
      </div>
    )
  }
  const result =
    suppliedResult ??
    (part?.state.status === 'completed' ? parseArtifactToolResult(toolOutputText(part.state.output)) : null)
  if (!result)
    return part && conversationId && messageId ? (
      <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
    ) : null

  const open = () => {
    setFailed(false)
    const action =
      onOpen ??
      (() =>
        conversationId
          ? window.api.artifacts.openInConversation(conversationId, result.id, result.version)
          : window.api.artifacts.openExternal(result.id, result.version))
    void Promise.resolve()
      .then(action)
      .catch(() => setFailed(true))
  }

  return (
    <div
      data-testid="artifact-card"
      className="flex min-w-0 max-w-full items-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
    >
      <AppWindow className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('artifacts.card')}</div>
        <div className="truncate text-[13px] text-foreground" title={result.title}>
          {result.title}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {failed ? t('artifacts.openFailed') : t('artifacts.version', { version: result.version })}
        </div>
      </div>
      <button
        type="button"
        onClick={open}
        className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-white/[0.06]"
      >
        {t('artifacts.open')} <ArrowUpRight className="size-3" />
      </button>
    </div>
  )
}
