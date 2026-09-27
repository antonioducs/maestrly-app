import { useTranslation } from 'react-i18next'
import type { FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { compactionPatch, type CompactionForm } from '@/lib/fleet/compaction'

/**
 * The fields of a compaction model: the model, its reasoning and Fast mode when it offers them, and how often it
 * prepares a summary. A `leading` choice (a bot's environment default) comes first and needs none of the others.
 */
export function CompactionFields({
  form,
  onChange,
  options,
  idPrefix,
  leading,
}: {
  form: CompactionForm
  onChange: (form: CompactionForm) => void
  options: FleetSelectionOption[]
  idPrefix: string
  leading?: { id: string; label: string }
}) {
  const { t } = useTranslation('fleet')
  const choice = options.find((option) => option.id === form.modelId)
  const inherits = leading !== undefined && form.modelId === leading.id
  const invalid = !inherits && Boolean(form.modelId) && !compactionPatch(form)
  return (
    <>
      <div>
        <label className="mb-2 block text-sm font-medium">{t('botSettings.compaction.model')}</label>
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
      {!inherits && choice && choice.efforts.length > 0 && (
        <div>
          <label className="mb-2 block text-sm font-medium" htmlFor={`${idPrefix}-reasoning`}>
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
      )}
      {!inherits && choice?.fastMode && (
        <div className="flex">
          <FastModeChip enabled={form.fastMode} onToggle={() => onChange({ ...form, fastMode: !form.fastMode })} />
        </div>
      )}
      {!inherits && (
        <div>
          <label className="mb-2 block text-sm font-medium" htmlFor={`${idPrefix}-interval`}>
            {t('botSettings.compaction.interval')}
          </label>
          <Input
            id={`${idPrefix}-interval`}
            type="number"
            min={10}
            max={1000}
            step={1}
            className="w-32 bg-surface-elevated"
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
      )}
    </>
  )
}
