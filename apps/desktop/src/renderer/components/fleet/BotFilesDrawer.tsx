import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Loader2,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import type { FleetBot, FleetFileOrigin, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useChatDocument, useChatOwnerWindow } from '@/lib/chat-window-context'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  clampPage,
  FILE_SORTS,
  FILES_PAGE_SIZE,
  FLEET_FILE_KINDS,
  filesLevel,
  fleetFileKind,
  freshestUsage,
  highlightFileNode,
  pageCount,
  pageNumbers,
  pageOf,
  scopedFiles,
  sharedIn,
  spaceLabel,
  visibleFiles,
  type FileSort,
  type FilesConversation,
  type FleetFileKind,
} from '@/lib/fleet/files'
import { useFleetServerId } from '@/lib/fleet/server-context'
import type { BotFiles } from '@/lib/fleet/use-bot-files'
import { cn } from '@/lib/utils'
import { BotFileRow } from './BotFileRow'
import { BotFilesLimitsPanel, BotFilesUsageCard } from './BotFilesUsage'

/** The drawer of one bot's files; several bots' views stay mounted, so each has its own. */
export const botFilesDrawerId = (botId: string) => `bot-files-drawer-${botId}`
/** Narrower than this, the drawer floats over the conversation instead of sitting beside it. */
const SIDE_BY_SIDE_MIN = 720
const NOTICE_MS = 4200

const iconButton =
  'grid size-7 place-items-center rounded-[7px] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const quietSelect =
  'h-[26px] w-auto gap-1 border-transparent bg-transparent px-2 text-xs text-foreground/75 shadow-none hover:bg-white/[0.05] hover:text-foreground'

/**
 * The files a bot shared, beside its conversation: the space they take, those of the conversation shown or of the whole
 * bot, and what the owner can do with them.
 */
