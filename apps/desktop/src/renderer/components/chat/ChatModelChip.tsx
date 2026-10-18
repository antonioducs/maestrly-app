import { useChatOwnerWindow, useChatDocument } from '@/lib/chat-window-context'
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
import { fixedPanelPlacement } from '@/lib/fixed-panel-position'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import type { HostId } from '../../../shared/host-key'
import { isChatProviderConnected } from '../../../shared/chat'
import type { ChatConfig, ChatModelRef } from '../../../shared/chat'
import type { ChatComposerSource } from './chat-composer-source'
import { modelDisplayName, providerSearchTerms, searchModelRows } from './model-search'
import { cachedModelPickerRows, loadModelPickerRows, type ModelPickerRow as Row } from './model-picker-rows'

interface Props {
  conversationId?: string
  value?: ChatModelRef | null
  onSelect?: (selection: ChatModelRef) => void | Promise<void>
  onSelectDefault?: () => void | Promise<void>
  defaultLabel?: string
  source?: ChatComposerSource

  providerFilter?: (providerId: string) => boolean

  avoidOverflow?: boolean
  refreshToken?: number
  onChange?: (sel: ChatModelRef) => void
}

export interface ChatModelChipHandle {
  open(): void
}

const hiddenCache = new Map<HostId, Record<string, string[]>>()

/** A bot's models, already filtered by the models its own accounts enable. */
async function loadBotRows(bot: NonNullable<ChatComposerSource['bot']>, botId: string | undefined): Promise<Row[]> {
  const result = await bot.listSelections(botId ?? '')
  return result.options.map((option) => ({
    providerId: option.providerId,
    providerName: option.providerLabel,
    modelId: option.modelId,
  }))
}

