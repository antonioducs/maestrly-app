import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Trash2,
  Plus,
  X,
  Pencil,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Sparkles,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  addFallback,
  availableCandidates,
  labelForSubscriptionProvider,
  moveFallbackDown,
  moveFallbackUp,
  removeFallback,
  routeForPrimary,
  withEnabled,
} from './subscription-failover-route'
import {
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  defaultProviderKind,
  DEFAULT_REASONING_EFFORTS,
  effectiveProviderKind,
  isChatProviderConnected,
  isOfficialOpenAIProvider,
  isChatSubscriptionProviderKind,
  withSubscriptionAccount,
} from '../../../shared/chat'
import type {
  ChatConfig,
  ChatModelMeta,
  ChatSubscriptionFailoverRoute,
  ChatProviderInfo,
  ChatProviderKind,
  ChatProviderPreset,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionLoginResult,
  ChatSubscriptionProviderKind,
  ChatSubscriptionUsage,
  ChatUserPrompt,
  McpServerInfo,
} from '../../../shared/chat'
import type { RuntimeAssetId, RuntimeAssetInfo } from '../../../shared/runtime-assets'
import { SubagentProfilesSettings } from './subagent-profiles/SubagentProfilesSettings'
import { SkillsSettings } from './SkillsSettings'
import { ChatGptWebSettings } from './ChatGptWebSettings'
import { SubscriptionUsagePanel } from './SubscriptionUsagePanel'
import { supportsSubscriptionUsage } from './subscription-usage-presentation'
import { MaestroSettings } from './MaestroSettings'

const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

const PROVIDER_RUNTIME_ASSET: Partial<Record<ChatSubscriptionProviderKind, RuntimeAssetId>> = {
  'codex-subscription': 'codex-runtime',
  'github-copilot-subscription': 'github-copilot-runtime',
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

function assetProgress(asset: RuntimeAssetInfo): number {
  const total = asset.status.totalBytes || asset.downloadBytes
  return total > 0 ? Math.min(100, ((asset.status.bytesDownloaded ?? 0) / total) * 100) : 0
}

const PROVIDER_KINDS: Exclude<ChatProviderKind, ChatSubscriptionProviderKind>[] = [
  'openai-responses',
  'openai',
  'anthropic',
]
const kindLabelKey: Record<ChatProviderKind, string> = {
  'openai-responses': 'settings.apiFormatOpenAIResponses',
  openai: 'settings.apiFormatOpenAI',
  anthropic: 'settings.apiFormatAnthropic',
  'codex-subscription': 'settings.apiFormatCodexSubscription',
  'github-copilot-subscription': 'settings.apiFormatGitHubCopilotSubscription',
  'claude-subscription': 'settings.apiFormatClaudeSubscription',
  'grok-subscription': 'settings.apiFormatGrokSubscription',
}

const subscriptionProviderCopy: Record<
  ChatSubscriptionProviderKind,
  {
    prefix:
      | 'codexSubscription'
      | 'githubCopilotSubscription'
      | 'claudeSubscription'
      | 'grokSubscription'
    borderClass: string
    buttonClass: string
  }
> = {
  'codex-subscription': {
    prefix: 'codexSubscription',
    borderClass: 'border-emerald-500/25 bg-emerald-500/[0.04]',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-500',
  },
  'github-copilot-subscription': {
    prefix: 'githubCopilotSubscription',
    borderClass: 'border-sky-500/25 bg-sky-500/[0.04]',
    buttonClass: 'bg-sky-600 hover:bg-sky-500',
  },
  'claude-subscription': {
    prefix: 'claudeSubscription',
    borderClass: 'border-orange-500/25 bg-orange-500/[0.04]',
    buttonClass: 'bg-orange-600 hover:bg-orange-500',
  },
  'grok-subscription': {
    prefix: 'grokSubscription',
    borderClass: 'border-zinc-400/25 bg-zinc-400/[0.04]',
    buttonClass: 'bg-zinc-700 hover:bg-zinc-600',
  },
}

function KindPicker({ value, onPick }: { value: ChatProviderKind; onPick: (k: ChatProviderKind) => void }) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROVIDER_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onPick(k)}
          className={cn(
            'rounded-md border px-2 py-0.5 text-[11px]',
            value === k
              ? 'border-ring bg-white/5 text-foreground'
              : 'border-border text-muted-foreground hover:bg-white/5'
          )}
        >
          {t(kindLabelKey[k])}
        </button>
      ))}
    </div>
  )
}

