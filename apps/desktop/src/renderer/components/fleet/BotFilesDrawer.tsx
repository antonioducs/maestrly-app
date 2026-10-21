import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
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
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  clampPage,
  FILE_SORTS,
  FILES_PAGE_SIZE,
  FLEET_FILE_KINDS,
  fleetFileKind,
  filesLevel,
  pageCount,
  pageNumbers,
  pageOf,
  scopedFiles,
  sharedIn,
  visibleFiles,
  type FilesConversation,
  type FileSort,
  type FleetFileKind,
} from '@/lib/fleet/files'
import type { BotFiles } from '@/lib/fleet/use-bot-files'
import { useFleetServerId } from '@/lib/fleet/server-context'
import { cn } from '@/lib/utils'
import { BotFileRow } from './BotFileRow'
import { BotFilesLimitsPanel, BotFilesUsageCard } from './BotFilesUsage'

export const BOT_FILES_DRAWER_ID = 'bot-files-drawer'

export function BotFilesDrawer({
  bot,
  files,
  conversation,
  overlay,
  request,
  onClose,
  onReveal,
  onOpenLane,
  revealMissed,
}: {
  bot: FleetBot
  files: BotFiles
  conversation: FilesConversation | null
  overlay: boolean
  request: { sort?: FileSort; nonce: number } | null
  onClose: () => void
  onReveal: (file: FleetPublishedFile) => void
  onOpenLane: (origin: Extract<FleetFileOrigin, { kind: 'routine' | 'thread' }>) => void
  revealMissed: number
}) {
  const serverId = useFleetServerId()
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const [scope, setScope] = useState<'conversation' | 'bot'>(conversation ? 'conversation' : 'bot')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<FleetFileKind | 'all'>('all')
  const [sort, setSort] = useState<FileSort>('recent')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deletingIds, setDeletingIds] = useState<string[] | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!conversation && scope === 'conversation') setScope('bot')
  }, [conversation, scope])

  useEffect(() => {
    if (!request) return
    if (request.sort) {
      setSort(request.sort)
      setPage(1)
    }
    searchRef.current?.focus()
  }, [request])

  useEffect(() => {
    if (revealMissed > 0) setNotice(t('files.drawer.notFound'))
  }, [revealMissed, t])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const allFiles = files.list?.files ?? []
  const usage = files.list?.usage ?? bot.sharedFiles
  const effectiveConversation = scope === 'conversation' ? conversation : null

  useEffect(() => {
    const existing = new Set(allFiles.map((f) => f.id))
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => existing.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [allFiles])

  const inScope = useMemo(
    () => scopedFiles(allFiles, effectiveConversation),
    [allFiles, effectiveConversation]
  )
  const others = useMemo(
    () => (conversation ? allFiles.filter((file) => !sharedIn(file, conversation)) : []),
    [allFiles, conversation]
  )
  const shown = useMemo(
    () =>
      visibleFiles(
        allFiles,
        { conversation: effectiveConversation, query, kind, sort },
        locale
      ),
    [allFiles, effectiveConversation, kind, locale, query, sort]
  )
  const visibleIdSet = useMemo(() => new Set(shown.map((f) => f.id)), [shown])
  const currentPage = clampPage(page, shown.length)
  const pageItems = useMemo(() => pageOf(shown, currentPage), [currentPage, shown])
  const totalPages = pageCount(shown.length)
  const pageAllSelected = pageItems.length > 0 && pageItems.every((f) => selected.has(f.id))
  const selectedFiles = useMemo(
    () => allFiles.filter((f) => selected.has(f.id)),
    [allFiles, selected]
  )
  const deletingFiles = useMemo(
    () => (deletingIds ? allFiles.filter((f) => deletingIds.includes(f.id)) : []),
    [allFiles, deletingIds]
  )

  const handleDownloadedChange = useCallback((fileId: string, isDownloaded: boolean) => {
    setDownloadedIds((prev) => {
      if (prev.has(fileId) === isDownloaded) return prev
      const next = new Set(prev)
      if (isDownloaded) next.add(fileId)
      else next.delete(fileId)
      return next
    })
  }, [])

  const selectSegment = (fileId: string) => {
    const target = allFiles.find((f) => f.id === fileId)
    if (!target) return
    let nextScope = scope
    let nextQuery = query
    let nextKind = kind
    if (effectiveConversation && !sharedIn(target, effectiveConversation)) nextScope = 'bot'
    if (nextKind !== 'all' && fleetFileKind(target) !== nextKind) nextKind = 'all'
    if (nextQuery.trim()) nextQuery = ''
    setScope(nextScope)
    setKind(nextKind)
    setQuery(nextQuery)
    const nextList = visibleFiles(
      allFiles,
      {
        conversation: nextScope === 'conversation' ? conversation : null,
        query: nextQuery,
        kind: nextKind,
        sort,
      },
      locale
    )
    const idx = nextList.findIndex((f) => f.id === fileId)
    if (idx >= 0) setPage(Math.floor(idx / FILES_PAGE_SIZE) + 1)
    setFlashId(fileId)
    setTimeout(() => setFlashId((cur) => (cur === fileId ? null : cur)), 1900)
  }

  const confirmDelete = async () => {
    if (!deletingIds?.length || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const targetName = deletingFiles[0]?.name ?? ''
      const result = await files.remove(deletingIds)
      setDeletingIds(null)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of result.deleted) next.delete(id)
        return next
      })
      setNotice(
        t('files.drawer.delete.done', {
          count: result.deleted.length,
          name: targetName,
          size: fileSizeLabel(result.freedBytes, locale),
        })
      )
    } catch (cause) {
      setDeleteError(fleetErrorText(cause, t))
    } finally {
      setDeleteBusy(false)
    }
  }

  const now = Date.now()
  const filtering = Boolean(effectiveConversation || kind !== 'all' || query.trim())
  const notDownloadedCount = deletingFiles.filter((f) => !downloadedIds.has(f.id)).length

  return (
    <>
      {overlay && (
        <div
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-20 bg-black/40"
        />
      )}
      <aside
        id={BOT_FILES_DRAWER_ID}
        aria-label={t('files.drawer.title')}
        className={cn(
          'flex min-h-0 w-[360px] max-w-full shrink-0 flex-col border-l border-border bg-chat-canvas',
          overlay && 'absolute inset-y-0 right-0 z-30 shadow-2xl'
        )}
      >
        <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border px-3.5">
          <h2 className="text-sm font-semibold">{t('files.drawer.title')}</h2>
          <div className="ml-auto flex items-center gap-1">
            {usage && (
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls={`bot-files-limits-${bot.id}`}
                aria-label={t('files.drawer.settings')}
                title={t('files.drawer.settings')}
                onClick={() => setSettingsOpen((v) => !v)}
                className={cn(
                  'rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
                  settingsOpen && 'bg-white/[0.08] text-foreground'
                )}
              >
                <Settings2 aria-hidden="true" className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('files.drawer.close')}
              title={t('files.drawer.close')}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>

        {settingsOpen && usage && (
          <BotFilesLimitsPanel
            bot={bot}
            usage={usage}
            diskFreeBytes={files.list?.diskFreeBytes ?? null}
            onSave={files.saveSettings}
          />
        )}

        {files.error && (
          <div role="alert" className="border-b border-border bg-red-400/[0.06] px-3.5 py-2.5 text-xs text-red-200">
            <p>{t('files.drawer.loadFailed', { message: fleetErrorText(files.error, t) })}</p>
            <button
              type="button"
              onClick={files.refresh}
              className="mt-1.5 rounded border border-border-strong px-2 py-0.5 text-[11px] hover:bg-white/[0.06]"
            >
              {t('files.drawer.retry')}
            </button>
          </div>
        )}

        {notice && (
          <p role="status" className="border-b border-border bg-white/[0.04] px-3.5 py-2 text-xs text-foreground">
            {notice}
          </p>
        )}

        {usage && (
          <div className="shrink-0 space-y-2.5 border-b border-border p-3.5">
            <BotFilesUsageCard
              bot={bot}
              usage={usage}
              files={allFiles}
              selectedIds={selected}
              visibleIds={visibleIdSet}
              filtering={filtering}
              onSelectSegment={selectSegment}
              onApplySort={(nextSort, wholeBot) => {
                setSort(nextSort)
                setQuery('')
                setKind('all')
                if (wholeBot) setScope('bot')
                setPage(1)
              }}
            />

            {allFiles.length > 0 && (
              <>
                {conversation && (
                  <div
                    role="group"
                    aria-label={t('files.drawer.scope.label')}
                    className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-white/[0.03] p-0.5 text-xs"
                  >
                    <button
                      type="button"
                      aria-pressed={scope === 'conversation'}
                      onClick={() => {
                        setScope('conversation')
                        setKind('all')
                        setPage(1)
                      }}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md py-1 transition-colors',
                        scope === 'conversation'
                          ? 'bg-white/[0.09] font-medium text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span>{t('files.drawer.scope.conversation')}</span>
                      <span className="tabular-nums text-[11px] text-muted-foreground">
                        {scopedFiles(allFiles, conversation).length}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={scope === 'bot'}
                      onClick={() => {
                        setScope('bot')
                        setKind('all')
                        setPage(1)
                      }}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md py-1 transition-colors',
                        scope === 'bot'
                          ? 'bg-white/[0.09] font-medium text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span>{t('files.drawer.scope.bot')}</span>
                      <span className="tabular-nums text-[11px] text-muted-foreground">
                        {allFiles.length}
                      </span>
                    </button>
                  </div>
                )}

                {scope === 'conversation' && others.length > 0 && filesLevel(usage) !== 'ok' && (
                  <p className="text-[11.5px] text-muted-foreground">
                    {t('files.drawer.others', {
                      count: others.length,
                      size: fileSizeLabel(
                        others.reduce((sum, f) => sum + f.byteSize, 0),
                        locale
                      ),
                    })}{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setScope('bot')
                        setPage(1)
                      }}
                      className="text-primary underline"
                    >
                      {t('files.drawer.seeAll')}
                    </button>
                  </p>
                )}

                <div className="relative flex items-center">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
                  />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setPage(1)
                    }}
                    placeholder={t('files.drawer.search')}
                    aria-label={t('files.drawer.search')}
                    className="h-8 w-full rounded-md border border-border bg-surface-elevated pl-8 pr-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              </>
            )}
          </div>
        )}

        {files.loading && !files.list ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : allFiles.length === 0 ? (
          <div className="m-auto max-w-xs px-6 py-10 text-center text-xs text-muted-foreground">
            <FolderOpen aria-hidden="true" className="mx-auto mb-2.5 size-6 text-muted-foreground/70" />
            <p className="font-medium text-foreground">{t('files.drawer.empty.title', { name: bot.name })}</p>
            <p className="mt-1">{t('files.drawer.empty.text')}</p>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
              <input
                type="checkbox"
                checked={pageAllSelected}
                disabled={pageItems.length === 0}
                onChange={() => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    for (const item of pageItems) {
                      if (pageAllSelected) next.delete(item.id)
                      else next.add(item.id)
                    }
                    return next
                  })
                }}
                aria-label={t('files.drawer.selectPage')}
                className="size-3.5 shrink-0 accent-primary"
              />
              <select
                aria-label={t('files.drawer.kind.label')}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as FleetFileKind | 'all')
                  setPage(1)
                }}
                className="h-6 rounded border border-border bg-surface-elevated px-1.5 text-[11.5px] text-foreground"
              >
                <option value="all">{t('files.drawer.kind.all', { count: inScope.length })}</option>
                {FLEET_FILE_KINDS.map((k) => {
                  const count = inScope.filter((f) => fleetFileKind(f) === k).length
                  if (count === 0 && kind !== k) return null
                  return (
                    <option key={k} value={k}>
                      {t(`files.drawer.kind.${k}`, { count })}
                    </option>
                  )
                })}
              </select>
              <select
                aria-label={t('files.drawer.sort.label')}
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as FileSort)
                  setPage(1)
                }}
                className="ml-auto h-6 rounded border border-border bg-surface-elevated px-1.5 text-[11.5px] text-foreground"
              >
                {FILE_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`files.drawer.sort.${s}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {pageItems.length > 0 ? (
                pageItems.map((file) => (
                  <BotFileRow
                    key={file.id}
                    botId={bot.id}
                    file={file}
                    conversation={effectiveConversation}
                    showOrigin={scope === 'bot'}
                    selected={selected.has(file.id)}
                    flashing={flashId === file.id}
                    now={now}
                    onToggleSelect={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(file.id)) next.delete(file.id)
                        else next.add(file.id)
                        return next
                      })
                    }
                    onReveal={onReveal}
                    onOpenLane={onOpenLane}
                    onDelete={() => {
                      setDeleteError(null)
                      setDeletingIds([file.id])
                    }}
                    onDownloadedChange={handleDownloadedChange}
                  />
                ))
              ) : inScope.length > 0 ? (
                <div className="px-6 py-8 text-center text-xs text-muted-foreground">
                  <p>{t('files.drawer.noMatch')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('')
                      setKind('all')
                      setPage(1)
                    }}
                    className="mt-2 rounded-md border border-border-strong px-2.5 py-1 text-foreground hover:bg-white/[0.05]"
                  >
                    {t('files.drawer.clearFilters')}
                  </button>
                </div>
              ) : (
                <div className="px-6 py-8 text-center text-xs text-muted-foreground">
                  <p>{t('files.drawer.emptyConversation')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setScope('bot')
                      setPage(1)
                    }}
                    className="mt-2 rounded-md border border-border-strong px-2.5 py-1 text-foreground hover:bg-white/[0.05]"
                  >
                    {t('files.drawer.seeAll')}
                  </button>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border">
              {selectedFiles.length > 0 && (
                <div className="flex items-center gap-2 border-b border-border bg-white/[0.03] px-3.5 py-2 text-xs">
                  <span className="font-medium">
                    {t('files.drawer.selected', { count: selectedFiles.length })}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {fileSizeLabel(
                      selectedFiles.reduce((sum, f) => sum + f.byteSize, 0),
                      locale
                    )}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        for (const f of selectedFiles)
                          void window.api.fleetDownloadFile(serverId, bot.id, f.id).catch(() => undefined)
                      }}
                      aria-label={t('files.drawer.downloadSelected')}
                      title={t('files.drawer.downloadSelected')}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                    >
                      <Download aria-hidden="true" className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null)
                        setDeletingIds(selectedFiles.map((f) => f.id))
                      }}
                      className="inline-flex items-center gap-1 rounded-md bg-red-500/20 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/30"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      {t('files.drawer.deleteSelected')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      aria-label={t('files.drawer.clearSelection')}
                      title={t('files.drawer.clearSelection')}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between px-3.5 py-2 text-[11.5px] text-muted-foreground">
                <span className="tabular-nums">
                  {t('files.drawer.range', {
                    from: shown.length ? (currentPage - 1) * FILES_PAGE_SIZE + 1 : 0,
                    to: Math.min(shown.length, currentPage * FILES_PAGE_SIZE),
                    total: shown.length,
                  })}
                </span>
                {totalPages > 1 && (
                  <nav aria-label={t('files.drawer.pages')} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => setPage(currentPage - 1)}
                      aria-label={t('files.drawer.previous')}
                      className="rounded p-1 hover:bg-white/[0.06] disabled:opacity-40"
                    >
                      <ChevronLeft aria-hidden="true" className="size-3.5" />
                    </button>
                    {pageNumbers(currentPage, totalPages).map((entry, idx) =>
                      entry === 'gap' ? (
                        <span key={`gap-${idx}`} aria-hidden="true" className="px-1">
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
                            'min-w-[22px] rounded px-1.5 py-0.5 tabular-nums',
                            entry === currentPage
                              ? 'bg-white/[0.1] font-medium text-foreground'
                              : 'hover:bg-white/[0.06]'
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
                      className="rounded p-1 hover:bg-white/[0.06] disabled:opacity-40"
                    >
                      <ChevronRight aria-hidden="true" className="size-3.5" />
                    </button>
                  </nav>
                )}
              </div>
            </div>
          </>
        )}
      </aside>

      {deletingFiles.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bot-files-delete-title"
            aria-describedby="bot-files-delete-desc"
            className="w-full max-w-md rounded-xl border border-border-strong bg-popover p-5 text-sm shadow-2xl"
          >
            <h3 id="bot-files-delete-title" className="text-base font-semibold">
              {t('files.drawer.delete.title', {
                count: deletingFiles.length,
                name: deletingFiles[0]?.name ?? '',
              })}
            </h3>
            <div id="bot-files-delete-desc" className="mt-2 space-y-2 text-xs text-muted-foreground">
              <p>
                {t('files.drawer.delete.message', {
                  count: deletingFiles.length,
                  size: fileSizeLabel(
                    deletingFiles.reduce((sum, f) => sum + f.byteSize, 0),
                    locale
                  ),
                  bot: bot.name,
                })}
              </p>
              {notDownloadedCount > 0 ? (
                <p className="flex items-start gap-1.5 text-amber-200">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {deletingFiles.length === 1
                      ? t('files.drawer.delete.notDownloadedThis')
                      : t('files.drawer.delete.notDownloaded', { count: notDownloadedCount })}
                  </span>
                </p>
              ) : (
                <p>{t('files.drawer.delete.downloaded')}</p>
              )}
              {deleteError && (
                <p role="alert" className="text-destructive">
                  {t('files.drawer.delete.failed', { message: deleteError })}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => setDeletingIds(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-white/[0.06]"
              >
                {t('files.cancel')}
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
                className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/30 disabled:opacity-50"
              >
                {deleteBusy
                  ? t('files.drawer.delete.busy')
                  : t('files.drawer.delete.confirm', { count: deletingFiles.length })}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
