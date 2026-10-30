import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import {
  isChatProviderConnected,
  type ChatConfig,
  type ChatSubscriptionAccountPoolInfo,
  type ChatSubscriptionAccountPoolPatch,
  type ChatSubscriptionAccountPoolPolicy,
} from '../../../../shared/chat'
import {
  accountPoolCandidates,
  addAccountPoolMember,
  makeAccountActive,
  moveAccountPoolMember,
  removeAccountPoolMember,
  withAccountPoolPolicy,
} from '../account-pool'
import { labelForSubscriptionProvider } from '../subscription-failover-route'
import { secondaryButtonCls } from './account-ui'

const POLICY_COPY = {
  drain: {
    name: 'settings.accountPoolPolicyDrain',
    description: 'settings.accountPoolPolicyDrainDescription',
  },
  'prefer-active': {
    name: 'settings.accountPoolPolicyPreferActive',
    description: 'settings.accountPoolPolicyPreferActiveDescription',
  },
} as const satisfies Record<ChatSubscriptionAccountPoolPolicy, { name: string; description: string }>

const POLICIES = Object.keys(POLICY_COPY) as ChatSubscriptionAccountPoolPolicy[]

/** The accounts a provider's "active account" model selection rotates over, and which one is active now. */
export function AccountPoolEditor({
  pool,
  providerId,
  config,
  defaultLabel,
  disconnectedLabel,
  onChanged,
}: {
  pool: ChatSubscriptionAccountPoolInfo
  /** The account this page shows, which the pool may or may not have as its active one. */
  providerId: string
  config: ChatConfig
  /** Name of the provider's default account, which has no account label of its own. */
  defaultLabel: string
  disconnectedLabel: string
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The pool also changes from other windows and from the rotation itself.
  useEffect(() => api.onChatModelsCatalogChanged(onChanged), [api, onChanged])

  const save = async (patch: ChatSubscriptionAccountPoolPatch | null) => {
    if (!patch) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.chatSubscriptionAccountPoolSet(patch)
      if (!result.ok) throw new Error(result.error || t('settings.accountPoolSaveFailed'))
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const candidates = accountPoolCandidates(pool, config.providers, defaultLabel)

  return (
    <section data-account-pool={pool.kind} className="mt-4 border-t border-border/70 pt-4">
      <p className="text-[12px] font-medium text-foreground">{t('settings.accountPoolTitle')}</p>
      <p className="text-[11px] text-muted-foreground">{t('settings.accountPoolDescription')}</p>

      {pool.activeProviderId === providerId ? (
        <p className="mt-2 text-[12px] text-foreground">{t('settings.accountPoolIsActive')}</p>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(makeAccountActive(pool, providerId))}
          className={cn(secondaryButtonCls, 'mt-2')}
        >
          {t('settings.accountPoolMakeActive')}
        </button>
      )}

      <fieldset className="mt-3 flex flex-col gap-1.5" disabled={busy}>
        <legend className="mb-1 text-[12px] font-medium text-foreground">{t('settings.accountPoolPolicyLabel')}</legend>
        {POLICIES.map((policy) => (
          <label key={policy} className="flex items-start gap-2">
            <input
              type="radio"
              className="mt-0.5"
              name={`account-pool-policy-${pool.kind}`}
              value={policy}
              checked={pool.policy === policy}
              onChange={() => void save(withAccountPoolPolicy(pool, policy))}
            />
            <span className="min-w-0">
              <span className="block text-[12px] text-foreground">{t(POLICY_COPY[policy].name)}</span>
              <span className="block text-[11px] text-muted-foreground">{t(POLICY_COPY[policy].description)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="mt-3 text-[12px] font-medium text-foreground">{t('settings.accountPoolMembers')}</p>
      <ol className="mt-1.5 flex flex-col gap-1.5">
        {pool.memberProviderIds.map((memberId, index) => {
          const provider = config.providers.find((entry) => entry.id === memberId)
          const connected = provider ? isChatProviderConnected(provider) : false
          const label = labelForSubscriptionProvider(memberId, config.providers, defaultLabel)
          const moveUp = moveAccountPoolMember(pool, index, -1)
          const moveDown = moveAccountPoolMember(pool, index, 1)
          const removal = removeAccountPoolMember(pool, memberId)
          return (
            <li
              key={memberId}
              className="flex items-center gap-1.5 rounded-md border border-border/60 bg-white/[0.02] px-2 py-1.5"
            >
              <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{label}</span>
              {pool.activeProviderId === memberId && (
                <span className="shrink-0 rounded-full bg-indigo-500/15 px-1.5 text-[10px] font-medium text-indigo-300">
                  {t('settings.accountPoolActiveBadge')}
                </span>
              )}
              {!connected && (
                <span className="shrink-0 text-[10px] text-amber-300">{disconnectedLabel}</span>
              )}
              <button
                type="button"
                title={t('settings.moveFallbackUp')}
                aria-label={t('settings.moveFallbackUp')}
                disabled={busy || !moveUp}
                onClick={() => void save(moveUp)}
                className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={t('settings.moveFallbackDown')}
                aria-label={t('settings.moveFallbackDown')}
                disabled={busy || !moveDown}
                onClick={() => void save(moveDown)}
                className="rounded p-1 text-muted-foreground hover:bg-white/5 disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={t('settings.accountPoolRemoveMember')}
                aria-label={t('settings.accountPoolRemoveMember')}
                disabled={busy || !removal}
                onClick={() => void save(removal)}
                className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          )
        })}

        {candidates.length > 0 && (
          <li className="list-none">
            <OptionSelect
              className="h-8 text-xs"
              disabled={busy}
              value=""
              onValueChange={(selectedValue) => {
                if (selectedValue) void save(addAccountPoolMember(pool, selectedValue))
              }}
              aria-label={t('settings.accountPoolAddMember')}
            >
              <SelectOption value="">{t('settings.accountPoolAddMember')}</SelectOption>
              {candidates.map((candidate) => (
                <SelectOption key={candidate.providerId} value={candidate.providerId}>
                  {candidate.label}
                  {!candidate.connected ? ` (${disconnectedLabel})` : ''}
                </SelectOption>
              ))}
            </OptionSelect>
          </li>
        )}
      </ol>

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </section>
  )
}
