import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Minus, Plus } from 'lucide-react'
import {
  FLEET_DELEGATION_LIMITS,
  FLEET_DELEGATION_TIERS,
  type FleetBotDelegation,
  type FleetDelegationTier,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import {
  delegationModelGroups,
  delegationPreview,
  setDelegationModel,
  suggestedDelegationTier,
} from '@/lib/fleet/bot-delegation'
import { choiceClass } from '@/lib/fleet/choice'
import { nextRadioIndex } from '@/lib/fleet/forms'
import type { DelegationAvailability } from '@/lib/fleet/provisioning'
import { cn } from '@/lib/utils'
import { ChoiceMark } from './ChoiceMark'
import { SettingsCard, SettingsSection } from './SettingsSection'
import { SettingsSwitch } from './SettingsSwitch'

const MODES = ['normal', 'delegate'] as const

/**
 * How a bot splits its work into tasks: the mode, how many tasks run at once and, when it delegates, the models it may
 * use with what each one is for. Saved with the other settings, through the save bar.
 */
export function BotTasksSection({
  id,
  botName,
  value,
  onChange,
  options,
  availability,
  environmentName,
}: {
  id: string
  botName: string
  value: FleetBotDelegation
  onChange: (next: FleetBotDelegation) => void
  options: FleetSelectionOption[]
  availability: DelegationAvailability
  environmentName: string | null
}) {
  const { t } = useTranslation('fleet')
  const disabled = availability !== 'ready'
  const radios = useRef<Array<HTMLButtonElement | null>>([])
  const groups = delegationModelGroups(options)
  const preview = delegationPreview(value, options)
  const tierLabel = (tier: FleetDelegationTier) => t(`botTasks.tier.${tier}`)
  const allowed = (providerId: string, modelId: string) =>
    value.models.find((model) => model.providerId === providerId && model.modelId === modelId)
  const anyAvailable = preview.some((row) => row.models.length > 0)

  const onModeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextRadioIndex(index, event.key, MODES.length)
    if (next === null) return
    event.preventDefault()
    onChange({ ...value, mode: MODES[next] })
    radios.current[next]?.focus()
  }
  const setTasks = (maxTasks: number) =>
    onChange({
      ...value,
      maxTasks: Math.min(FLEET_DELEGATION_LIMITS.tasksMax, Math.max(FLEET_DELEGATION_LIMITS.tasksMin, maxTasks)),
    })

  return (
    <SettingsSection
      id={id}
      title={t('botSettings.section.tasks')}
      note={t('botSettings.tasksNote', { name: botName })}
    >
      {availability === 'restart-environment' && (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
          {t('botTasks.restart', { environment: environmentName ?? botName })}
        </p>
      )}
      <div className="flex flex-col gap-4">
        <SettingsCard className="flex flex-col gap-4 p-[18px]">
          <div
            role="radiogroup"
            aria-label={t('botSettings.field.delegation')}
            className="grid grid-cols-1 gap-2 @xl:grid-cols-2"
          >
            {MODES.map((mode, index) => {
              const selected = value.mode === mode
              return (
                <button
                  key={mode}
                  ref={(node) => {
                    radios.current[index] = node
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  disabled={disabled}
                  onClick={() => onChange({ ...value, mode })}
                  onKeyDown={(event) => onModeKey(event, index)}
                  className={cn(
                    'flex items-start justify-between gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                    choiceClass(selected)
                  )}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{t(`botTasks.mode.${mode}.title`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`botTasks.mode.${mode}.description`, { name: botName })}
                    </span>
                  </span>
                  <ChoiceMark selected={selected} />
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p id={`${id}-max-tasks`} className="text-sm font-medium">
                {t('botTasks.maxTasks')}
              </p>
              <p className="text-xs text-muted-foreground">{t('botTasks.maxTasksHint')}</p>
            </div>
            <div
              role="group"
              aria-labelledby={`${id}-max-tasks`}
              className="inline-flex shrink-0 items-center overflow-hidden rounded-[9px] border border-input"
            >
              <button
                type="button"
                aria-label={t('botTasks.fewer')}
                disabled={disabled || value.maxTasks <= FLEET_DELEGATION_LIMITS.tasksMin}
                onClick={() => setTasks(value.maxTasks - 1)}
                className="grid size-8 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
              <output aria-live="polite" className="min-w-8 text-center text-sm tabular-nums">
                {value.maxTasks}
              </output>
              <button
                type="button"
                aria-label={t('botTasks.more')}
                disabled={disabled || value.maxTasks >= FLEET_DELEGATION_LIMITS.tasksMax}
                onClick={() => setTasks(value.maxTasks + 1)}
                className="grid size-8 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </SettingsCard>

        {value.mode === 'delegate' && (
          <>
            <SettingsCard className="flex flex-col gap-4 p-[18px]">
              <div>
                <h3 className="text-sm font-semibold">{t('botTasks.models.title', { name: botName })}</h3>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('botTasks.models.note')}</p>
              </div>
              <dl
                aria-live="polite"
                className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-[13px] @xl:grid-cols-[10rem_1fr] @xl:gap-y-1.5"
              >
                {preview.map((row) => (
                  <div key={row.complexity} className="contents">
                    <dt className="text-muted-foreground">{t(`botTasks.preview.${row.complexity}`)}</dt>
                    <dd className={cn('mb-2 @xl:mb-0', row.models.length ? 'text-foreground' : 'text-amber-300')}>
                      {row.models.length
                        ? row.models.join(` ${t('botTasks.preview.or')} `)
                        : t('botTasks.preview.self', { name: botName })}
                      {row.upgradedFrom && (
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          {t('botTasks.preview.upgraded', { tier: tierLabel(row.upgradedFrom).toLowerCase() })}
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {!anyAvailable && <p className="text-xs text-muted-foreground">{t('botTasks.models.empty')}</p>}
              {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('botSettings.noAccount')}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.providerId} className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground">{group.accounts.join(', ')}</p>
                    {group.models.map((model) => {
                      const entry = allowed(group.providerId, model.modelId)
                      return (
                        <div key={model.modelId} className="flex min-h-9 items-center gap-3">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={!!entry}
                            disabled={disabled}
                            onClick={() =>
                              onChange(
                                setDelegationModel(
                                  value,
                                  group.providerId,
                                  model.modelId,
                                  entry ? null : suggestedDelegationTier(model.modelId)
                                )
                              )
                            }
                            className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                                entry ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong'
                              )}
                            >
                              {entry && <Check className="size-3" strokeWidth={3} />}
                            </span>
                            <span className={cn('truncate', !entry && 'text-muted-foreground')}>{model.label}</span>
                          </button>
                          {entry && (
                            <OptionSelect
                              value={entry.tier}
                              onValueChange={(tier) =>
                                onChange(
                                  setDelegationModel(
                                    value,
                                    group.providerId,
                                    model.modelId,
                                    tier as FleetDelegationTier
                                  )
                                )
                              }
                              disabled={disabled}
                              aria-label={t('botTasks.tierFor', { model: model.label })}
                              className="h-8 w-36 shrink-0"
                            >
                              {FLEET_DELEGATION_TIERS.map((tier) => (
                                <SelectOption key={tier} value={tier}>
                                  {tierLabel(tier)}
                                </SelectOption>
                              ))}
                            </OptionSelect>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </SettingsCard>
            <SettingsCard className="flex flex-col divide-y divide-border">
              {(
                [
                  ['retryStronger', 'botTasks.retryStronger', 'botTasks.retryStrongerHint'],
                  ['spreadAccounts', 'botTasks.spreadAccounts', 'botTasks.spreadAccountsHint'],
                  ['sideConversations', 'botTasks.sideConversations', 'botTasks.sideConversationsHint'],
                ] as const
              ).map(([key, label, hint]) => (
                <div key={key} className="flex items-start justify-between gap-3 p-[18px]">
                  <div>
                    <p className="text-sm font-medium">{t(label)}</p>
                    <p className="text-xs text-muted-foreground">{t(hint, { name: botName })}</p>
                  </div>
                  <SettingsSwitch
                    checked={value[key]}
                    disabled={disabled}
                    label={t(label)}
                    onChange={() => onChange({ ...value, [key]: !value[key] })}
                  />
                </div>
              ))}
            </SettingsCard>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
