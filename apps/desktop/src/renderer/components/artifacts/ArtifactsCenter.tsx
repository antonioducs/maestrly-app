import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, AppWindow, Check, HardDrive, Info, PanelLeft, Search, X } from 'lucide-react'
import type { ArtifactListItem } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ArtifactDetailSheet } from './ArtifactDetailSheet'
import { ArtifactGridCard } from './ArtifactGridCard'
import { EmptyState, LoadingGrid, NoMatchState, type SuggestionKey, UnavailableState } from './ArtifactsStates'
import {
  ALL_PROJECTS,
  ARTIFACT_SORTS,
  type Arrival,
  type ArtifactSort,
  arrivals,
  centerBody,
  nearQuota,
  type ProjectFilter,
  type ProjectOption,
  projectOptions,
  showToolbar,
  visibleArtifacts,
} from './artifacts-view'
import { HostStatusChip } from './HostStatusChip'
import { PortDialog } from './PortDialog'
import { ShareDialog } from './ShareDialog'
import { useArtifacts } from './use-artifacts'

/** How long a new artifact or version stays marked as new. */
const ARRIVAL_MS = 9_000

function openConversation(conversationId: string): void {
  window.dispatchEvent(new CustomEvent('maestrly:open-conversation', { detail: { conversationId } }))
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

interface Notice {
  id: number
  tone: 'ok' | 'bad' | 'info'
  text: string
  action?: { label: string; run: () => void }
}

/** Short confirmations of what just happened in the center, announced to assistive technology. */
function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([])
  const sequence = useRef(0)
  const dismiss = useCallback((id: number) => setNotices((list) => list.filter((notice) => notice.id !== id)), [])
  const push = useCallback(
    (notice: Omit<Notice, 'id'>) => {
      const id = ++sequence.current
      setNotices((list) => [...list.slice(-2), { ...notice, id }])
      setTimeout(() => dismiss(id), notice.action ? 6_500 : 4_200)
    },
    [dismiss]
  )
  return { notices, push, dismiss }
}

