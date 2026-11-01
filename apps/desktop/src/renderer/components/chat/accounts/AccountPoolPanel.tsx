import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Play, Trash2 } from 'lucide-react'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import {
  isChatProviderConnected,
  type ChatConfig,
  type ChatSubscriptionAccountPoolInfo,
  type ChatSubscriptionAccountPoolPatch,
  type ChatSubscriptionAccountPoolPolicy,
  type ChatSubscriptionAccountPoolSwitch,
  type ChatSubscriptionUsage,
} from '../../../../shared/chat'
import {
  accountPoolCandidates,
  accountPoolCurrent,
  accountPoolNext,
  addAccountPoolMember,
  makeAccountActive,
  moveAccountPoolMember,
  removeAccountPoolMember,
  withAccountPoolAutoJoin,
  withAccountPoolEnabled,
  withAccountPoolPolicy,
} from '../account-pool'
import { labelForSubscriptionProvider } from '../subscription-failover-route'
import { subscriptionUsageResetDisplay } from '../subscription-usage-presentation'
import { SubscriptionUsagePanel } from '../SubscriptionUsagePanel'
import { subscriptionPlanLabel, type AccountSnapshot, type SubscriptionAccountSnapshot } from './account-entries'
import {
  AccountPoolMark,
  DetailBackButton,
  DetailHeader,
  DetailSection,
  Switch,
  primaryButtonCls,
  secondaryButtonCls,
  UsageGauge,
} from './account-ui'

const POLICIES: ChatSubscriptionAccountPoolPolicy[] = ['drain', 'prefer-active']
const POLICY_COPY = {
  drain: { name: 'settings.accountPoolPolicyDrain', description: 'settings.accountPoolPolicyDrainDescription' },
  'prefer-active': {
    name: 'settings.accountPoolPolicyPreferActive',
    description: 'settings.accountPoolPolicyPreferActiveDescription',
  },
} as const satisfies Record<ChatSubscriptionAccountPoolPolicy, { name: string; description: string }>

const iconCls = 'rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-30'

interface Member {
  providerId: string
  label: string
  connected: boolean
  /** Out of quota, and when it comes back when known (epoch ms). */
  limited: boolean
  limitedUntil: number | null
  usage: ChatSubscriptionUsage | null
  facts: string
}

/** What the settings know about each account of the pool's provider. */
function useMembers(
  pool: ChatSubscriptionAccountPoolInfo,
  config: ChatConfig,
  snapshots: Record<string, AccountSnapshot>,
  defaultLabel: string
): (providerId: string) => Member {
  const { t } = useTranslation('chat')
  return (providerId) => {
    const provider = config.providers.find((entry) => entry.id === providerId)
    const snapshot = snapshots[providerId] as SubscriptionAccountSnapshot | undefined
    const usage = snapshot?.usage ?? null
    const full = usage?.state === 'ready' ? usage.windows.filter((window) => window.usedPercent >= 100) : []
    const known = pool.limitedUntil?.[providerId]
    const resets = full.map((window) => window.resetsAt).filter((at): at is number => at !== null)
    return {
      providerId,
      label: labelForSubscriptionProvider(providerId, config.providers, defaultLabel),
      connected: provider ? isChatProviderConnected(provider) : false,
      limited: known !== undefined || full.length > 0,
      limitedUntil: known ? Date.parse(known) : resets.length > 0 ? Math.max(...resets) : null,
      usage,
      facts: [snapshot?.status?.email ?? snapshot?.status?.username, subscriptionPlanLabel(snapshot?.status?.planType, t)]
        .filter(Boolean)
        .join(' · '),
    }
  }
}

function useAccountPoolSave(onChanged: () => void) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The pool also changes from other windows and from the rotation itself.
  useEffect(() => api.onChatModelsCatalogChanged(onChanged), [api, onChanged])
  const save = useCallback(
    async (patch: ChatSubscriptionAccountPoolPatch | null) => {
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
    },
    [api, onChanged, t]
  )
  return { busy, error, save }
}

