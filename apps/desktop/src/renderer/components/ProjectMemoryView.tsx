import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  BrainCircuit,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  PanelLeft,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import { cn } from '@/lib/utils'
import type {
  LocalMemory,
  LocalMemoryStatus,
  MemoryIndexStatus,
  MemoryType,
  SharedKnowledgeDocument,
} from '../../shared/memory'

type Section = 'all' | 'local' | 'shared' | 'recent' | 'archived'
type Selected = { kind: 'local' | 'shared'; id: string } | null

interface Props {
  workspaceId: string
  workspaceName: string
  onShowSidebar?: () => void
  onClose: () => void
}

const MEMORY_TYPE_OPTIONS: MemoryType[] = ['decision', 'constraint', 'preference', 'procedure', 'lesson', 'reference']

function relativeTime(timestamp: number, locale: string): string {
  const delta = timestamp - Date.now()
  const minutes = Math.round(delta / 60_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function ProjectMemoryView({ workspaceId, workspaceName, onShowSidebar, onClose }: Props) {
  const { t, i18n } = useTranslation('ui')
  const [enabled, setEnabled] = useState(true)
  const [section, setSection] = useState<Section>('all')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<MemoryType | ''>('')
  const [statusFilter, setStatusFilter] = useState<LocalMemoryStatus | ''>('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [local, setLocal] = useState<LocalMemory[]>([])
  const [shared, setShared] = useState<SharedKnowledgeDocument[]>([])
  const [sharedWarnings, setSharedWarnings] = useState<string[]>([])
  const [selected, setSelected] = useState<Selected>(null)
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [backups, setBackups] = useState<Array<{ path: string; hash: string; status: string }>>([])

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [isEnabled, localRows, sharedResult, indexStatus, legacyBackups] = await Promise.all([
        window.api.getMemoryEnabled(workspaceId),
        window.api.listMemories(workspaceId, { limit: 500 }),
        window.api.listSharedMemories(workspaceId),
        window.api.getMemoryIndexStatus(workspaceId),
        window.api.listLegacyMemoryBackups(workspaceId),
      ])
      setEnabled(isEnabled)
      setLocal(localRows as LocalMemory[])
      setShared((sharedResult as { documents: SharedKnowledgeDocument[] }).documents)
      setSharedWarnings((sharedResult as { warnings: string[] }).warnings)
      setStatus(indexStatus)
      setBackups(legacyBackups)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => void reload(), [reload])
  useEffect(
    () =>
      window.api.onMemoryChanged((event) => {
        if (event.workspaceId === workspaceId) void reload()
      }),
    [reload, workspaceId]
  )
  useEffect(
    () =>
      window.api.onMemoryIndexStatus((next) => {
        if (next.workspaceId === workspaceId) setStatus(next)
      }),
    [workspaceId]
  )

  const localVisible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const recentThreshold = Date.now() - 7 * 24 * 60 * 60 * 1_000
    return local.filter((memory) => {
      if (section === 'shared') return false
      if (section === 'archived' && memory.status !== 'archived') return false
      if (section !== 'archived' && section !== 'all' && memory.status === 'archived') return false
      if (section === 'recent' && memory.createdAt < recentThreshold) return false
      if (typeFilter && memory.type !== typeFilter) return false
      if (statusFilter && memory.status !== statusFilter) return false
      if (pinnedOnly && !memory.pinned) return false
      if (!needle) return true
      return [memory.title, memory.content, memory.scope, memory.source, ...memory.tags]
        .join('\n')
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [local, pinnedOnly, query, section, statusFilter, typeFilter])

  const sharedVisible = useMemo(() => {
    if (section === 'local' || section === 'archived' || section === 'recent' || pinnedOnly) return []
    const needle = query.trim().toLocaleLowerCase()
    return shared.filter((memory) => {
      if (typeFilter && memory.type !== typeFilter) return false
      if (statusFilter && memory.status !== statusFilter) return false
      if (!needle) return true
      return [memory.title, memory.content, memory.scope, memory.relativePath, ...memory.tags]
        .join('\n')
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [pinnedOnly, query, section, shared, statusFilter, typeFilter])

  const selectedLocal = selected?.kind === 'local' ? local.find((memory) => memory.id === selected.id) : undefined
  const selectedShared = selected?.kind === 'shared' ? shared.find((memory) => memory.id === selected.id) : undefined

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    window.api.setMemoryEnabled(workspaceId, next)
  }

  const exportData = async () => {
    const data = (await window.api.exportMemories(workspaceId)) as { json: string; markdown: string }
    downloadText(`${workspaceName}-memories.json`, data.json, 'application/json')
    downloadText(`${workspaceName}-memories.md`, data.markdown, 'text/markdown')
  }

  const rebuild = async () => {
    setStatus((current) => (current ? { ...current, state: 'indexing' } : current))
    await window.api.rebuildMemoryIndex(workspaceId)
    await reload()
  }

  const sections: Array<{ id: Section; label: string }> = [
    { id: 'all', label: t('projectMemory.sections.all') },
    { id: 'local', label: t('projectMemory.sections.local') },
    { id: 'shared', label: t('projectMemory.sections.shared') },
    { id: 'recent', label: t('projectMemory.sections.recent') },
    { id: 'archived', label: t('projectMemory.sections.archived') },
  ]

  return (
    <div className="flex h-full flex-col bg-background">
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
            title={t('common.showWorkspaces')}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        <BrainCircuit className="size-4 text-primary" />
        <span className="truncate text-[13px] font-medium">
          {t('projectMemory.centerTitle', { name: workspaceName })}
        </span>
        <button
          onClick={toggle}
          className={cn(
            'no-drag ml-2 rounded-full px-2 py-1 text-[11px] font-medium ring-1',
            enabled
              ? 'bg-status-ready/15 text-status-ready ring-status-ready/30'
              : 'bg-white/[0.04] text-muted-foreground ring-white/[0.1]'
          )}
        >
          {enabled ? t('projectMemory.enabled') : t('projectMemory.disabled')}
        </button>
        <span className="no-drag hidden text-[10px] text-muted-foreground md:inline">
          {status ? t(`projectMemory.index.${status.state}`) : t('projectMemory.index.indexing')}
          {status ? ` · ${status.documents} ${t('projectMemory.documents')} / ${status.chunks} chunks` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag ml-auto size-7"
          onClick={exportData}
          title={t('projectMemory.export')}
        >
          <Download className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag size-7"
          onClick={rebuild}
          title={t('projectMemory.rebuild')}
        >
          <RefreshCw className={cn('size-3.5', status?.state === 'indexing' && 'animate-spin')} />
        </Button>
        <Button variant="ghost" size="icon" className="no-drag size-7" onClick={onClose} title={t('common.close')}>
          <X className="size-4" />
        </Button>
      </header>

      {!enabled && (
        <div className="hairline-b bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100/90">
          {t('projectMemory.disabledNotice')}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-44 shrink-0 flex-col gap-1 hairline-r p-2">
          {sections.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={cn(
                'rounded px-2 py-1.5 text-left text-xs',
                section === item.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/[0.04]'
              )}
            >
              {item.label}
            </button>
          ))}
          <Button
            size="sm"
            className="mt-2 h-8 justify-start gap-1.5"
            onClick={() => {
              setCreating(true)
              setSelected(null)
            }}
          >
            <Plus className="size-3.5" /> {t('projectMemory.newMemory')}
          </Button>
          {backups.length > 0 && (
            <div className="mt-auto rounded border border-white/[0.08] p-2 text-[10px] text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/80">{t('projectMemory.legacyBackup')}</div>
              {backups.map((backup) => (
                <div key={backup.hash} className="flex items-center gap-1">
                  <FileText className="size-3" />
                  <span className="truncate">{backup.hash.slice(0, 8)}</span>
                  <button
                    className="ml-auto hover:text-destructive"
                    onClick={async () => {
                      if (!window.confirm(t('projectMemory.removeBackupConfirm'))) return
                      await window.api.removeLegacyMemoryBackup(workspaceId, backup.path, true)
                      await reload()
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 hairline-b p-2">
            <label className="flex min-w-52 flex-1 items-center gap-1.5 rounded border border-white/[0.08] bg-black/10 px-2">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('projectMemory.search')}
                className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
              />
            </label>
            <OptionSelect
              value={typeFilter}
              onValueChange={(selectedValue) => setTypeFilter(selectedValue as MemoryType | '')}
              className="h-8 text-xs w-auto"
            >
              <SelectOption value="">{t('projectMemory.allTypes')}</SelectOption>
              {MEMORY_TYPE_OPTIONS.map((type) => (
                <SelectOption key={type} value={type}>
                  {t(`projectMemory.types.${type}`)}
                </SelectOption>
              ))}
            </OptionSelect>
            <OptionSelect
              value={statusFilter}
              onValueChange={(selectedValue) => setStatusFilter(selectedValue as LocalMemoryStatus | '')}
              className="h-8 text-xs w-auto"
            >
              <SelectOption value="">{t('projectMemory.allStatuses')}</SelectOption>
              {(['active', 'superseded', 'archived'] as const).map((item) => (
                <SelectOption key={item} value={item}>
                  {t(`projectMemory.statuses.${item}`)}
                </SelectOption>
              ))}
            </OptionSelect>
            <button
              onClick={() => setPinnedOnly((value) => !value)}
              className={cn(
                'flex h-8 items-center gap-1 rounded border px-2 text-xs',
                pinnedOnly
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-white/[0.08] text-muted-foreground'
              )}
            >
              <Pin className="size-3" /> {t('projectMemory.pinned')}
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="w-[42%] min-w-64 overflow-y-auto hairline-r p-2">
              {loading ? (
                <div className="flex h-32 items-center justify-center">
                  <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
              ) : localVisible.length + sharedVisible.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">{t('projectMemory.empty')}</div>
              ) : (
                <div className="space-y-1.5">
                  {localVisible.map((memory) => (
                    <MemoryRow
                      key={`local:${memory.id}`}
                      active={selected?.kind === 'local' && selected.id === memory.id}
                      title={memory.title}
                      snippet={memory.content}
                      badge={t('projectMemory.local')}
                      metadata={`${t(`projectMemory.types.${memory.type}`)} · ${t(`projectMemory.statuses.${memory.status}`)} · ${relativeTime(memory.updatedAt, i18n.language)}`}
                      pinned={memory.pinned}
                      warning={Boolean(memory.promotedPath)}
                      onClick={() => {
                        setCreating(false)
                        setSelected({ kind: 'local', id: memory.id })
                      }}
                    />
                  ))}
                  {sharedVisible.map((memory) => (
                    <MemoryRow
                      key={`shared:${memory.id}`}
                      active={selected?.kind === 'shared' && selected.id === memory.id}
                      title={memory.title}
                      snippet={memory.content}
                      badge={t('projectMemory.shared')}
                      metadata={`${memory.type} · ${memory.status} · ${memory.relativePath}`}
                      warning={memory.warnings.length > 0}
                      onClick={() => {
                        setCreating(false)
                        setSelected({ kind: 'shared', id: memory.id })
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {creating ? (
                <LocalMemoryEditor
                  workspaceId={workspaceId}
                  onSaved={async (memory) => {
                    setCreating(false)
                    setSelected({ kind: 'local', id: memory.id })
                    await reload()
                  }}
                />
              ) : selectedLocal ? (
                <LocalMemoryEditor
                  workspaceId={workspaceId}
                  memory={selectedLocal}
                  onSaved={reload}
                  onDeleted={async () => {
                    setSelected(null)
                    await reload()
                  }}
                />
              ) : selectedShared ? (
                <SharedMemoryDetail workspaceId={workspaceId} memory={selectedShared} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t('projectMemory.selectOne')}
                </div>
              )}
              {sharedWarnings.length > 0 && !selectedShared && (
                <div className="mt-4 rounded border border-amber-500/20 bg-amber-500/[0.06] p-2 text-xs text-amber-100/80">
                  {sharedWarnings.join('\n')}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function MemoryRow(props: {
  active: boolean
  title: string
  snippet: string
  badge: string
  metadata: string
  pinned?: boolean
  warning?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={props.onClick}
      className={cn(
        'w-full rounded-lg border p-2 text-left transition-colors',
        props.active
          ? 'border-primary/35 bg-primary/[0.08]'
          : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
      )}
    >
      <div className="flex items-center gap-1.5">
        {props.pinned && <Pin className="size-3 fill-current text-primary" />}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-muted-foreground">{props.badge}</span>
        {props.warning && <span className="size-1.5 rounded-full bg-amber-400" />}
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{props.snippet}</p>
      <div className="mt-1.5 truncate text-[9px] text-muted-foreground/70">{props.metadata}</div>
    </button>
  )
}

function LocalMemoryEditor({
  workspaceId,
  memory,
  onSaved,
  onDeleted,
}: {
  workspaceId: string
  memory?: LocalMemory
  onSaved: (memory: LocalMemory) => void | Promise<void>
  onDeleted?: () => void | Promise<void>
}) {
  const { t } = useTranslation('ui')
  const [title, setTitle] = useState(memory?.title ?? '')
  const [content, setContent] = useState(memory?.content ?? '')
  const [type, setType] = useState<MemoryType>(memory?.type ?? 'reference')
  const [scope, setScope] = useState(memory?.scope ?? '')
  const [tags, setTags] = useState(memory?.tags.join(', ') ?? '')
  const [pinned, setPinned] = useState(memory?.pinned ?? false)
  const [saving, setSaving] = useState(false)
  const [promotion, setPromotion] = useState<{ relativePath: string; markdown: string } | null>(null)

  useEffect(() => {
    setTitle(memory?.title ?? '')
    setContent(memory?.content ?? '')
    setType(memory?.type ?? 'reference')
    setScope(memory?.scope ?? '')
    setTags(memory?.tags.join(', ') ?? '')
    setPinned(memory?.pinned ?? false)
    setPromotion(null)
  }, [memory])

  const save = async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    try {
      const tagList = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
      const result = memory
        ? await window.api.updateMemory(workspaceId, memory.id, { title, content, type, scope, tags: tagList, pinned })
        : await window.api.createMemory({
            workspaceId,
            title,
            content,
            type,
            scope,
            tags: tagList,
            pinned,
            source: 'user',
          })
      await onSaved((result as { memory: LocalMemory }).memory)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{memory ? memory.title : t('projectMemory.newMemory')}</h2>
        {memory?.originConversationId && (
          <span className="text-[10px] text-muted-foreground">{t('projectMemory.fromConversation')}</span>
        )}
        <button
          onClick={() => setPinned((value) => !value)}
          className={cn('ml-auto rounded p-1.5', pinned ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}
          title={t('projectMemory.pinned')}
        >
          <Pin className="size-4" />
        </button>
      </div>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t('projectMemory.fields.title')}
        className="h-9 w-full rounded border border-white/[0.1] bg-black/10 px-3 text-sm outline-none focus:border-primary/40"
      />
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={t('projectMemory.fields.content')}
        rows={12}
        className="w-full resize-y rounded border border-white/[0.1] bg-black/10 p-3 text-xs leading-relaxed outline-none focus:border-primary/40"
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <OptionSelect
          value={type}
          onValueChange={(selectedValue) => setType(selectedValue as MemoryType)}
          className="h-9 text-xs"
        >
          {MEMORY_TYPE_OPTIONS.map((item) => (
            <SelectOption key={item} value={item}>
              {t(`projectMemory.types.${item}`)}
            </SelectOption>
          ))}
        </OptionSelect>
        <input
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          placeholder={t('projectMemory.fields.scope')}
          className="h-9 rounded border border-white/[0.1] bg-black/10 px-2 text-xs outline-none"
        />
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t('projectMemory.fields.tags')}
          className="h-9 rounded border border-white/[0.1] bg-black/10 px-2 text-xs outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={saving || !title.trim() || !content.trim()}>
          {saving ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
          {t('common.save')}
        </Button>
        {memory && memory.status !== 'archived' && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await window.api.archiveMemory(workspaceId, memory.id)
              await onSaved(memory)
            }}
          >
            <Archive className="mr-1 size-3.5" />
            {t('projectMemory.archive')}
          </Button>
        )}
        {memory?.status === 'archived' && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await window.api.restoreMemory(workspaceId, memory.id)
              await onSaved(memory)
            }}
          >
            {t('projectMemory.restore')}
          </Button>
        )}
        {memory && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () =>
              setPromotion(await window.api.previewMemoryPromotion({ workspaceId, memoryId: memory.id }))
            }
          >
            <Share2 className="mr-1 size-3.5" />
            {t('projectMemory.promote')}
          </Button>
        )}
        {memory && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={async () => {
              if (!window.confirm(t('projectMemory.forgetConfirm'))) return
              await window.api.forgetMemory(workspaceId, memory.id, true)
              await onDeleted?.()
            }}
          >
            <Trash2 className="mr-1 size-3.5" />
            {t('projectMemory.forget')}
          </Button>
        )}
      </div>
      {memory?.promotedPath && (
        <div className="rounded bg-emerald-500/[0.08] p-2 text-xs text-emerald-200">
          {t('projectMemory.promotedAt', { path: memory.promotedPath })}
        </div>
      )}
      {promotion && memory && (
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
          <div className="mb-2 text-xs font-medium">
            {t('projectMemory.promotionPreview')} · {promotion.relativePath}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px]">
            {promotion.markdown}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                const result = await window.api.promoteMemory({ workspaceId, memoryId: memory.id })
                setPromotion(null)
                if (result.gitIgnored) window.alert(t('projectMemory.gitIgnoredWarning'))
                await onSaved(memory)
              }}
            >
              {t('projectMemory.createShared')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPromotion(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SharedMemoryDetail({ workspaceId, memory }: { workspaceId: string; memory: SharedKnowledgeDocument }) {
  const { t } = useTranslation('ui')
  return (
    <article className="mx-auto max-w-3xl">
      <div className="flex items-start gap-2 hairline-b pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{memory.title}</h2>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {memory.relativePath} · {memory.type} · {memory.status}
          </div>
          {memory.scope && <div className="mt-1 text-[10px] text-muted-foreground">scope: {memory.scope}</div>}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.api.openSharedMemory(workspaceId, memory.relativePath)}
        >
          <ExternalLink className="mr-1 size-3.5" />
          {t('projectMemory.openSource')}
        </Button>
      </div>
      {memory.warnings.length > 0 && (
        <div className="my-3 rounded bg-amber-500/[0.08] p-2 text-xs text-amber-100">{memory.warnings.join('\n')}</div>
      )}
      <div className="prose prose-invert mt-4 max-w-none text-sm">
        <MarkdownViewer markdown={memory.content} />
      </div>
    </article>
  )
}
