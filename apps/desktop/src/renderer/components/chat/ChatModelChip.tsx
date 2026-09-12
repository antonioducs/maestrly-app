import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isChatProviderConnected } from '../../../shared/chat'
import type { ChatConfig, ChatModelRef } from '../../../shared/chat'

interface Props {
  conversationId?: string
  value?: ChatModelRef | null
  onSelect?: (selection: ChatModelRef) => void | Promise<void>

  providerFilter?: (providerId: string) => boolean

  avoidOverflow?: boolean
  refreshToken?: number
  onChange?: (sel: ChatModelRef) => void
}

export interface ChatModelChipHandle {
  open(): void
}

interface Row {
  providerId: string
  providerName: string
  modelId: string
}

let rowsCache: Row[] | null = null

async function fetchRows(): Promise<{ config: ChatConfig; rows: Row[] }> {
  const config = await window.api.chatConfig()
  const connected = config.providers.filter(isChatProviderConnected)
  const lists = await Promise.all(
    connected.map((p) =>
      window.api
        .chatModels(p.id)
        .then((models) => models.map((m) => ({ providerId: p.id, providerName: p.name, modelId: m })))
        .catch(() => [] as Row[])
    )
  )
  const rows = lists.flat()
  rowsCache = rows
  return { config, rows }
}