function Tag({ tone, children }: { tone: 'current' | 'next' | 'preferred' | 'bad' | 'warn'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 text-[10px]',
        tone === 'current' && 'rounded-full bg-indigo-500/15 px-1.5 font-medium text-indigo-300',
        tone === 'next' && 'rounded-full bg-white/[0.06] px-1.5 text-muted-foreground',
        tone === 'preferred' && 'rounded-full bg-emerald-500/10 px-1.5 text-emerald-300',
        tone === 'bad' && 'text-rose-300',
        tone === 'warn' && 'text-amber-300'
      )}
    >
      {children}
    </span>
  )
}

function FlowChip({ lit, children }: { lit: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-px font-mono text-[10px]',
        lit ? 'border-indigo-400/50 text-indigo-300' : 'border-border text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

/** A provider's rotation: which account turns run on, in what order the others take over, and how. */
export function AccountPoolPanel({
  pool,
  config,
  snapshots,
  defaultLabel,
  onBack,
  onChanged,
}: {
  pool: ChatSubscriptionAccountPoolInfo
  config: ChatConfig
  snapshots: Record<string, AccountSnapshot>
  /** Name of the provider's default account, which has no account label of its own. */
  defaultLabel: string
  onBack: () => void
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation('chat')
  const locale = i18n.resolvedLanguage || i18n.language
  const { busy, error, save } = useAccountPoolSave(onChanged)
  const member = useMembers(pool, config, snapshots, defaultLabel)
  const provider = t(`settings.accountProviderName_${pool.kind}`)
  const activeName = t('settings.accountPoolActiveName', { provider })
  const canRun = (id: string) => {
    const state = member(id)
    return state.connected && !state.limited
  }
  const current = member(accountPoolCurrent(pool))
  const nextId = accountPoolNext(pool, canRun)
  const next = nextId ? member(nextId) : null
  const drain = pool.policy === 'drain'
  const candidates = accountPoolCandidates(pool, config.providers, defaultLabel)
  const limitedText = (state: Member) => {
    const reset = subscriptionUsageResetDisplay(state.limitedUntil, locale)
    return reset.kind === 'relative'
      ? t('settings.accountPoolLimitedIn', { time: reset.value })
      : reset.kind === 'absolute'
        ? t('settings.accountPoolLimitedAt', { time: reset.value })
        : t('settings.accountPoolLimited')
  }
  const rotated = (() => {
    const members = pool.memberProviderIds
    const index = members.indexOf(current.providerId)
    return index <= 0 ? members : [...members.slice(index), ...members.slice(0, index)]
  })()
  const preferredOther = pool.memberProviderIds.find((id) => id !== pool.activeProviderId)

  const header = (
    <DetailHeader
      mark={<AccountPoolMark enabled={pool.enabled} size="lg" />}
      title={t('settings.accountPoolTitle', { provider })}
      subtitle={t('settings.accountPoolDescription', { provider, active: activeName })}
      actions={
        <Switch
          checked={pool.enabled}
          disabled={busy}
          label={t('settings.accountPoolToggle', { provider })}
          onChange={(enabled) => void save(withAccountPoolEnabled(pool, enabled))}
        />
      }
    />
  )

  return (
    <div data-account-pool-panel={pool.kind}>
      <DetailBackButton onBack={onBack} />
      {header}
      {!pool.enabled ? (
        <div className="mt-5 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
          <AccountPoolMark enabled={false} size="lg" />
          <p className="mt-1 text-[13px] font-medium text-foreground">{t('settings.accountPoolOffTitle')}</p>
          <p className="max-w-sm text-[12px] text-muted-foreground">
            {t('settings.accountPoolOffDescription', {
              count: pool.memberProviderIds.length,
              provider,
              active: activeName,
              account: member(pool.activeProviderId).label,
            })}
          </p>
          <button
            type="button"
            className={cn(primaryButtonCls, 'mt-1')}
            disabled={busy}
            onClick={() => void save(withAccountPoolEnabled(pool, true))}
          >
            {t('settings.accountPoolTurnOn', { count: pool.memberProviderIds.length })}
          </button>
        </div>
      ) : (
        <>
          <DetailSection title={t('settings.accountPoolNow')}>
            <div className="rounded-lg border border-border bg-white/[0.02] p-3" data-account-pool-current={current.providerId}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="size-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
                <span className="text-[13px] font-medium text-foreground">{current.label}</span>
                {current.facts && <span className="text-[11px] text-muted-foreground">{current.facts}</span>}
                {current.limited && <Tag tone="bad">{limitedText(current)}</Tag>}
              </div>
              {current.usage && current.usage.state !== 'unsupported' && (
                <div className="mt-2">
                  <SubscriptionUsagePanel usage={current.usage} loading={false} showHeading={false} />
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  {next ? (
                    <>
                      {t('settings.accountPoolNextLabel')}{' '}
                      <span className="font-medium text-foreground">{next.label}</span>
                    </>
                  ) : (
                    <span className="text-rose-300">{t('settings.accountPoolNoNext')}</span>
                  )}
                </p>
                {drain && next && (
                  <button
                    type="button"
                    className={secondaryButtonCls}
                    disabled={busy}
                    onClick={() => void save(makeAccountActive(pool, next.providerId))}
                  >
                    {t('settings.accountPoolSkipTo', { account: next.label })}
                  </button>
                )}
              </div>
            </div>
          </DetailSection>

          <DetailSection title={t('settings.accountPoolQueue')}>
            <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">{t('settings.accountPoolQueueHint')}</p>
            <ol className="flex flex-col gap-1.5">
              {pool.memberProviderIds.map((id, index) => {
                const state = member(id)
                const isCurrent = id === current.providerId
                const moveUp = moveAccountPoolMember(pool, index, -1)
                const moveDown = moveAccountPoolMember(pool, index, 1)
                const removal = removeAccountPoolMember(pool, id)
                return (
                  <li
                    key={id}
                    data-account-pool-member={id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2.5 py-1.5',
                      isCurrent ? 'border-indigo-400/50 bg-indigo-500/[0.06]' : 'border-border/60 bg-white/[0.02]'
                    )}
                  >
                    <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className={cn('flex min-w-0 flex-1 flex-wrap items-center gap-1.5', !isCurrent && !canRun(id) && 'opacity-70')}>
                      <span className="truncate text-[12px] text-foreground">{state.label}</span>
                      {isCurrent && <Tag tone="current">{t('settings.accountPoolInUse')}</Tag>}
                      {!drain && id === pool.activeProviderId && (
                        <Tag tone="preferred">{t('settings.accountPoolPreferred')}</Tag>
                      )}
                      {!state.connected ? (
                        <Tag tone="warn">{t('settings.accountPoolDisconnected')}</Tag>
                      ) : state.limited ? (
                        <Tag tone="bad">{limitedText(state)}</Tag>
                      ) : (
                        id === nextId && <Tag tone="next">{t('settings.accountPoolNextBadge')}</Tag>
                      )}
                    </span>
                    {state.connected && <UsageGauge usage={state.usage} />}
                    {drain && !isCurrent && canRun(id) && (
                      <button
                        type="button"
                        title={t('settings.accountPoolUseNow', { account: state.label })}
                        aria-label={t('settings.accountPoolUseNow', { account: state.label })}
                        disabled={busy}
                        onClick={() => void save(makeAccountActive(pool, id))}
                        className={iconCls}
                      >
                        <Play className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t('settings.accountPoolMoveUp', { account: state.label })}
                      aria-label={t('settings.accountPoolMoveUp', { account: state.label })}
                      disabled={busy || !moveUp}
                      onClick={() => void save(moveUp)}
                      className={iconCls}
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t('settings.accountPoolMoveDown', { account: state.label })}
                      aria-label={t('settings.accountPoolMoveDown', { account: state.label })}
                      disabled={busy || !moveDown}
                      onClick={() => void save(moveDown)}
                      className={iconCls}
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t('settings.accountPoolRemove', { account: state.label })}
                      aria-label={t('settings.accountPoolRemove', { account: state.label })}
                      disabled={busy || !removal}
                      onClick={() => void save(removal)}
                      className={cn(iconCls, 'hover:text-destructive')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                )
              })}
            </ol>
            {candidates.length > 0 && (
              <OptionSelect
                className="mt-1.5 h-8 text-xs"
                disabled={busy}
                value=""
                onValueChange={(value) => {
                  if (value) void save(addAccountPoolMember(pool, value))
                }}
                aria-label={t('settings.accountPoolAdd')}
              >
                <SelectOption value="">{t('settings.accountPoolAdd')}</SelectOption>
                {candidates.map((candidate) => (
                  <SelectOption key={candidate.providerId} value={candidate.providerId}>
                    {candidate.label}
                    {!candidate.connected ? ` (${t('settings.accountPoolDisconnected')})` : ''}
                  </SelectOption>
                ))}
              </OptionSelect>
            )}
          </DetailSection>

          <DetailSection title={t('settings.accountPoolPolicyTitle')}>
            <div
              role="radiogroup"
              aria-label={t('settings.accountPoolPolicyTitle')}
              className="grid gap-2 @xl:grid-cols-2"
            >
              {POLICIES.map((policy) => {
                const selected = pool.policy === policy
                return (
                  <button
                    key={policy}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={busy}
                    data-account-pool-policy={policy}
                    onClick={() => void save(withAccountPoolPolicy(pool, policy))}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                      selected ? 'border-indigo-400/70 bg-indigo-500/[0.07]' : 'border-border hover:border-white/20'
                    )}
                  >
                    <span className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-3 shrink-0 rounded-full',
                          selected ? 'border-[4px] border-indigo-400' : 'border border-white/25'
                        )}
                      />
                      {t(POLICY_COPY[policy].name)}
                    </span>
                    <span className="mt-1 block pl-5 text-[11px] text-muted-foreground">
                      {t(POLICY_COPY[policy].description)}
                    </span>
                    <span className="mt-2.5 flex flex-wrap items-center gap-1 pl-5 text-[10px] text-muted-foreground" aria-hidden="true">
                      {policy === 'drain'
                        ? rotated.slice(0, 3).map((id, index) => (
                            <span key={id} className="contents">
                              {index > 0 && <span>{t('settings.accountPoolFlowRunsOut')}</span>}
                              <FlowChip lit={index < 2}>{member(id).label}</FlowChip>
                            </span>
                          ))
                        : [
                            <FlowChip key="from" lit>
                              {member(pool.activeProviderId).label}
                            </FlowChip>,
                            ...(preferredOther
                              ? [
                                  <span key="a1">{t('settings.accountPoolFlowRunsOut')}</span>,
                                  <FlowChip key="other" lit={false}>
                                    {member(preferredOther).label}
                                  </FlowChip>,
                                  <span key="a2">{t('settings.accountPoolFlowResets')}</span>,
                                  <FlowChip key="back" lit>
                                    {member(pool.activeProviderId).label}
                                  </FlowChip>,
                                ]
                              : []),
                          ]}
                    </span>
                  </button>
                )
              })}
            </div>
            {!drain && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <span>
                  <span className="block text-[12px] text-foreground">{t('settings.accountPoolPreferredLabel')}</span>
                  <span className="block text-[11px] text-muted-foreground">{t('settings.accountPoolPreferredHint')}</span>
                </span>
                <OptionSelect
                  className="h-8 w-auto min-w-40 text-xs"
                  disabled={busy}
                  value={pool.activeProviderId}
                  onValueChange={(value) => void save(makeAccountActive(pool, value))}
                  aria-label={t('settings.accountPoolPreferredLabel')}
                >
                  {pool.memberProviderIds.map((id) => (
                    <SelectOption key={id} value={id}>
                      {member(id).label}
                    </SelectOption>
                  ))}
                </OptionSelect>
              </div>
            )}
          </DetailSection>

          <DetailSection>
            <div className="flex items-center justify-between gap-3">
              <span>
                <span id={`account-pool-autojoin-${pool.kind}`} className="block text-[12px] text-foreground">
                  {t('settings.accountPoolAutoJoin', { provider })}
                </span>
                <span className="block text-[11px] text-muted-foreground">{t('settings.accountPoolAutoJoinHint')}</span>
              </span>
              <Switch
                checked={pool.autoJoin}
                disabled={busy}
                labelledBy={`account-pool-autojoin-${pool.kind}`}
                onChange={(autoJoin) => void save(withAccountPoolAutoJoin(pool, autoJoin))}
              />
            </div>
          </DetailSection>

          <DetailSection title={t('settings.accountPoolRecent')}>
            <AccountPoolSwitches switches={pool.recentSwitches ?? []} label={(id) => member(id).label} />
          </DetailSection>
        </>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

function AccountPoolSwitches({
  switches,
  label,
}: {
  switches: ChatSubscriptionAccountPoolSwitch[]
  label: (providerId: string) => string
}) {
  const { t, i18n } = useTranslation('chat')
  if (switches.length === 0) return <p className="text-[11px] text-muted-foreground">{t('settings.accountPoolRecentEmpty')}</p>
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  })
  return (
    <ul className="flex flex-col text-[11px] text-muted-foreground">
      {switches.map((entry) => (
        <li
          key={entry.at + entry.toProviderId}
          className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-2 border-b border-border/50 py-1.5 last:border-b-0"
        >
          <time dateTime={entry.at} className="truncate font-mono text-[10px]">
            {format.format(new Date(entry.at))}
          </time>
          <span>
            {t(entry.reason === 'exhausted' ? 'settings.accountPoolSwitchExhausted' : 'settings.accountPoolSwitchManual', {
              from: label(entry.fromProviderId),
              to: label(entry.toProviderId),
            })}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Where an account stands in its provider's rotation, on the account's own page; the rotation is managed apart. */
export function AccountPoolMembership({
  pool,
  providerId,
  connected,
  onOpenPool,
  onChanged,
}: {
  pool: ChatSubscriptionAccountPoolInfo
  providerId: string
  connected: boolean
  onOpenPool: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const { busy, error, save } = useAccountPoolSave(onChanged)
  const provider = t(`settings.accountProviderName_${pool.kind}`)
  const title = t('settings.accountPoolTitle', { provider })
  const index = pool.memberProviderIds.indexOf(providerId)
  const removal = removeAccountPoolMember(pool, providerId)
  let heading: string
  let hint: string
  let actions: ReactNode
  if (!pool.enabled) {
    heading = t('settings.accountPoolOffCardTitle', { pool: title })
    hint = t('settings.accountPoolOffCardHint', { provider })
    actions = (
      <button type="button" className={secondaryButtonCls} onClick={onOpenPool}>
        {t('settings.accountPoolConfigure')}
      </button>
    )
  } else if (index >= 0) {
    heading =
      accountPoolCurrent(pool) === providerId
        ? t('settings.accountPoolMemberInUse')
        : t('settings.accountPoolMemberPosition', { position: index + 1, count: pool.memberProviderIds.length })
    hint = t('settings.accountPoolMemberHint', { policy: t(POLICY_COPY[pool.policy].name), pool: title })
    actions = (
      <>
        <button
          type="button"
          className={cn(secondaryButtonCls, 'border-transparent text-muted-foreground')}
          disabled={busy || !removal}
          onClick={() => void save(removal)}
        >
          {t('settings.accountPoolTakeOut')}
        </button>
        <button type="button" className={secondaryButtonCls} onClick={onOpenPool}>
          {t('settings.accountPoolManage')}
        </button>
      </>
    )
  } else {
    heading = t('settings.accountPoolOutsideTitle')
    hint = t('settings.accountPoolOutsideHint')
    actions = (
      <button
        type="button"
        className={secondaryButtonCls}
        disabled={busy || !connected}
        onClick={() => void save(addAccountPoolMember(pool, providerId))}
      >
        {t('settings.accountPoolAddThis')}
      </button>
    )
  }
  return (
    <DetailSection title={title}>
      <div
        data-account-pool-membership={pool.kind}
        className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white/[0.02] p-3"
      >
        <AccountPoolMark enabled={pool.enabled && index >= 0} />
        <span className="min-w-[12rem] flex-1">
          <span className="block text-[12px] font-medium text-foreground">{heading}</span>
          <span className="block text-[11px] text-muted-foreground">{hint}</span>
        </span>
        <span className="flex flex-wrap gap-1.5">{actions}</span>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('settings.accountPoolFixedHint', { active: t('settings.accountPoolActiveName', { provider }) })}
      </p>
      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </DetailSection>
  )
}
