import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BrainCircuit,
  Download,
  Info,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { cn } from '@/lib/utils'
import {
  LOCAL_MEMORY_STATUSES,
  MEMORY_TYPES,
  type LocalMemory,
  type LocalMemoryStatus,
  type MemoryType,
} from '../../../shared/memory'
import { MemoryConfirmation } from './MemoryConfirmation'
import { PersonalMemorySheet } from './PersonalMemorySheet'
import { PersonalMemorySettingsDialog } from './PersonalMemorySettingsDialog'
import { memoryError, usePersonalMemory } from './use-personal-memory'

type Section = 'all' | 'recent' | 'archived'
type Selection = { memory?: LocalMemory }
const SECTIONS: Section[] = ['all', 'recent', 'archived']

export interface PersonalMemoryPanelProps {
  focusMemoryId?: string
  focusMemoryRequest?: number
  onShowSidebar?: () => void
  onClose: () => void
}

export function PersonalMemoryPanel({
  focusMemoryId,
  focusMemoryRequest,
  onShowSidebar,
  onClose,
}: PersonalMemoryPanelProps) {
  const { t, i18n } = useTranslation('ui')
  const data = usePersonalMemory()
  const [section, setSection] = useState<Section>('all')
  const [query, setQuery] = useState('')
  const [type, setType] = useState<MemoryType | ''>('')
  const [status, setStatus] = useState<LocalMemoryStatus | ''>('')
  const [pinned, setPinned] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [guard, setGuard] = useState({ dirty: false, busy: false })
  const guardRef = useRef(guard)
  const [pending, setPending] = useState<{ next: Selection | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const focusApplied = useRef('')
  const newButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const updateGuard = useCallback((next: typeof guard) => {
    guardRef.current = next
    setGuard((current) => (current.dirty === next.dirty && current.busy === next.busy ? current : next))
  }, [])
  const select = useCallback((next: Selection | null) => {
    if (guardRef.current.busy) return false
    if (guardRef.current.dirty) setPending({ next })
    else setSelection(next)
    return true
  }, [])
  useEffect(() => {
    if (!selection) updateGuard({ dirty: false, busy: false })
  }, [selection, updateGuard])
  useEffect(() => {
    const key = `${focusMemoryId}:${focusMemoryRequest}`
    if (!focusMemoryId || focusApplied.current === key || guard.busy) return
    const memory = data.memories.find((row) => row.id === focusMemoryId)
    if (!memory) return
    if (selection?.memory?.id === memory.id || select({ memory })) focusApplied.current = key
  }, [focusMemoryId, focusMemoryRequest, data.memories, guard.busy, selection, select])

  const recentThreshold = Date.now() - 7 * 86400000
  const recent = (memory: LocalMemory) => memory.createdAt >= recentThreshold && memory.status !== 'archived'
  const counts = {
    all: data.memories.length,
    recent: data.memories.filter(recent).length,
    archived: data.memories.filter((m) => m.status === 'archived').length,
  }
  const filtered = Boolean(query.trim() || type || status || pinned)
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return data.memories.filter((memory) => {
      if (section === 'recent' && (memory.createdAt < recentThreshold || memory.status === 'archived')) return false
      if (section === 'archived' && memory.status !== 'archived') return false
      if (type && memory.type !== type) return false
      if (status && memory.status !== status) return false
      if (pinned && !memory.pinned) return false
      return (
        !needle ||
        [
          memory.title,
          memory.content,
          memory.scope,
          memory.source,
          t(`personalMemory.sources.${memory.source}`),
          ...memory.tags,
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle)
      )
    })
  }, [data.memories, section, recentThreshold, query, type, status, pinned, t])
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(memoryError(reason))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (enabled: boolean) =>
    void perform(async () => {
      const latest = await window.api.getPersonalMemorySettings()
      await window.api.setPersonalMemorySettings({ ...latest, enabled })
    })
  const exportFile = (format: 'json' | 'markdown') =>
    void perform(async () => {
      const result = await window.api.exportPersonalMemories()
      const url = URL.createObjectURL(
        new Blob([result[format]], { type: format === 'json' ? 'application/json' : 'text/markdown' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `personal-memories.${format === 'json' ? 'json' : 'md'}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  const date = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' })
  const selectedMemory = selection?.memory
    ? (data.memories.find((row) => row.id === selection.memory?.id) ?? selection.memory)
    : undefined
  const missing = Boolean(selectedMemory && !data.memories.some((row) => row.id === selectedMemory.id))
  return (
    <div ref={panel} className="flex h-full min-w-0 flex-col bg-background" data-testid="personal-memory-panel">
      <header
        className={cn(
          'drag flex h-11 shrink-0 items-center gap-2 hairline-b pr-3',
          onShowSidebar ? 'pl-[var(--tt-offset)]' : 'pl-3'
        )}
      >
        {onShowSidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag size-7"
            onClick={onShowSidebar}
            aria-label={t('common.showWorkspaces')}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        <BrainCircuit className="size-4 shrink-0 text-primary" />
        <h1 className="min-w-0 truncate text-[13px] font-medium">{t('personalMemory.title')}</h1>
        <div className="no-drag ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            ref={settingsButton}
            aria-label={t('personalMemory.settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-3.5" />
            <span className="hidden sm:inline">{t('personalMemory.settings')}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            ref={moreButton}
            aria-label={t('personalMemory.more')}
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label={t('common.close')} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto @container">
        <main className="mx-auto max-w-[1120px] px-4 py-7 @min-[700px]:px-8">
          <div className="mb-7 flex items-start justify-between gap-5">
            <p className="text-xs text-muted-foreground">{t('personalMemory.description')}</p>
            <label className="flex shrink-0 items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                aria-label={t('personalMemory.enable')}
                checked={data.settings?.enabled ?? false}
                disabled={!data.settings || busy}
                onChange={(event) => toggle(event.target.checked)}
              />
              {data.settings
                ? t(data.settings.enabled ? 'personalMemory.enabled' : 'personalMemory.disabled')
                : t('common.loading')}
            </label>
          </div>
          {data.settings && !data.settings.enabled && (
            <p className="mb-4 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
              {t('personalMemory.disabledNotice')}
            </p>
          )}
          {(data.error || (error && !moreOpen)) && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-3 text-xs text-destructive"
            >
              {data.error || error}
              <Button size="sm" variant="outline" onClick={() => void data.reload()}>
                {t('personalMemory.retry')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
            <div role="tablist" aria-label={t('personalMemory.title')} className="flex gap-5">
              {SECTIONS.map((item, index) => (
                <button
                  key={item}
                  id={`personal-memory-tab-${item}`}
                  role="tab"
                  aria-selected={section === item}
                  aria-controls="personal-memory-collection"
                  tabIndex={section === item ? 0 : -1}
                  className={cn(
                    'border-b-2 pb-3 text-xs',
                    section === item ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
                  )}
                  onClick={() => setSection(item)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const next =
                      SECTIONS[
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? 2
                            : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
                      ]
                    setSection(next)
                    document.getElementById(`personal-memory-tab-${next}`)?.focus()
                  }}
                >
                  {t(`personalMemory.sections.${item}`)}
                  <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground">{counts[item]}</span>
                </button>
              ))}
            </div>
            <Button ref={newButton} size="sm" className="mb-2" onClick={() => select({})}>
              <Plus className="size-3.5" />
              {t('projectMemory.newMemory')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 py-4">
            <label className="flex min-w-40 flex-1 basis-full items-center gap-2 rounded-md border border-input px-2.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring @min-[700px]:basis-auto">
              <Search className="size-3.5" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t('personalMemory.search')}
                placeholder={t('personalMemory.search')}
                className="h-8 w-full min-w-0 bg-transparent text-xs text-foreground outline-none"
              />
            </label>
            <OptionSelect
              aria-label={t('personalMemory.type')}
              className="h-8 w-auto min-w-32 flex-1 text-xs @min-[700px]:flex-none"
              value={type}
              onValueChange={(value) => setType(value as MemoryType | '')}
            >
              <SelectOption value="">{t('projectMemory.allTypes')}</SelectOption>
              {MEMORY_TYPES.map((item) => (
                <SelectOption key={item} value={item}>
                  {t(`projectMemory.types.${item}`)}
                </SelectOption>
              ))}
            </OptionSelect>
            <OptionSelect
              aria-label={t('personalMemory.status')}
              className="h-8 w-auto min-w-32 flex-1 text-xs @min-[700px]:flex-none"
              value={status}
              onValueChange={(value) => setStatus(value as LocalMemoryStatus | '')}
            >
              <SelectOption value="">{t('projectMemory.allStatuses')}</SelectOption>
              {LOCAL_MEMORY_STATUSES.map((item) => (
                <SelectOption key={item} value={item}>
                  {t(`projectMemory.statuses.${item}`)}
                </SelectOption>
              ))}
            </OptionSelect>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={pinned}
              className={cn(pinned && 'border-primary/40 bg-primary/10')}
              onClick={() => setPinned((value) => !value)}
            >
              <Pin className="size-3" />
              {t('projectMemory.pinned')}
            </Button>
          </div>
          <section id="personal-memory-collection" role="tabpanel" aria-labelledby={`personal-memory-tab-${section}`}>
            {section !== 'all' && (
              <p className="mb-4 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
                {t(section === 'recent' ? 'personalMemory.recentHint' : 'personalMemory.archivedHint')}
              </p>
            )}
            {data.loading ? (
              <div className="flex justify-center py-16" role="status" aria-label={t('common.loading')}>
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : visible.length ? (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_80px] gap-3 border-b border-border px-3 py-2 text-[10px] text-muted-foreground @min-[700px]:grid-cols-[minmax(0,1fr)_110px_95px] @min-[700px]:gap-[18px]">
                  <span>{t('personalMemory.count', { count: visible.length })}</span>
                  <span>{t('personalMemory.status')}</span>
                  <span className="hidden text-right @min-[700px]:block">{t('personalMemory.updated')}</span>
                </div>
                {visible.map((memory) => (
                  <button
                    key={memory.id}
                    data-testid="personal-memory-row"
                    data-memory-id={memory.id}
                    aria-label={memory.title}
                    onClick={() => select({ memory })}
                    className="grid w-full grid-cols-[minmax(0,1fr)_80px] items-center gap-3 border-b border-border px-3 py-4 text-left transition-colors hover:bg-white/[0.035] focus-visible:bg-accent @min-[700px]:grid-cols-[minmax(0,1fr)_110px_95px] @min-[700px]:gap-[18px]"
                  >
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'flex items-center gap-1.5 text-[13px] font-medium',
                          memory.status !== 'active' && 'text-muted-foreground'
                        )}
                      >
                        {memory.pinned && <Pin aria-label={t('projectMemory.pinned')} className="size-3 shrink-0" />}
                        <span className="truncate">{memory.title}</span>
                      </span>
                      <span className="mt-1 block truncate text-xs leading-relaxed text-muted-foreground">
                        {memory.content}
                      </span>
                      <span className="mt-1.5 block truncate text-[10px] text-muted-foreground">
                        {[
                          t(`projectMemory.types.${memory.type}`),
                          t(`personalMemory.sources.${memory.source}`),
                          memory.tags.join(', '),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {memory.status === 'active' && <span className="size-[5px] rounded-full bg-status-ready" />}
                      {t(`projectMemory.statuses.${memory.status}`)}
                    </span>
                    <span className="hidden text-right text-[11px] text-muted-foreground @min-[700px]:block">
                      {date.format(memory.updatedAt)}
                    </span>
                  </button>
                ))}
              </>
            ) : filtered ? (
              <div className="py-16 text-center">
                <h2 className="text-sm font-medium">{t('projectMemory.empty')}</h2>
                <p className="mb-5 mt-2 text-xs text-muted-foreground">{t('personalMemory.emptyHint')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery('')
                    setType('')
                    setStatus('')
                    setPinned(false)
                  }}
                >
                  {t('personalMemory.clear')}
                </Button>
              </div>
            ) : (
              <div className="py-16 text-center">
                <h2 className="text-sm font-medium">{t(`personalMemory.emptySection.${section}`)}</h2>
                {section === 'all' && (
                  <>
                    <p className="mb-5 mt-2 text-xs text-muted-foreground">{t('personalMemory.emptyAllHint')}</p>
                    <Button size="sm" onClick={() => select({})}>
                      <Plus className="size-3.5" />
                      {t('projectMemory.newMemory')}
                    </Button>
                  </>
                )}
              </div>
            )}
          </section>
          <p className="mt-5 flex items-start justify-center gap-2 text-center text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3 shrink-0" />
            {t('projectMemory.pinnedHint')}
          </p>
        </main>
      </div>
      {selection && (
        <PersonalMemorySheet
          key={selection.memory?.id ?? 'new'}
          memory={selectedMemory}
          missing={missing}
          onGuardChange={updateGuard}
          onRestoreFocus={() => {
            const row = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-memory-id]') ?? []).find(
              (button) => button.dataset.memoryId === selectedMemory?.id
            )
            ;(row ?? newButton.current)?.focus()
          }}
          onClose={() => select(null)}
          onChanged={() => void data.reload()}
          onSaved={(memory) => {
            data.accept(memory)
            setSelection({ memory })
          }}
          onDeleted={() => {
            setSelection(null)
            void data.reload()
            newButton.current?.focus()
          }}
        />
      )}
      {pending && (
        <MemoryConfirmation
          kind="discard"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            updateGuard({ dirty: false, busy: false })
            setSelection(pending.next)
            setPending(null)
          }}
        />
      )}
      {settingsOpen && (
        <PersonalMemorySettingsDialog
          onClose={() => setSettingsOpen(false)}
          onRestoreFocus={() => settingsButton.current?.focus()}
        />
      )}
      <Dialog open={moreOpen} onOpenChange={(open) => !busy && setMoreOpen(open)}>
        <DialogContent
          showClose={false}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            moreButton.current?.focus()
          }}
          className="max-w-[min(540px,calc(100vw-24px))] gap-0 rounded-xl p-0"
        >
          <div className="flex items-center justify-between px-5 py-4 hairline-b">
            <DialogTitle className="text-[13px] font-medium">{t('personalMemory.more')}</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={busy}
              aria-label={t('common.close')}
              onClick={() => setMoreOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="p-6">
            <div className="mb-5 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => exportFile('json')}>
                <Download className="size-3.5" />
                {t('personalMemory.exportJson')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => exportFile('markdown')}>
                <Download className="size-3.5" />
                {t('personalMemory.exportMarkdown')}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-4">
              <div>
                <h3 className="text-xs font-medium">{t('personalMemory.index')}</h3>
                <p role="status" className="mt-1 text-[11px] text-muted-foreground">
                  {data.index
                    ? `${t(`projectMemory.index.${data.index.state}`)} · ${t('personalMemory.count', { count: data.index.documents })}`
                    : t('common.loading')}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || data.index?.state === 'indexing'}
                onClick={() =>
                  void perform(async () => {
                    await window.api.rebuildPersonalMemoryIndex()
                    await data.reload()
                  })
                }
              >
                <RefreshCw className={cn('size-3.5', data.index?.state === 'indexing' && 'animate-spin')} />
                {t('personalMemory.rebuild')}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('personalMemory.indexHint')}</p>
            {error && (
              <p role="alert" className="mt-4 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end px-5 py-3.5 hairline-t">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMoreOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
