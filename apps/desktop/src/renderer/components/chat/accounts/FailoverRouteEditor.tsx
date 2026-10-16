import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useHostApi } from '@/lib/hosts/host-context'
import type { ChatConfig, ChatSubscriptionFailoverRoute } from '../../../../shared/chat'
import {
  addFallback,
  availableCandidates,
  labelForSubscriptionProvider,
  moveFallbackDown,
  moveFallbackUp,
  removeFallback,
  routeForPrimary,
  withEnabled,
} from '../subscription-failover-route'

export function FailoverRouteEditor({
  primaryProviderId,
  defaultLabel,
  disconnectedLabel,
  config,
  onChanged,
}: {
  primaryProviderId: string
  /** Name of the provider's default account, which has no account label of its own. */
  defaultLabel: string
  disconnectedLabel: string
  config: ChatConfig
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
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
      const result = await api.chatSubscriptionFailoverSetRoute({
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
    <section className="mt-4 border-t border-border/70 pt-4">
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
        <ol className="mt-2.5 flex flex-col gap-1.5 pl-5">
          {route.fallbackProviderIds.map((fallbackId, index) => {
            const provider = config.providers.find((entry) => entry.id === fallbackId)
            const connected = provider ? (provider.connected ?? provider.apiKeyPresent) : false
            const label = labelForSubscriptionProvider(fallbackId, config.providers, defaultLabel)
            return (
              <li
                key={fallbackId}
                className="flex items-center gap-1.5 rounded-md border border-border/60 bg-white/[0.02] px-2 py-1.5"
              >
                <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">{index + 1}</span>
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
                    {!candidate.connected ? ` (${disconnectedLabel})` : ''}
                  </SelectOption>
                ))}
              </OptionSelect>
            </li>
          )}
        </ol>
      )}

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </section>
  )
}