export function BotFilesDrawer({
  bot,
  files,
  conversation,
  request,
  revealMissed,
  onClose,
  onReveal,
  onOpenLane,
}: {
  bot: FleetBot
  files: BotFiles
  /** The conversation shown beside the drawer; null while a list of runs or threads is. */
  conversation: FilesConversation | null
  /** Set when something opened the drawer for a purpose, as "Free space" does to list the largest first. */
  request: { sort?: FileSort; nonce: number } | null
  /** Bumped when a file could not be shown in its conversation. */
  revealMissed: number
  /** `restoreFocus`: the owner dismissed the drawer, so the Files button gets the focus back. */
  onClose: (restoreFocus: boolean) => void
  onReveal: (file: FleetPublishedFile) => void
  onOpenLane: (origin: Extract<FleetFileOrigin, { kind: 'routine' | 'thread' }>) => void
}) {
  const serverId = useFleetServerId()
  const ownerDocument = useChatDocument()
  const ownerWindow = useChatOwnerWindow()
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const [scope, setScope] = useState<'conversation' | 'bot'>(conversation ? 'conversation' : 'bot')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<FleetFileKind | 'all'>('all')
  const [sort, setSort] = useState<FileSort>('recent')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirm, setConfirm] = useState<{ ids: string[]; notDownloaded: number } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showId, setShowId] = useState<string | null>(null)
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const [overlay, setOverlay] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const handledRequest = useRef<number | null>(null)

  // Measured where the drawer is: the conversation moves to a window of its own with it.
  useEffect(() => {
    const parent = aside?.parentElement
    if (!parent) return
    const measure = () => setOverlay(parent.clientWidth > 0 && parent.clientWidth < SIDE_BY_SIDE_MIN)
    measure()
    const observer = new ((ownerWindow as Window & typeof globalThis).ResizeObserver ?? ResizeObserver)(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [aside, ownerWindow])

  useEffect(() => {
    if (!request) closeRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!request || handledRequest.current === request.nonce) return
    handledRequest.current = request.nonce
    if (request.sort) setSort(request.sort)
    setQuery('')
    setKind('all')
    setPage(1)
    searchRef.current?.focus({ preventScroll: true })
  }, [request])

  useEffect(() => {
    if (!conversation && scope === 'conversation') setScope('bot')
  }, [conversation, scope])

  // Only a miss after the drawer opened is news.
  const seenMissed = useRef(revealMissed)
  useEffect(() => {
    if (revealMissed === seenMissed.current) return
    seenMissed.current = revealMissed
    setNotice(t('files.drawer.notFound'))
  }, [revealMissed, t])

  useEffect(() => {
    if (!notice) return
    const timer = ownerWindow.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => ownerWindow.clearTimeout(timer)
  }, [notice, ownerWindow])

  const allFiles = useMemo(() => files.list?.files ?? [], [files.list])
  const usage = freshestUsage(files.list?.usage, bot.sharedFiles)
  const shownConversation = scope === 'conversation' ? conversation : null

  // A file deleted elsewhere, or by a run's cleanup, leaves the selection.
  useEffect(() => {
    const existing = new Set(allFiles.map((file) => file.id))
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => existing.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [allFiles])

  const inScope = useMemo(() => scopedFiles(allFiles, shownConversation), [allFiles, shownConversation])
  const others = useMemo(
    () => (conversation ? allFiles.filter((file) => !sharedIn(file, conversation)) : []),
    [allFiles, conversation]
  )
  const shown = useMemo(
    () => visibleFiles(allFiles, { conversation: shownConversation, query, kind, sort }, locale),
    [allFiles, shownConversation, kind, locale, query, sort]
  )
  const shownIds = useMemo(() => new Set(shown.map((file) => file.id)), [shown])
  const currentPage = clampPage(page, shown.length)
  const pageItems = useMemo(() => pageOf(shown, currentPage), [currentPage, shown])
  const totalPages = pageCount(shown.length)
  const pageAllSelected = pageItems.length > 0 && pageItems.every((file) => selected.has(file.id))
  const selectedFiles = useMemo(() => allFiles.filter((file) => selected.has(file.id)), [allFiles, selected])
  const confirmFiles = useMemo(
    () => (confirm ? allFiles.filter((file) => confirm.ids.includes(file.id)) : []),
    [allFiles, confirm]
  )
  const filtering = Boolean(shownConversation || kind !== 'all' || query.trim())

  // A new page, scope or filter starts at the top of the list; a file asked for is then brought into view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [currentPage, scope, kind, sort, query])
  useEffect(() => {
    if (!showId) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-file-row="${CSS.escape(showId)}"]`)
    if (node) highlightFileNode(node, 'nearest')
    setShowId(null)
  }, [showId, pageItems])

  // After a deletion the row or bar that asked is gone: the search keeps the focus inside the drawer. It runs after the
  // dialog has closed and given the focus back where it could.
  const [refocus, setRefocus] = useState(0)
  useEffect(() => {
    if (!refocus) return
    const active = ownerDocument.activeElement
    if (!active || active === ownerDocument.body) (searchRef.current ?? closeRef.current)?.focus()
  }, [refocus])

  const close = (restoreFocus: boolean) => onClose(restoreFocus)
  const filter = (change: () => void) => {
    change()
    setPage(1)
  }

  /** A segment of the bar shows its file: its filters are cleared if they hide it, and its page is opened. */
  const showFile = (fileId: string) => {
    const target = allFiles.find((file) => file.id === fileId)
    if (!target) return
    const nextScope = shownConversation && !sharedIn(target, shownConversation) ? 'bot' : scope
    const nextKind = kind !== 'all' && fleetFileKind(target) !== kind ? 'all' : kind
    const nextList = visibleFiles(
      allFiles,
      { conversation: nextScope === 'conversation' ? conversation : null, query: '', kind: nextKind, sort },
      locale
    )
    setScope(nextScope)
    setKind(nextKind)
    setQuery('')
    setPage(
      Math.floor(
        Math.max(
          0,
          nextList.findIndex((file) => file.id === fileId)
        ) / FILES_PAGE_SIZE
      ) + 1
    )
    setShowId(fileId)
  }

  const askDelete = async (ids: string[]) => {
    setDeleteError(null)
    // A copy saved on this computer survives the deletion; the warning names those that would be lost.
    const receipts = await Promise.all(
      ids.map((id) => window.api.fleetGetDownload(serverId, bot.id, id).catch(() => null))
    )
    setConfirm({ ids, notDownloaded: receipts.filter((receipt) => !receipt).length })
  }
  const cancelDelete = useCallback(() => {
    if (!deleteBusy) setConfirm(null)
  }, [deleteBusy])
  const confirmDelete = async () => {
    if (!confirm || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const name = confirmFiles[0]?.name ?? ''
      const result = await files.remove(confirm.ids)
      setConfirm(null)
      setSelected((previous) => new Set([...previous].filter((id) => !result.deleted.includes(id))))
      setNotice(
        t('files.drawer.delete.done', {
          count: result.deleted.length,
          name,
          size: spaceLabel(result.freedBytes, locale),
        })
      )
      setRefocus((n) => n + 1)
    } catch (cause) {
      setDeleteError(t('files.drawer.delete.failed', { message: fleetErrorText(cause, t) }))
    } finally {
      setDeleteBusy(false)
    }
  }

  const downloadSelected = async () => {
    // One at a time: each row shows its own progress, and a failure leaves the others going.
    for (const file of selectedFiles)
      await window.api.fleetDownloadFile(serverId, bot.id, file.id).catch(() => undefined)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    // An open list of a select closes on its own.
    if (event.defaultPrevented || target.closest('[data-select-content]')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (target === searchRef.current && query) filter(() => setQuery(''))
      else close(true)
    } else if (
      event.key === '/' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !target.closest('input, textarea, select, [role="combobox"]')
    ) {
      event.preventDefault()
      searchRef.current?.focus()
    }
  }

  const now = Date.now()
  const confirmBytes = confirmFiles.reduce((sum, file) => sum + file.byteSize, 0)
  const one = confirmFiles.length === 1
  const scopeButton = (value: 'conversation' | 'bot', label: string, count: number) => (
    <button
      type="button"
      aria-pressed={scope === value}
      onClick={() =>
        filter(() => {
          setScope(value)
          setKind('all')
        })
      }
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        scope === value
          ? 'bg-surface-elevated text-foreground shadow-[0_0_0_1px_var(--border-strong)]'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
      <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
    </button>
  )

  return (
    <>
      {overlay && (
        <div
          aria-hidden="true"
          onClick={() => close(true)}
          className="absolute inset-0 z-20 bg-black/45 animate-in fade-in-0 motion-reduce:animate-none"
        />
      )}
      <aside
        ref={setAside}
        id={botFilesDrawerId(bot.id)}
        aria-label={t('files.drawer.title')}
        onKeyDown={onKeyDown}
        className={cn(
          'flex min-h-0 flex-col bg-[#161618] animate-in fade-in-0 slide-in-from-right-6 duration-200 motion-reduce:animate-none',
          overlay
            ? 'absolute inset-y-0 right-0 z-30 w-[min(392px,100%)] border-l border-border shadow-[-24px_0_60px_rgba(0,0,0,0.5)]'
            : 'w-[392px] shrink-0 border-l border-border'
        )}
      >
        <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <h2 className="text-[13px] font-semibold">{t('files.drawer.title')}</h2>
          <div className="ml-auto flex items-center gap-0.5">
            {usage && (
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls={`bot-files-limits-${bot.id}`}
                aria-label={t('files.drawer.settings')}
                title={t('files.drawer.settings')}
                onClick={() => setSettingsOpen((open) => !open)}
                className={cn(iconButton, settingsOpen && 'bg-white/[0.08] text-foreground')}
              >
                <Settings2 aria-hidden="true" className="size-4" />
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={() => close(true)}
              aria-label={t('files.drawer.close')}
              title={t('files.drawer.close')}
              className={iconButton}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>

        {settingsOpen && usage && (
          <BotFilesLimitsPanel
            id={`bot-files-limits-${bot.id}`}
            bot={bot}
            usage={usage}
            diskFreeBytes={files.list?.diskFreeBytes ?? null}
            onSave={files.saveSettings}
          />
        )}

        {files.error && (
          <div role="alert" className="shrink-0 border-b border-border bg-destructive/[0.06] px-4 py-2.5 text-xs">
            <p className="text-destructive">
              {t('files.drawer.loadFailed', { message: fleetErrorText(files.error, t) })}
            </p>
            <button
              type="button"
              onClick={files.refresh}
              className="mt-1.5 rounded-md border border-border-strong px-2 py-0.5 text-[11.5px] text-foreground hover:bg-white/[0.06]"
            >
              {t('files.drawer.retry')}
            </button>
          </div>
        )}

        {notice && (
          <p
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-border bg-white/[0.04] px-4 py-2 text-xs text-foreground"
          >
            <Check aria-hidden="true" className="size-3.5 shrink-0 text-status-ready" />
            <span className="min-w-0">{notice}</span>
          </p>
        )}

        {usage && (
          <div className="flex shrink-0 flex-col gap-2.5 px-3 pt-3">
            <BotFilesUsageCard
              bot={bot}
              usage={usage}
              files={allFiles}
              selectedIds={selected}
              visibleIds={shownIds}
              filtering={filtering}
              onSelectSegment={showFile}
              onApplySort={(nextSort, wholeBot) =>
                filter(() => {
                  setSort(nextSort)
                  setQuery('')
                  setKind('all')
                  if (wholeBot) setScope('bot')
                })
              }
            />
            {allFiles.length > 0 && (
              <>
                {conversation && (
                  <div
                    role="group"
                    aria-label={t('files.drawer.scope.label')}
                    className="flex gap-0.5 rounded-lg border border-border-strong bg-black/20 p-0.5"
                  >
                    {scopeButton(
                      'conversation',
                      t('files.drawer.scope.conversation'),
                      scopedFiles(allFiles, conversation).length
                    )}
                    {scopeButton('bot', t('files.drawer.scope.bot'), allFiles.length)}
                  </div>
                )}
                {scope === 'conversation' && others.length > 0 && filesLevel(usage) !== 'ok' && (
                  <p className="-mt-1 px-0.5 text-xs text-muted-foreground">
                    {t('files.drawer.others', {
                      count: others.length,
                      size: spaceLabel(
                        others.reduce((sum, file) => sum + file.byteSize, 0),
                        locale
                      ),
                    })}{' '}
                    <button
                      type="button"
                      onClick={() => filter(() => setScope('bot'))}
                      className="rounded-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('files.drawer.seeAll')}
                    </button>
                  </p>
                )}
                <label className="flex h-8 items-center gap-2 rounded-lg border border-border-strong bg-black/[0.18] pl-2.5 pr-2 text-muted-foreground focus-within:border-ring">
                  <Search aria-hidden="true" className="size-4 shrink-0" />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => filter(() => setQuery(event.target.value))}
                    placeholder={t('files.drawer.search')}
                    aria-label={t('files.drawer.search')}
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                  />
                  <kbd
                    aria-hidden="true"
                    className="rounded border border-border-strong px-1.5 font-mono text-[10.5px] leading-4"
                  >
                    /
                  </kbd>
                </label>
              </>
            )}
          </div>
        )}

        {files.loading && !files.list ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : allFiles.length === 0 ? (
          files.list && (
            <div className="mx-auto flex max-w-[34ch] flex-col items-center gap-1.5 px-6 py-9 text-center text-[12.5px] text-muted-foreground">
              <FolderOpen aria-hidden="true" className="mb-1 size-6 text-foreground/75" />
              <p className="font-semibold text-foreground">{t('files.drawer.empty.title', { name: bot.name })}</p>
              <p>{t('files.drawer.empty.text')}</p>
            </div>
          )
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-1.5 pb-1 pl-[21px] pr-3 pt-2.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={pageAllSelected}
                disabled={pageItems.length === 0}
                onChange={() =>
                  setSelected((previous) => {
                    const next = new Set(previous)
                    for (const file of pageItems) {
                      if (pageAllSelected) next.delete(file.id)
                      else next.add(file.id)
                    }
                    return next
                  })
                }
                aria-label={t('files.drawer.selectPage')}
                className="mr-1"
              />
              <Select value={kind} onValueChange={(value) => filter(() => setKind(value as FleetFileKind | 'all'))}>
                <SelectTrigger
                  aria-label={t('files.drawer.kind.label')}
                  className={cn(quietSelect, kind !== 'all' && 'border-border-strong text-foreground')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('files.drawer.kind.all', { count: inScope.length })}</SelectItem>
                  {FLEET_FILE_KINDS.map((value) => {
                    const count = inScope.filter((file) => fleetFileKind(file) === value).length
                    if (!count && kind !== value) return null
                    return (
                      <SelectItem key={value} value={value}>
                        {t(`files.drawer.kind.${value}`, { count })}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(value) => filter(() => setSort(value as FileSort))}>
                <SelectTrigger aria-label={t('files.drawer.sort.label')} className={cn(quietSelect, 'ml-auto')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {FILE_SORTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`files.drawer.sort.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div
              ref={listRef}
              role="list"
              aria-label={t('files.drawer.title')}
              className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"
            >
              {pageItems.length > 0 ? (
                pageItems.map((file) => (
                  <BotFileRow
                    key={file.id}
                    botId={bot.id}
                    file={file}
                    conversation={shownConversation}
                    showOrigin={scope === 'bot'}
                    selected={selected.has(file.id)}
                    now={now}
                    onToggleSelect={() =>
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (next.has(file.id)) next.delete(file.id)
                        else next.add(file.id)
                        return next
                      })
                    }
                    onReveal={(target) => {
                      onReveal(target)
                      if (overlay) close(false)
                    }}
                    onOpenLane={(origin) => {
                      onOpenLane(origin)
                      if (overlay) close(false)
                    }}
                    onDelete={() => void askDelete([file.id])}
                  />
                ))
              ) : (
                <div className="flex flex-col items-center gap-2 px-4 py-7 text-center text-[12.5px] text-muted-foreground">
                  <p>{inScope.length ? t('files.drawer.noMatch') : t('files.drawer.emptyConversation')}</p>
                  <button
                    type="button"
                    onClick={() =>
                      filter(() => {
                        setQuery('')
                        setKind('all')
                        if (!inScope.length) setScope('bot')
                      })
                    }
                    className="rounded-md border border-border-strong px-2.5 py-1 text-xs text-foreground hover:bg-white/[0.06]"
                  >
                    {inScope.length ? t('files.drawer.clearFilters') : t('files.drawer.seeAll')}
                  </button>
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-t border-border pb-2.5 pl-4 pr-2.5 pt-2">
              {selectedFiles.length > 0 && (
                <div
                  role="region"
                  aria-label={t('files.drawer.selected', { count: selectedFiles.length })}
                  className="-ml-1.5 flex items-center gap-1.5 rounded-[9px] border border-border-strong bg-[#2a2a2e] py-[5px] pl-2.5 pr-[5px] text-[12.5px]"
                >
                  <b className="font-semibold">{t('files.drawer.selected', { count: selectedFiles.length })}</b>
                  <span className="font-mono text-[11.5px] text-foreground/75">
                    {spaceLabel(
                      selectedFiles.reduce((sum, file) => sum + file.byteSize, 0),
                      locale
                    )}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => void downloadSelected()}
                      aria-label={t('files.drawer.downloadSelected')}
                      title={t('files.drawer.downloadSelected')}
                      className={iconButton}
                    >
                      <Download aria-hidden="true" className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void askDelete(selectedFiles.map((file) => file.id))}
                      className="inline-flex h-6 items-center gap-1.5 rounded-[7px] bg-destructive px-2 text-xs font-medium text-[#1a0a0c] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      {t('files.drawer.deleteSelected')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      aria-label={t('files.drawer.clearSelection')}
                      title={t('files.drawer.clearSelection')}
                      className={iconButton}
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}
              <div className="flex min-h-7 items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                <span>
                  {t('files.drawer.range', {
                    from: shown.length ? (currentPage - 1) * FILES_PAGE_SIZE + 1 : 0,
                    to: Math.min(shown.length, currentPage * FILES_PAGE_SIZE),
                    total: shown.length,
                  })}
                </span>
                {totalPages > 1 && (
                  <nav aria-label={t('files.drawer.pages')} className="flex items-center gap-px">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => setPage(currentPage - 1)}
                      aria-label={t('files.drawer.previous')}
                      className={cn(iconButton, 'disabled:pointer-events-none disabled:opacity-40')}
                    >
                      <ChevronLeft aria-hidden="true" className="size-4" />
                    </button>
                    {pageNumbers(currentPage, totalPages).map((entry, index) =>
                      entry === 'gap' ? (
                        <span key={`gap-${index}`} aria-hidden="true" className="px-[3px]">
                          …
                        </span>
                      ) : (
                        <button
                          key={entry}
                          type="button"
                          onClick={() => setPage(entry)}
                          aria-label={t('files.drawer.page', { page: entry })}
                          aria-current={entry === currentPage ? 'page' : undefined}
                          className={cn(
                            'h-[26px] min-w-[26px] rounded-md px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            entry === currentPage
                              ? 'bg-white/10 font-semibold text-foreground'
                              : 'text-foreground/75 hover:bg-white/[0.06]'
                          )}
                        >
                          {entry}
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      disabled={currentPage >= totalPages}
                      onClick={() => setPage(currentPage + 1)}
                      aria-label={t('files.drawer.next')}
                      className={cn(iconButton, 'disabled:pointer-events-none disabled:opacity-40')}
                    >
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </button>
                  </nav>
                )}
              </div>
            </div>
          </>
        )}
      </aside>

      {confirm && confirmFiles.length > 0 && (
        <ConfirmDialog
          title={t('files.drawer.delete.title', { count: confirmFiles.length, name: confirmFiles[0]!.name })}
          message={
            t('files.drawer.delete.message', {
              count: confirmFiles.length,
              size: spaceLabel(confirmBytes, locale),
              bot: bot.name,
            }) + (confirm.notDownloaded ? '' : ` ${t('files.drawer.delete.downloaded')}`)
          }
          warning={
            !confirm.notDownloaded
              ? null
              : one
                ? t('files.drawer.delete.notDownloadedThis')
                : confirm.notDownloaded === confirmFiles.length
                  ? t('files.drawer.delete.notDownloadedAny')
                  : t('files.drawer.delete.notDownloaded', { count: confirm.notDownloaded })
          }
          confirmLabel={
            deleteBusy
              ? t('files.drawer.delete.busy')
              : t('files.drawer.delete.confirm', { count: confirmFiles.length })
          }
          destructive
          busy={deleteBusy}
          error={deleteError}
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  )
}
