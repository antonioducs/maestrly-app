import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, LogIn, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import {
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  defaultProviderKind,
  effectiveProviderKind,
  isOfficialOpenAIProvider,
  withSubscriptionAccount,
} from '../../../../shared/chat'
import type {
  ChatConfig,
  ChatProviderKind,
  ChatProviderPreset,
  ChatSubscriptionProviderKind,
} from '../../../../shared/chat'
import {
  baseUrlHost,
  defaultSubscriptionProviderId,
  type AccountSnapshot,
  type SubscriptionAccountSnapshot,
} from './account-entries'
import { inputCls, primaryButtonCls, ProviderMark, secondaryButtonCls } from './account-ui'
import { KindPicker } from './ApiKeyAccount'
import { subscriptionProviderCopy } from './SubscriptionAccount'

export interface AddAccountIntent {
  kind?: ChatSubscriptionProviderKind
  /** Always create a new labeled account, even when the provider's default slot is free. */
  newAccount?: boolean
}

type Choice =
  | { type: 'subscription'; kind: ChatSubscriptionProviderKind }
  | { type: 'api'; preset: ChatProviderPreset | null }
  | null

const cardCls =
  'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-indigo-400/60 hover:bg-white/[0.04]'

export function AddAccountDialog({
  intent,
  config,
  snapshots,
  onClose,
  onChanged,
  onSubscriptionReady,
  onChatGptWeb,
  onApiProviderAdded,
}: {
  intent: AddAccountIntent | null
  config: ChatConfig
  snapshots: Record<string, AccountSnapshot>
  onClose: () => void
  onChanged: () => void
  /** The slot is ready for sign-in: select it and start signing in. */
  onSubscriptionReady: (providerId: string) => void
  onChatGptWeb: () => void
  onApiProviderAdded: (providerId: string | null) => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [choice, setChoice] = useState<Choice>(null)
  const [label, setLabel] = useState('')
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [key, setKey] = useState('')
  const [kind, setKind] = useState<ChatProviderKind>('openai')
  const [kindTouched, setKindTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!intent) return
    setChoice(intent.kind ? { type: 'subscription', kind: intent.kind } : null)
    setLabel('')
    setError(null)
    setBusy(false)
  }, [intent])

  useEffect(() => {
    if (!choice) return
    const timer = setTimeout(() => {
      formRef.current?.scrollIntoView({ block: 'nearest' })
      // A preset fills the name and URL, so the key is the next thing to type.
      const target = choice.type === 'api' && choice.preset ? 'input[type="password"]' : 'input'
      formRef.current?.querySelector<HTMLInputElement>(target)?.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [choice])

  const accountsOf = (providerKind: ChatSubscriptionProviderKind) =>
    config.providers.filter((provider) => provider.kind === providerKind)
  const defaultSlotInUse = (providerKind: ChatSubscriptionProviderKind): boolean => {
    const base = accountsOf(providerKind).find((provider) => !provider.accountId)
    const key = base?.id ?? defaultSubscriptionProviderId(providerKind)
    const state = (snapshots[key] as SubscriptionAccountSnapshot | undefined)?.status?.state
    return state === 'signed-in' || state === 'signing-in' || (!state && base?.connected === true)
  }
  const connectedCount = (providerKind: ChatSubscriptionProviderKind) =>
    accountsOf(providerKind).filter((provider) => {
      const state = (snapshots[provider.id] as SubscriptionAccountSnapshot | undefined)?.status?.state
      return state ? state === 'signed-in' : provider.connected === true
    }).length

  const pickApi = (preset: ChatProviderPreset | null) => {
    setChoice({ type: 'api', preset })
    setError(null)
    setName(preset?.name ?? '')
    setBaseURL(preset?.baseURL ?? '')
    setKind(preset?.kind ?? (preset ? defaultProviderKind(preset.baseURL) : 'openai'))
    setKindTouched(!!preset)
    setKey('')
  }

  const needsLabel = choice?.type === 'subscription' && (intent?.newAccount === true || defaultSlotInUse(choice.kind))

  const submitSubscription = async (providerKind: ChatSubscriptionProviderKind) => {
    if (!needsLabel) {
      onSubscriptionReady(
        accountsOf(providerKind).find((p) => !p.accountId)?.id ?? defaultSubscriptionProviderId(providerKind)
      )
      return
    }
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    const result = await api.chatSubscriptionAccountAdd({ kind: providerKind, label: label.trim() })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? t('settings.errAddFailed'))
      return
    }
    onChanged()
    onSubscriptionReady(
      result.providerId ??
        withSubscriptionAccount(defaultSubscriptionProviderId(providerKind), result.accountId ?? null)
    )
  }

  const submitApi = async () => {
    if (!name.trim() || !baseURL.trim()) {
      setError(t('settings.errNameBaseUrlRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await api.chatAddProvider({
      name: name.trim(),
      baseURL: baseURL.trim(),
      key: key.trim() || undefined,
      kind: effectiveProviderKind(baseURL, kind),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? t('settings.errAddFailed'))
      return
    }
    onChanged()
    onApiProviderAdded(result.id ?? null)
  }

  const submit = () => {
    if (choice?.type === 'subscription') void submitSubscription(choice.kind)
    else if (choice?.type === 'api') void submitApi()
  }

  const canSubmit =
    !busy &&
    (choice?.type === 'subscription'
      ? !needsLabel || !!label.trim()
      : choice?.type === 'api'
        ? !!name.trim() && !!baseURL.trim()
        : false)

  const groupTitle = (text: string) => (
    <p className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:mt-0">{text}</p>
  )

  return (
    <Dialog open={intent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[min(640px,calc(100vh-2rem))] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="add-account-dialog"
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5">
          <DialogTitle className="text-[15px]">{t('settings.addAccountTitle')}</DialogTitle>
          <DialogDescription className="text-[12px]">{t('settings.addAccountDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          {groupTitle(t('settings.addAccountSubscriptions'))}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
            {CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((providerKind) => {
              const count = connectedCount(providerKind)
              const active = choice?.type === 'subscription' && choice.kind === providerKind
              return (
                <button
                  key={providerKind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setChoice({ type: 'subscription', kind: providerKind })
                    setError(null)
                  }}
                  className={cn(cardCls, active ? 'border-indigo-400/70 bg-white/[0.05]' : 'border-border')}
                >
                  <ProviderMark kind={providerKind} />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {t(`settings.accountProviderName_${providerKind}`)}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {count > 0 ? t('settings.addAccountConnected', { count }) : t('settings.addAccountUsePlan')}
                    </span>
                  </span>
                </button>
              )
            })}
            <button type="button" onClick={onChatGptWeb} className={cn(cardCls, 'border-border')}>
              <ProviderMark kind="chatgpt-web" />
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {t('settings.accountProviderName_chatgpt-web')}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t('settings.addAccountChatGptWebHint')}
                </span>
              </span>
            </button>
          </div>

          {groupTitle(t('settings.accountsApiKeysGroup'))}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2">
            {config.presets.map((preset) => {
              const active = choice?.type === 'api' && choice.preset?.name === preset.name
              return (
                <button
                  key={preset.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickApi(preset)}
                  className={cn(cardCls, active ? 'border-indigo-400/70 bg-white/[0.05]' : 'border-border')}
                >
                  <ProviderMark kind={{ apiName: preset.name, baseURL: preset.baseURL }} />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-foreground">{preset.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {baseUrlHost(preset.baseURL)}
                    </span>
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              aria-pressed={choice?.type === 'api' && choice.preset === null}
              onClick={() => pickApi(null)}
              className={cn(
                cardCls,
                choice?.type === 'api' && choice.preset === null
                  ? 'border-indigo-400/70 bg-white/[0.05]'
                  : 'border-dashed border-border'
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-muted-foreground">
                <Plus className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {t('settings.addAccountCustomProvider')}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {t('settings.addAccountCustomHint')}
                </span>
              </span>
            </button>
          </div>

          {choice?.type === 'subscription' && (
            <div ref={formRef} className="mt-4 border-t border-border pt-4">
              {needsLabel ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-muted-foreground">{t('settings.addAccountLabel')}</span>
                  <input
                    className={inputCls}
                    placeholder={t('settings.accountLabelPlaceholder')}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canSubmit) submit()
                    }}
                  />
                </label>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  {t(`settings.${subscriptionProviderCopy[choice.kind].prefix}Description`)}
                </p>
              )}
            </div>
          )}

          {choice?.type === 'api' && (
            <div ref={formRef} className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
              <input
                className={inputCls}
                placeholder={t('settings.providerNamePlaceholder')}
                aria-label={t('settings.providerNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder={t('settings.baseUrlPlaceholder')}
                aria-label={t('settings.baseUrlPlaceholder')}
                value={baseURL}
                onChange={(e) => {
                  setBaseURL(e.target.value)
                  if (!kindTouched) setKind(defaultProviderKind(e.target.value))
                }}
              />
              {!isOfficialOpenAIProvider(baseURL) && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">{t('settings.apiFormat')}</span>
                  <KindPicker
                    value={kind}
                    onPick={(next) => {
                      setKind(next)
                      setKindTouched(true)
                    }}
                  />
                </div>
              )}
              <input
                className={cn(inputCls, 'font-mono text-[12px]')}
                type="password"
                placeholder={t('settings.apiKeyOptionalPlaceholder')}
                aria-label={t('settings.apiKeyOptionalPlaceholder')}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) submit()
                }}
              />
              {choice.preset?.apiKeyUrl && (
                <button
                  type="button"
                  className="inline-flex w-fit items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200"
                  onClick={() => window.api.openExternalUrl(choice.preset!.apiKeyUrl!)}
                >
                  <ExternalLink className="h-3 w-3" /> {t('settings.addAccountGetKey')}
                </button>
              )}
              {config.storageMode === 'unavailable' && (
                <p className="text-[11px] text-amber-300">{t('settings.noKeyringWarning')}</p>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" className={secondaryButtonCls} onClick={onClose}>
            {t('settings.cancel')}
          </button>
          <button type="button" className={primaryButtonCls} disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {choice?.type === 'api' ? (
              t('settings.addProvider')
            ) : choice?.type === 'subscription' ? (
              <>
                {!busy && <LogIn className="h-3.5 w-3.5" />}
                {t(`settings.${subscriptionProviderCopy[choice.kind].prefix}Login`)}
              </>
            ) : (
              t('settings.addAccountChoose')
            )}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
