import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrainCircuit } from 'lucide-react'
import type { ChatMessage } from '../../../shared/chat'

export function MemorySourcesChip({
  message,
  variant,
  onOpenMention,
}: {
  message: ChatMessage
  variant: 'used' | 'recalled'
  onOpenMention?: (path: string, startLine?: number, endLine?: number) => void
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      {message.memoryContext && message.memoryContext.sources.length > 0 && (
        <div className="w-fit max-w-full">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 rounded-full border border-fuchsia-400/25 bg-fuchsia-400/[0.08] px-2 py-0.5 text-[10px] font-medium text-fuchsia-200 hover:bg-fuchsia-400/[0.13]"
            title={t(variant === 'used' ? 'messages.memorySourcesHint' : 'messages.memoryRecalledHint')}
          >
            <BrainCircuit className="size-3" />
            {t(variant === 'used' ? 'messages.memoriesUsed' : 'messages.memoriesRecalled', {
              count: message.memoryContext.sources.length,
            })}
          </button>
          {expanded && (
            <div className="mt-1.5 max-w-lg space-y-1 rounded-lg border border-white/[0.08] bg-black/20 p-1.5">
              {message.memoryContext.sources.map((source, index) => (
                <button
                  key={`${source.kind}:${source.id}:${source.path ?? ''}:${index}`}
                  type="button"
                  onClick={() => {
                    if (source.kind === 'local') {
                      window.dispatchEvent(
                        new CustomEvent('maestrly:open-memory', {
                          detail: { conversationId: message.conversationId, memoryId: source.id },
                        })
                      )
                      return
                    }
                    if (!source.path) return
                    const publicRepo =
                      source.repo &&
                      source.repo !== 'repository' &&
                      !source.repo.includes('/') &&
                      !source.repo.includes('\\') &&
                      !source.repo.includes(':')
                        ? `${source.repo}/`
                        : ''
                    onOpenMention?.(`${publicRepo}${source.path}`, source.startLine, source.endLine)
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                >
                  <span className="rounded bg-white/[0.06] px-1 py-0.5">
                    {source.kind === 'local' ? t('messages.memoryLocal') : t('messages.memoryShared')}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                  {source.path && <span className="max-w-48 truncate font-mono opacity-70">{source.path}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
