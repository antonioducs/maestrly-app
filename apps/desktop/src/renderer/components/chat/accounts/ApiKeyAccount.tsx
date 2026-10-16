import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MoreHorizontal, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { effectiveProviderKind, isChatProviderConnected, isOfficialOpenAIProvider } from '../../../../shared/chat'
import type { ChatProviderInfo, ChatProviderKind, ChatSubscriptionProviderKind } from '../../../../shared/chat'
import type { ApiKeyAccountEntry } from './account-entries'
import {
  DetailBackButton,
  DetailHeader,
  DetailSection,
  iconButtonCls,
  inputCls,
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
  const officialOpenAI = isOfficialOpenAIProvider(provider.baseURL)
  const effectiveKind = effectiveProviderKind(provider.baseURL, provider.kind)

  const changeKind = async (k: ChatProviderKind) => {
    if (k === effectiveKind) return
    setBusy(true)
    await api.chatUpdateProvider(provider.id, { kind: k })
    setBusy(false)
    onChanged()
  }

  const saveKey = async () => {
    if (!value.trim()) return
    setBusy(true)
    await api.chatSetKey(provider.id, value.trim())
    setValue('')
    setBusy(false)
    onChanged()
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
          provider.apiKeyPresent ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-emerald-400">
              <Check className="h-3 w-3" /> {t('settings.accountKeySaved')}
            </span>
          ) : (
            <span className="text-[12px] text-amber-300">{t('settings.accountNoApiKey')}</span>
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

      {isChatProviderConnected(provider) && (
        <ProviderModelFilter providerId={provider.id} onFilterChanged={onModelFilterChanged} />
      )}
    </div>
  )
}
