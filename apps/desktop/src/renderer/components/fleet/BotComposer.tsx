import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Check, ChevronDown, Hand, Plus, ShieldAlert, TerminalSquare, X } from 'lucide-react'
import type { FleetBot, FleetSelection, FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import type { FleetOutgoingAttachment } from '../../../preload/api-fleet'
import { ChatReasoningPicker } from '@/components/chat/ChatReasoningPicker'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { ChatMicButton } from '@/components/chat/ChatMicButton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { formatFleetUsage, selectionPatch, validateAttachments } from '@/lib/fleet/composer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'

const modes = [
  { id: 'ask', icon: Hand },
  { id: 'auto', icon: TerminalSquare },
  { id: 'full', icon: ShieldAlert },
] as const

function AttachmentPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { t } = useTranslation('fleet')
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return (
    <div className="relative flex max-w-36 items-center gap-2 rounded-md border border-border bg-surface-elevated p-1.5 text-xs">
      {url && <img src={url} alt="" className="size-8 rounded object-cover" />}
      <span className="truncate" title={file.name}>
        {file.name}
      </span>
      <button type="button" aria-label={t('composer.removeAttachment', { name: file.name })} onClick={onRemove}>
        <X className="size-3" />
      </button>
    </div>
  )
}

export function BotComposer({ bot, fleet }: { bot: FleetBot; fleet: FleetController }) {
  const { t } = useTranslation('fleet')
  const { t: chatT } = useTranslation('chat')
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [options, setOptions] = useState<FleetSelectionOption[]>([])
  const [current, setCurrent] = useState<FleetSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accessOpen, setAccessOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const accessRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef(files)
  filesRef.current = files
  useEffect(() => {
    let active = true
    if (['offline', 'starting'].includes(bot.status)) return
    void window.api
      .fleetListSelections(bot.id)
      .then((result) => {
        if (active) {
          setOptions(result.options)
          setCurrent(result.current)
        }
      })
      .catch((cause) => {
        if (active) setError(fleetErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [bot.id, bot.status])
  useEffect(() => {
    if (!accessOpen) return
    const onDoc = (event: MouseEvent) => {
      if (!accessRef.current?.contains(event.target as Node)) setAccessOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [accessOpen])
  useEffect(() => {
    setDraft('')
    setFiles([])
    setError(null)
  }, [bot.id])
  const addFiles = (incoming: File[]) => {
    if (!incoming.length) return
    const issue = validateAttachments(filesRef.current, incoming)
    if (issue) {
      setError(t(`composer.attachmentError.${issue}`))
      return
    }
    setFiles((previous) => [...previous, ...incoming])
    setError(null)
  }
  const changeSelection = async (change: {
    model?: FleetSelectionOption | null
    reasoning?: string | null
    fastMode?: boolean
  }) => {
    const next = selectionPatch(current, change)
    if (!next && !('model' in change)) return
    try {
      setError(null)
      await window.api.fleetUpdateBot(bot.id, { selection: next })
      const result = await window.api.fleetListSelections(bot.id)
      setOptions(result.options)
      setCurrent(result.current)
      await fleet.refresh()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  const send = async () => {
    const text = draft.trim()
    if ((!text && !files.length) || busy) return
    setBusy(true)
    setError(null)
    try {
      const attachments: FleetOutgoingAttachment[] = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mediaType: file.type as FleetOutgoingAttachment['mediaType'],
          data: new Uint8Array(await file.arrayBuffer()),
        }))
      )
      await window.api.fleetSendMessage(bot.id, text, attachments)
      setDraft('')
      setFiles([])
      if (fileRef.current) fileRef.current.value = ''
      await fleet.loadTranscript(bot.id)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const option = options.find((item) => item.providerId === current?.providerId && item.modelId === current.modelId)
  const usage = bot.usage && formatFleetUsage(bot.usage)
  return (
    <>
      <div
        className="rounded-xl border border-border bg-card p-2"
        onDragOver={(event: DragEvent) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 p-2">
            {files.map((file, index) => (
              <AttachmentPreview
                key={`${file.name}-${index}`}
                file={file}
                onRemove={() => setFiles((items) => items.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          onPaste={(event: ClipboardEvent) => {
            const pasted = Array.from(event.clipboardData.files)
            if (pasted.length) {
              event.preventDefault()
              addFiles(pasted)
            }
          }}
          maxLength={16000}
          rows={2}
          aria-label={t('composer.message')}
          placeholder={t('composer.placeholder', { name: bot.name })}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
        />
        <div className="flex flex-wrap items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            aria-label={t('composer.attach')}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <button
            type="button"
            aria-label={t('composer.attach')}
            title={t('composer.attach')}
            onClick={() => fileRef.current?.click()}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05]"
          >
            <Plus className="size-4" />
          </button>
          <Select
            value={bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : '__default'}
            onValueChange={(value) =>
              void changeSelection({ model: options.find((item) => item.id === value) ?? null })
            }
          >
            <SelectTrigger className="h-7 max-w-52 text-xs" aria-label={t('composer.model')}>
              <SelectValue placeholder={t('composer.model')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">{t('composer.defaultModel')}</SelectItem>
              {options.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.providerLabel} · {item.modelLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {option && option.efforts.length > 0 && (
            <ChatReasoningPicker
              value={current?.reasoning ?? 'off'}
              efforts={option.efforts}
              allowUltra={false}
              avoidOverflow
              onChange={(reasoning) => void changeSelection({ reasoning: reasoning === 'off' ? null : reasoning })}
            />
          )}
          {option?.fastMode && (
            <FastModeChip
              enabled={current?.fastMode ?? false}
              onToggle={() => void changeSelection({ fastMode: !current?.fastMode })}
            />
          )}
          <span className="ml-auto" />
          <ChatMicButton
            onTranscribed={(text) => setDraft((previous) => (previous ? `${previous.trimEnd()} ${text}` : text))}
            disabled={busy}
          />
          <button
            type="button"
            disabled={(!draft.trim() && !files.length) || busy}
            onClick={() => void send()}
            aria-label={t('composer.send')}
            className="rounded-md bg-primary p-1.5 text-primary-foreground disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <div className="relative" ref={accessRef}>
          <button
            type="button"
            aria-label={t('composer.access')}
            aria-expanded={accessOpen}
            onClick={() => setAccessOpen((open) => !open)}
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.05]',
              bot.ceiling === 'full' ? 'text-amber-400' : 'text-muted-foreground'
            )}
          >
            {bot.ceiling === 'full' ? (
              <ShieldAlert className="size-3.5" />
            ) : bot.ceiling === 'auto' ? (
              <TerminalSquare className="size-3.5" />
            ) : (
              <Hand className="size-3.5" />
            )}
            {chatT(`perm.${bot.ceiling}Label`)}
            <ChevronDown className="size-3" />
          </button>
          {accessOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl">
              {modes.map(({ id, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setAccessOpen(false)
                    void window.api
                      .fleetUpdateBot(bot.id, { ceiling: id })
                      .then(() => fleet.refresh())
                      .catch((cause) => setError(fleetErrorMessage(cause)))
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05]"
                >
                  <Icon className={cn('mt-0.5 size-3.5', id === 'full' ? 'text-amber-400' : 'text-muted-foreground')} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-[13px]', id === 'full' && 'text-amber-300')}>
                      {chatT(`perm.${id}Label`)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{chatT(`perm.${id}Desc`)}</span>
                  </span>
                  <Check className={cn('mt-0.5 size-3.5', bot.ceiling === id ? 'opacity-100' : 'opacity-0')} />
                </button>
              ))}
            </div>
          )}
        </div>
        {usage && (
          <span
            title={t('composer.usageTooltip', {
              quality: bot.usage?.contextQuality === 'measured' ? t('composer.measured') : t('composer.estimated'),
            })}
            className="text-muted-foreground"
          >
            {usage}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  )
}
