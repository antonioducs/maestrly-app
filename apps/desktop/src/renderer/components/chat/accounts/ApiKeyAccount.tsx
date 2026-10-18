import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, Loader2, MoreHorizontal, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import {
  effectiveProviderKind,
  isChatProviderConnected,
  isChatProviderKeyRejected,
  isOfficialOpenAIProvider,
} from '../../../../shared/chat'
import type {
  ChatProviderInfo,
  ChatProviderKeyCheck,
  ChatProviderKind,
  ChatSubscriptionProviderKind,
} from '../../../../shared/chat'
import type { ApiKeyAccountEntry } from './account-entries'
import {
  DetailBackButton,
  DetailHeader,
  DetailSection,
  iconButtonCls,
  inputCls,
  linkButtonCls,
  primaryButtonCls,
  ProviderMark,
} from './account-ui'
import { ProviderModelFilter } from './ProviderModelFilter'

export const API_PROVIDER_KINDS: Exclude<ChatProviderKind, ChatSubscriptionProviderKind>[] = [
  'openai-responses',
  'openai',
  'anthropic',
]

export const kindLabelKey: Record<ChatProviderKind, string> = {
  'openai-responses': 'settings.apiFormatOpenAIResponses',
  openai: 'settings.apiFormatOpenAI',
  anthropic: 'settings.apiFormatAnthropic',
  'codex-subscription': 'settings.apiFormatCodexSubscription',
  'github-copilot-subscription': 'settings.apiFormatGitHubCopilotSubscription',
  'claude-subscription': 'settings.apiFormatClaudeSubscription',
  'grok-subscription': 'settings.apiFormatGrokSubscription',
  'cursor-subscription': 'settings.apiFormatCursorSubscription',
  'antigravity-subscription': 'settings.apiFormatAntigravitySubscription',
}

export function KindPicker({ value, onPick }: { value: ChatProviderKind; onPick: (k: ChatProviderKind) => void }) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex flex-wrap gap-1.5">
      {API_PROVIDER_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onPick(k)}
          aria-pressed={value === k}
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