function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-6 left-1/2 z-40 grid -translate-x-1/2 justify-items-center gap-2"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          data-testid="artifacts-notice"
          className="pointer-events-auto flex min-w-[260px] max-w-[440px] items-center gap-2.5 rounded-[10px] border border-border-strong bg-[#34353a] px-3 py-2 text-[12.5px] text-foreground shadow-2xl animate-in fade-in-0 slide-in-from-bottom-1"
        >
          {notice.tone === 'bad' ? (
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          ) : notice.tone === 'info' ? (
            <Info className="size-3.5 shrink-0 text-foreground/75" aria-hidden="true" />
          ) : (
            <Check className="size-3.5 shrink-0 text-status-ready" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-white/[0.08]"
              onClick={() => {
                onDismiss(notice.id)
                notice.action?.run()
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Every artifact on this computer: where it came from, its versions, and the owner's actions. */
export function ArtifactsCenter({
  onClose,
  onShowSidebar,
  onOpenSettings,
}: {
  onClose: () => void
  onShowSidebar?: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const { items, status, loading, listed, error, refresh } = useArtifacts()
  const { notices, push, dismiss } = useNotices()
  const [query, setQuery] = useState('')
  const [project, setProject] = useState<ProjectFilter>(ALL_PROJECTS)
  const [sort, setSort] = useState<ArtifactSort>('updated')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set())
  const [confirm, setConfirm] = useState<ArtifactListItem | null>(null)
  const [shareId, setShareId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [hostBusy, setHostBusy] = useState(false)
  const [portDialog, setPortDialog] = useState(false)
  const [pendingSuggestion, setPendingSuggestion] = useState<SuggestionKey | null>(null)
  const [arrived, setArrived] = useState<ReadonlyMap<string, Arrival>>(new Map())
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const previousItems = useRef<ArtifactListItem[] | null>(null)
  const shown = useRef<ReadonlySet<string>>(new Set())

  const options = useMemo(() => projectOptions(items, locale), [items, locale])
  const visible = useMemo(
    () => visibleArtifacts(items, { query, project, sort, locale }),
    [items, query, project, sort, locale]
  )
  const body = centerBody({ loading, status, listed, total: items.length, visible: visible.length })
  const toolbar = body.kind !== 'loading' && body.kind !== 'unavailable' && showToolbar(items.length, query, project)
  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined
  const sharing = shareId ? items.find((item) => item.id === shareId) : undefined

  // A filter for a project that no longer has artifacts falls back to all of them.
  useEffect(() => {
    if (project !== ALL_PROJECTS && !options.some((option) => option.value === project)) setProject(ALL_PROJECTS)
  }, [options, project])

  // Artifacts and versions that appear while the center is open are marked for a moment.
  useEffect(() => {
    if (!listed) return
    const previous = previousItems.current
    previousItems.current = items
    if (!previous) return
    const found = arrivals(previous, items)
    if (!found.size) return
    setArrived((current) => new Map([...current, ...found]))
    setTimeout(
      () =>
        setArrived((current) => {
          const next = new Map(current)
          for (const id of found.keys()) next.delete(id)
          return next
        }),
      ARRIVAL_MS
    )
  }, [items, listed])

  // Only cards that were not on screen animate in: typing in the search does not replay the grid.
  const entering = new Set(visible.filter((item) => !shown.current.has(item.id)).map((item) => item.id))
  useEffect(() => {
    shown.current = new Set(body.kind === 'grid' ? visible.map((item) => item.id) : [])
  })

  useEffect(() => {
    if (!toolbar) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toolbar])

  const projectLabel = useCallback(
    (option: Pick<ProjectOption, 'kind' | 'name'>) =>
      option.kind === 'all'
        ? t('artifacts.filter.allProjects')
        : option.kind === 'standalone'
          ? t('artifacts.filter.standalone')
          : (option.name ?? t('artifacts.filter.removedProject')),
    [t]
  )
  const itemProject = (item: ArtifactListItem) =>
    item.project ? (item.project.name ?? t('artifacts.filter.removedProject')) : t('artifacts.card.standalone')

  const isOpening = (id: string, version?: number) => opening.has(`${id}:${version ?? 'current'}`)
  const open = async (item: ArtifactListItem, version?: number) => {
    const key = `${item.id}:${version ?? 'current'}`
    if (opening.has(key)) return
    setOpening((current) => new Set(current).add(key))
    try {
      await window.api.artifacts.openExternal(item.id, version)
      push({
        tone: 'ok',
        text:
          version && version !== item.currentVersion
            ? t('artifacts.notice.openedVersion', { title: item.title, version })
            : t('artifacts.notice.opened', { title: item.title }),
      })
    } catch (reason) {
      push({
        tone: 'bad',
        text: t('artifacts.notice.openFailed', { title: item.title, message: message(reason) }),
        action: { label: t('artifacts.unavailable.retry'), run: () => void open(item, version) },
      })
    } finally {
      setOpening((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const select = (id: string) => {
    setSelectedId((current) => (current === id ? null : id))
    setArrived((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }
  const closeSheet = () => {
    const id = selectedId
    setSelectedId(null)
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-artifact-id="${id}"] [data-testid="artifact-card-select"]`)?.focus()
    )
  }

  const askDelete = (item: ArtifactListItem) => {
    setDeleteError(null)
    setConfirm(item)
  }
  const remove = async (item: ArtifactListItem) => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await window.api.artifacts.remove(item.id)
      setConfirm(null)
      if (selectedId === item.id) setSelectedId(null)
      push({
        tone: 'ok',
        text:
          result.freedBytes > 0
            ? t('artifacts.notice.deletedFreed', { title: item.title, size: formatBytes(result.freedBytes) })
            : t('artifacts.notice.deleted', { title: item.title }),
      })
      await refresh()
      requestAnimationFrame(() =>
        (
          document.querySelector<HTMLElement>('[data-testid="artifact-card-select"]') ??
          document.querySelector<HTMLElement>('[data-testid="artifact-suggestion"]')
        )?.focus()
      )
    } catch (reason) {
      setDeleteError(t('artifacts.delete.failed', { message: message(reason) }))
    } finally {
      setDeleting(false)
    }
  }

  const runHost = async (action: () => Promise<unknown>, done?: () => void) => {
    setHostBusy(true)
    try {
      await action()
      await refresh()
      done?.()
    } catch (reason) {
      push({ tone: 'bad', text: t('artifacts.error', { message: message(reason) }) })
    } finally {
      setHostBusy(false)
    }
  }
  const enableHosting = () =>
    runHost(async () => {
      const settings = await window.api.artifacts.getSettings()
      await window.api.artifacts.setSettings({ ...settings, hostEnabled: true })
    })
  const retryHost = () =>
    runHost(async () => {
      const next = await window.api.artifacts.start()
      if (next.problem === 'port_in_use')
        push({ tone: 'info', text: t('artifacts.notice.stillBusy', { port: next.port }) })
    })
  const savePort = async (port: number) => {
    const settings = await window.api.artifacts.getSettings()
    await window.api.artifacts.setSettings({ ...settings, port })
    setPortDialog(false)
    await refresh()
    const next = await window.api.artifacts.status()
    if (next.state === 'running') push({ tone: 'ok', text: t('artifacts.notice.hostRunning', { port: next.port }) })
  }

  const suggest = (key: SuggestionKey) => {
    setPendingSuggestion(key)
    // The app creates the conversation with Maestrly tools on, puts the request in its composer, and opens it.
    window.dispatchEvent(
      new CustomEvent('maestrly:new-chat-with-prompt', {
        detail: {
          prompt: t(`artifacts.empty.suggestions.${key}.prompt`),
          appTools: true,
          settle: () => setPendingSuggestion(null),
        },
      })
    )
  }

  const showLargest = () => {
    setSort('size')
    setProject(ALL_PROJECTS)
    setQuery('')
    scrollRef.current?.scrollTo({ top: 0 })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="artifact-card-select"]')?.focus())
  }
  const clearFilters = () => {
    setQuery('')
    setProject(ALL_PROJECTS)
    searchRef.current?.focus()
  }

  const trimmed = query.trim()
  const currentProject = options.find((option) => option.value === project)
  const noMatchTitle = trimmed
    ? project !== ALL_PROJECTS && currentProject
      ? t('artifacts.noMatch.queryIn', { query: trimmed, project: projectLabel(currentProject) })
      : t('artifacts.noMatch.query', { query: trimmed })
    : t('artifacts.noMatch.project', { project: currentProject ? projectLabel(currentProject) : '' })

  return (
    <div className="relative flex h-full flex-col" data-testid="artifacts-center">
      <header
        className={cn(
          'drag flex h-10 shrink-0 items-center gap-2 hairline-b pr-3',
          onShowSidebar ? 'pl-[var(--tt-offset)]' : 'pl-3'
        )}
      >
        {onShowSidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag size-7 text-muted-foreground"
            onClick={onShowSidebar}
            title={t('common.showWorkspaces')}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        <AppWindow className="size-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground/90">{t('artifacts.title')}</span>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag ml-auto size-7"
          onClick={onClose}
          title={t('common.close')}
        >
          <X className="size-4" />
        </Button>
      </header>
      <section ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-[1080px] px-8 pb-16 pt-7">
          <header className="mb-[22px] flex items-start justify-between gap-6 max-sm:flex-col max-sm:gap-3">
            <div className="min-w-0">
              <h1 className="mb-1.5 text-2xl font-semibold tracking-tight text-foreground">{t('artifacts.title')}</h1>
              <p className="max-w-[58ch] text-[13.5px] text-muted-foreground">{t('artifacts.description')}</p>
            </div>
            {status && <HostStatusChip status={status} onOpenSettings={onOpenSettings} />}
          </header>

          {body.kind === 'grid' || body.kind === 'no-match'
            ? nearQuota(status) && (
                <div
                  role="status"
                  data-testid="artifacts-quota"
                  className="mb-[18px] flex flex-wrap items-start gap-3 rounded-[10px] border border-artifact-warn/30 bg-artifact-warn/[0.08] px-3.5 py-3"
                >
                  <HardDrive className="mt-px size-4 shrink-0 text-artifact-warn" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <b className="block font-semibold text-foreground">{t('artifacts.quota.title')}</b>
                    <span className="text-[12.5px] text-foreground/75">
                      {t('artifacts.quota.text', {
                        used: formatBytes(status?.storageBytes ?? 0),
                        total: formatBytes(status?.quotaBytes ?? 0),
                      })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={showLargest}>
                      {t('artifacts.quota.largest')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onOpenSettings}>
                      {t('artifacts.quota.raise')}
                    </Button>
                  </div>
                </div>
              )
            : null}

          {toolbar && (
            <div className="mb-5 flex flex-wrap items-center gap-2" data-testid="artifacts-toolbar">
              <label className="flex h-8 min-w-[220px] flex-[1_1_260px] items-center gap-2 rounded-md border border-border-strong bg-black/[0.18] pl-2.5 pr-2 text-muted-foreground focus-within:border-ring">
                <Search className="size-4 shrink-0" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      event.stopPropagation()
                      setQuery('')
                    }
                  }}
                  placeholder={t('artifacts.search')}
                  aria-label={t('artifacts.searchLabel')}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                />
                <kbd
                  className="rounded border border-border-strong px-1.5 font-mono text-[10.5px] leading-4"
                  aria-hidden="true"
                >
                  /
                </kbd>
              </label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger
                  className="h-8 w-auto max-w-[240px] border-border-strong bg-black/[0.18] text-[12.5px]"
                  aria-label={t('artifacts.filter.project')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="backdrop-blur-xl">
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {projectLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(value) => setSort(value as ArtifactSort)}>
                <SelectTrigger
                  className="h-8 w-auto border-border-strong bg-black/[0.18] text-[12.5px]"
                  aria-label={t('artifacts.filter.sort')}
                >
                  <span className="text-muted-foreground">{t('artifacts.filter.sortPrefix')}</span>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" className="backdrop-blur-xl">
                  {ARTIFACT_SORTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`artifacts.filter.sorts.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground max-sm:ml-0 max-sm:w-full" aria-live="polite">
                {visible.length === items.length
                  ? t('artifacts.count', { count: items.length })
                  : t('artifacts.countFiltered', {
                      shown: visible.length,
                      total: t('artifacts.count', { count: items.length }),
                    })}
              </span>
            </div>
          )}

          {error && status?.state === 'running' && (
            <p role="alert" className="mb-4 text-xs text-destructive">
              {t('artifacts.error', { message: error })}
            </p>
          )}

          {body.kind === 'loading' && <LoadingGrid />}
          {body.kind === 'unavailable' && (
            <UnavailableState
              reason={body.reason}
              port={status?.port ?? 0}
              busy={hostBusy}
              onEnable={() => void enableHosting()}
              onRetry={() => void retryHost()}
              onChangePort={() => setPortDialog(true)}
              onOpenSettings={onOpenSettings}
            />
          )}
          {body.kind === 'empty' && <EmptyState pending={pendingSuggestion} onSuggest={suggest} />}
          {body.kind === 'no-match' && <NoMatchState title={noMatchTitle} onClear={clearFilters} />}
          {body.kind === 'grid' && (
            <ul className="artifact-grid" aria-label={t('artifacts.title')} data-testid="artifacts-grid">
              {visible.map((item) => (
                <ArtifactGridCard
                  key={item.id}
                  item={item}
                  projectLabel={project === ALL_PROJECTS ? itemProject(item) : null}
                  showSize={sort === 'size'}
                  arrival={arrived.get(item.id)}
                  entering={entering.has(item.id)}
                  selected={selectedId === item.id}
                  opening={isOpening(item.id)}
                  onSelect={() => select(item.id)}
                  onOpen={() => void open(item)}
                  onShare={() => setShareId(item.id)}
                  onDelete={() => askDelete(item)}
                  onGoToConversation={() => item.conversation && openConversation(item.conversation.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {selected && body.kind === 'grid' && (
        <ArtifactDetailSheet
          item={selected}
          projectName={itemProject(selected)}
          isOpening={(version) => isOpening(selected.id, version)}
          onOpen={(version) => void open(selected, version)}
          onGoToConversation={() => selected.conversation && openConversation(selected.conversation.id)}
          onShare={() => setShareId(selected.id)}
          onDelete={() => askDelete(selected)}
          onClose={closeSheet}
          onError={(text) => push({ tone: 'bad', text: t('artifacts.error', { message: text }) })}
          onNotice={(text) => push({ tone: 'ok', text })}
        />
      )}

      {sharing && <ShareDialog item={sharing} onClose={() => setShareId(null)} onOpenSettings={onOpenSettings} />}

      <Notices notices={notices} onDismiss={dismiss} />

      {confirm && (
        <ConfirmDialog
          title={t('artifacts.delete.title', { title: confirm.title })}
          message={t('artifacts.delete.message', { count: confirm.versionCount })}
          confirmLabel={deleting ? t('artifacts.delete.busy') : t('artifacts.delete.confirm')}
          destructive
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            if (!deleting) setConfirm(null)
          }}
          onConfirm={() => void remove(confirm)}
        />
      )}
      {portDialog && status && (
        <PortDialog busyPort={status.port} onSave={savePort} onCancel={() => setPortDialog(false)} />
      )}
    </div>
  )
}