function AddProviderForm({
  presets,
  onAdded,
  onCancel,
}: {
  presets: ChatProviderPreset[]
  onAdded: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [key, setKey] = useState('')
  const [kind, setKind] = useState<ChatProviderKind>('openai')
  const [kindTouched, setKindTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const officialOpenAI = isOfficialOpenAIProvider(baseURL)

  const onBaseURLChange = (v: string) => {
    setBaseURL(v)
    if (!kindTouched) setKind(defaultProviderKind(v))
  }
  const pickKind = (k: ChatProviderKind) => {
    setKind(k)
    setKindTouched(true)
  }

  const submit = async () => {
    if (!name.trim() || !baseURL.trim()) {
      setError(t('settings.errNameBaseUrlRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const r = await window.api.chatAddProvider({
      name: name.trim(),
      baseURL: baseURL.trim(),
      key: key.trim() || undefined,
      kind: effectiveProviderKind(baseURL, kind),
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? t('settings.errAddFailed'))
      return
    }
    onAdded()
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-white/[0.02] px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">{t('settings.newProvider')}</span>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {presets.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                setName(p.name)
                setBaseURL(p.baseURL)
                setKind(p.kind ?? defaultProviderKind(p.baseURL))
                setKindTouched(true)
              }}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <input
          className={inputCls}
          placeholder={t('settings.providerNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder={t('settings.baseUrlPlaceholder')}
          value={baseURL}
          onChange={(e) => onBaseURLChange(e.target.value)}
        />
        {!officialOpenAI && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t('settings.apiFormat')}</span>
            <KindPicker value={kind} onPick={pickKind} />
          </div>
        )}
        <input
          className={inputCls}
          type="password"
          placeholder={t('settings.apiKeyOptionalPlaceholder')}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim() || !baseURL.trim()}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[12px] font-medium',
              name.trim() && baseURL.trim()
                ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                : 'bg-foreground/10 text-muted-foreground'
            )}
          >
            {t('settings.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProviderModelFilter({ providerId, onFilterChanged }: { providerId: string; onFilterChanged: () => void }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [query, setQuery] = useState('')
  const hiddenRef = useRef<string[]>([])
  const hiddenRevisionRef = useRef(0)
  const latestSaveIdRef = useRef(0)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const aliveRef = useRef(true)

  const applyHidden = useCallback((next: string[]) => {
    hiddenRef.current = next
    setHidden(next)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    const hiddenRevision = hiddenRevisionRef.current
    window.api
      .chatHiddenModels()
      .then((map) => {
        if (alive && hiddenRevision === hiddenRevisionRef.current) applyHidden(map[providerId] ?? [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [applyHidden, providerId])

  useEffect(() => {
    if (!open) return
    let alive = true
    const hiddenRevision = hiddenRevisionRef.current
    setLoading(true)
    setFailed(false)
    setSaveError(false)
    setModels([])
    setQuery('')
    Promise.all([window.api.chatModels(providerId, false, true), window.api.chatHiddenModels()])
      .then(([all, map]) => {
        if (!alive) return
        setModels(all)

        if (hiddenRevision === hiddenRevisionRef.current) applyHidden(map[providerId] ?? [])
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [applyHidden, open, providerId])

  const hiddenSet = new Set(hidden)
  const persist = (update: (current: string[]) => string[]) => {
    const next = update(hiddenRef.current)
    const saveId = ++latestSaveIdRef.current
    hiddenRevisionRef.current += 1
    applyHidden(next)
    setSaveError(false)
    setSaving(true)

    const save = async () => {
      hiddenRevisionRef.current += 1
      try {
        const result = await window.api.chatSetHiddenModels(providerId, next)
        if (!result.ok) throw new Error(result.error ?? 'save-failed')

        hiddenRevisionRef.current += 1
        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        applyHidden(next)
        setSaving(false)
        onFilterChanged()
      } catch {
        hiddenRevisionRef.current += 1

        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        try {
          const map = await window.api.chatHiddenModels()
          if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
          hiddenRevisionRef.current += 1
          applyHidden(map[providerId] ?? [])

          onFilterChanged()
        } catch {}
        if (!aliveRef.current || saveId !== latestSaveIdRef.current) return
        setSaving(false)
        setSaveError(true)
      }
    }

    saveQueueRef.current = saveQueueRef.current.then(save, save)
  }
  const toggle = (modelId: string) =>
    persist((current) => (current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]))
  const q = query.trim().toLowerCase()

  const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models
  const showAll = () => persist((current) => current.filter((id) => !shown.includes(id)))
  const hideAll = () => persist((current) => [...new Set([...current, ...shown])])
  const visibleCount = models.filter((m) => !hiddenSet.has(m)).length

  const toggleOpen = () => {
    if (!open) {
      setLoading(true)
      setModels([])
      setFailed(false)
      setQuery('')
    }
    setOpen((current) => !current)
  }

  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {t('settings.modelFilterToggle')}
        {hidden.length > 0 && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px]">
            {t('settings.modelFilterBadge', { count: hidden.length })}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[11px] text-muted-foreground">{t('settings.modelFilterDescription')}</p>
          <input
            className={cn(inputCls, 'py-1 text-[12px]')}
            placeholder={t('settings.modelFilterSearchPlaceholder')}
            value={query}
            disabled={loading}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {t('settings.modelFilterCount', {
                visible: visibleCount,
                total: models.length,
              })}
              {saving && <Loader2 className="h-3 w-3 animate-spin" aria-label={t('settings.modelFilterSaving')} />}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={showAll}
                disabled={loading || shown.length === 0}
                className="hover:text-foreground disabled:opacity-40"
              >
                {t('settings.modelFilterShowAll')}
              </button>
              <button
                type="button"
                onClick={hideAll}
                disabled={loading || shown.length === 0}
                className="hover:text-foreground disabled:opacity-40"
              >
                {t('settings.modelFilterHideAll')}
              </button>
            </span>
          </div>
          <div className="max-h-56 overflow-auto rounded-md border border-border">
            {loading && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('settings.loadingModels')}
              </div>
            )}
            {!loading && failed && (
              <p className="px-2.5 py-2 text-[12px] text-destructive">{t('settings.modelFilterLoadFailed')}</p>
            )}
            {!loading && !failed && models.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-muted-foreground">{t('settings.modelFilterEmpty')}</p>
            )}
            {!loading && !failed && models.length > 0 && shown.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-muted-foreground">{t('settings.modelFilterNoMatch')}</p>
            )}
            {!loading &&
              !failed &&
              shown.map((m) => (
                <label key={m} className="flex cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-white/[0.04]">
                  <input type="checkbox" checked={!hiddenSet.has(m)} onChange={() => toggle(m)} />
                  <span className="truncate text-[12px] text-foreground">{m}</span>
                </label>
              ))}
          </div>
          {saveError && <p className="text-[11px] text-destructive">{t('settings.modelFilterSaveFailed')}</p>}
        </div>
      )}
    </div>
  )
}

function ProviderRow({
  provider,
  onChanged,
  onModelFilterChanged,
}: {
  provider: ChatProviderInfo
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const officialOpenAI = isOfficialOpenAIProvider(provider.baseURL)
  const effectiveKind = effectiveProviderKind(provider.baseURL, provider.kind)

  const changeKind = async (k: ChatProviderKind) => {
    if (k === effectiveKind) return
    setBusy(true)
    await window.api.chatUpdateProvider(provider.id, { kind: k })
    setBusy(false)
    onChanged()
  }

  const saveKey = async () => {
    if (!value.trim()) return
    setBusy(true)
    await window.api.chatSetKey(provider.id, value.trim())
    setValue('')
    setBusy(false)
    onChanged()
  }
  const remove = async () => {
    if (!confirm(t('settings.confirmRemoveProvider', { name: provider.name }))) return
    setBusy(true)
    await window.api.chatRemoveProvider(provider.id)
    setBusy(false)
    onChanged()
  }

  return (
    <div className="rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">{provider.name}</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t(kindLabelKey[effectiveKind])}
          </span>
          {provider.apiKeyPresent ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
              <Check className="h-3 w-3" /> {t('settings.keySaved')}
            </span>
          ) : (
            <span className="text-[11px] text-amber-400/80">{t('settings.noKey')}</span>
          )}
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="text-muted-foreground hover:text-destructive"
          title={t('settings.removeProvider')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={value}
          disabled={busy}
          placeholder={
            provider.apiKeyPresent
              ? t('settings.replaceKeyPlaceholder')
              : t('settings.keyForProviderPlaceholder', { name: provider.name })
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveKey()
          }}
          className={cn(inputCls, 'flex-1')}
        />
        <button
          type="button"
          onClick={saveKey}
          disabled={!value.trim() || busy}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-[12px] font-medium',
            value.trim() ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground'
          )}
        >
          {t('settings.save')}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{provider.baseURL}</p>
      {!officialOpenAI && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t('settings.apiFormat')}</span>
          <KindPicker value={effectiveKind} onPick={changeKind} />
        </div>
      )}
      {isChatProviderConnected(provider) && (
        <ProviderModelFilter providerId={provider.id} onFilterChanged={onModelFilterChanged} />
      )}
    </div>
  )
}

