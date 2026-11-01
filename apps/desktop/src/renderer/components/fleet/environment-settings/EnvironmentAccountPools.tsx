import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import {
  FLEET_ACCOUNT_POOL_KINDS,
  FLEET_ACCOUNT_POOLS_FEATURE,
  type FleetEnvironment,
  type FleetSettingsInput,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { useEnvironmentSettingsResource, useSettingsLifetime } from '@/lib/fleet/environment-settings'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { SettingsSwitch } from '../SettingsSwitch'

type Subscription = FleetSettingsOutput<'accounts'>['subscriptions'][number]
type Pool = FleetSettingsOutput<'accountPools'>['pools'][number]
type Patch = Omit<FleetSettingsInput<'setAccountPool'>, 'kind' | 'expectedRevision'>
type Kind = Pool['kind']

/** A slot as a select value: the default account has no slot of its own. */
const DEFAULT_SLOT = 'default'
const slotValue = (slot: string | null): string => slot ?? DEFAULT_SLOT
const slotOf = (value: string): string | null => (value === DEFAULT_SLOT ? null : value)

/**
 * One rotation per provider for the environment's Claude and Codex accounts: bots on the provider's active account
 * move to the next account in line once the one in use reaches its limit, while a bot that chose an account directly
 * stays on it. Shown for a kind once the environment has two accounts of it; a change is saved at once.
 */
export function EnvironmentAccountPools({
  environment,
  fleet,
  subscriptions,
  accountsRevision,
  online,
}: {
  environment: FleetEnvironment
  fleet: FleetController
  subscriptions: Subscription[]
  /** A change of the accounts changes the rotations: they are read again. */
  accountsRevision: string
  online: boolean
}) {
  const { t } = useTranslation('fleet')
  const groups = FLEET_ACCOUNT_POOL_KINDS.map((kind) => ({
    kind,
    accounts: subscriptions.filter((account) => account.kind === kind),
  })).filter((group) => group.accounts.length > 1)
  if (!groups.length) return null
  const server = fleet.state.connection.features.includes(FLEET_ACCOUNT_POOLS_FEATURE)
  const image = environment.capabilities.includes(FLEET_ACCOUNT_POOLS_FEATURE)
  return (
    <section aria-labelledby="environment-account-pools-title" className="space-y-2">
      <h3 id="environment-account-pools-title" className="text-xs font-medium">
        {t('environmentSettings.accountPools.title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('environmentSettings.accountPools.note')}</p>
      {server && image ? (
        <AccountPools environmentId={environment.id} groups={groups} accountsRevision={accountsRevision} online={online} />
      ) : (
        <p role="status" className="text-xs text-amber-300">
          {t(server ? 'environmentSettings.accountPools.restart' : 'environmentSettings.accountPools.updateServer')}
        </p>
      )}
    </section>
  )
}

function AccountPools({
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
  const resource = useEnvironmentSettingsResource(environmentId, 'accountPools')
  const lifetime = useSettingsLifetime()
  const [saving, setSaving] = useState(false)
  const { reload } = resource
  useEffect(() => {
    void reload()
  }, [accountsRevision, reload])

  const save = async (kind: Kind, patch: Patch) => {
    if (!resource.data || saving || !online) return
    const epoch = lifetime.current
    setSaving(true)
    try {
      const next = await resource.source.setAccountPool({ kind, ...patch, expectedRevision: resource.data.revision })
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
      {groups.flatMap(({ kind, accounts }) => {
        const pool = data.pools.find((entry) => entry.kind === kind)
        return pool
          ? [
              <PoolEditor
                key={kind}
                pool={pool}
                accounts={accounts}
                disabled={!online || saving}
                onChange={(patch) => void save(kind, patch)}
              />,
            ]
          : []
      })}
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

function PoolEditor({
  pool,
  accounts,
  disabled,
  onChange,
}: {
  pool: Pool
  accounts: Subscription[]
  disabled: boolean
  onChange: (patch: Patch) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const bySlot = new Map(accounts.map((account) => [slotValue(account.accountId), account]))
  const name = (slot: string | null) =>
    bySlot.get(slotValue(slot))?.label ?? (slot === null ? t('environmentSettings.defaultSlot') : slot)
  const provider = t(`environmentSettings.accountPools.provider.${pool.kind}`)
  const toggle = t('environmentSettings.accountPools.enable', { provider })
  const preferring = pool.policy === 'prefer-active'
  const candidates = accounts.filter((account) => !pool.members.includes(account.accountId))
  const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' })
  const limitedUntil = (slot: string | null) => pool.limited.find((entry) => entry.slot === slot)?.until
  const move = (index: number, by: -1 | 1) => {
    const members = [...pool.members]
    const target = index + by
    if (target < 0 || target >= members.length) return
    ;[members[index], members[target]] = [members[target]!, members[index]!]
    onChange({ members })
  }
  return (
    <div className="rounded-lg border border-border bg-white/[0.025] px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate">{t('environmentSettings.accountPools.pool', { provider })}</p>
        <SettingsSwitch
          checked={pool.enabled}
          label={toggle}
          disabled={disabled}
          onChange={() => onChange({ enabled: !pool.enabled })}
        />
      </div>
      {!pool.enabled ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('environmentSettings.accountPools.off', { name: name(pool.current) })}
        </p>
      ) : (
        <>
          {pool.bots.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('environmentSettings.accountPools.usedBy', { names: pool.bots.map((bot) => bot.name).join(', ') })}
            </p>
          )}
          {pool.pinned.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('environmentSettings.accountPools.pinned', {
                names: pool.pinned.map((bot) => `${bot.name} (${name(bot.slot)})`).join(', '),
              })}
            </p>
          )}
          <ol className="mt-2 space-y-1.5">
            {pool.members.map((slot, index) => {
              const label = name(slot)
              const connected = bySlot.get(slotValue(slot))?.state === 'connected'
              const until = limitedUntil(slot)
              return (
                <li
                  key={slotValue(slot)}
                  className={`flex items-center gap-1.5 rounded border px-2 py-1.5 ${
                    slot === pool.current ? 'border-indigo-400/40 bg-indigo-500/[0.06]' : 'border-border/60 bg-white/[0.02]'
                  }`}
                >
                  <span className="w-4 shrink-0 text-right text-[11px] text-muted-foreground">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
                  {slot === pool.current && (
                    <span className="shrink-0 rounded-full border border-indigo-400/40 px-1.5 text-[10px] text-indigo-200">
                      {t('environmentSettings.accountPools.inUse')}
                    </span>
                  )}
                  {preferring && slot === pool.active && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t('environmentSettings.accountPools.preferred')}
                    </span>
                  )}
                  {until ? (
                    <span className="shrink-0 text-[10px] text-amber-300">
                      {t('environmentSettings.accountPools.limited', { time: time.format(new Date(until)) })}
                    </span>
                  ) : (
                    !connected && (
                      <span className="shrink-0 text-[10px] text-amber-300">
                        {t('environmentSettings.accountPools.disconnected')}
                      </span>
                    )
                  )}
                  <IconButton
                    label={t('environmentSettings.accountPools.moveUp', { name: label })}
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('environmentSettings.accountPools.moveDown', { name: label })}
                    disabled={disabled || index === pool.members.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('environmentSettings.accountPools.remove', { name: label })}
                    disabled={disabled || pool.members.length <= 1}
                    onClick={() => onChange({ members: pool.members.filter((entry) => entry !== slot) })}
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
                  aria-label={t('environmentSettings.accountPools.add')}
                  onValueChange={(value) => {
                    if (!value) return
                    onChange({ members: [...pool.members, slotOf(value)] })
                  }}
                >
                  <SelectOption value="">{t('environmentSettings.accountPools.add')}</SelectOption>
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
          <fieldset className="mt-3 space-y-1.5" disabled={disabled}>
            <legend className="mb-1 text-xs font-medium">{t('environmentSettings.accountPools.policy')}</legend>
            {(['drain', 'prefer-active'] as const).map((policy) => (
              <label key={policy} className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="radio"
                  name={`environment-account-pool-policy-${pool.kind}`}
                  className="mt-0.5"
                  checked={pool.policy === policy}
                  onChange={() => onChange({ policy })}
                />
                <span>
                  <span className="block">{t(`environmentSettings.accountPools.policies.${policy}.name`)}</span>
                  <span className="block text-muted-foreground">
                    {t(`environmentSettings.accountPools.policies.${policy}.description`)}
                  </span>
                </span>
              </label>
            ))}
            {preferring && (
              <div className="flex items-center gap-2 pl-5 text-xs">
                <span className="shrink-0 text-muted-foreground">{t('environmentSettings.accountPools.preferredLabel')}</span>
                <OptionSelect
                  className="h-8 text-xs"
                  disabled={disabled}
                  value={slotValue(pool.active)}
                  aria-label={t('environmentSettings.accountPools.preferredLabel')}
                  onValueChange={(value) => onChange({ active: slotOf(value) })}
                >
                  {pool.members.map((slot) => (
                    <SelectOption key={slotValue(slot)} value={slotValue(slot)}>
                      {name(slot)}
                    </SelectOption>
                  ))}
                </OptionSelect>
              </div>
            )}
          </fieldset>
        </>
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
