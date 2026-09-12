/** Workspace or conversation notebook with a collapsible page tree and restored page/scroll state.
 * Serialize autosaves, preserve uncommitted edits on conflicts, and defer the editor until visible. */
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { NotesSaveQueue, prepareNotesMemoryEviction } from '@/lib/notes-save-queue'
import { useTranslation } from 'react-i18next'
import { ArrowUpToLine, RotateCw, FileText, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { PageTree } from '@/components/notes/PageTree'
import type { NotesScope, PageMeta } from '../../../preload'

const PAGE_EMOJIS = [
  '📝',
  '📄',
  '🗒️',
  '📋',
  '✅',
  '📌',
  '💡',
  '🎯',
  '🐛',
  '🚀',
  '⭐',
  '🔥',
  '⚠️',
  '📊',
  '🧠',
  '🛠️',
  '🔧',
  '🎨',
  '📦',
  '🔍',
  '💬',
  '📅',
  '⏰',
  '🏷️',
  '❤️',
  '👍',
  '🎉',
  '🧩',
  '🔑',
  '🌟',
  '✨',
  '📈',
  '🧪',
  '🔬',
  '📚',
  '✏️',
  '🗂️',
  '💻',
  '⚙️',
  '🟢',
  '🔴',
  '🟡',
  '🟣',
  '🔵',
  '⚪',
  '⚽',
  '🎮',
  '🏗️',
]

const NotesEditor = lazy(() => import('@/components/notes/NotesEditor').then((m) => ({ default: m.NotesEditor })))

const railKey = (scope: NotesScope): string => `notes-rail-open:${scope}`
function readRailOpen(scope: NotesScope): boolean {
  try {
    return localStorage.getItem(railKey(scope)) !== '0'
  } catch {
    return true
  }
}

interface OpenState {
  pageId: string
  scrollTop: number
}
const openKey = (scope: NotesScope, scopeId: string): string => `notes-open:${scope}:${scopeId}`
function readOpenState(scope: NotesScope, scopeId: string): OpenState | null {
  try {
    const raw = localStorage.getItem(openKey(scope, scopeId))
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.pageId === 'string') return { pageId: v.pageId, scrollTop: Number(v.scrollTop) || 0 }
  } catch {}
  return null
}
function writeOpenState(scope: NotesScope, scopeId: string, st: OpenState): void {
  try {
    localStorage.setItem(openKey(scope, scopeId), JSON.stringify(st))
  } catch {}
}

const EDIT_GRACE_MS = 2000

interface Props {
  scope: NotesScope
  scopeId: string
  showMerge?: boolean

  visible?: boolean
}

interface Doc {
  content: string
  version: number
  loaded: boolean
}

