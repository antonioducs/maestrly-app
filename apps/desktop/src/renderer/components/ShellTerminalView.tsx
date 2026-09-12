/** Own an xterm instance for a local shell session. Fit and repaint after visibility changes;
 * dispose renderer resources without confusing them with the main-process PTY lifecycle. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PtyOutputSnapshot, PtyStreamMeta } from '../../shared/pty'
import { i18n } from '@/lib/i18n'
import { TERMINAL_SEARCH_OPTIONS, isTerminalSearchShortcut } from '@/lib/terminal-search'
import { TerminalSearchBar } from '@/components/TerminalSearchBar'

interface Props {
  agentId: string

  visible?: boolean

  onOscTitle?: (agentId: string, title: string) => void
}

export function ShellTerminalView({ agentId, visible = true, onOscTitle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Keep terminal handles available for repainting when the panel becomes visible.
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState({ index: -1, total: 0 })
  const [searchFocusSignal, setSearchFocusSignal] = useState(0)
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen

  const onOscTitleRef = useRef(onOscTitle)
  onOscTitleRef.current = onOscTitle

  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setSearchResult({ index: -1, total: 0 })
    termRef.current?.focus()
  }, [])

  const findNext = useCallback(() => {
    if (searchQuery) searchRef.current?.findNext(searchQuery, TERMINAL_SEARCH_OPTIONS)
  }, [searchQuery])

  const findPrevious = useCallback(() => {
    if (searchQuery) searchRef.current?.findPrevious(searchQuery, TERMINAL_SEARCH_OPTIONS)
  }, [searchQuery])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#e6e8ef',
        cursor: '#EDEAE3',
        cursorAccent: '#0A0A0B',
        selectionBackground: 'rgba(237,234,227,0.30)',
      },
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    const searchDisposable = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResult({ index: resultIndex, total: resultCount })
    })

    term.attachCustomKeyEventHandler((event) => {
      if (!isTerminalSearchShortcut(event, window.api.platformInfo.os)) return true
      event.preventDefault()
      setSearchOpen(true)
      setSearchFocusSignal((signal) => signal + 1)
      return false
    })
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !visibleRef.current || !searchOpenRef.current) return
      event.preventDefault()
      event.stopPropagation()
      closeSearch()
    }
    window.addEventListener('keydown', onWindowKeyDown, true)

    const titleDisposable = term.onTitleChange((title) => onOscTitleRef.current?.(agentId, title))

    const oscBg = term.parser.registerOscHandler(11, () => true)
    const oscBgReset = term.parser.registerOscHandler(111, () => true)

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose()) // Fall back to DOM rendering if the GPU context is lost.
      term.loadAddon(webgl)
    } catch {}

    const safeFit = () => {
      if (host.clientHeight > 0 && host.clientWidth > 0) fit.fit()
    }
    safeFit()
    let disposed = false
    if (visible) term.focus()

    let ready = false
    let replayGeneration: number | null = null
    let replayWatermark = 0
    const replayQueue: Array<{ data: string; meta: PtyStreamMeta }> = []
    let gotData = false

    const acceptGeneration = (generation: number): boolean => {
      if (replayGeneration !== null && generation < replayGeneration) return false
      if (replayGeneration !== null && generation > replayGeneration) {
        term.reset()
        replayGeneration = generation
        replayWatermark = 0
        gotData = false
      } else if (replayGeneration === null) {
        replayGeneration = generation
      }
      return true
    }

    const writeLive = (data: string, meta: PtyStreamMeta) => {
      if (!acceptGeneration(meta.generation) || meta.sequence <= replayWatermark) return
      replayWatermark = meta.sequence
      term.write(data)
      onFirstData()
    }

    const onFirstData = () => {
      if (gotData) return
      gotData = true
      if (!visibleRef.current) return
      term.focus()
    }
    const offData = window.api.onPtyData(agentId, (data, meta) => {
      if (!meta) {
        if (!ready) return
        term.write(data)
        onFirstData()
        return
      }
      if (!ready) {
        replayQueue.push({ data, meta })
        return
      }
      writeLive(data, meta)
    })
    void window.api.readTerminal(agentId).then((rawSnapshot) => {
      if (disposed) return
      const snapshot = (
        typeof rawSnapshot === 'string' ? { data: rawSnapshot, generation: 0, sequence: 0 } : rawSnapshot
      ) as PtyOutputSnapshot
      const newerQueuedGeneration = replayQueue.reduce(
        (max, event) => Math.max(max, event.meta.generation),
        snapshot.generation
      )

      if (snapshot.data && newerQueuedGeneration === snapshot.generation) {
        replayGeneration = snapshot.generation
        replayWatermark = snapshot.sequence
        term.write(snapshot.data)
        onFirstData()
      }
      ready = true
      if (newerQueuedGeneration > snapshot.generation) {
        replayGeneration = newerQueuedGeneration
        replayWatermark = 0
      } else if (replayGeneration === null) {
        replayGeneration = snapshot.generation
        replayWatermark = snapshot.sequence
      }
      for (const event of replayQueue) writeLive(event.data, event.meta)
      replayQueue.length = 0
    })

    const offExit = window.api.onPtyExit(agentId, (code, generation) => {
      if (ready && generation !== undefined && !acceptGeneration(generation)) return
      if (!gotData) return
      term.write(`\r\n\x1b[90m${i18n.t('ui:terminal.processEnded', { code })}\x1b[0m\r\n`)
    })
    const dataDisposable = term.onData((data) => window.api.writePty(agentId, data))

    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleFit = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // box.
        if (!visibleRef.current) return
        if (host.clientHeight <= 0 || host.clientWidth <= 0) return
        fit.fit()
        window.api.resizePty(agentId, term.cols, term.rows)
        term.refresh(0, term.rows - 1) // Repaint the buffer after returning from display:none.
      }, 60)
    }
    const ro = new ResizeObserver(scheduleFit)
    ro.observe(host)

    window.addEventListener('resize', scheduleFit)

    const offFocus = window.api.onTerminalFocus((id) => {
      if (id === agentId) term.focus()
    })

    const onWindowFocus = () => {
      if (visibleRef.current) term.focus()
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      ro.disconnect()
      window.removeEventListener('resize', scheduleFit)
      window.removeEventListener('keydown', onWindowKeyDown, true)
      window.removeEventListener('focus', onWindowFocus)
      offData()
      offExit()
      offFocus()
      titleDisposable.dispose()
      oscBg.dispose()
      oscBgReset.dispose()
      dataDisposable.dispose()
      searchDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [agentId])

  useEffect(() => {
    const search = searchRef.current
    if (!search) return
    if (searchOpen && searchQuery) search.findNext(searchQuery, TERMINAL_SEARCH_OPTIONS)
    else {
      search.clearDecorations()
      setSearchResult({ index: -1, total: 0 })
    }
  }, [searchOpen, searchQuery])

  useEffect(() => {
    if (visible) return
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setSearchResult({ index: -1, total: 0 })
  }, [visible])

  // When the host becomes visible again, fit and repaint its restored dimensions.

  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      const host = hostRef.current
      const term = termRef.current
      const fit = fitRef.current
      if (!host || !term || !fit || host.clientHeight <= 0 || host.clientWidth <= 0) return
      fit.fit()
      window.api.resizePty(agentId, term.cols, term.rows)
      term.refresh(0, term.rows - 1)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, agentId])

  return (
    <div className="relative h-full w-full">
      <div className="h-full w-full bg-terminal-bg px-3 py-2.5">
        <div
          className="h-full w-full"
          ref={hostRef}
          onMouseDown={() => hostRef.current?.querySelector('textarea')?.focus()}
        />
      </div>
      {searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          index={searchResult.index}
          total={searchResult.total}
          focusSignal={searchFocusSignal}
          onQueryChange={setSearchQuery}
          onPrev={findPrevious}
          onNext={findNext}
          onClose={closeSearch}
        />
      )}
    </div>
  )
}