export const ChatModelChip = forwardRef<ChatModelChipHandle, Props>(function ChatModelChip(
  {
    conversationId,
    value,
    onSelect,
    onSelectDefault,
    defaultLabel,
    source,
    providerFilter,
    avoidOverflow = false,
    refreshToken,
    onChange,
  },
  ref
) {
  const ownerWindow = useChatOwnerWindow()
  const ownerDocument = useChatDocument()
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const hostId = useHostId()
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [conversationSel, setConversationSel] = useState<ChatModelRef | null>(null)
  const controlled = conversationId === undefined || !!source?.bot
  const sel = controlled ? (value ?? null) : conversationSel
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // The module cache holds each host's models; a bot's list comes from the bot only.
  const [rows, setRows] = useState<Row[]>(() => (source?.bot ? [] : (cachedModelPickerRows(hostId) ?? [])))
  // A bot's list arrives at once; a host's arrives account by account, and `loading` stays on until the last one.
  const [loading, setLoading] = useState(false)
  const [hiddenModels, setHiddenModels] = useState<Record<string, string[]> | null>(null)
  const [choosingKey, setChoosingKey] = useState<string | null>(null)
  const choosingRef = useRef(false)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusSearch = useCallback(() => {
    setTimeout(() => searchRef.current?.focus(), 0)
  }, [])
  const positionPanel = useCallback(() => {
    if (!avoidOverflow) return
    const root = rootRef.current
    if (!root) return
    setPanelStyle(
      fixedPanelPlacement(root, {
        width: Math.min(320, ownerWindow.innerWidth - 16),
        estimatedHeight: Math.min(420, ownerWindow.innerHeight * 0.5),
      }).style
    )
  }, [ownerWindow, avoidOverflow])
  useImperativeHandle(ref, () => ({
    open: () => {
      positionPanel()
      setOpen(true)
      focusSearch()
    },
  }))

  const load = () => {
    if (source?.bot) return
    api.chatConfig().then(setConfig)
    if (conversationId) api.chatGetSelection(conversationId).then(setConversationSel)
  }
  useEffect(load, [api, conversationId, refreshToken])

  useEffect(
    () =>
      source?.bot
        ? () => {}
        : api.onChatModelsCatalogChanged(() => {
            if (!open) return
            // Supersedes the fetch the opening started, so it also owns the loading line from here.
            void loadModelPickerRows(api, hostId, (update) => {
              setConfig(update.config)
              setRows(update.rows)
              setLoading(update.pending > 0)
            }).catch(() => setLoading(false))
          }),
    [api, hostId, open]
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    let alive = true
    if (source?.bot) {
      setHiddenModels({})
      setLoading(true)
      void loadBotRows(source.bot, conversationId)
        .then((next) => {
          if (!alive) return
          setRows(next)
          setLoading(false)
        })
        .catch(() => alive && setLoading(false))
      focusSearch()
      return () => {
        alive = false
      }
    }
    setRows(cachedModelPickerRows(hostId) ?? [])
    setHiddenModels(hiddenCache.get(hostId) ?? null)
    setLoading(true)
    void api
      .chatHiddenModels()
      .catch((): Record<string, string[]> => ({}))
      .then((hidden) => {
        hiddenCache.set(hostId, hidden)
        if (alive) setHiddenModels(hidden)
      })
    loadModelPickerRows(api, hostId, (update) => {
      if (!alive) return
      setConfig(update.config)
      setRows(update.rows)
      setLoading(update.pending > 0)
    }).catch(() => alive && setLoading(false))
    focusSearch()
    return () => {
      alive = false
    }
  }, [api, hostId, focusSearch, open])

  // A bot's closed chip needs the provider label of its selection, not only an open menu.
  const botSource = source?.bot
  useEffect(() => {
    if (!botSource) return
    let alive = true
    void loadBotRows(botSource, conversationId)
      .then((next) => alive && setRows(next))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [botSource, conversationId, sel?.providerId, sel?.modelId])

  useEffect(() => {
    if (!open || !avoidOverflow) return
    positionPanel()
    const reposition = () => positionPanel()
    ownerWindow.addEventListener('resize', reposition)
    ownerWindow.addEventListener('scroll', reposition, true)
    return () => {
      ownerWindow.removeEventListener('resize', reposition)
      ownerWindow.removeEventListener('scroll', reposition, true)
    }
  }, [ownerWindow, avoidOverflow, open, positionPanel])

  useEffect(() => {
    if (!open || !config) return
    focusSearch()
  }, [config, focusSearch, open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    ownerDocument.addEventListener('mousedown', onDoc)
    return () => ownerDocument.removeEventListener('mousedown', onDoc)
  }, [ownerDocument, open])

  const provider = config?.providers.find((p) => p.id === sel?.providerId)
  const connectedProviders = config?.providers.filter(isChatProviderConnected) ?? []
  const connectedProviderIds = useMemo(() => new Set(connectedProviders.map((candidate) => candidate.id)), [config])
  const botRow = source?.bot && rows.find((row) => row.providerId === sel?.providerId && row.modelId === sel?.modelId)
  const label = sel?.modelId
    ? `${botRow?.providerName ?? provider?.name ?? sel.providerId} · ${modelDisplayName(sel.modelId)}`
    : (defaultLabel ?? t('modelChip.choosePlaceholder'))
  const modelShortcut = window.api.platformInfo.os === 'mac' ? '⌘⇧M' : 'Ctrl+Shift+M'
  const loadingLine = (
    <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> {t('modelChip.loading')}
    </div>
  )

  const providerTerms = useMemo(
    () => new Map((config?.providers ?? []).map((candidate) => [candidate.id, providerSearchTerms(candidate)])),
    [config]
  )
  const filtered = useMemo(() => {
    if (!hiddenModels) return []
    const offered = rows.filter(
      (r) =>
        (source?.bot || connectedProviderIds.has(r.providerId)) &&
        !(hiddenModels[r.providerId] ?? []).includes(r.modelId) &&
        (!providerFilter || providerFilter(r.providerId))
    )
    return searchModelRows(offered, query, (providerId) => providerTerms.get(providerId) ?? [])
  }, [rows, query, connectedProviderIds, hiddenModels, providerFilter, providerTerms, source?.bot])

  useEffect(() => {
    setActiveIndex((index) => (filtered.length > 0 ? Math.min(index, filtered.length - 1) : 0))
  }, [filtered.length])

  useEffect(() => setActiveIndex(0), [query])

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const choose = async (providerId: string, modelId: string) => {
    const next = { providerId, modelId }
    if (!conversationId || source?.bot) {
      setOpen(false)
      await onSelect?.(next)
      onChange?.(next)
      return
    }
    // Validation can wait for the provider's runtime; further clicks or Enter must not queue more validations.
    if (choosingRef.current) return
    choosingRef.current = true
    setChoosingKey(`${providerId}::${modelId}`)
    try {
      const result = await api.chatSetSelection(conversationId, next)
      if (!result.ok) {
        setConversationSel(await api.chatGetSelection(conversationId))
        return
      }
      setConversationSel(next)
      setOpen(false)
      onChange?.(next)
    } catch {
      setConversationSel(await api.chatGetSelection(conversationId).catch(() => sel))
    } finally {
      choosingRef.current = false
      setChoosingKey(null)
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
      {open && (config || source?.bot) && (
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
          <div className="max-h-[40vh] overflow-auto py-1" aria-busy={choosingKey !== null}>
            {connectedProviders.length === 0 && !source?.bot && (
              <div className="px-3 py-3 text-center text-[12px] text-muted-foreground">
                {t('modelChip.noProviders')}
              </div>
            )}
            {loading && source?.bot && loadingLine}
            {!loading && source?.bot && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  void onSelectDefault?.()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-white/[0.05]"
              >
                <Check className={cn('h-3.5 w-3.5', !value ? 'opacity-100' : 'opacity-0')} />
                {defaultLabel ?? t('modelChip.choosePlaceholder')}
              </button>
            )}
            {(!loading || !source?.bot) &&
              filtered.map((r, index) => {
                const active = sel?.providerId === r.providerId && sel?.modelId === r.modelId
                const highlighted = index === activeIndex
                const choosing = choosingKey === `${r.providerId}::${r.modelId}`
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
                    {choosing ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Check className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={r.modelId}>
                      {modelDisplayName(r.modelId)}
                    </span>
                    <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">
                      {r.providerName}
                    </span>
                  </button>
                )
              })}
            {/* Accounts answer one by one: their rows show as they arrive, and this line until the last one. */}
            {loading && !source?.bot && loadingLine}
            {!source?.bot && !loading && filtered.length === 0 && connectedProviders.length > 0 && (
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
