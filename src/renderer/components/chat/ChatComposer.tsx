import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Square, X, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StructuredAgentMentionDraft } from '../../../shared/chat-agent-mentions'
import type { SubagentAgentDto } from '../../../shared/subagent-profiles'
import type { ChatFileHit, ChatSlashCommand } from '../../../shared/chat'
import { MentionEditor, type MentionEditorHandle } from './MentionEditor'

export interface UIAttachment {
  id: string
  name: string
  mediaType: string
  kind: 'image' | 'text'
  data?: string
  bytes?: Uint8Array
  artifactId?: string
  byteSize?: number
  previewUrl?: string
}

type OpenMention = (path: string, startLine?: number, endLine?: number) => void

interface Props {
  value: string
  onChange: (v: string) => void
  streaming: boolean

  sendWhileStreaming?: boolean
  streamingPlaceholder?: string
  disabled?: boolean

  onMentionsChange?: (mentions: StructuredAgentMentionDraft[]) => void

  structuredAgentMentions?: StructuredAgentMentionDraft[]

  onSend: (payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => void
  onStop: () => void
  leftSlot?: ReactNode

  metaSlot?: ReactNode

  micSlot?: ReactNode
  attachments?: UIAttachment[]
  onAddFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
  onSearchFiles?: (query: string) => Promise<ChatFileHit[]>

  onOpenMention?: OpenMention

  agents?: SubagentAgentDto[] | null

  commands?: ChatSlashCommand[]

  onPickCommand?: (cmd: ChatSlashCommand) => void

  onCycleMode?: () => void

  onCycleReasoning?: () => void
}

export interface ChatComposerHandle {
  focus(): void
}

const MAX_H = 220

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  {
    value,
    onChange,
    streaming,
    sendWhileStreaming = false,
    streamingPlaceholder,
    disabled,
    onSend,
    onStop,
    leftSlot,
    metaSlot,
    micSlot,
    attachments = [],
    onAddFiles,
    onRemoveAttachment,
    onSearchFiles,
    onOpenMention,
    onMentionsChange,
    structuredAgentMentions = [],
    agents = null,
    commands = [],
    onPickCommand,
    onCycleMode,
    onCycleReasoning,
  },
  ref
) {
  const { t } = useTranslation('chat')
  const editorRef = useRef<MentionEditorHandle>(null)
  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
  }))

  const [cmdIdx, setCmdIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashQuery = !disabled ? (/^\/([\w:-]*)$/.exec(value)?.[1] ?? null) : null
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false)
    )
  }, [slashQuery, commands])
  const slashOpen = slashQuery !== null && !slashDismissed && filteredCommands.length > 0
  useEffect(() => setCmdIdx(0), [slashQuery])
  useEffect(() => setSlashDismissed(false), [value])

  const pickCommand = (cmd: ChatSlashCommand | undefined) => {
    if (!cmd) return
    setSlashDismissed(true)
    onPickCommand?.(cmd)
  }

  const submit = () => {
    if (disabled) return

    const { text, mentions } = editorRef.current?.serialize() ?? { text: value, mentions: [] }
    if (!text.trim() && attachments.length === 0) return

    onSend({ text, agentMentions: mentions })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (e.key === 'Tab' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && onCycleReasoning) {
      e.preventDefault()
      onCycleReasoning()
      return true
    }

    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && onCycleMode) {
      e.preventDefault()
      onCycleMode()
      return true
    }
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdIdx((i) => Math.min(i + 1, filteredCommands.length - 1))
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdIdx((i) => Math.max(i - 1, 0))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickCommand(filteredCommands[cmdIdx])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return true
      }
    }
    return false
  }

  const canSend = value.trim().length > 0 || attachments.length > 0

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="chat-composer-shell relative mx-auto w-full max-w-3xl rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 pb-2 pt-2.5 transition-[border-color,background,box-shadow] duration-300 focus-within:border-white/[0.16]">
        {slashOpen && (
          <div className="absolute bottom-full left-3 z-50 mb-1 max-h-72 w-96 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
            {filteredCommands.map((c, i) => (
              <button
                key={`${c.kind}:${c.name}`}
                type="button"
                onMouseEnter={() => setCmdIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickCommand(c)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                  i === cmdIdx ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                )}
              >
                <span className="shrink-0 font-mono text-[13px] text-foreground">
                  /{c.name}
                  {c.argumentHint && <span className="ml-1 text-muted-foreground/70">{c.argumentHint}</span>}
                </span>
                {c.description && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{c.description}</span>
                )}
                <span className="ml-auto shrink-0 rounded text-[10px] uppercase tracking-wide text-muted-foreground/60">
                  {c.kind === 'action'
                    ? t('composer.kindAction')
                    : c.kind === 'project'
                      ? t('composer.kindProject')
                      : c.kind === 'skill'
                        ? t('composer.kindSkill')
                        : t('composer.kindPrompt')}
                </span>
              </button>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) =>
              a.kind === 'image' ? (
                <div key={a.id} className="relative">
                  <img
                    src={a.previewUrl || a.data}
                    alt={a.name}
                    title={a.name}
                    className="h-14 w-14 rounded-lg border border-white/[0.08] object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment?.(a.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/80 text-white ring-1 ring-white/20 hover:bg-black"
                    title={t('composer.remove')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ) : (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px] text-foreground"
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="max-w-[180px] truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment?.(a.id)}
                    className="text-muted-foreground hover:text-destructive"
                    title={t('composer.remove')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            )}
          </div>
        )}

        <MentionEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          onMentionsChange={onMentionsChange}
          structuredAgentMentions={structuredAgentMentions}
          agents={agents}
          disabled={disabled}
          placeholder={
            disabled
              ? t('composer.placeholderDisabled')
              : streaming
                ? (streamingPlaceholder ?? t('composer.placeholderQueue'))
                : t('composer.placeholder')
          }
          className="chat-input max-h-[220px] overflow-y-auto"
          maxHeight={MAX_H}
          onSearchFiles={onSearchFiles}
          onOpenMention={onOpenMention}
          onAddFiles={onAddFiles}
          onRequestSubmit={submit}
          onKeyDown={handleKeyDown}
        />

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">{leftSlot}</div>
          <div className="flex shrink-0 items-center gap-2">
            {micSlot}
            {(!streaming || sendWhileStreaming) && (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend || disabled}
                className={cn(
                  'chat-send-button flex h-8 w-8 items-center justify-center rounded-full transition-[color,background,box-shadow,transform]',
                  canSend ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground',
                  disabled && 'bg-foreground/10 text-muted-foreground'
                )}
                title={t('composer.send')}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
            {streaming && (
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/10 text-foreground hover:bg-foreground/20"
                title={t('composer.stop')}
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {metaSlot && (
        <div className="mx-auto mt-1.5 flex w-full max-w-3xl items-center justify-between gap-2 px-1">{metaSlot}</div>
      )}
    </div>
  )
})
