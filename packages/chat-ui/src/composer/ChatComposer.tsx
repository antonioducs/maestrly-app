import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Square, X, FileText } from 'lucide-react'
import { cn, ComposerSurface, Textarea, Button } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { ChatComposerDock } from '../layout/ChatLayout'

export interface ComposerCommand {
  name: string
  description?: string
  argumentHint?: string
  /** Shown as a small tag: prompt, skill, project… */
  kind?: string
}
export interface ComposerAttachment {
  id: string
  name: string
  size?: number
}

const MAX_HEIGHT = 220

/**
 * The message box both applications share: Enter sends, Shift+Enter breaks a line, `/` opens
 * the command palette, chips show attachments, and the three slots (left, mic, meta) let each
 * application add its pickers without the composer knowing what they are.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  stopping = false,
  disabled = false,
  disabledReason,
  attachments = [],
  onRemoveAttachment,
  commands = [],
  onPickCommand,
  leftSlot,
  metaSlot,
  micSlot,
  busy = false,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  stopping?: boolean
  disabled?: boolean
  disabledReason?: string
  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (id: string) => void
  commands?: ComposerCommand[]
  onPickCommand?: (command: ComposerCommand) => void
  leftSlot?: ReactNode
  metaSlot?: ReactNode
  micSlot?: ReactNode
  /** A request is in flight: sending is held without disabling the box. */
  busy?: boolean
}) {
  const { labels } = useChatUi()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const slashQuery = !disabled ? (/^\/([\w:-]*)$/.exec(value)?.[1] ?? null) : null
  const filtered = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description?.toLowerCase().includes(q) ?? false)
    )
  }, [slashQuery, commands])
  const paletteOpen = slashQuery !== null && !dismissed && filtered.length > 0
  useEffect(() => setCommandIndex(0), [slashQuery])
  useEffect(() => setDismissed(false), [value])
  // Grow with the text up to a ceiling, then scroll: the conversation above must stay visible.
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const canSend = !disabled && !busy && !streaming && (value.trim().length > 0 || attachments.length > 0)
  const pick = (command: ComposerCommand | undefined) => {
    if (!command) return
    setDismissed(true)
    onPickCommand?.(command)
  }
  return (
    <ChatComposerDock>
      <ComposerSurface
        as="form"
        className="composer relative"
        data-composer
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) onSend()
        }}
      >
        {paletteOpen && (
          <div
            role="listbox"
            aria-label={labels.composer.commands}
            className="absolute bottom-full left-3 z-50 mb-1 max-h-72 w-96 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl"
          >
            {filtered.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === commandIndex}
                onMouseEnter={() => setCommandIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(command)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                  index === commandIndex ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                )}
              >
                <span className="shrink-0 font-mono text-[13px] text-foreground">
                  /{command.name}
                  {command.argumentHint && (
                    <span className="ml-1 text-muted-foreground/70">{command.argumentHint}</span>
                  )}
                </span>
                {command.description && (
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                    {command.description}
                  </span>
                )}
                {command.kind && (
                  <span className="ml-auto shrink-0 rounded text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {command.kind}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments mb-2 flex flex-wrap gap-2" aria-label={labels.composer.attachments}>
            {attachments.map((file) => (
              <span
                key={file.id}
                className="attachment-chip inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px] text-foreground"
              >
                <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="max-w-[180px] truncate" title={file.name}>
                  {file.name}
                </span>
                {file.size != null && <small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small>}
                {onRemoveAttachment && (
                  <Button
                    type="button"
                    aria-label={`${labels.composer.removeAttachment} ${file.name}`}
                    disabled={streaming || busy}
                    onClick={() => onRemoveAttachment(file.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </Button>
                )}
              </span>
            ))}
          </div>
        )}
        <Textarea
          className="chat-input max-h-[220px] min-h-[54px] overflow-y-auto"
          ref={textarea}
          aria-label={labels.composer.message}
          placeholder={labels.composer.placeholder}
          aria-describedby={disabled ? 'composer-reason' : undefined}
          readOnly={disabled}
          value={value}
          rows={1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (paletteOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCommandIndex((i) => Math.min(i + 1, filtered.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCommandIndex((i) => Math.max(i - 1, 0))
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                pick(filtered[commandIndex])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(true)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSend) onSend()
            }
          }}
        />
        <div className="actions mt-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">{leftSlot}</div>
          <div className="flex shrink-0 items-center gap-2">
            {micSlot}
            {streaming ? (
              <Button
                className="stop-button"
                type="button"
                aria-label={stopping ? labels.composer.stopping : labels.composer.stop}
                title={stopping ? labels.composer.stopping : labels.composer.stop}
                disabled={disabled || stopping || busy}
                onClick={onStop}
              >
                <Square size={12} aria-hidden="true" />
                <span className="sr-only">{stopping ? labels.composer.stopping : labels.composer.stop}</span>
              </Button>
            ) : (
              <Button
                className="send-button"
                type="submit"
                aria-label={labels.composer.send}
                title={labels.composer.send}
                disabled={!canSend}
              >
                <ArrowUp size={18} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
        {disabled && <p id="composer-reason">{disabledReason}</p>}
      </ComposerSurface>
      {metaSlot && (
        <div className="composer-meta mx-auto mt-1.5 flex w-full max-w-3xl items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
          {metaSlot}
        </div>
      )}
    </ChatComposerDock>
  )
}
