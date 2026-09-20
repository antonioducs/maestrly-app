import type { AgentStageSettings, DelegationModelCatalog, DelegationModelEntry } from '@maestrly/protocol'
import { Select } from '../../components/Select.js'
import { t, useLocale } from '../../i18n/index.js'

export interface ModelChoice {
  selectionId: string
  reasoning: string | null
  fastMode: boolean
  executionMode: 'standard' | 'maestro'
  delegationProfiles: string[]
}

export function defaultChoice(catalog: DelegationModelCatalog, from?: AgentStageSettings | null): ModelChoice {
  const selection =
    catalog.models.find((model) => model.selectionId === from?.selectionId) ?? catalog.models[0] ?? null
  return {
    selectionId: selection?.selectionId ?? '',
    reasoning: from && selection?.efforts.includes(from.reasoning ?? '') ? from.reasoning : null,
    fastMode: (from?.fastMode ?? false) && !!selection?.fastMode,
    executionMode: from?.executionMode === 'maestro' && catalog.features.maestro ? 'maestro' : 'standard',
    delegationProfiles: from?.delegationProfiles ?? [],
  }
}

/**
 * Account, model, reasoning effort, fast mode and execution mode for one stage.
 *
 * Only what the chosen selection actually offers is shown: an effort a model does not have is never listed,
 * and switching models drops an effort the new one cannot honor instead of pretending it carries over.
 */
export function ModelPicker({
  catalog,
  value,
  onChange,
  disabled = false,
}: {
  catalog: DelegationModelCatalog
  value: ModelChoice
  onChange(next: ModelChoice): void
  disabled?: boolean
}) {
  useLocale()
  const selection: DelegationModelEntry | undefined = catalog.models.find(
    (model) => model.selectionId === value.selectionId
  )
  const efforts = selection?.efforts ?? []
  const modes = selection?.executionModes ?? ['standard']

  function chooseModel(selectionId: string) {
    const next = catalog.models.find((model) => model.selectionId === selectionId)
    onChange({
      selectionId,
      // Effort is never translated between providers: it is kept only when the new selection offers it.
      reasoning: value.reasoning && next?.efforts.includes(value.reasoning) ? value.reasoning : null,
      fastMode: value.fastMode && !!next?.fastMode,
      executionMode: next?.executionModes.includes(value.executionMode) ? value.executionMode : 'standard',
      delegationProfiles: value.delegationProfiles.filter((profile) =>
        next?.delegationProfiles.includes(profile)
      ),
    })
  }

  return (
    <div className="model-picker">
      <div className="model-picker-field">
        <span className="field-label">{t('Account and model')}</span>
        <Select
          label={t('Account and model')}
          disabled={disabled}
          value={value.selectionId}
          onChange={chooseModel}
          options={catalog.models.map((model) => ({
            value: model.selectionId,
            label: `${model.accountLabel} · ${model.modelLabel}`,
          }))}
        />
      </div>
      <div className="model-picker-field">
        <span className="field-label">{t('Reasoning effort')}</span>
        <Select
          label={t('Reasoning effort')}
          disabled={disabled || !efforts.length}
          value={value.reasoning ?? ''}
          onChange={(next) => onChange({ ...value, reasoning: next || null })}
          options={[
            { value: '', label: t('Model default') },
            ...efforts.map((effort) => ({ value: effort, label: effort })),
          ]}
        />
        {!efforts.length ? <p className="form-note">{t('This model does not expose a reasoning effort.')}</p> : null}
      </div>
      <div className="model-picker-field">
        <span className="field-label">{t('Execution mode')}</span>
        <Select
          label={t('Execution mode')}
          disabled={disabled || modes.length < 2}
          value={value.executionMode}
          onChange={(next) => onChange({ ...value, executionMode: next as ModelChoice['executionMode'] })}
          options={modes
            .filter((mode) => mode !== 'maestro' || catalog.features.maestro)
            .map((mode) => ({ value: mode, label: t(mode === 'maestro' ? 'Maestro' : 'Standard') }))}
        />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={disabled || !selection?.fastMode}
          checked={value.fastMode}
          onChange={(event) => onChange({ ...value, fastMode: event.target.checked })}
        />
        <span>{t('Fast mode')}</span>
      </label>
      {selection && !selection.fastMode ? (
        <p className="form-note">{t('Fast mode is unavailable for this account and model.')}</p>
      ) : null}
      {selection?.delegationProfiles.length && catalog.features.subagents ? (
        <fieldset className="model-picker-profiles">
          <legend>{t('Subagent profiles')}</legend>
          {selection.delegationProfiles.map((profile) => (
            <label key={profile} className="checkbox-row">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value.delegationProfiles.includes(profile)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    delegationProfiles: event.target.checked
                      ? [...value.delegationProfiles, profile]
                      : value.delegationProfiles.filter((current) => current !== profile),
                  })
                }
              />
              <span>{profile}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  )
}