function NotesPanelImpl({ scope, scopeId, showMerge, visible = true }: Props) {
  const { t } = useTranslation('ui')

  const [revealed, setRevealed] = useState(visible)
  useEffect(() => {
    if (visible) setRevealed(true)
  }, [visible])
  const [pages, setPages] = useState<PageMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [doc, setDoc] = useState<Doc>({ content: '', version: 0, loaded: false })
  const [stale, setStale] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [railOpen, setRailOpenState] = useState(() => readRailOpen(scope))
  const setRailOpen = (open: boolean) => {
    setRailOpenState(open)
    try {
      localStorage.setItem(railKey(scope), open ? '1' : '0')
    } catch {}
  }
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const focusedRef = useRef(false)
  const titleFocused = useRef(false)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const titleDraftRef = useRef('')
  titleDraftRef.current = titleDraft

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveQueueRef = useRef<NotesSaveQueue | null>(null)
  if (!saveQueueRef.current) saveQueueRef.current = new NotesSaveQueue()
  const saveQueue = saveQueueRef.current
  const commitTitle = useCallback(async () => {
    titleFocused.current = false
    const id = selectedRef.current
    if (id) await window.api.renameNotePage(scope, scopeId, id, { title: titleDraftRef.current })
  }, [scope, scopeId])

  const staleExternal = useRef<string | null>(null)

  const scrollTopRef = useRef(0)
  const pageScrollsRef = useRef<Record<string, number>>({})
  const openSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const getPageScrollTop = (id: string) => pageScrollsRef.current[id] ?? scrollTopRef.current
  const writeOpenPage = (id: string, top = getPageScrollTop(id)) =>
    writeOpenState(scope, scopeId, { pageId: id, scrollTop: top })

  const lastLocalEditRef = useRef<{ pageId: string; at: number } | null>(null)

  useEffect(() => {
    let alive = true
    const saved = readOpenState(scope, scopeId)
    window.api.listNotePages(scope, scopeId).then((pgs) => {
      if (!alive) return
      setPages(pgs)
      const restore = saved && pgs.some((p) => p.id === saved.pageId) ? saved : null
      if (restore) {
        scrollTopRef.current = restore.scrollTop
        pageScrollsRef.current[restore.pageId] = restore.scrollTop
      }
      setSelectedId((cur) => cur ?? restore?.pageId ?? null)
    })
    return () => {
      alive = false
    }
  }, [scope, scopeId])

  useEffect(() => {
    if (selectedId) writeOpenPage(selectedId)
  }, [selectedId, scope, scopeId])

  useEffect(
    () => () => {
      clearTimeout(openSaveTimer.current)
      const id = selectedRef.current
      if (id) writeOpenPage(id)
    },
    [scope, scopeId]
  )

  useEffect(() => {
    if (!selectedId) {
      setDoc({ content: '', version: 0, loaded: false })
      return
    }
    let alive = true
    setStale(false)
    window.api.readNotePage(scope, scopeId, selectedId).then((content) => {
      if (alive) setDoc((d) => ({ content, version: d.version + 1, loaded: true }))
    })
    return () => {
      alive = false
    }
  }, [scope, scopeId, selectedId])

  useEffect(() => {
    if (titleFocused.current) return
    const p = pages.find((x) => x.id === selectedId)
    if (p) setTitleDraft(p.title)
  }, [selectedId, pages])

  useEffect(() => {
    return window.api.onNotesState((s) => {
      if (s.scope !== scope || s.id !== scopeId) return
      if (s.type === 'tree') {
        setPages(s.pages)

        setSelectedId((cur) => (cur && s.pages.some((p) => p.id === cur) ? cur : null))
      } else if (s.pageId === selectedRef.current) {
        if (!s.external) return

        const recentLocalEdit =
          lastLocalEditRef.current?.pageId === s.pageId &&
          performance.now() - lastLocalEditRef.current.at < EDIT_GRACE_MS
        const editingActive = saveQueue.pendingEdit !== null || focusedRef.current || recentLocalEdit
        if (editingActive) {
          clearTimeout(saveTimer.current)
          staleExternal.current = s.content
          setStale(true)
        } else {
          setStale(false)
          setDoc((d) => ({ content: s.content, version: d.version + 1, loaded: true }))
        }
      }
    })
  }, [scope, scopeId])

  const flush = () => saveQueue.flush((pageId, md) => window.api.writeNotePage(scope, scopeId, pageId, md))
  const prepareMemoryEviction = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const id = selectedRef.current
    const selectedPage = pages.find((page) => page.id === id)
    return prepareNotesMemoryEviction({
      pendingDelete: pendingDelete !== null,
      conflict: stale,
      flushBody: flush,
      titleDirty: titleFocused.current || (selectedPage != null && titleDraftRef.current !== selectedPage.title),
      commitTitle,
      persistOpenPage: () => {
        if (id) writeOpenPage(id)
      },
    })
  }, [commitTitle, pages, pendingDelete, stale])
  usePanelMemoryEviction(scope === 'conv' ? scopeId : '', 'notes', prepareMemoryEviction)
  const saveBody = (pageId: string, md: string) => {
    lastLocalEditRef.current = { pageId, at: performance.now() }
    saveQueue.setPending(pageId, md)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 600)
  }

  useEffect(
    () => () => {
      clearTimeout(saveTimer.current)
      flush()
    },
    [selectedId]
  )

  const selectPage = (id: string | null) => {
    const current = selectedRef.current
    if (id === current) return
    if (current) writeOpenPage(current)
    scrollTopRef.current = 0
    clearTimeout(openSaveTimer.current)
    if (id) {
      pageScrollsRef.current[id] = 0
      writeOpenState(scope, scopeId, { pageId: id, scrollTop: 0 })
    }
    setSelectedId(id)
  }

  const onEditorScroll = (top: number) => {
    scrollTopRef.current = top
    const id = selectedRef.current
    if (!id) return
    pageScrollsRef.current[id] = top
    clearTimeout(openSaveTimer.current)
    openSaveTimer.current = setTimeout(() => writeOpenState(scope, scopeId, { pageId: id, scrollTop: top }), 400)
  }

  const create = async (parentId: string | null) => {
    const p = await window.api.createNotePage(scope, scopeId, { title: t('notes.untitled'), parentId })
    if (p) selectPage(p.id)
  }

  const remove = (id: string) => setPendingDelete(id)
  const confirmDelete = () => {
    if (pendingDelete) window.api.deleteNotePage(scope, scopeId, pendingDelete)
    setPendingDelete(null)
  }
  const move = (id: string, parentId: string | null, order: number) =>
    window.api.moveNotePage(scope, scopeId, id, parentId, order)
  const doMerge = async () => {
    const r = await window.api.mergeNotes(scopeId)
    setMsg(r.message)
    setTimeout(() => setMsg(null), 4000)
  }
  const reload = () => {
    if (!selectedId) return
    setStale(false)
    clearTimeout(saveTimer.current)
    saveQueue.clearPending()
    const ext = staleExternal.current
    staleExternal.current = null
    if (ext != null) setDoc((d) => ({ content: ext, version: d.version + 1, loaded: true }))
    else
      window.api
        .readNotePage(scope, scopeId, selectedId)
        .then((c) => setDoc((d) => ({ content: c, version: d.version + 1, loaded: true })))
  }
  const setEmoji = (emoji: string | null) => {
    if (selectedId) window.api.renameNotePage(scope, scopeId, selectedId, { emoji })
    setEmojiOpen(false)
  }
  const selectedPage = pages.find((p) => p.id === selectedId)
  const rootPages = pages.filter((p) => p.parentId === null).sort((a, b) => a.order - b.order)

  return (
    <div className="flex h-full">
      {railOpen && (
        <div className="flex w-56 shrink-0 flex-col hairline-r bg-white/[0.02]">
          <div className="min-h-0 flex-1">
            <PageTree
              pages={pages}
              selectedId={selectedId}
              onSelect={selectPage}
              onCreate={create}
              onDelete={remove}
              onMove={move}
              onCollapse={() => setRailOpen(false)}
            />
          </div>
          {showMerge && (
            <div className="hairline-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-1.5 text-xs"
                onClick={doMerge}
                title={t('notes.mergeHint')}
              >
                <ArrowUpToLine className="size-3.5" /> {t('notes.merge')}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!railOpen && (
          <div className="flex items-center gap-1 px-2 pt-2">
            <button
              onClick={() => setRailOpen(true)}
              title={t('notes.showPages')}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </div>
        )}
        {msg && <div className="hairline-b bg-status-ready/10 px-3 py-1 text-xs text-status-ready">{msg}</div>}
        {selectedId ? (
          <>
            <div className="flex items-center gap-1.5 px-4 pt-4 pb-1">
              <DropdownMenu open={emojiOpen} onOpenChange={setEmojiOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    title={t('notes.changeIcon')}
                    className="flex size-8 shrink-0 items-center justify-center rounded text-xl leading-none hover:bg-white/[0.06]"
                  >
                    {selectedPage?.emoji ?? <FileText className="size-5 text-muted-foreground" />}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto p-1.5">
                  <div className="grid grid-cols-8 gap-0.5">
                    {PAGE_EMOJIS.map((e) => (
                      <button
                        key={e}
                        onClick={() => setEmoji(e)}
                        className="flex size-7 items-center justify-center rounded text-lg leading-none hover:bg-white/[0.1]"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setEmoji(null)}
                    className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-white/[0.06]"
                  >
                    {t('notes.removeIcon')}
                  </button>
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onFocus={() => (titleFocused.current = true)}
                onBlur={() => void commitTitle().catch(() => {})}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                placeholder={t('notes.untitled')}
                className="min-w-0 flex-1 bg-transparent text-xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
              />
            </div>
            {stale && (
              <button
                onClick={reload}
                className="flex items-center gap-1.5 hairline-b bg-primary/10 px-3 py-1 text-left text-xs text-primary hover:bg-primary/15"
              >
                <RotateCw className="size-3 shrink-0" /> {t('notes.staleReload')}
              </button>
            )}
            <div className="min-h-0 flex-1">
              {revealed && doc.loaded ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      {t('notes.loadingEditor')}
                    </div>
                  }
                >
                  <NotesEditor
                    key={`${scope}:${scopeId}:${selectedId}:${doc.version}`}
                    pageId={selectedId}
                    value={doc.content}
                    onChange={saveBody}
                    onFocusChange={(f) => (focusedRef.current = f)}
                    imageScope={{ scope, id: scopeId }}
                    initialScrollTop={scrollTopRef.current}
                    onScroll={onEditorScroll}
                  />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t('notes.loading')}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <div className="flex size-12 items-center justify-center rounded-xl bg-white/[0.04] text-muted-foreground">
                <FileText className="size-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/90">
                  {scope === 'project' ? t('notes.projectNotes') : t('notes.notes')}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {rootPages.length ? t('notes.chooseOrCreate') : t('notes.startCreate')}
                </p>
              </div>
            </div>
            {rootPages.length > 0 && (
              <div className="flex max-h-56 w-full max-w-xs flex-col gap-1 overflow-y-auto">
                {rootPages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => selectPage(p.id)}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground/90 hover:bg-white/[0.06]"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-base leading-none">
                      {p.emoji ?? <FileText className="size-4 text-muted-foreground" />}
                    </span>
                    <span className="truncate">{p.title}</span>
                  </button>
                ))}
              </div>
            )}
            <Button variant="secondary" size="sm" onClick={() => create(null)}>
              {t('notes.newPage')}
            </Button>
          </div>
        )}
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title={t('notes.deleteConfirmTitle', {
            title: pages.find((p) => p.id === pendingDelete)?.title || t('notes.untitled'),
          })}
          message={
            pages.some((p) => p.parentId === pendingDelete)
              ? t('notes.deleteConfirmSubtree')
              : t('notes.deleteConfirmLeaf')
          }
          confirmLabel={t('common.delete')}
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  )
}

export const NotesPanel = memo(NotesPanelImpl)