export const ChatModelChip = forwardRef<ChatModelChipHandle, Props>(function ChatModelChip(
  { conversationId, value, onSelect, providerFilter, avoidOverflow = false, refreshToken, onChange },
  ref
) {
  const { t } = useTranslation('chat')
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [conversationSel, setConversationSel] = useState<ChatModelRef | null>(null)
  const controlled = conversationId === undefined
  const sel = controlled ? (value ?? null) : conversationSel
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [rows, setRows] = useState<Row[]>(() => rowsCache ?? [])
  const [loading, setLoading] = useState(false)
  const [hiddenModels, setHiddenModels] = useState<Record<string, string[]> | null>(null)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusSearch = useCallback(() => {
    setTimeout(() => searchRef.current?.focus(), 0)
  }, [])
  const positionPanel = useCallback(() => {
    if (!avoidOverflow) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(320, window.innerWidth - 16)
    const estimatedHeight = Math.min(420, window.innerHeight * 0.5)
    const opensUp = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight
    setPanelStyle({
      position: 'fixed',
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: opensUp ? undefined : rect.bottom + 4,
      bottom: opensUp ? window.innerHeight - rect.top + 4 : undefined,
      width,
    })
  }, [avoidOverflow])
  useImperativeHandle(ref, () => ({
    open: () => {
      positionPanel()
      setOpen(true)
      focusSearch()
    },
  }))

  const load = () => {
    window.api.chatConfig().then(setConfig)
    if (conversationId) window.api.chatGetSelection(conversationId).then(setConversationSel)
  }
  useEffect(load, [conversationId, refreshToken])

  useEffect(
    () =>
      window.api.onChatModelsCatalogChanged(() => {
        rowsCache = null
        if (!open) return
        void fetchRows()
          .then(({ config: nextConfig, rows: nextRows }) => {
            setConfig(nextConfig)
            setRows(nextRows)
          })
          .catch(() => undefined)
      }),
    [open]
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    let alive = true
    const hadCache = rowsCache != null
    if (hadCache) setRows(rowsCache!)
    setHiddenModels(null)
    setLoading(true)
    void window.api
      .chatHiddenModels()
      .then((hidden) => {
        if (!alive) return
        setHiddenModels(hidden)
        if (hadCache) setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setHiddenModels({})
        if (hadCache) setLoading(false)
      })
    fetchRows()
      .then(({ config: cfg, rows: next }) => {
        if (!alive) return
        setConfig(cfg)
        setRows(next)
        setLoading(false)
      })
      .catch(() => alive && setLoading(false))
    focusSearch()
    return () => {
      alive = false
    }
  }, [focusSearch, open])

  useEffect(() => {
    if (!open || !avoidOverflow) return
    positionPanel()
    const reposition = () => positionPanel()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [avoidOverflow, open, positionPanel])

  useEffect(() => {
    if (!open || !config) return
    focusSearch()
  }, [config, focusSearch, open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const provider = config?.providers.find((p) => p.id === sel?.providerId)
  const connectedProviders = config?.providers.filter(isChatProviderConnected) ?? []
  const connectedProviderIds = useMemo(() => new Set(connectedProviders.map((candidate) => candidate.id)), [config])
  const label = sel?.modelId ? `${provider?.name ?? sel.providerId} · ${sel.modelId}` : t('modelChip.choosePlaceholder')
  const modelShortcut = window.api.platformInfo.os === 'mac' ? '⌘⇧M' : 'Ctrl+Shift+M'

  const filtered = useMemo(() => {
    if (!hiddenModels) return []
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        connectedProviderIds.has(r.providerId) &&
        !(hiddenModels[r.providerId] ?? []).includes(r.modelId) &&
        (!providerFilter || providerFilter(r.providerId)) &&
        (!q || `${r.providerName} ${r.modelId}`.toLowerCase().includes(q))
    )
  }, [rows, query, connectedProviderIds, hiddenModels, providerFilter])

  useEffect(() => {
    setActiveIndex((index) => (filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0))
  }, [filtered.length])

  useEffect(() => setActiveIndex(0), [query])

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const choose = async (providerId: string, modelId: string) => {
    const next = { providerId, modelId }
    if (!conversationId) {
      setOpen(false)
      await onSelect?.(next)
      onChange?.(next)
      return
    }
    try {
      const result = await window.api.chatSetSelection(conversationId, next)
      if (!result.ok) {
        setConversationSel(await window.api.chatGetSelection(conversationId))
        return
      }
      setConversationSel(next)
      setOpen(false)
      onChange?.(next)
    } catch {
      setConversationSel(await window.api.chatGetSelection(conversationId).catch(() => sel))
    }
  }

  const manual = () => {
    const selected = connectedProviders.find((candidate) => candidate.id === sel?.providerId)
    const providerId = selected?.id ?? connectedProviders[0]?.id
    if (!providerId) return
    const modelId = query.trim() || prompt(t('modelChip.manualPrompt'))?.trim()
    if (modelId) void choose(providerId, modelId)
  }

  return (
    <div className="relative min-w-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          if (open) setOpen(false)
          else {
            positionPanel()
            setOpen(true)
          }
        }}
        title={t('modelChip.buttonTitle', { shortcut: modelShortcut })}
        aria-keyshortcuts={window.api.platformInfo.os === 'mac' ? 'Meta+Shift+M' : 'Control+Shift+M'}
        className="flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && config && (
        <div
          style={avoidOverflow ? panelStyle : undefined}
          className={cn(
            'z-[80] max-h-[50vh] overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] shadow-2xl',
            avoidOverflow ? 'fixed' : 'absolute bottom-full left-0 mb-1 w-80'
          )}
        >
          <div className="flex items-center gap-2 border-b border-white/[0.08] px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && filtered.length > 0) {
                  e.preventDefault()
                  setActiveIndex((index) => (index + 1) % filtered.length)
                  return
                }
                if (e.key === 'ArrowUp' && filtered.length > 0) {
                  e.preventDefault()
                  setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const item = filtered[filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : -1]
                  if (item) void choose(item.providerId, item.modelId)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                }
              }}
              placeholder={t('modelChip.searchPlaceholder')}
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[40vh] overflow-auto py-1">
            {connectedProviders.length === 0 && (
              <div className="px-3 py-3 text-center text-[12px] text-muted-foreground">
                {t('modelChip.noProviders')}
              </div>
            )}
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('modelChip.loading')}
              </div>
            )}
            {!loading &&
              filtered.map((r, index) => {
                const active = sel?.providerId === r.providerId && sel?.modelId === r.modelId
                const highlighted = index === activeIndex
                return (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    key={`${r.providerId}::${r.modelId}`}
                    type="button"
                    onClick={() => void choose(r.providerId, r.modelId)}
                    onMouseEnter={() => setActiveIndex(index)}
                    aria-selected={highlighted}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.05]',
                      highlighted && 'bg-white/[0.06]'
                    )}
                  >
                    <Check className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex-1 truncate text-[13px] text-foreground">{r.modelId}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{r.providerName}</span>
                  </button>
                )
              })}
            {!loading && filtered.length === 0 && connectedProviders.length > 0 && (
              <button
                type="button"
                onClick={manual}
                className="flex w-full items-center px-3 py-2 text-left text-[12px] text-muted-foreground hover:text-foreground"
              >
                {query.trim() ? t('modelChip.useAsId', { query: query.trim() }) : t('modelChip.typeManually')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
