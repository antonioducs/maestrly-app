/** Lazy Milkdown editor with Markdown, Mermaid, search, and external-link handling.
 * Flush edits on blur and preserve focus/scroll coordination with the parent notebook. */
import { useEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { commandsCtx, editorViewCtx, prosePluginsCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { codeBlockSchema, clearTextInCurrentBlockCommand, addBlockTypeCommand } from '@milkdown/kit/preset/commonmark'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { Fragment, type Node as ProseNode, type Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import { renderMermaid, mermaidError } from '@/lib/mermaid'
import { i18n } from '@/lib/i18n'
import type { NotesScope } from '../../../preload'
import {
  notesSearchPlugin,
  setSearch,
  clearSearch,
  goToMatch,
  replaceCurrent,
  replaceAll,
  type SearchOpts,
  type SearchSnapshot,
} from '@/lib/notes-search'
import { NotesSearchPanel } from '@/components/notes/NotesSearchPanel'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame-dark.css'

const previewTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()
const previewSeq = new WeakMap<object, number>()
let previewGlobalSeq = 0
function scheduleMermaidPreview(content: string, applyPreview: (html: string) => void): void {
  const prev = previewTimers.get(applyPreview)
  if (prev) clearTimeout(prev)
  previewTimers.set(
    applyPreview,
    setTimeout(() => {
      const seq = ++previewGlobalSeq
      previewSeq.set(applyPreview, seq)
      const ok = (html: string) => {
        if (previewSeq.get(applyPreview) === seq) applyPreview(html)
      }
      renderMermaid(content)
        .then(ok)
        .catch((e) => ok(mermaidError(e)))
    }, 300)
  )
}

// Intercept external link clicks in ProseMirror and open them through the system browser.

const linkOpenPlugin = new Plugin({
  props: {
    handleClick(_view, _pos, event) {
      const a = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      const href = a?.getAttribute('href') ?? ''
      if (!/^(https?:|mailto:)/i.test(href)) return false
      event.preventDefault()
      void window.api.openExternalUrl(href)
      return true
    },
  },
})

function cleanCopiedMarkdown(md: string): string {
  return md
    .replace(/\\([\\`*_{}[\]()#+.!>~|-])/g, '$1')
    .replace(/\n{3,}$/g, '\n')
    .trimEnd()
}

const DIAGRAM_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z"/></svg>'

const ACCEPTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

async function persistNoteImage(
  scope: NotesScope,
  id: string,
  file: File,
  onError: (msg: string) => void
): Promise<string | null> {
  const label = file.name || i18n.t('ui:notesEditor.imageFallbackName')
  if (!ACCEPTED_IMAGE_MIME.has(file.type)) {
    onError(i18n.t('ui:notesEditor.imageUnsupported', { name: label }))
    return null
  }
  if (file.size > MAX_IMAGE_BYTES) {
    onError(i18n.t('ui:notesEditor.imageTooBig', { name: label }))
    return null
  }
  try {
    const res = await window.api.uploadNoteImage(scope, id, file.type, await file.arrayBuffer())
    if (res.ok) return res.relPath
    onError(res.error)
  } catch {
    onError(i18n.t('ui:notesEditor.imageSaveFailed', { name: label }))
  }
  return null
}

async function filesToImageNodes(
  files: File[],
  schema: Schema,
  scope: NotesScope,
  id: string,
  onError: (msg: string) => void
): Promise<ProseNode[]> {
  const nodes: ProseNode[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const rel = await persistNoteImage(scope, id, file, onError)
    if (!rel) continue
    const node = schema.nodes['image']?.createAndFill({
      src: rel,
      alt: file.name || i18n.t('ui:notesEditor.imageFallbackName'),
    })
    if (node) nodes.push(node)
  }
  return nodes
}

function imageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const fromItems: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) fromItems.push(f)
    }
  }
  if (fromItems.length) return fromItems
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'))
}

type ImagePastePlaceholderAction =
  | { add: { id: symbol; pos: number }; remove?: never }
  | { add?: never; remove: { id: symbol } }

interface Props {
  pageId: string
  value: string
  onChange: (pageId: string, markdown: string) => void
  onFocusChange?: (focused: boolean) => void

  imageScope?: { scope: NotesScope; id: string }

  initialScrollTop?: number

  onScroll?: (scrollTop: number) => void
}

function uniqueElements(elements: Array<HTMLElement | null | undefined>): HTMLElement[] {
  return Array.from(new Set(elements.filter((el): el is HTMLElement => Boolean(el))))
}

function collectScrollTargets(root: HTMLElement): HTMLElement[] {
  const directMilkdown = root.querySelector<HTMLElement>(':scope > .milkdown')
  const milkdownEls = Array.from(root.querySelectorAll<HTMLElement>('.milkdown'))
  const proseMirror = root.querySelector<HTMLElement>('.ProseMirror')
  const proseAncestors: HTMLElement[] = []
  for (let el = proseMirror?.parentElement; el && root.contains(el); el = el.parentElement) {
    proseAncestors.push(el)
    if (el === root) break
  }
  return uniqueElements([directMilkdown, ...milkdownEls, ...proseAncestors, root])
}

function applyScrollTop(targets: HTMLElement[], top: number): void {
  for (const el of targets) {
    if (el.scrollTop !== top) el.scrollTop = top
  }
}

function readScrollTop(targets: HTMLElement[]): number {
  return targets.reduce((max, el) => Math.max(max, el.scrollTop), 0)
}

export function NotesEditor({ pageId, value, onChange, onFocusChange, imageScope, initialScrollTop, onScroll }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onFocusRef = useRef(onFocusChange)
  onFocusRef.current = onFocusChange
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  const initialScrollRef = useRef(initialScrollTop)
  const scrollTargetsRef = useRef<HTMLElement[]>([])

  const imageScopeRef = useRef(imageScope)
  imageScopeRef.current = imageScope

  const [imgError, setImgError] = useState<string | null>(null)
  const imgErrTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showImgError = useRef<(msg: string) => void>(() => {})
  showImgError.current = (msg: string) => {
    setImgError(msg)
    clearTimeout(imgErrTimer.current)
    imgErrTimer.current = setTimeout(() => setImgError(null), 4500)
  }

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showCopied = useRef<() => void>(() => {})
  showCopied.current = () => {
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  const viewRef = useRef<EditorView | null>(null)
  const [viewReady, setViewReady] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  searchOpenRef.current = searchOpen
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [opts, setOpts] = useState<SearchOpts>({ caseSensitive: false, wholeWord: false, regex: false })
  const [replaceMode, setReplaceMode] = useState(false)
  const [snapshot, setSnapshot] = useState<SearchSnapshot>({ count: 0, current: 0, error: null })
  const [focusSignal, setFocusSignal] = useState(0)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let destroyed = false
    let ready = false
    let live: Crepe | null = null
    const crepe = new Crepe({
      root: el,
      defaultValue: value,

      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: i18n.t('ui:notesEditor.placeholder') },
        [Crepe.Feature.BlockEdit]: {
          buildMenu: (builder) => {
            builder.getGroup('advanced').addItem('mermaid', {
              label: i18n.t('ui:notesEditor.diagramMermaid'),
              icon: DIAGRAM_ICON,
              onRun: (ctx) => {
                const commands = ctx.get(commandsCtx)
                const codeBlock = codeBlockSchema.type(ctx)
                commands.call(clearTextInCurrentBlockCommand.key)
                commands.call(addBlockTypeCommand.key, { nodeType: codeBlock, attrs: { language: 'mermaid' } })
              },
            })
          },
        },
        [Crepe.Feature.CodeMirror]: {
          previewLoading: i18n.t('ui:notesEditor.renderingDiagram'),

          onCopy: () => showCopied.current(),

          renderPreview: (language: string, content: string, applyPreview: (html: string) => void) => {
            if (language?.toLowerCase() === 'mermaid' && content.trim()) {
              scheduleMermaidPreview(content, applyPreview)

              return undefined
            }
            return null
          },
        },

        ...(imageScope
          ? {
              [Crepe.Feature.ImageBlock]: {
                onUpload: async (file: File): Promise<string> => {
                  const s = imageScopeRef.current
                  if (!s) return ''
                  return (await persistNoteImage(s.scope, s.id, file, (m) => showImgError.current(m))) ?? ''
                },
                proxyDomURL: async (url: string): Promise<string> => {
                  const s = imageScopeRef.current
                  if (!url || !s || /^(https?:|data:|blob:)/i.test(url)) return url
                  return (await window.api.readNoteAsset(s.scope, s.id, url)) || url
                },
              },
            }
          : {}),
      },
    })

    crepe.editor.config((ctx) => {
      const cleanClipboard = new Plugin({
        props: {
          clipboardTextSerializer: (slice) => {
            const doc = ctx.get(schemaCtx).topNodeType.createAndFill(undefined, slice.content)
            if (doc) {
              const md = cleanCopiedMarkdown(ctx.get(serializerCtx)(doc))
              if (md) return md
            }
            return slice.content.textBetween(0, slice.content.size, '\n\n')
          },
        },
      })
      ctx.update(prosePluginsCtx, (prev) => [cleanClipboard, ...prev, notesSearchPlugin(setSnapshot), linkOpenPlugin])
    })

    if (imageScope) {
      crepe.editor.config((ctx) => {
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader: async (files: FileList, schema: Schema): Promise<ProseNode[]> => {
            const s = imageScopeRef.current
            if (!s) return []
            return filesToImageNodes(Array.from(files), schema, s.scope, s.id, (m) => showImgError.current(m))
          },
        }))
      })
      const imagePastePluginKey = new PluginKey<DecorationSet>('NOTES_IMAGE_PASTE')
      const imagePastePlugin = new Plugin({
        key: imagePastePluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const next = set.map(tr.mapping, tr.doc)
            const action = tr.getMeta(imagePastePluginKey) as ImagePastePlaceholderAction | undefined
            if (action?.add) {
              const placeholder = Decoration.widget(action.add.pos, () => document.createElement('span'), {
                id: action.add.id,
              })
              return next.add(tr.doc, [placeholder])
            }
            if (action?.remove) {
              return next.remove(next.find(undefined, undefined, (spec) => spec.id === action.remove.id))
            }
            return next
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
          handlePaste: (view, event): boolean => {
            const s = imageScopeRef.current
            if (!s) return false
            const files = imageFilesFromClipboard(event.clipboardData)
            if (!files.length) return false
            const placeholderId = Symbol('notes image paste')
            const addPlaceholder: ImagePastePlaceholderAction = {
              add: { id: placeholderId, pos: view.state.selection.from },
            }
            view.dispatch(view.state.tr.setMeta(imagePastePluginKey, addPlaceholder))
            void (async () => {
              const nodes = await filesToImageNodes(files, view.state.schema, s.scope, s.id, (m) =>
                showImgError.current(m)
              )
              if (view.isDestroyed) return
              const decorations = imagePastePluginKey.getState(view.state)
              const pos = decorations?.find(undefined, undefined, (spec) => spec.id === placeholderId)[0]?.from ?? -1
              if (pos < 0) return
              const removePlaceholder: ImagePastePlaceholderAction = { remove: { id: placeholderId } }
              const tr = nodes.length
                ? view.state.tr.replaceWith(pos, pos, Fragment.fromArray(nodes)).scrollIntoView()
                : view.state.tr
              view.dispatch(tr.setMeta(imagePastePluginKey, removePlaceholder))
            })()
            return true
          },
        },
      })
      crepe.editor.config((ctx) => {
        ctx.update(prosePluginsCtx, (prev) => [imagePastePlugin, ...prev])
      })
    }
    crepe.on((l) => {
      l.markdownUpdated((_ctx, md) => {
        if (ready) onChangeRef.current(pageId, md)
      })
      l.focus(() => onFocusRef.current?.(true))

      l.blur(() => {
        if (!searchOpenRef.current) onFocusRef.current?.(false)
      })
    })

    const handleScroll = (e: Event) => onScrollRef.current?.((e.currentTarget as HTMLElement).scrollTop)
    crepe
      .create()
      .then(() => {
        if (destroyed) {
          void crepe.destroy()
          return
        }
        live = crepe
        viewRef.current = crepe.editor.action((ctx) => ctx.get(editorViewCtx))
        setViewReady(true)
        ready = true
        const scrollTargets = collectScrollTargets(el)
        scrollTargetsRef.current = scrollTargets
        const top = initialScrollRef.current
        if (top) {
          const restore = () => {
            applyScrollTop(scrollTargets, top)
            onScrollRef.current?.(readScrollTop(scrollTargets))
          }
          restore()

          requestAnimationFrame(() => {
            if (!destroyed) restore()
          })
          setTimeout(() => {
            if (!destroyed) restore()
          }, 120)
        }
        for (const target of scrollTargets) target.addEventListener('scroll', handleScroll, { passive: true })
      })
      .catch((e) => console.error('[notes] Crepe failed:', e))
    return () => {
      destroyed = true
      viewRef.current = null
      clearTimeout(imgErrTimer.current)
      clearTimeout(copiedTimer.current)
      for (const target of scrollTargetsRef.current) target.removeEventListener('scroll', handleScroll)
      scrollTargetsRef.current = []
      if (live) void live.destroy()
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    if (searchOpen && query) setSearch(v, query, opts)
    else clearSearch(v)
  }, [query, opts, searchOpen, viewReady])

  useEffect(() => {
    if (searchOpen) onFocusRef.current?.(true)
  }, [searchOpen])

  const openSearch = () => {
    setSearchOpen(true)
    setFocusSignal((n) => n + 1)
  }
  const closeSearch = () => {
    setSearchOpen(false)
    const v = viewRef.current
    if (v)
      v.focus() // Restore editor focus and notify onFocusChange.
    else onFocusRef.current?.(false)
  }

  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      e.stopPropagation()
      openSearch()
    } else if (e.key === 'Escape' && searchOpenRef.current) {
      e.preventDefault()
      e.stopPropagation()
      closeSearch()
    }
  }

  const withView = (fn: (v: EditorView) => void) => () => {
    const v = viewRef.current
    if (v) fn(v)
  }

  return (
    <div className="relative h-full min-h-0" onKeyDownCapture={onKeyDownCapture}>
      {imgError && (
        <div className="absolute inset-x-2 top-2 z-10 rounded-md border border-status-error/30 bg-status-error/15 px-3 py-1.5 text-xs text-status-error shadow-sm backdrop-blur">
          {imgError}
        </div>
      )}
      {copied && (
        <div className="absolute right-2 top-2 z-10 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-400 shadow-sm backdrop-blur">
          {i18n.t('ui:notesEditor.codeCopied')}
        </div>
      )}
      <div ref={rootRef} className="milkdown-notes h-full" />
      {searchOpen && (
        <NotesSearchPanel
          query={query}
          replacement={replacement}
          opts={opts}
          snapshot={snapshot}
          replaceMode={replaceMode}
          focusSignal={focusSignal}
          onQueryChange={setQuery}
          onReplacementChange={setReplacement}
          onOptsChange={setOpts}
          onToggleReplace={() => setReplaceMode((m) => !m)}
          onPrev={withView((v) => goToMatch(v, -1))}
          onNext={withView((v) => goToMatch(v, 1))}
          onReplace={withView((v) => replaceCurrent(v, replacement))}
          onReplaceAll={withView((v) => replaceAll(v, replacement))}
          onClose={closeSearch}
        />
      )}
    </div>
  )
}