export function ApiKeyAccount({
  entry,
  keyringAvailable,
  onBack,
  onChanged,
  onModelFilterChanged,
}: {
  entry: ApiKeyAccountEntry
  keyringAvailable: boolean
  onBack: () => void
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const provider: ChatProviderInfo = entry.provider
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  // The check's own answer, shown until the refreshed config carries it.
  const [answered, setAnswered] = useState<ChatProviderKeyCheck | null>(null)
  const autoChecked = useRef(new Set<string>())
  const officialOpenAI = isOfficialOpenAIProvider(provider.baseURL)
  const effectiveKind = effectiveProviderKind(provider.baseURL, provider.kind)
  const keyCheck = provider.apiKeyPresent
    ? [provider.keyCheck, answered].reduce<ChatProviderKeyCheck | undefined>(
        (latest, candidate) => (candidate && (!latest || candidate.checkedAt > latest.checkedAt) ? candidate : latest),
        undefined
      )
    : undefined
  const rejected = isChatProviderKeyRejected({ keyCheck })

  const checkKey = useCallback(async () => {
    setChecking(true)
    try {
      const result = await api.chatCheckKey(provider.id)
      setAnswered(result.ok && result.keyCheck ? result.keyCheck : null)
    } catch {
      // A host without the check keeps showing the key as saved.
    } finally {
      setChecking(false)
    }
    onChanged()
  }, [api, provider.id, onChanged])

  // A key saved elsewhere (the Add account dialog, an older version) is checked the first time its card opens.
  useEffect(() => {
    if (!provider.apiKeyPresent || provider.keyCheck || autoChecked.current.has(provider.id)) return
    autoChecked.current.add(provider.id)
    void checkKey()
  }, [provider.id, provider.apiKeyPresent, provider.keyCheck, checkKey])

  const changeKind = async (k: ChatProviderKind) => {
    if (k === effectiveKind) return
    setBusy(true)
    await api.chatUpdateProvider(provider.id, { kind: k })
    setBusy(false)
    setAnswered(null)
    onChanged()
    if (provider.apiKeyPresent) void checkKey()
  }

  const saveKey = async () => {
    if (!value.trim()) return
    setBusy(true)
    await api.chatSetKey(provider.id, value.trim())
    setValue('')
    setBusy(false)
    setAnswered(null)
    autoChecked.current.add(provider.id)
    onChanged()
    // Saving never waits for the provider: an unreachable one leaves the key saved and unverified.
    void checkKey()
  }
  const remove = async () => {
    if (!confirm(t('settings.confirmRemoveProvider', { name: provider.name }))) return
    setBusy(true)
    await api.chatRemoveProvider(provider.id)
    setBusy(false)
    onChanged()
  }

  return (
    <div data-api-key-provider={provider.id}>
      <DetailBackButton onBack={onBack} />
      <DetailHeader
        mark={<ProviderMark kind={{ apiName: provider.name, baseURL: provider.baseURL }} size="lg" />}
        title={provider.name}
        status={
          !provider.apiKeyPresent ? (
            <span className="text-[12px] text-amber-300">{t('settings.accountNoApiKey')}</span>
          ) : checking ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('settings.accountKeyChecking')}
            </span>
          ) : rejected ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-rose-300" data-key-check="rejected">
              <AlertCircle className="h-3 w-3" /> {t('settings.accountKeyRejected')}
            </span>
          ) : keyCheck?.outcome === 'unverified' ? (
            <span className="text-[12px] text-muted-foreground" data-key-check="unverified">
              {t('settings.accountKeyUnverified')}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[12px] text-emerald-400"
              data-key-check={keyCheck?.outcome ?? 'unchecked'}
            >
              <Check className="h-3 w-3" />{' '}
              {keyCheck?.outcome === 'accepted' ? t('settings.accountKeyVerified') : t('settings.accountKeySaved')}
            </span>
          )
        }
        subtitle={t(kindLabelKey[effectiveKind])}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={iconButtonCls}
                disabled={busy}
                aria-label={t('settings.accountMoreActions')}
                title={t('settings.accountMoreActions')}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem destructive onSelect={() => void remove()}>
                <Trash2 /> {t('settings.removeProvider')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <DetailSection
        title={t('settings.accountApiKeyHeading')}
        hint={keyringAvailable ? t('settings.accountApiKeyStored') : undefined}
      >
        {!keyringAvailable && <p className="mb-2 text-[12px] text-amber-300">{t('settings.noKeyringWarning')}</p>}
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={value}
            disabled={busy}
            aria-label={t('settings.accountApiKeyHeading')}
            placeholder={
              provider.apiKeyPresent
                ? t('settings.replaceKeyPlaceholder')
                : t('settings.keyForProviderPlaceholder', { name: provider.name })
            }
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey()
            }}
            className={cn(inputCls, 'min-w-0 flex-1 font-mono text-[12px]')}
          />
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={!value.trim() || busy}
            className={primaryButtonCls}
          >
            {t('settings.save')}
          </button>
        </div>
        {!checking && keyCheck && keyCheck.outcome !== 'accepted' && (
          <div
            role={rejected ? 'alert' : 'status'}
            data-key-check-notice={keyCheck.outcome}
            className={cn(
              'mt-2.5 rounded-md border px-2.5 py-2 text-[12px]',
              rejected ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-border text-muted-foreground'
            )}
          >
            <p>
              {rejected
                ? t('settings.accountKeyRejectedHint', { status: keyCheck.status ?? 401 })
                : keyCheck.status
                  ? t('settings.accountKeyUnverifiedHttpHint', { status: keyCheck.status })
                  : t('settings.accountKeyUnverifiedHint')}
            </p>
            {keyCheck.detail && <p className="mt-1 break-words font-mono text-[11px] opacity-90">{keyCheck.detail}</p>}
            <button type="button" className={cn(linkButtonCls, 'mt-1.5')} onClick={() => void checkKey()}>
              {t('settings.accountKeyCheckAgain')}
            </button>
          </div>
        )}
      </DetailSection>

      <DetailSection title={t('settings.accountConnectionHeading')}>
        <p className="break-all font-mono text-[12px] text-foreground/80">{provider.baseURL}</p>
        {!officialOpenAI && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t('settings.apiFormat')}</span>
            <KindPicker value={effectiveKind} onPick={(k) => void changeKind(k)} />
          </div>
        )}
      </DetailSection>

      {isChatProviderConnected(provider) && !rejected && (
        <ProviderModelFilter providerId={provider.id} onFilterChanged={onModelFilterChanged} />
      )}
    </div>
  )
}