function FailoverRouteEditor({
  primaryProviderId,
  providerKind,
  config,
  onChanged,
}: {
  primaryProviderId: string
  providerKind: ChatSubscriptionProviderKind
  config: ChatConfig
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const prefix = subscriptionProviderCopy[providerKind].prefix
  const defaultLabel = t(`settings.${prefix}Heading`)
  const initial = routeForPrimary(config.subscriptionFailover.routes, primaryProviderId)
  const [route, setRoute] = useState<ChatSubscriptionFailoverRoute>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRoute(routeForPrimary(config.subscriptionFailover.routes, primaryProviderId))
  }, [config.subscriptionFailover.routes, primaryProviderId])

  const save = async (next: ChatSubscriptionFailoverRoute) => {
    setRoute(next)
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.chatSubscriptionFailoverSetRoute({
        primaryProviderId: next.primaryProviderId,
        enabled: next.enabled,
        fallbackProviderIds: next.fallbackProviderIds,
      })
      if (!result.ok) throw new Error(result.error || t('settings.errAddFailed'))
      if (result.route) setRoute(result.route)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setRoute(routeForPrimary(config.subscriptionFailover.routes, primaryProviderId))
    } finally {
      setBusy(false)
    }
  }

  const candidates = availableCandidates({
    primaryProviderId,
    fallbackProviderIds: route.fallbackProviderIds,
    providers: config.providers,
    defaultLabel,
  })

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-black/10 px-2.5 py-2">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={route.enabled}
          disabled={busy}
          onChange={(e) => void save(withEnabled(route, e.target.checked))}
        />
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-foreground">{t('settings.automaticRotation')}</span>
          <span className="block text-[11px] text-muted-foreground">{t('settings.automaticRotationDescription')}</span>
        </span>
      </label>

      {route.enabled && (
        <div className="mt-2 flex flex-col gap-1.5">
          {route.fallbackProviderIds.map((fallbackId, index) => {
            const provider = config.providers.find((entry) => entry.id === fallbackId)
            const connected = provider ? (provider.connected ?? provider.apiKeyPresent) : false
            const label = labelForSubscriptionProvider(fallbackId, config.providers, defaultLabel)
            return (
              <div
                key={fallbackId}
                className="flex items-center gap-1.5 rounded border border-border/60 bg-white/[0.02] px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{label}</span>
                {!connected && (
                  <span className="shrink-0 text-[10px] text-amber-300">
                    {t('settings.fallbackDisconnectedWarning')}
                  </span>
                )}
                <button
                  type="button"
                  title={t('settings.moveFallbackUp')}
                  aria-label={t('settings.moveFallbackUp')}
                  disabled={busy || index === 0}
                  onClick={() => void save(moveFallbackUp(route, index))}
                  className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t('settings.moveFallbackDown')}
                  aria-label={t('settings.moveFallbackDown')}
                  disabled={busy || index >= route.fallbackProviderIds.length - 1}
                  onClick={() => void save(moveFallbackDown(route, index))}
                  className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title={t('settings.removeFallback')}
                  aria-label={t('settings.removeFallback')}
                  disabled={busy}
                  onClick={() => void save(removeFallback(route, fallbackId))}
                  className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}

          {candidates.length > 0 && (
            <OptionSelect
              className="h-8 text-xs"
              disabled={busy}
              value=""
              onValueChange={(selectedValue) => {
                const id = selectedValue
                if (!id) return
                void save(addFallback(route, id))
              }}
              aria-label={t('settings.addFallbackAccount')}
            >
              <SelectOption value="">{t('settings.addFallbackAccount')}</SelectOption>
              {candidates.map((candidate) => (
                <SelectOption key={candidate.providerId} value={candidate.providerId}>
                  {candidate.label}
                  {!candidate.connected ? ` (${t(`settings.${prefix}Disconnected`)})` : ''}
                </SelectOption>
              ))}
            </OptionSelect>
          )}
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

function SubscriptionProviderCard({
  providerKind,
  provider,
  accountId = null,
  accountLabel,
  config,
  showSubscriptionFailover = false,
  onChanged,
  onModelFilterChanged,
}: {
  providerKind: ChatSubscriptionProviderKind
  provider?: ChatProviderInfo

  accountId?: string | null
  accountLabel?: string
  config?: ChatConfig

  showSubscriptionFailover?: boolean
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<ChatSubscriptionAuthStatus | null>(null)
  const [loginInstructions, setLoginInstructions] = useState<ChatSubscriptionLoginResult | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'login' | 'logout' | null>(null)
  const [usage, setUsage] = useState<ChatSubscriptionUsage | null>(null)
  const [usageBusy, setUsageBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const runtimeId = PROVIDER_RUNTIME_ASSET[providerKind]
  const [runtime, setRuntime] = useState<RuntimeAssetInfo | null>(null)
  const runtimeStateRef = useRef<RuntimeAssetInfo['status']['state'] | null>(null)
  const runtimeInstallInProgressRef = useRef(false)
  const runtimeStatusRefreshInProgressRef = useRef(false)
  const usageRequestRef = useRef(0)
  const copy = subscriptionProviderCopy[providerKind]
  const copyKey = (suffix: string) => `settings.${copy.prefix}${suffix}`
  const usageSupported = supportsSubscriptionUsage(providerKind)

  const refreshUsage = useCallback(
    async (force = false): Promise<ChatSubscriptionUsage | null> => {
      if (!usageSupported) return null
      const request = ++usageRequestRef.current
      setUsageBusy(true)
      try {
        const next = await window.api.chatSubscriptionUsage(providerKind, force, accountId)
        if (request === usageRequestRef.current) setUsage(next)
        return next
      } catch (error) {
        const failed: ChatSubscriptionUsage = {
          state: 'error',
          providerKind,
          accountId,
          error: error instanceof Error ? error.message : String(error),
        }
        if (request === usageRequestRef.current) setUsage(failed)
        return failed
      } finally {
        if (request === usageRequestRef.current) setUsageBusy(false)
      }
    },
    [accountId, providerKind, usageSupported]
  )

  const refreshStatus = async (force = false): Promise<ChatSubscriptionAuthStatus | null> => {
    setBusy((current) => current ?? 'refresh')
    setActionError(null)
    try {
      const next = await window.api.chatSubscriptionStatus(providerKind, force, accountId)
      setStatus(next)

      onChanged()
      return next
    } catch (error) {
      setStatus({
        state: 'error',
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    } finally {
      setBusy((current) => (current === 'refresh' ? null : current))
    }
  }

  useEffect(() => {
    void refreshStatus()
    return window.api.onChatSubscriptionStatus(providerKind, (next) => {
      if ((next.accountId ?? null) !== accountId) return
      setStatus(next)
      setBusy(null)
      setActionError(null)
      if (next.state === 'signed-in' || next.state === 'signed-out') setLoginInstructions(null)
      if (next.state === 'signed-in') void refreshUsage(true)
      else {
        usageRequestRef.current += 1
        setUsage(null)
        setUsageBusy(false)
      }
      onChanged()
    })
    // `onChanged` is the stable config refresher owned by ApiKeySettings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  useEffect(() => {
    if (status?.state === 'signed-in' && usageSupported) {
      void refreshUsage()
      return
    }
    usageRequestRef.current += 1
    setUsage(null)
    setUsageBusy(false)
  }, [refreshUsage, status?.state, usageSupported])

  useEffect(() => {
    if (!runtimeId) return
    void window.api.runtimeAssetStatus(runtimeId).then((next) => {
      if (runtimeStateRef.current !== null) return
      runtimeStateRef.current = next.status.state
      setRuntime(next)
    })
    return window.api.onRuntimeAssetChanged((next) => {
      if (next.id !== runtimeId) return
      const previousState = runtimeStateRef.current
      runtimeStateRef.current = next.status.state
      setRuntime(next)
      if (
        next.status.state === 'ready' &&
        previousState !== 'ready' &&
        !runtimeInstallInProgressRef.current &&
        !runtimeStatusRefreshInProgressRef.current
      ) {
        runtimeStatusRefreshInProgressRef.current = true
        void refreshStatus(true).finally(() => {
          runtimeStatusRefreshInProgressRef.current = false
        })
      }
    })
  }, [runtimeId])

  const login = async () => {
    setBusy('login')
    setActionError(null)
    try {
      if (runtimeId && runtime?.status.state !== 'ready') {
        runtimeInstallInProgressRef.current = true
        try {
          const installed =
            runtime?.status.state === 'failed' || runtime?.status.state === 'corrupt'
              ? await window.api.runtimeAssetRepair(runtimeId)
              : await window.api.runtimeAssetInstall(runtimeId)
          runtimeStateRef.current = installed.status.state
          setRuntime(installed)
          if (installed.status.state !== 'ready')
            throw new Error(installed.status.error || t('settings.componentInstallFailed'))
        } finally {
          runtimeInstallInProgressRef.current = false
        }

        const recovered = await refreshStatus(true)
        if (recovered?.authenticated || recovered?.state === 'signed-in') {
          setLoginInstructions(null)
          return
        }
        if (recovered?.state !== 'signed-out') {
          throw new Error(recovered?.error || t(copyKey('LoginFailed')))
        }
      }
      const result = await window.api.chatSubscriptionLogin(providerKind, accountId)
      if (!result.ok) {
        if (result.status) setStatus(result.status)
        throw new Error(result.error || t(copyKey('LoginFailed')))
      }
      setLoginInstructions(result)
      setStatus(result.status ?? { state: 'signing-in', authenticated: false })
      const loginUrl = result.authUrl ?? result.verificationUrl
      if (loginUrl) window.api.openExternalUrl(loginUrl)
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const logout = async () => {
    setBusy('logout')
    setActionError(null)
    try {
      const result = await window.api.chatSubscriptionLogout(providerKind, accountId)
      if (!result.ok) {
        throw new Error(result.error || t(copyKey('LogoutFailed')))
      }
      setLoginInstructions(null)
      setStatus(result.status ?? { state: 'signed-out', authenticated: false })
      usageRequestRef.current += 1
      setUsage(null)
      setUsageBusy(false)
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const removeAccount = async () => {
    if (!accountId) return
    if (
      !confirm(
        t('settings.confirmRemoveAccount', {
          label: accountLabel ?? accountId,
        })
      )
    )
      return
    setBusy('logout')
    setActionError(null)
    try {
      const result = await window.api.chatSubscriptionAccountRemove(accountId)
      if (!result.ok) throw new Error(result.error || t('settings.accountRemoveFailed'))
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const commitRename = async () => {
    if (accountId && renaming?.trim()) {
      setActionError(null)
      const result = await window.api.chatSubscriptionAccountRename(accountId, renaming.trim())
      if (!result.ok) setActionError(result.error || t('settings.accountRenameFailed'))
      onChanged()
    }
    setRenaming(null)
  }

  const signedIn = status?.state === 'signed-in'
  const signingIn = status?.state === 'signing-in'
  const unavailable = status?.state === 'unavailable'
  const statusLabel = !status
    ? t('settings.loading')
    : signedIn
      ? t(copyKey('Connected'))
      : signingIn
        ? t(copyKey('Waiting'))
        : unavailable
          ? t(copyKey('Unavailable'))
          : t(copyKey('Disconnected'))
  const identity = status?.username ?? status?.email
  const runtimeActive =
    runtime !== null && ['downloading', 'verifying', 'installing', 'removing'].includes(runtime.status.state)
  const runtimeReady = !runtimeId || runtime?.status.state === 'ready'

  const refreshAll = async () => {
    const next = await refreshStatus(true)
    if (next?.state === 'signed-in') await refreshUsage(true)
  }

  return (
    <div
      className={cn('rounded-lg border px-3 py-3', copy.borderClass)}
      data-subscription-provider={providerKind}
      data-subscription-account={accountId ?? 'default'}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-1 size-2.5 shrink-0 rounded-full',
            signedIn ? 'bg-emerald-400' : signingIn ? 'bg-amber-400' : 'bg-muted-foreground/50'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-foreground">
              {accountId ? `${t(copyKey('Heading'))} — ${accountLabel ?? accountId}` : t(copyKey('Heading'))}
            </span>
            {accountId && renaming === null && (
              <button
                type="button"
                onClick={() => setRenaming(accountLabel ?? '')}
                className="text-muted-foreground hover:text-foreground"
                title={t('settings.renameAccountTitle')}
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <span
              className={cn(
                'text-[11px]',
                signedIn ? 'text-emerald-400' : signingIn ? 'text-amber-300' : 'text-muted-foreground'
              )}
            >
              {statusLabel}
            </span>
          </div>
          {accountId && renaming !== null && (
            <div className="mt-1 flex items-center gap-1.5">
              <input
                className={cn(inputCls, 'py-1 text-[12px]')}
                value={renaming}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => void commitRename()}
              />
            </div>
          )}
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t(copyKey('Description'))}</p>
          {runtime && runtime.status.state !== 'ready' && (
            <div className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/[0.05] px-2 py-1.5 text-[11px]">
              <p className="text-amber-200">
                {t('settings.componentRequired', {
                  name: t(`settings.componentName_${runtime.id}`),
                })}
              </p>
              <p className="text-muted-foreground">
                v{runtime.availableVersion} ·{' '}
                {t('settings.componentSizes', {
                  download: formatBytes(runtime.downloadBytes),
                  installed: formatBytes(runtime.status.diskUsageBytes || runtime.unpackedBytes),
                })}
              </p>
              {runtimeActive && runtime.status.state !== 'removing' && (
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded bg-white/10">
                    <div
                      className="h-full bg-amber-400"
                      style={{
                        width: `${assetProgress(runtime)}%`,
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="text-amber-200 hover:text-white"
                    onClick={() => void window.api.runtimeAssetCancel(runtime.id)}
                  >
                    {t('settings.componentCancel')}
                  </button>
                </div>
              )}
            </div>
          )}
          {signedIn && (identity || status.planType) && (
            <p className="mt-1 text-[11px] text-foreground/80">
              {[identity, status.planType].filter(Boolean).join(' · ')}
            </p>
          )}
          {signingIn && loginInstructions?.userCode && (
            <div className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2">
              <p className="text-[11px] text-amber-100">{t(copyKey('DeviceCodeHint'))}</p>
              <code className="mt-1 block select-all font-mono text-[15px] font-semibold tracking-[0.18em] text-foreground">
                {loginInstructions.userCode}
              </code>
            </div>
          )}
          {(actionError || status?.error) && (
            <p className="mt-1 text-[11px] text-destructive">
              {actionError ||
                (status?.errorCode === 'claude-authentication-required'
                  ? t('messages.claudeAuthenticationRequired')
                  : status?.error)}
            </p>
          )}
          {!provider && signedIn && <p className="mt-1 text-[11px] text-amber-300">{t(copyKey('ProviderPending'))}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={busy !== null || usageBusy}
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-50"
            title={t(copyKey('Refresh'))}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (busy === 'refresh' || usageBusy) && 'animate-spin')} />
          </button>
          {signedIn || signingIn ? (
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/5 disabled:opacity-50"
            >
              {busy === 'logout' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              {signingIn ? t('settings.cancel') : t(copyKey('Logout'))}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void login()}
              disabled={
                busy !== null ||
                signingIn ||
                (runtimeReady && unavailable) ||
                (runtimeId !== undefined && runtime === null)
              }
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-50',
                copy.buttonClass
              )}
            >
              {busy === 'login' || signingIn ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogIn className="h-3.5 w-3.5" />
              )}
              {signingIn
                ? t(copyKey('WaitingShort'))
                : runtime && runtime.status.state !== 'ready'
                  ? runtime.status.state === 'failed' || runtime.status.state === 'corrupt'
                    ? t('settings.componentRetryAndConnect')
                    : t('settings.componentInstallAndConnect')
                  : t(copyKey('Login'))}
              {!signingIn && <ExternalLink className="h-3 w-3" />}
            </button>
          )}
          {accountId && (
            <button
              type="button"
              onClick={() => void removeAccount()}
              disabled={busy !== null}
              className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
              title={t('settings.removeAccountTitle')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {signedIn && usageSupported && <SubscriptionUsagePanel usage={usage} loading={usageBusy} />}
      {provider && signedIn && <ProviderModelFilter providerId={provider.id} onFilterChanged={onModelFilterChanged} />}
      {showSubscriptionFailover && config && (
        <FailoverRouteEditor
          providerKind={providerKind}
          primaryProviderId={
            provider?.id ?? withSubscriptionAccount(`builtin_${providerKind.replaceAll('-', '_')}`, accountId ?? null)
          }
          config={config}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function AddSubscriptionAccountForm({
  kind,
  onDone,
  onCancel,
}: {
  kind: ChatSubscriptionProviderKind
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    const r = await window.api.chatSubscriptionAccountAdd({
      kind,
      label: label.trim(),
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? t('settings.errAddFailed'))
      return
    }
    onDone()
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
      <input
        className={cn(inputCls, 'flex-1 py-1 text-[12px]')}
        placeholder={t('settings.accountLabelPlaceholder')}
        value={label}
        autoFocus
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !label.trim()}
        className={cn(
          'rounded-md px-2.5 py-1 text-[12px] font-medium',
          label.trim() ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground'
        )}
      >
        {t('settings.accountAdd')}
      </button>
      <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  )
}

type ChatSettingsTab = 'accounts' | 'models' | 'maestro' | 'tools' | 'skills' | 'prompts' | 'components'

const CHAT_SETTINGS_TABS: Array<{ id: ChatSettingsTab; labelKey: string }> = [
  { id: 'accounts', labelKey: 'settings.tabAccounts' },
  { id: 'models', labelKey: 'settings.tabModelsAgents' },
  { id: 'maestro', labelKey: 'settings.tabMaestro' },
  { id: 'tools', labelKey: 'settings.tabTools' },
  { id: 'skills', labelKey: 'settings.tabSkills' },
  { id: 'prompts', labelKey: 'settings.tabPrompts' },
  { id: 'components', labelKey: 'settings.tabComponents' },
]

function RuntimeComponentsSettings() {
  const { t } = useTranslation('chat')
  const [assets, setAssets] = useState<readonly RuntimeAssetInfo[]>([])
  const [busy, setBusy] = useState<RuntimeAssetId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => window.api.runtimeAssetList().then(setAssets)
  useEffect(() => {
    void refresh()
    return window.api.onRuntimeAssetChanged((next) =>
      setAssets((current) => current.map((item) => (item.id === next.id ? next : item)))
    )
  }, [])
  const act = async (id: RuntimeAssetId, action: 'install' | 'repair' | 'remove') => {
    if (action === 'remove' && !confirm(t('settings.componentRemoveConfirm'))) return
    setBusy(id)
    setError(null)
    try {
      const next = await (action === 'install'
        ? window.api.runtimeAssetInstall(id)
        : action === 'repair'
          ? window.api.runtimeAssetRepair(id)
          : window.api.runtimeAssetRemove(id))
      setAssets((current) => current.map((item) => (item.id === id ? next : item)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }
  const total = assets.reduce((sum, item) => sum + item.status.diskUsageBytes, 0)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-[12px] text-muted-foreground">{t('settings.componentsDescription')}</p>
        <span className="text-[11px] text-foreground">
          {t('settings.componentsTotal', { size: formatBytes(total) })}
        </span>
      </div>
      {assets.map((asset) => {
        const active = ['downloading', 'verifying', 'installing', 'removing'].includes(asset.status.state)
        return (
          <div key={asset.id} className="rounded-md border border-border px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-foreground">{t(`settings.componentName_${asset.id}`)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t(`settings.componentRequiredBy_${asset.id}`)} · {t(`settings.componentState_${asset.status.state}`)}{' '}
                  · v{asset.status.version ?? asset.availableVersion} ·{' '}
                  {t('settings.componentSizes', {
                    download: formatBytes(asset.downloadBytes),
                    installed: formatBytes(asset.status.diskUsageBytes || asset.unpackedBytes),
                  })}
                </p>
                {active && asset.status.state !== 'removing' && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-indigo-400" style={{ width: `${assetProgress(asset)}%` }} />
                  </div>
                )}
                {asset.status.error && <p className="mt-0.5 text-[11px] text-destructive">{asset.status.error}</p>}
              </div>
              {active ? (
                <button
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                  type="button"
                  onClick={() => void window.api.runtimeAssetCancel(asset.id)}
                >
                  {t('settings.componentCancel')}
                </button>
              ) : asset.status.state === 'ready' ? (
                <button
                  className="rounded border border-border px-2 py-0.5 text-[11px]"
                  disabled={busy === asset.id}
                  type="button"
                  onClick={() => void act(asset.id, 'remove')}
                >
                  {t('settings.componentRemove')}
                </button>
              ) : asset.status.state === 'corrupt' || asset.status.state === 'failed' ? (
                <button
                  className="rounded border border-border px-2 py-0.5 text-[11px]"
                  disabled={busy === asset.id}
                  type="button"
                  onClick={() => void act(asset.id, 'repair')}
                >
                  {asset.status.state === 'corrupt' ? t('settings.componentRepair') : t('settings.componentRetry')}
                </button>
              ) : (
                <button
                  className="rounded border border-border px-2 py-0.5 text-[11px]"
                  disabled={busy === asset.id || asset.downloadBytes === 0}
                  type="button"
                  onClick={() => void act(asset.id, 'install')}
                >
                  {t('settings.componentInstall')}
                </button>
              )}
            </div>
          </div>
        )
      })}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

function AccountsSettingsPanel({
  config,
  onChanged,
  onModelFilterChanged,
}: {
  config: ChatConfig
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const [adding, setAdding] = useState(false)
  const [addingAccountKind, setAddingAccountKind] = useState<ChatSubscriptionProviderKind | null>(null)

  const subscriptionProviders = new Map(
    config.providers
      .filter((provider) => isChatSubscriptionProviderKind(provider.kind) && !provider.accountId)
      .map((provider) => [provider.kind as ChatSubscriptionProviderKind, provider])
  )
  const subscriptionAccounts = config.providers.filter(
    (provider) => isChatSubscriptionProviderKind(provider.kind) && provider.accountId
  )
  const customProviders = config.providers.filter((provider) => !isChatSubscriptionProviderKind(provider.kind))
  const showSubscriptionFailover = (kind: ChatSubscriptionProviderKind) =>
    config.subscriptionFailover.supportedKinds.includes(kind) &&
    config.providers.filter((provider) => provider.kind === kind).length > 1

  return (
    <div className="flex flex-col gap-3">
      {CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((providerKind) => (
        <div key={providerKind} className="flex flex-col gap-2">
          <SubscriptionProviderCard
            providerKind={providerKind}
            provider={subscriptionProviders.get(providerKind)}
            config={config}
            showSubscriptionFailover={showSubscriptionFailover(providerKind)}
            onChanged={onChanged}
            onModelFilterChanged={onModelFilterChanged}
          />
          {subscriptionAccounts
            .filter((provider) => provider.kind === providerKind)
            .map((provider) => (
              <SubscriptionProviderCard
                key={provider.id}
                providerKind={providerKind}
                provider={provider}
                accountId={provider.accountId ?? null}
                accountLabel={provider.accountLabel}
                config={config}
                showSubscriptionFailover={showSubscriptionFailover(providerKind)}
                onChanged={onChanged}
                onModelFilterChanged={onModelFilterChanged}
              />
            ))}
          {addingAccountKind === providerKind ? (
            <AddSubscriptionAccountForm
              kind={providerKind}
              onDone={() => {
                setAddingAccountKind(null)
                onChanged()
              }}
              onCancel={() => setAddingAccountKind(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAddingAccountKind(providerKind)}
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> {t('settings.addSubscriptionAccount')}
            </button>
          )}
        </div>
      ))}

      <ChatGptWebSettings onChanged={onChanged} />

      {config.storageMode === 'unavailable' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          {t('settings.noKeyringWarning')}
        </div>
      )}

      {customProviders.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
          {t('settings.noProvidersConfigured')}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {customProviders.map((p) => (
          <ProviderRow key={p.id} provider={p} onChanged={onChanged} onModelFilterChanged={onModelFilterChanged} />
        ))}
      </div>

      {adding ? (
        <AddProviderForm
          presets={config.presets}
          onAdded={() => {
            setAdding(false)
            onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/5"
        >
          <Plus className="h-3.5 w-3.5" /> {t('settings.addProvider')}
        </button>
      )}
    </div>
  )
}

export function ApiKeySettings() {
  const { t } = useTranslation('chat')
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [activeTab, setActiveTab] = useState<ChatSettingsTab>('accounts')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const [modelFilterRevision, setModelFilterRevision] = useState(0)

  const refresh = () => window.api.chatConfig().then(setConfig)
  const modelFilterChanged = () => setModelFilterRevision((revision) => revision + 1)
  useEffect(() => {
    refresh()
  }, [])

  if (!config) return <div className="text-[12px] text-muted-foreground">{t('settings.loading')}</div>

  const onTabKeyDown = (index: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? CHAT_SETTINGS_TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + CHAT_SETTINGS_TABS.length) % CHAT_SETTINGS_TABS.length
    setActiveTab(CHAT_SETTINGS_TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label={t('settings.tabsLabel')}
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-lg border border-border bg-background/95 p-1 shadow-sm backdrop-blur"
      >
        {CHAT_SETTINGS_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            id={`chat-settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`chat-settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => onTabKeyDown(index, event)}
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
              activeTab === tab.id
                ? 'bg-white/[0.09] text-foreground'
                : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
            )}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div
        id="chat-settings-panel-accounts"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-accounts"
        hidden={activeTab !== 'accounts'}
      >
        <AccountsSettingsPanel config={config} onChanged={refresh} onModelFilterChanged={modelFilterChanged} />
      </div>
      <div
        id="chat-settings-panel-models"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-models"
        hidden={activeTab !== 'models'}
        className={cn('flex flex-col gap-3', activeTab !== 'models' && 'hidden')}
      >
        {config.providers.some(isChatProviderConnected) && (
          <DefaultModelPicker config={config} onChanged={refresh} modelFilterRevision={modelFilterRevision} />
        )}
        {config.providers.some(isChatProviderConnected) && (
          <ImageInterpreterPicker config={config} onChanged={refresh} modelFilterRevision={modelFilterRevision} />
        )}
        <SubagentProfilesSettings config={config} />
      </div>
      <div
        id="chat-settings-panel-maestro"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-maestro"
        hidden={activeTab !== 'maestro'}
      >
        <MaestroSettings config={config} />
      </div>
      <div
        id="chat-settings-panel-tools"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-tools"
        hidden={activeTab !== 'tools'}
        className={cn('flex flex-col gap-3', activeTab !== 'tools' && 'hidden')}
      >
        <FlagToggle
          headingKey="settings.appToolsHeading"
          descriptionKey="settings.appToolsDescription"
          enabled={config.appToolsEnabled}
          setEnabled={window.api.chatSetAppTools}
          onChanged={refresh}
        />
        <FlagToggle
          headingKey="settings.imageGenHeading"
          descriptionKey="settings.imageGenDescription"
          enabled={config.imageGenEnabled}
          setEnabled={window.api.chatSetImageGen}
          onChanged={refresh}
        />
        <FlagToggle
          headingKey="settings.bashFiltersHeading"
          descriptionKey="settings.bashFiltersDescription"
          enabled={config.bashFiltersEnabled}
          setEnabled={window.api.chatSetBashFilters}
          onChanged={refresh}
        />
        <McpSettings servers={config.mcpServers} onChanged={refresh} />
      </div>
      <div
        id="chat-settings-panel-skills"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-skills"
        hidden={activeTab !== 'skills'}
      >
        <SkillsSettings />
      </div>
      <div
        id="chat-settings-panel-prompts"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-prompts"
        hidden={activeTab !== 'prompts'}
      >
        <PromptsSettings />
      </div>
      <div
        id="chat-settings-panel-components"
        role="tabpanel"
        aria-labelledby="chat-settings-tab-components"
        hidden={activeTab !== 'components'}
      >
        <RuntimeComponentsSettings />
      </div>
    </div>
  )
}

function PromptsSettings() {
  const { t } = useTranslation('chat')
  const [prompts, setPrompts] = useState<ChatUserPrompt[]>([])
  const [editing, setEditing] = useState<ChatUserPrompt | 'new' | null>(null)

  const refresh = () => window.api.chatPrompts().then(setPrompts)
  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-foreground">{t('settings.savedPromptsHeading')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.savedPromptsDescription')}</p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> {t('settings.new')}
          </button>
        )}
      </div>

      {prompts.length === 0 && editing === null && (
        <p className="text-[11px] text-muted-foreground">{t('settings.noSavedPrompts')}</p>
      )}

      <div className="flex flex-col gap-1.5">
        {prompts.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5"
          >
            <span className="shrink-0 font-mono text-[12px] text-foreground">/{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {p.description || p.content}
            </span>
            <button
              type="button"
              onClick={() => {
                if (!confirm(t('settings.skillConvertConfirm', { name: p.name }))) return
                void window.api.chatSkillFromPrompt(p.id).then(() => {
                  refresh()

                  window.dispatchEvent(new Event('maestrly:skills-changed'))
                })
              }}
              className="shrink-0 text-muted-foreground hover:text-violet-300"
              title={t('settings.skillConvertToSkill')}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditing(p)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              title={t('settings.edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void window.api.chatPromptRemove(p.id).then(refresh)}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              title={t('settings.remove')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {editing !== null && (
        <PromptForm
          prompt={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function PromptForm({
  prompt,
  onDone,
  onCancel,
}: {
  prompt?: ChatUserPrompt
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')
  const [name, setName] = useState(prompt?.name ?? '')
  const [description, setDescription] = useState(prompt?.description ?? '')
  const [content, setContent] = useState(prompt?.content ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError('')
    const res = prompt
      ? await window.api.chatPromptUpdate(prompt.id, {
          name,
          description,
          content,
        })
      : await window.api.chatPromptAdd({ name, description, content })
    setBusy(false)
    if (res.ok) onDone()
    else setError((res as { error?: string }).error || t('settings.errSavePrompt'))
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-white/[0.02] px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">
          {prompt ? t('settings.editPrompt') : t('settings.newPrompt')}
        </span>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <input
          className={inputCls}
          placeholder={t('settings.promptNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder={t('settings.promptDescriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <textarea
          className={cn(inputCls, 'min-h-[80px] resize-y font-mono text-[12px]')}
          placeholder={t('settings.promptContentPlaceholder')}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !name.trim() || !content.trim()}
            className="rounded-md bg-indigo-500 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            {t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function FlagToggle({
  headingKey,
  descriptionKey,
  enabled,
  setEnabled,
  onChanged,
}: {
  headingKey: string
  descriptionKey: string
  enabled: boolean
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  return (
    <div className="mt-1 flex items-start justify-between gap-3 border-t border-border pt-3">
      <div className="min-w-0">
        <span className="text-[12px] font-medium text-foreground">{t(headingKey)}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t(descriptionKey)}</p>
      </div>
      <button
        type="button"
        onClick={() => setEnabled(!enabled).then(onChanged)}
        className={cn(
          'mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
          enabled ? 'bg-emerald-500/70' : 'bg-white/10'
        )}
        title={enabled ? t('settings.toggleOn') : t('settings.toggleOff')}
        aria-label={t(headingKey)}
        aria-pressed={enabled}
      >
        <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', enabled && 'translate-x-3')} />
      </button>
    </div>
  )
}

function DefaultModelPicker({
  config,
  onChanged,
  modelFilterRevision,
}: {
  config: ChatConfig
  onChanged: () => void
  modelFilterRevision: number
}) {
  const { t } = useTranslation('chat')
  const connectedProviders = config.providers.filter(isChatProviderConnected)
  const initialProviderId = config.defaultSelection?.providerId ?? connectedProviders[0]?.id ?? ''
  const [providerId, setProviderId] = useState(initialProviderId)
  const [modelId, setModelId] = useState(
    config.defaultSelection?.providerId === initialProviderId ? config.defaultSelection.modelId : ''
  )
  const [reasoning, setReasoning] = useState(config.defaultReasoning || 'off')
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)
  const manualChosenRef = useRef(false)

  const providerConnected = connectedProviders.some((provider) => provider.id === providerId)
  const selectableProviders = config.providers.filter(
    (provider) => isChatProviderConnected(provider) || provider.id === config.defaultSelection?.providerId
  )

  useEffect(() => {
    if (!providerId || !providerConnected) {
      setModels([])
      setLoading(false)
      return
    }
    let alive = true
    setModels([])
    setLoading(true)
    window.api
      .chatModels(providerId)
      .then((m) => {
        if (!alive) return
        setModels(m)
        if (m.length === 0) setManual(true)
        else if (!manualChosenRef.current) setManual(false)
      })
      .catch(() => {
        if (alive) setModels([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [providerId, providerConnected, modelFilterRevision])

  useEffect(() => {
    if (!modelId) {
      setMeta(null)
      return
    }
    let alive = true
    window.api.chatModelMeta(modelId, providerId).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [modelId, providerId])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]

  useEffect(() => {
    if (reasoning !== 'off' && meta?.reasoning && !efforts.includes(reasoning)) {
      setReasoning('off')
      if (providerId && modelId) window.api.chatSetDefault({ providerId, modelId, reasoning: 'off' }).then(onChanged)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, modelId])

  const commit = (pId: string, mId: string, r: string = reasoning) => {
    if (pId && mId) window.api.chatSetDefault({ providerId: pId, modelId: mId, reasoning: r }).then(onChanged)
  }

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <span className="text-[12px] font-medium text-foreground">{t('settings.defaultModelHeading')}</span>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          value={providerId}
          onValueChange={(selectedValue) => {
            setProviderId(selectedValue)
            setModelId('')
            manualChosenRef.current = false
            setManual(false)
          }}
          className="h-8 w-auto max-w-full text-[13px]"
        >
          {selectableProviders.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </OptionSelect>
        {manual ? (
          <input
            disabled={!providerConnected}
            className={cn(inputCls, 'min-w-[220px] flex-1')}
            placeholder={t('settings.modelIdPlaceholder')}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onBlur={() => commit(providerId, modelId)}
          />
        ) : (
          <OptionSelect
            value={modelId}
            disabled={loading || !providerConnected}
            onValueChange={(selectedValue) => {
              if (selectedValue === '__manual__') {
                manualChosenRef.current = true
                setManual(true)
                setModelId('')
                return
              }
              setModelId(selectedValue)
              commit(providerId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
          >
            <SelectOption value="">{loading ? t('settings.loadingModels') : t('settings.chooseModel')}</SelectOption>
            {!providerConnected && modelId && <SelectOption value={modelId}>{modelId}</SelectOption>}
            {models.map((m) => (
              <SelectOption key={m} value={m}>
                {m}
              </SelectOption>
            ))}
            <SelectOption value="__manual__">{t('settings.enterIdManually')}</SelectOption>
          </OptionSelect>
        )}
        {meta?.reasoning && (
          <OptionSelect
            value={efforts.includes(reasoning) ? reasoning : 'off'}
            onValueChange={(selectedValue) => {
              setReasoning(selectedValue)
              commit(providerId, modelId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
            title={t('reasoning.buttonTitle')}
          >
            <SelectOption value="off">{t('reasoning.default')}</SelectOption>
            {efforts.map((eff) => (
              <SelectOption key={eff} value={eff}>
                {eff}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
        <button
          type="button"
          disabled={!providerConnected}
          onClick={() => window.api.chatModels(providerId, true).then(setModels)}
          className="rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5"
          title={t('settings.reloadModelsTitle')}
        >
          {t('settings.reload')}
        </button>
      </div>
    </div>
  )
}

function ImageInterpreterPicker({
  config,
  onChanged,
  modelFilterRevision,
}: {
  config: ChatConfig
  onChanged: () => void
  modelFilterRevision: number
}) {
  const { t } = useTranslation('chat')
  const connectedProviders = config.providers.filter(isChatProviderConnected)
  const [providerId, setProviderId] = useState(config.imageInterpreter?.providerId ?? '')
  const [modelId, setModelId] = useState(config.imageInterpreter?.modelId ?? '')
  const [effort, setEffort] = useState(config.imageInterpreter?.effort ?? 'off')
  const [models, setModels] = useState<string[]>([])
  const [meta, setMeta] = useState<ChatModelMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState(false)

  useEffect(() => {
    if (!providerId) {
      setModels([])
      return
    }
    let alive = true
    setModels([])
    setLoading(true)
    window.api
      .chatModels(providerId)
      .then((m) => {
        if (!alive) return
        setModels(m)
        if (m.length === 0) setManual(true)
      })
      .catch(() => alive && setModels([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [providerId, modelFilterRevision])

  useEffect(() => {
    if (!providerId || !modelId) {
      setMeta(null)
      return
    }
    let alive = true
    window.api.chatModelMeta(modelId, providerId).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [modelId, providerId])

  const efforts = meta?.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]
  const commit = (pId: string, mId: string, eff: string) => {
    const value =
      pId && mId
        ? {
            providerId: pId,
            modelId: mId,
            ...(eff && eff !== 'off' ? { effort: eff } : {}),
          }
        : null
    void window.api.chatSetImageInterpreter(value).then(onChanged)
  }

  // Reject tool schemas that provider runtimes cannot describe.
  useEffect(() => {
    if (!meta || effort === 'off') return
    if (meta.reasoning && efforts.includes(effort)) return
    setEffort('off')
    if (providerId && modelId) commit(providerId, modelId, 'off')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div className="min-w-0">
        <span className="text-[12px] font-medium text-foreground">{t('settings.imageInterpreterHeading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.imageInterpreterDescription')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect
          value={providerId}
          onValueChange={(selectedValue) => {
            const next = selectedValue
            setProviderId(next)
            setModelId('')
            setManual(false)
            setMeta(null)
            setEffort('off')
            if (!next) commit('', '', 'off')
          }}
          className="h-8 w-auto max-w-full text-[13px]"
        >
          <SelectOption value="">{t('settings.imageInterpreterOff')}</SelectOption>
          {connectedProviders.map((p) => (
            <SelectOption key={p.id} value={p.id}>
              {p.name}
            </SelectOption>
          ))}
        </OptionSelect>
        {providerId &&
          (manual ? (
            <input
              className={cn(inputCls, 'min-w-[220px] flex-1')}
              placeholder={t('settings.modelIdPlaceholder')}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              onBlur={() => commit(providerId, modelId.trim(), effort)}
            />
          ) : (
            <OptionSelect
              value={modelId}
              disabled={loading}
              onValueChange={(selectedValue) => {
                if (selectedValue === '__manual__') {
                  setManual(true)
                  setModelId('')
                  return
                }
                setModelId(selectedValue)
                setEffort('off')
                commit(providerId, selectedValue, 'off')
              }}
              className="h-8 w-auto max-w-full text-[13px]"
            >
              <SelectOption value="">{loading ? t('settings.loadingModels') : t('settings.chooseModel')}</SelectOption>
              {modelId && !models.includes(modelId) && <SelectOption value={modelId}>{modelId}</SelectOption>}
              {models.map((m) => (
                <SelectOption key={m} value={m}>
                  {m}
                </SelectOption>
              ))}
              <SelectOption value="__manual__">{t('settings.enterIdManually')}</SelectOption>
            </OptionSelect>
          ))}
        {providerId && modelId && meta?.reasoning && (
          <OptionSelect
            value={efforts.includes(effort) ? effort : 'off'}
            onValueChange={(selectedValue) => {
              setEffort(selectedValue)
              commit(providerId, modelId, selectedValue)
            }}
            className="h-8 w-auto max-w-full text-[13px]"
            title={t('reasoning.buttonTitle')}
          >
            <SelectOption value="off">{t('reasoning.default')}</SelectOption>
            {efforts.map((eff) => (
              <SelectOption key={eff} value={eff}>
                {eff}
              </SelectOption>
            ))}
          </OptionSelect>
        )}
      </div>
      {providerId && modelId && meta?.vision === false && (
        <p className="text-[11px] text-amber-300">{t('settings.imageInterpreterNoVisionWarning')}</p>
      )}
    </div>
  )
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function McpAddForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const { t } = useTranslation('chat')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const r = await window.api.chatMcpAdd(
      transport === 'http'
        ? {
            name: name.trim(),
            transport,
            url: url.trim(),
            headers: headers.trim() ? parseHeaders(headers) : undefined,
          }
        : {
            name: name.trim(),
            transport,
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : undefined,
            env: env.trim() ? parseEnv(env) : undefined,
          }
    )
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? t('settings.errAddFailed'))
      return
    }
    onAdded()
  }

  return (
    <div className="rounded-lg border border-indigo-500/30 bg-white/[0.02] px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">{t('settings.newMcpServer')}</span>
        <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <input
          className={inputCls}
          placeholder={t('settings.mcpNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTransport('http')}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px]',
              transport === 'http' ? 'border-ring bg-white/5 text-foreground' : 'border-border text-muted-foreground'
            )}
          >
            HTTP
          </button>
          <button
            type="button"
            onClick={() => setTransport('stdio')}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px]',
              transport === 'stdio' ? 'border-ring bg-white/5 text-foreground' : 'border-border text-muted-foreground'
            )}
          >
            stdio
          </button>
        </div>
        {transport === 'http' ? (
          <>
            <input
              className={inputCls}
              placeholder={t('settings.mcpUrlPlaceholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <textarea
              className={cn(inputCls, 'min-h-[56px] font-mono text-[12px]')}
              placeholder={t('settings.mcpHeadersPlaceholder')}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
            />
          </>
        ) : (
          <>
            <input
              className={inputCls}
              placeholder={t('settings.mcpCommandPlaceholder')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder={t('settings.mcpArgsPlaceholder')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            <textarea
              className={cn(inputCls, 'min-h-[44px] font-mono text-[12px]')}
              placeholder={t('settings.mcpEnvPlaceholder')}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </>
        )}
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/5"
          >
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim() || (transport === 'http' ? !url.trim() : !command.trim())}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[12px] font-medium',
              name.trim() ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-foreground/10 text-muted-foreground'
            )}
          >
            {t('settings.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

function McpSettings({ servers, onChanged }: { servers: McpServerInfo[]; onChanged: () => void }) {
  const { t } = useTranslation('chat')
  const [adding, setAdding] = useState(false)
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div>
        <span className="text-[12px] font-medium text-foreground">{t('settings.mcpServersHeading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.mcpServersDescription')}</p>
      </div>
      {servers.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[13px]"
        >
          <button
            type="button"
            onClick={() => window.api.chatMcpUpdate(s.id, { enabled: !s.enabled }).then(onChanged)}
            className={cn(
              'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
              s.enabled ? 'bg-emerald-500/70' : 'bg-white/10'
            )}
            title={s.enabled ? t('settings.toggleOn') : t('settings.toggleOff')}
          >
            <span
              className={cn('block h-3 w-3 rounded-full bg-white transition-transform', s.enabled && 'translate-x-3')}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-foreground">{s.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {s.transport === 'http' ? s.url : s.command}
            </div>
          </div>
          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {s.transport}
          </span>
          <button
            type="button"
            onClick={() => window.api.chatMcpRemove(s.id).then(onChanged)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            title={t('settings.remove')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {adding ? (
        <McpAddForm
          onAdded={() => {
            setAdding(false)
            onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/5"
        >
          <Plus className="h-3.5 w-3.5" /> {t('settings.addMcpServer')}
        </button>
      )}
    </div>
  )
}
