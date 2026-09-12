import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { Conversation } from '../../preload'
import type { Tab as DrawerTab } from '@/components/Drawer'
import { defaultDrawerShortcut, formatAccelerator } from '../../shared/shortcuts'
import {
  DEFAULT_MAIN_ORDER,
  mainTabsForContext,
  mainTabsForFeatures,
  reorderVisibleTabs,
  tabAvailableInContext,
} from '@/lib/drawer-tabs'

const MIN_DRAWER = 360

// Keep the conversation header actions inside the chat when restoring a split drawer.
const MIN_MAIN = 280
const DEFAULT_DRAWER = 640

type UseDrawerStateParams = {
  active: Conversation | null
  mainRef: RefObject<HTMLElement | null>
  setMountedConvs: Dispatch<SetStateAction<Conversation[]>>
}

export function useDrawerState({ active, mainRef, setMountedConvs }: UseDrawerStateParams) {
  const shortcutOs = window.api.platformInfo.os
  const [drawerShortcutLabel, setDrawerShortcutLabel] = useState(() =>
    formatAccelerator(defaultDrawerShortcut(shortcutOs), shortcutOs)
  )
  useEffect(() => {
    const apply = (state: {
      os: typeof shortcutOs
      drawer: { key: string; mods: Array<'meta' | 'control' | 'alt' | 'shift'> }
    }) => setDrawerShortcutLabel(formatAccelerator(state.drawer, state.os))
    void window.api
      .getShortcuts()
      .then(apply)
      .catch(() => undefined)
    return window.api.onShortcutsChanged(apply)
  }, [shortcutOs])
  const [chatGptWebEnabled, setChatGptWebEnabled] = useState(false)
  const chatGptWebEnabledRef = useRef(false)
  chatGptWebEnabledRef.current = chatGptWebEnabled
  useEffect(() => {
    let alive = true
    const apply = (status: { enabled: boolean }) => {
      if (alive) setChatGptWebEnabled(status.enabled)
    }
    void window.api
      .chatGptWebStatus()
      .then(apply)
      .catch(() => setChatGptWebEnabled(false))
    const off = window.api.onChatGptWebStatus(apply)
    return () => {
      alive = false
      off()
    }
  }, [])

  const [drawerOpenByConv, setDrawerOpenByConv] = useState<Record<string, boolean>>({})
  const drawerOpen = active ? (drawerOpenByConv[active.id] ?? false) : false
  const activeRef = useRef<Conversation | null>(null)
  activeRef.current = active
  const setDrawerOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const id = activeRef.current?.id
    if (!id) return
    setDrawerOpenByConv((prev) => {
      const cur = prev[id] ?? false
      const next = typeof v === 'function' ? v(cur) : v
      return next === cur ? prev : { ...prev, [id]: next }
    })
  }, [])

  const [drawerTabByConv, setDrawerTabByConv] = useState<Record<string, DrawerTab>>({})
  const setActiveDrawerTab = useCallback((t: DrawerTab) => {
    const active = activeRef.current
    const id = active?.id
    if (id && tabAvailableInContext(t, active, chatGptWebEnabledRef.current)) {
      setDrawerTabByConv((prev) => (prev[id] === t ? prev : { ...prev, [id]: t }))
    }
  }, [])

  const [mainTabOrderByConv, setMainTabOrderByConv] = useState<Record<string, DrawerTab[]>>({})
  const mainTabOrder = active
    ? mainTabsForContext(mainTabOrderByConv[active.id] ?? DEFAULT_MAIN_ORDER, active, chatGptWebEnabled)
    : mainTabsForFeatures(DEFAULT_MAIN_ORDER, chatGptWebEnabled)
  const requestedDrawerTab = active ? drawerTabByConv[active.id] : undefined
  const drawerTab =
    active && requestedDrawerTab && tabAvailableInContext(requestedDrawerTab, active, chatGptWebEnabled)
      ? requestedDrawerTab
      : mainTabOrder[0]

  const mainTabOrderRef = useRef(mainTabOrderByConv)
  mainTabOrderRef.current = mainTabOrderByConv
  const reorderMainTabs = useCallback((from: number, to: number) => {
    const id = activeRef.current?.id
    if (!id) return
    const full = mainTabOrderRef.current[id] ?? DEFAULT_MAIN_ORDER
    const visible = mainTabsForContext(full, activeRef.current, chatGptWebEnabledRef.current)
    const next = reorderVisibleTabs(full, visible, from, to)
    if (next === full) return
    window.api.setConvMainTabOrder(id, next)
    setMainTabOrderByConv((prev) => ({ ...prev, [id]: next }))
  }, [])

  const forgetConvDrawerState = useCallback((id: string) => {
    const drop = <T>(prev: Record<string, T>): Record<string, T> => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    }
    setDrawerOpenByConv(drop)
    setDrawerTabByConv(drop)
    setDrawerWidthByConv(drop)
    setMountedConvs((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const [drawerWidthByConv, setDrawerWidthByConv] = useState<Record<string, number>>({})
  const drawerWidth = active ? (drawerWidthByConv[active.id] ?? DEFAULT_DRAWER) : DEFAULT_DRAWER
  const setDrawerWidth = useCallback((w: number) => {
    const id = activeRef.current?.id
    if (id) setDrawerWidthByConv((prev) => (prev[id] === w ? prev : { ...prev, [id]: w }))
  }, [])

  const [drawerFullByConv, setDrawerFullByConv] = useState<Record<string, boolean>>({})
  const drawerFull = active ? (drawerFullByConv[active.id] ?? false) : false
  const toggleDrawerFull = useCallback(() => {
    const id = activeRef.current?.id
    if (id) setDrawerFullByConv((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))
  }, [])

  const fullActive = drawerFull && drawerOpen
  const dragging = useRef(false)

  useEffect(() => {
    return window.api.onToggleDrawerShortcut((convId) => {
      setDrawerOpenByConv((prev) => ({ ...prev, [convId]: !(prev[convId] ?? false) }))
    })
  }, [])

  useEffect(() => {
    const offFocus = window.api.onDrawerTerminalFocus(({ convId }) => {
      setDrawerOpenByConv((prev) => (prev[convId] ? prev : { ...prev, [convId]: true }))
      setDrawerTabByConv((prev) => (prev[convId] === 'terminal' ? prev : { ...prev, [convId]: 'terminal' }))
    })
    return () => {
      offFocus()
    }
  }, [])

  useEffect(() => {
    return window.api.onChatGptWebOpen((convId) => {
      setDrawerOpenByConv((prev) => (prev[convId] ? prev : { ...prev, [convId]: true }))
      setDrawerTabByConv((prev) => (prev[convId] === 'chatgpt' ? prev : { ...prev, [convId]: 'chatgpt' }))
    })
  }, [])

  useEffect(() => {
    return window.api.onDebugEnsureVscode((convId) => {
      setDrawerTabByConv((prev) => (prev[convId] === 'vscode' ? prev : { ...prev, [convId]: 'vscode' }))
      setDrawerOpenByConv((prev) => (prev[convId] ? prev : { ...prev, [convId]: true }))
    })
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return

      const left = mainRef.current?.getBoundingClientRect().left ?? 0
      const maxDrawer = Math.max(MIN_DRAWER, window.innerWidth - left - MIN_MAIN)
      const w = Math.min(maxDrawer, Math.max(MIN_DRAWER, window.innerWidth - e.clientX))
      setDrawerWidth(w)
    }
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    const id = active?.id
    if (!id || drawerFull) return
    const clampToMax = () => {
      const left = mainRef.current?.getBoundingClientRect().left ?? 0
      const max = Math.max(MIN_DRAWER, window.innerWidth - left - MIN_MAIN)
      setDrawerWidthByConv((prev) => {
        const cur = prev[id] ?? DEFAULT_DRAWER
        const capped = Math.min(cur, max)
        return capped === cur ? prev : { ...prev, [id]: capped }
      })
    }
    clampToMax()
    window.addEventListener('resize', clampToMax)
    return () => window.removeEventListener('resize', clampToMax)
  }, [active?.id, drawerFull])

  return {
    drawerOpenByConv,
    setDrawerOpenByConv,
    drawerOpen,
    setDrawerOpen,
    drawerTabByConv,
    setDrawerTabByConv,
    drawerTab,
    setActiveDrawerTab,
    mainTabOrderByConv,
    setMainTabOrderByConv,
    mainTabOrder,
    reorderMainTabs,
    forgetConvDrawerState,
    drawerWidthByConv,
    setDrawerWidthByConv,
    drawerWidth,
    setDrawerWidth,
    drawerFullByConv,
    setDrawerFullByConv,
    drawerFull,
    toggleDrawerFull,
    fullActive,
    dragging,
    chatGptWebEnabled,
    drawerShortcutLabel,
  }
}
