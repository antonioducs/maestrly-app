import type { ColumnAutomation, RunnerAutomationCapabilities } from '@maestrly/protocol'
import { Select } from '../../components/Select.js'
import { t } from '../../i18n/index.js'
export interface CatalogRunner {
  personal?:boolean
  id: string
  name: string
  status: string
  lastSeenAt: string | null
  capabilities: RunnerAutomationCapabilities | null
  repositories: Array<{ bindingId: string; available: boolean; branches: string[] }>
}
export function catalogModels(runners: CatalogRunner[], target: string | null) {
  return runners.filter((r) => !target || r.id === target).flatMap((r) => r.capabilities?.models ?? [])
}
export function ModelFields({
  config,
  update,
  runners,
  disabled = false,
}: {
  config: ColumnAutomation
  update(patch: Partial<ColumnAutomation>): void
  runners: CatalogRunner[]
  disabled?: boolean
}) {
  const models = catalogModels(runners, config.runnerSelector === 'runner' ? config.targetRunnerId : null)
  const providers = [...new Set(models.map((m) => m.provider))]
  const available = models.filter((m) => m.provider === config.provider)
  const distinct = [...new Map(available.map((m) => [m.model, m])).values()]
  const selected = available.filter((m) => m.model === config.model)
  const efforts = [...new Set(selected.flatMap((m) => m.efforts))]
  const fast = selected.some((m) => m.fastMode)
  const invalid = !!config.model && !selected.length
  return (
    <>
      <div className="select-field">
        {t('Provider')}
        <Select
          disabled={disabled || !providers.length}
          value={config.provider}
          label={t('Provider')}
          options={(providers.length ? providers : [config.provider]).map((value) => ({
            value,
            label: value === 'codex' ? 'Codex' : value === 'maestrly' ? 'Maestrly' : 'Claude Agent SDK',
          }))}
          onChange={(value) =>
            update({ provider: value as ColumnAutomation['provider'], model: '', effort: null, fastMode: false, ...(value === 'maestrly' ? { approvalRequired: false } : {}) })
          }
        />
      </div>
      <div className="select-field">
        {t('Model')}
        <Select
          disabled={disabled || !available.length}
          value={config.model}
          label={t('Model')}
          options={[
            { value: '', label: t('Select a model') },
            ...distinct.map((m) => ({ value: m.model, label: m.label })),
            ...(invalid ? [{ value: config.model, label: t('Unavailable') + ' · ' + config.model }] : []),
          ]}
          onChange={(model) => update({ model, effort: null, fastMode: false, ...(!runners.some(r=>!r.personal&&r.capabilities?.models.some(m=>m.provider===config.provider&&m.model===model))?{autoRun:false}: {}) })}
        />
      </div>
      {efforts.length ? (
        <div className="select-field">
          {t('Reasoning effort')}
          <Select
            disabled={disabled}
            value={config.effort ?? ''}
            label={t('Reasoning effort')}
            options={[
              { value: '', label: t('Model default') },
              ...efforts.map((value) => ({ value, label: t(value) })),
              ...(config.effort && !efforts.includes(config.effort)
                ? [{ value: config.effort, label: t('Unavailable') + ' · ' + config.effort }]
                : []),
            ]}
            onChange={(effort) => update({ effort: effort || null })}
          />
        </div>
      ) : null}
      {fast || config.fastMode ? (
        <label className="check">
          <input
            type="checkbox"
            disabled={disabled || !fast}
            checked={config.fastMode}
            onChange={(e) => update({ fastMode: e.target.checked })}
          />
          {t('Fast mode')}
        </label>
      ) : null}
      {!models.length ? (
        <p className="form-note automation-wide">
          {t('No available models. Configure provider credentials on an authorized runner and start it.')}
        </p>
      ) : invalid ? (
        <p className="form-error automation-wide">{t('The saved model is not available on the selected runners.')}</p>
      ) : null}
    </>
  )
}
