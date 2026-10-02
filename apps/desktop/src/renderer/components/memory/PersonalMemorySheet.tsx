import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ExternalLink, LoaderCircle, Pencil, Pin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import { MEMORY_TYPES, type LocalMemory, type MemoryType } from '../../../shared/memory'
import type { PersonalMemoryCreateInput, PersonalMemoryUpdateInput } from '../../../preload/api-memory'
import { MemoryConfirmation } from './MemoryConfirmation'
import { memoryError } from './use-personal-memory'

interface Draft {
  title: string
  content: string
  type: MemoryType
  scope: string
  tags: string
  pinned: boolean
}
const fieldClass =
  'w-full rounded-md border border-input bg-black/10 px-3 py-2 text-xs text-foreground outline-none focus:border-ring'

export function PersonalMemorySheet({
  memory,
  missing = false,
  onClose,
  onSaved,
  onChanged,
  onDeleted,
  onGuardChange,
  onRestoreFocus,
}: {
  memory?: LocalMemory
  missing?: boolean
  onClose: () => void
  onSaved: (memory: LocalMemory) => void
  onChanged: () => void
  onDeleted: () => void
  onRestoreFocus: () => void
  onGuardChange: (guard: { dirty: boolean; busy: boolean }) => void
}) {
  const { t, i18n } = useTranslation('ui')
  const [editing, setEditing] = useState(!memory)
  const [changes, setChanges] = useState<Partial<Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [forget, setForget] = useState(false)
  // Untouched fields follow incoming updates. Edited fields survive unrelated collection refreshes.
  const draft: Draft = {
    title: memory?.title ?? '',
    content: memory?.content ?? '',
    type: memory?.type ?? 'reference',
    scope: memory?.scope ?? '',
    tags: memory?.tags.join(', ') ?? '',
    pinned: memory?.pinned ?? false,
    ...changes,
  }
  const dirty = editing && Object.keys(changes).length > 0
  useEffect(() => onGuardChange({ dirty, busy }), [dirty, busy, onGuardChange])
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setChanges((current) => ({ ...current, [key]: value }))
    setError('')
  }
  const save = async () => {
    if (busy || missing || !draft.title.trim() || !draft.content.trim()) return
    setBusy(true)
    setError('')
    const input: PersonalMemoryCreateInput = {
      ...draft,
      tags: draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    }
    // Save only touched fields so an incoming correction isn't silently replaced by an older form value.
    const patch: PersonalMemoryUpdateInput = {}
    for (const field of Object.keys(changes) as (keyof Draft)[]) Object.assign(patch, { [field]: input[field] })
    try {
      const result = memory
        ? await window.api.updatePersonalMemory(memory.id, patch)
        : await window.api.createPersonalMemory(input)
      setChanges({})
      setEditing(false)
      onGuardChange({ dirty: false, busy: false })
      onSaved(result.memory)
    } catch (reason) {
      setError(memoryError(reason))
    } finally {
      setBusy(false)
    }
  }
  const mutate = async (action: 'archive' | 'restore' | 'forget') => {
    if (!memory || busy || missing) return
    setBusy(true)
    setError('')
    try {
      if (action === 'forget') {
        await window.api.forgetPersonalMemory(memory.id, true)
        setForget(false)
        onGuardChange({ dirty: false, busy: false })
        onDeleted()
      } else {
        await (action === 'archive' ? window.api.archivePersonalMemory : window.api.restorePersonalMemory)(memory.id)
        onChanged()
      }
    } catch (reason) {
      setError(memoryError(reason))
    } finally {
      setBusy(false)
    }
  }
  const date = (value: number) => new Date(value).toLocaleString(i18n.language)
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        showClose={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
        aria-describedby={undefined}
        className="left-auto right-3 top-3 bottom-3 flex w-[460px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4 hairline-b">
          <DialogTitle className="text-[13px] font-medium tracking-normal">
            {t(!memory ? 'projectMemory.newMemory' : editing ? 'personalMemory.edit' : 'personalMemory.details')}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('common.close')}
            disabled={busy}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
        {editing ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={busy} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
              {missing && (
                <p role="alert" className="text-xs text-destructive">
                  {t('personalMemory.removed')}
                </p>
              )}
              <label className="flex flex-col gap-2 text-[11px] text-muted-foreground">
                {t('projectMemory.fields.title')}
                <input
                  required
                  aria-label={t('projectMemory.fields.title')}
                  className={fieldClass}
                  value={draft.title}
                  placeholder={t('projectMemory.fields.title')}
                  onChange={(event) => change('title', event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-2 text-[11px] text-muted-foreground">
                {t('projectMemory.fields.content')}
                <textarea
                  required
                  rows={8}
                  aria-label={t('projectMemory.fields.content')}
                  className={`${fieldClass} min-h-44 resize-y leading-relaxed`}
                  value={draft.content}
                  placeholder={t('projectMemory.fields.content')}
                  onChange={(event) => change('content', event.target.value)}
                />
              </label>
              <label className="flex items-start gap-2.5 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={draft.pinned}
                  onChange={(event) => change('pinned', event.target.checked)}
                />
                <span>
                  {t('personalMemory.pin')}
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {t('projectMemory.pinnedHint')}
                  </span>
                </span>
              </label>
              <details className="border-t border-border pt-4">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t('personalMemory.classification')}
                </summary>
                <div className="mt-5 space-y-4">
                  <div className="space-y-2 text-[11px] text-muted-foreground">
                    <label htmlFor="personal-memory-type">{t('personalMemory.type')}</label>
                    <OptionSelect
                      id="personal-memory-type"
                      value={draft.type}
                      disabled={busy}
                      className="h-8 text-xs text-foreground"
                      onValueChange={(value) => change('type', value as MemoryType)}
                    >
                      {MEMORY_TYPES.map((type) => (
                        <SelectOption key={type} value={type}>
                          {t(`projectMemory.types.${type}`)}
                        </SelectOption>
                      ))}
                    </OptionSelect>
                  </div>
                  <label className="flex flex-col gap-2 text-[11px] text-muted-foreground">
                    {t('personalMemory.scope')}
                    <input
                      className={fieldClass}
                      value={draft.scope}
                      onChange={(event) => change('scope', event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-[11px] text-muted-foreground">
                    {t('projectMemory.fields.tags')}
                    <input
                      className={fieldClass}
                      value={draft.tags}
                      onChange={(event) => change('tags', event.target.value)}
                    />
                  </label>
                </div>
              </details>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
            <div className="flex shrink-0 justify-end gap-2 px-5 py-3.5 hairline-t">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || missing || !draft.title.trim() || !draft.content.trim()}
              >
                {busy && <LoaderCircle className="size-3.5 animate-spin" />}
                {t('common.save')}
              </Button>
            </div>
          </form>
        ) : memory ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                <span className="rounded border border-border bg-secondary px-2 py-0.5">
                  {t(`projectMemory.types.${memory.type}`)}
                </span>
                {memory.pinned && (
                  <span className="flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5">
                    <Pin className="size-3" />
                    {t('projectMemory.pinned')}
                  </span>
                )}
                <span className="rounded border border-border bg-secondary px-2 py-0.5">
                  {t(`projectMemory.statuses.${memory.status}`)}
                </span>
              </div>
              <h2 className="mb-4 mt-3 break-words text-lg font-semibold leading-snug">{memory.title}</h2>
              {(missing || memory.status !== 'active') && (
                <p className="mb-4 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
                  {t(
                    missing
                      ? 'personalMemory.removed'
                      : memory.status === 'archived'
                        ? 'personalMemory.archivedHint'
                        : 'personalMemory.supersededHint'
                  )}
                </p>
              )}
              <MarkdownViewer markdown={memory.content} />
              <dl className="mt-7 space-y-3 border-t border-border pt-5 text-[11px]">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('personalMemory.source')}</dt>
                  <dd className="text-right">
                    {t(`personalMemory.sources.${memory.source}`)} · {date(memory.createdAt)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('personalMemory.updated')}</dt>
                  <dd>{date(memory.updatedAt)}</dd>
                </div>
                {memory.scope && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('personalMemory.scope')}</dt>
                    <dd className="min-w-0 break-words text-right">{memory.scope}</dd>
                  </div>
                )}
                {memory.tags.length > 0 && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('personalMemory.tags')}</dt>
                    <dd className="min-w-0 break-words text-right">{memory.tags.join(', ')}</dd>
                  </div>
                )}
              </dl>
              {memory.originConversationId && (
                <button
                  className="mt-5 flex items-center gap-1.5 text-[11px] underline underline-offset-4"
                  onClick={() => {
                    onClose()
                    window.dispatchEvent(
                      new CustomEvent('maestrly:open-conversation', {
                        detail: { conversationId: memory.originConversationId },
                      })
                    )
                  }}
                >
                  <ExternalLink className="size-3" />
                  {t('personalMemory.openConversation')}
                </button>
              )}
              <div className="mt-7 flex flex-wrap justify-between gap-2 border-t border-border pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || missing}
                  onClick={() => void mutate(memory.status === 'archived' ? 'restore' : 'archive')}
                >
                  <Archive className="size-3.5" />
                  {t(memory.status === 'archived' ? 'projectMemory.restore' : 'projectMemory.archive')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy || missing}
                  onClick={() => {
                    setError('')
                    setForget(true)
                  }}
                >
                  {t('projectMemory.forget')}
                </Button>
              </div>
              {error && !forget && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 justify-end gap-2 px-5 py-3.5 hairline-t">
              <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button
                size="sm"
                disabled={busy || missing}
                onClick={() => {
                  setError('')
                  setEditing(true)
                }}
              >
                <Pencil className="size-3.5" />
                {t('personalMemory.edit')}
              </Button>
            </div>
          </>
        ) : null}
        {forget && (
          <MemoryConfirmation
            kind="forget"
            busy={busy}
            error={error}
            onCancel={() => {
              setForget(false)
              setError('')
            }}
            onConfirm={() => void mutate('forget')}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
