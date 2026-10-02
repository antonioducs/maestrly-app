import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type BotWorkspaceMode = 'chat' | 'split' | 'computer'
type Pane = 'chat' | 'computer'
const DEFAULT_RATIO = 45
const CHAT_MIN = 360
const COMPUTER_MIN = 480
export const BOT_WORKSPACE_SEPARATOR_WIDTH = 6

function savedRatio(key: string): number {
  try {
    const saved = localStorage.getItem(key)
    if (saved === null || saved.trim() === '') return DEFAULT_RATIO
    const value = Number(saved)
    return Number.isFinite(value) && value > 0 && value < 100 ? value : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

/** The owning workspace is keyed by server and bot; only its preferred split ratio survives remounting. */
export function useBotWorkspaceLayout(server: string | null, botId: string, initialMode: BotWorkspaceMode) {
  const storageKey = `fleet.botWorkspace.v1:${JSON.stringify([server, botId])}`
  const [ratio, setPreferredRatio] = useState(() => savedRatio(storageKey))
  const [mode, setMode] = useState(initialMode)
  const [lastVisiblePane, setLastVisiblePane] = useState<Pane>(initialMode === 'chat' ? 'chat' : 'computer')
  const [computerOpened, setComputerOpened] = useState(initialMode !== 'chat')
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const node = container.current
    if (!node) return
    const measure = () => {
      const next = node.getBoundingClientRect().width
      // Settings hides this workspace. Keep its last measurement until it is shown again.
      if (next > 0) setWidth(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(ratio))
    } catch {
      // Layout remains usable when preferences cannot be saved.
    }
  }, [storageKey, ratio])

  const panelWidth = Math.max(1, width - BOT_WORKSPACE_SEPARATOR_WIDTH)
  const narrow = panelWidth < CHAT_MIN + COMPUTER_MIN
  const minRatio = narrow ? DEFAULT_RATIO : (CHAT_MIN / panelWidth) * 100
  const maxRatio = narrow ? DEFAULT_RATIO : 100 - (COMPUTER_MIN / panelWidth) * 100
  const shownRatio = Math.min(maxRatio, Math.max(minRatio, ratio))
  const setRatio = (next: number) => {
    if (!narrow && Number.isFinite(next)) setPreferredRatio(Math.min(maxRatio, Math.max(minRatio, next)))
  }
  const openComputer = useCallback(() => {
    setComputerOpened(true)
    setMode((current) => (current === 'chat' ? 'split' : current))
    setLastVisiblePane('computer')
  }, [])
  const closeComputer = useCallback(() => {
    setMode('chat')
    setLastVisiblePane('chat')
  }, [])
  const maximize = () => {
    setMode('computer')
    setLastVisiblePane('computer')
  }
  const restore = () => {
    setMode('split')
    setLastVisiblePane('chat')
  }
  return {
    container,
    mode,
    ratio: shownRatio,
    minRatio,
    maxRatio,
    chatWidth: (panelWidth * shownRatio) / 100,
    computerOpened,
    narrow,
    lastVisiblePane,
    showChat: mode === 'chat' || (mode === 'split' && (!narrow || lastVisiblePane === 'chat')),
    showComputer: mode === 'computer' || (mode === 'split' && (!narrow || lastVisiblePane === 'computer')),
    setRatio,
    openComputer,
    closeComputer,
    maximize,
    restore,
    showPane: setLastVisiblePane,
  }
}

export type BotWorkspaceLayout = ReturnType<typeof useBotWorkspaceLayout>
