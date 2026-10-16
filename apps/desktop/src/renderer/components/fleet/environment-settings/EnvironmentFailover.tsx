import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import {
  FLEET_ACCOUNT_FAILOVER_FEATURE,
  FLEET_FAILOVER_KINDS,
  type FleetEnvironment,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useEnvironmentSettingsResource, useSettingsLifetime } from '@/lib/fleet/environment-settings'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { SettingsSwitch } from '../SettingsSwitch'

type Subscription = FleetSettingsOutput<'accounts'>['subscriptions'][number]
type Route = FleetSettingsOutput<'failover'>['routes'][number]
type Kind = Route['kind']

/** A slot as a select value: the default account has no slot of its own. */
const DEFAULT_SLOT = 'default'
const slotValue = (slot: string | null): string => slot ?? DEFAULT_SLOT
const slotOf = (value: string): string | null => (value === DEFAULT_SLOT ? null : value)

/**
 * The order in which the environment's Claude and Codex accounts take over a bot's turn once one reaches its usage
 * limit. Each account that bots may use has its own list; a change is saved at once, as in the desktop's settings.
 * Shown for a kind once the environment has two accounts of it.
 */
export function EnvironmentFailover({
  environment,
  fleet,
  subscriptions,
  accountsRevision,
  online,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  subscriptions: Subscription[]
  /** A change of the accounts may drop routes: their list is read again. */
  accountsRevision: string
  online: boolean
}) {
  const { t } = useTranslation('fleet')
  const groups = FLEET_FAILOVER_KINDS.map((kind) => ({
    kind,
    accounts: subscriptions.filter((account) => account.kind === kind),
  })).filter((group) => group.accounts.length > 1)
  if (!groups.length) return null
  const server = fleet.state.connection.features.includes(FLEET_ACCOUNT_FAILOVER_FEATURE)
  const image = environment.capabilities.includes(FLEET_ACCOUNT_FAILOVER_FEATURE)
  return (
    <section aria-labelledby="environment-failover-title" className="space-y-2">
      <h3 id="environment-failover-title" className="text-xs font-medium">
        {t('environmentSettings.failover.title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('environmentSettings.failover.note')}</p>
      {server && image ? (
        <FailoverRoutes
          environmentId={environment.id}
          groups={groups}
          accountsRevision={accountsRevision}
          online={online}
        />
      ) : (
        <p role="status" className="text-xs text-amber-300">
          {t(server ? 'environmentSettings.failover.restart' : 'environmentSettings.failover.updateServer')}
        </p>
      )}
    </section>
  )
}

function FailoverRoutes({
  environmentId,
  groups,
  accountsRevision,
  online,
}: {
  environmentId: string
  groups: Array<{ kind: Kind; accounts: Subscription[] }>
  accountsRevision: string
  online: boolean
}) {
  const resource = useEnvironmentSettingsResource(environmentId, 'failover')
  const lifetime = useSettingsLifetime()
  const [saving, setSaving] = useState(false)
  const { reload } = resource
  useEffect(() => {
    void reload()
  }, [accountsRevision, reload])

  const save = async (route: Route) => {
    if (!resource.data || saving || !online) return
    const epoch = lifetime.current
    setSaving(true)
    try {
      const next = await resource.source.setFailoverRoute({ ...route, expectedRevision: resource.data.revision })
      if (epoch !== lifetime.current) return
      resource.setData(next)
      resource.setError(false)
    } catch {
      if (epoch === lifetime.current) resource.setError(true)
    } finally {
      if (epoch === lifetime.current) setSaving(false)
    }
  }

  if (!resource.data) return resource.error ? <LoadFailed reload={() => void reload()} /> : null
  const data = resource.data
  return (
    <div className="space-y-2">
      {resource.error && <LoadFailed reload={() => void reload()} />}
      {groups.flatMap(({ kind, accounts }) =>
        accounts.map((account) => {
          const route = data.routes.find((entry) => entry.kind === kind && entry.slot === account.accountId) ?? {
            kind,
            slot: account.accountId,
            enabled: false,
            fallbacks: [],
          }
          const key = kind + ':' + slotValue(account.accountId)
          return (
            <RouteEditor
              key={key}
              route={route}
              accounts={accounts}
              disabled={!online || saving}
              onChange={(next) => void save(next)}
            />
          )
        })
      )}
    </div>
  )
}

function LoadFailed({ reload }: { reload: () => void }) {
  const { t } = useTranslation('fleet')
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
      <p>{t('environmentSettings.failed')}</p>
      <button type="button" className="underline hover:no-underline" onClick={reload}>
        {t('environmentSettings.reload')}
      </button>
    </div>
  )
}

function RouteEditor({
  route,
  accounts,
  disabled,
  onChange,
}: {
  route: Route
  accounts: Subscription[]
  disabled: boolean
  onChange: (route: Route) => void
}) {
  const { t } = useTranslation('fleet')
  const bySlot = new Map(accounts.map((account) => [slotValue(account.accountId), account]))
  const name = (slot: string | null) =>
    bySlot.get(slotValue(slot))?.label ?? (slot === null ? t('environmentSettings.defaultSlot') : slot)
  const primary = name(route.slot)
  const candidates = accounts.filter(
    (account) => account.accountId !== route.slot && !route.fallbacks.includes(account.accountId)
  )
  const move = (index: number, by: -1 | 1) => {
    const fallbacks = [...route.fallbacks]
    const target = index + by
    if (target < 0 || target >= fallbacks.length) return
    ;[fallbacks[index], fallbacks[target]] = [fallbacks[target]!, fallbacks[index]!]
    onChange({ ...route, fallbacks })
  }
  return (
    <div className="rounded-lg border border-border bg-white/[0.025] px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate">{t('environmentSettings.failover.enable', { name: primary })}</p>
        <SettingsSwitch
          checked={route.enabled}
          label={t('environmentSettings.failover.enable', { name: primary })}
          disabled={disabled}
          onChange={() => onChange({ ...route, enabled: !route.enabled })}
        />
      </div>
      {route.enabled && (
        <ol className="mt-2 space-y-1.5">
          {route.fallbacks.map((slot, index) => {
            const label = name(slot)
            const connected = bySlot.get(slotValue(slot))?.state === 'connected'
            return (
              <li
                key={slotValue(slot)}
                className="flex items-center gap-1.5 rounded border border-border/60 bg-white/[0.02] px-2 py-1.5"
              >
                <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
                {!connected && (
                  <span className="shrink-0 text-[10px] text-amber-300">
                    {t('environmentSettings.failover.disconnected')}
                  </span>
                )}
                <IconButton
                  label={t('environmentSettings.failover.moveUp', { name: label })}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label={t('environmentSettings.failover.moveDown', { name: label })}
                  disabled={disabled || index === route.fallbacks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton
                  label={t('environmentSettings.failover.remove', { name: label })}
                  disabled={disabled}
                  onClick={() => onChange({ ...route, fallbacks: route.fallbacks.filter((entry) => entry !== slot) })}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            )
          })}
          {candidates.length > 0 && (
            <li>
              <OptionSelect
                className="h-8 text-xs"
                disabled={disabled}
                value=""
                aria-label={t('environmentSettings.failover.add')}
                onValueChange={(value) => {
                  if (!value) return
                  onChange({ ...route, fallbacks: [...route.fallbacks, slotOf(value)] })
                }}
              >
                <SelectOption value="">{t('environmentSettings.failover.add')}</SelectOption>
                {candidates.map((account) => (
                  <SelectOption key={slotValue(account.accountId)} value={slotValue(account.accountId)}>
                    {account.label}
                    {account.state !== 'connected' ? ` (${t(`botAccounts.state.${account.state}`)})` : ''}
                  </SelectOption>
                ))}
              </OptionSelect>
            </li>
          )}
        </ol>
      )}
    </div>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
    >
      {children}
    </button>
  )
}
