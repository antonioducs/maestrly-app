import { useTranslation } from 'react-i18next'
import { FLEET_COMPACTION_LIMITS, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { compactionContextLimitTokens, compactionIntervalTokens, type CompactionForm } from '@/lib/fleet/compaction'

const CONTEXT_LIMIT_MIN_THOUSANDS = FLEET_COMPACTION_LIMITS.contextLimitTokensMin / 1_000
const CONTEXT_LIMIT_MAX_THOUSANDS = FLEET_COMPACTION_LIMITS.contextLimitTokensMax / 1_000

/**
 * The fields of a compaction model: the model, its reasoning and Fast mode when it offers them, how often it
 * prepares a summary and, when `contextLimit` is given, the most context the conversation may use. A `leading` choice
 * (a bot's environment default) comes first and needs none of the others. `dense` sets them side by side, with the
 * smaller labels of the bot settings.
 */
export function CompactionFields({
  form,
  onChange,
  options,
  idPrefix,
  leading,
  dense = false,
  contextLimit,
}: {
  form: CompactionForm
  onChange: (form: CompactionForm) => void
  options: FleetSelectionOption[]
  idPrefix: string
  leading?: { id: string; label: string }
  dense?: boolean
  /** Whether the maximum context window is offered; absent where the gateway does not store it. */
  contextLimit?: 'ready' | 'restart-environment'
}) {
  const { t } = useTranslation('fleet')
  const choice = options.find((option) => option.id === form.modelId)
  const inherits = leading !== undefined && form.modelId === leading.id
  const invalid = !inherits && Boolean(form.modelId) && compactionIntervalTokens(form) === null
  const limitInvalid = compactionContextLimitTokens(form) === undefined
  const label = dense ? 'mb-1.5 block text-[13px] font-medium' : 'mb-2 block text-sm font-medium'
  const reasoning = !inherits && choice && choice.efforts.length > 0 && (
    <div>
      <label className={label} htmlFor={`${idPrefix}-reasoning`}>
        {t('botSettings.compaction.reasoning')}
      </label>
      <Select
        value={form.reasoning ?? 'default'}
        onValueChange={(value) => onChange({ ...form, reasoning: value === 'default' ? null : value })}
      >
        <SelectTrigger id={`${idPrefix}-reasoning`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{t('botSettings.compaction.default')}</SelectItem>
          {choice.efforts.map((effort) => (
            <SelectItem key={effort} value={effort}>
              {effort}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
  const fast = !inherits && choice?.fastMode && (
    <div className="flex">
      <FastModeChip enabled={form.fastMode} onToggle={() => onChange({ ...form, fastMode: !form.fastMode })} />
    </div>
  )
  const interval = !inherits && (
    <div>
      <label className={label} htmlFor={`${idPrefix}-interval`}>
        {t('botSettings.compaction.interval')}
      </label>
      <Input
        id={`${idPrefix}-interval`}
        type="number"
        min={10}
        max={1000}
        step={1}
        className={dense ? 'bg-surface-elevated' : 'w-32 bg-surface-elevated'}
        value={form.intervalThousands}
        aria-invalid={invalid}
        onChange={(event) => onChange({ ...form, intervalThousands: event.target.value })}
      />
      {invalid && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t('botSettings.compaction.intervalInvalid')}
        </p>
      )}
    </div>
  )
  const limitField = !inherits && contextLimit && (
    <div>
      <label className={label} htmlFor={`${idPrefix}-context-limit`}>
        {t('botSettings.compaction.contextLimit')}
      </label>
      <Input
        id={`${idPrefix}-context-limit`}
        type="number"
        min={CONTEXT_LIMIT_MIN_THOUSANDS}
        max={CONTEXT_LIMIT_MAX_THOUSANDS}
        step={1}
        placeholder={t('botSettings.compaction.contextLimitPlaceholder')}
        className={dense ? 'bg-surface-elevated' : 'w-44 bg-surface-elevated'}
        value={form.contextLimitThousands}
        aria-invalid={limitInvalid}
        aria-describedby={`${idPrefix}-context-limit-note`}
        onChange={(event) => onChange({ ...form, contextLimitThousands: event.target.value })}
      />
      {limitInvalid ? (
        <p role="alert" id={`${idPrefix}-context-limit-note`} className="mt-1 text-xs text-destructive">
          {t('botSettings.compaction.contextLimitInvalid', {
            min: CONTEXT_LIMIT_MIN_THOUSANDS,
            max: CONTEXT_LIMIT_MAX_THOUSANDS,
          })}
        </p>
      ) : (
        <p id={`${idPrefix}-context-limit-note`} className="mt-1 text-xs text-muted-foreground">
          {t('botSettings.compaction.contextLimitHint')}
        </p>
      )}
      {contextLimit === 'restart-environment' && (
        <p className="mt-1 text-xs text-amber-300">{t('botSettings.compaction.contextLimitRestart')}</p>
      )}
    </div>
  )
  return (
    <>
      <div>
        <label className={label}>{t('botSettings.compaction.model')}</label>
        <SearchSelect
          value={form.modelId || undefined}
          options={[
            ...(leading ? [leading] : []),
            ...options.map((option) => ({
              id: option.id,
              label: `${option.providerLabel} · ${option.modelLabel}`,
            })),
          ]}
          onChange={(id) => onChange({ ...form, modelId: id ?? '', reasoning: null, fastMode: false })}
          disabled={!options.length && !leading}
          placeholder={t('botSettings.chooseModel')}
          ariaLabel={t('botSettings.compaction.model')}
        />
      </div>
      {dense ? (
        (reasoning || interval || limitField) && (
          <div className="grid grid-cols-1 items-start gap-4 @xl:grid-cols-2">
            {reasoning}
            {interval}
            {limitField}
          </div>
        )
      ) : (
        <>
          {reasoning}
          {fast}
          {interval}
          {limitField}
        </>
      )}
      {dense && fast}
    </>
  )
}
