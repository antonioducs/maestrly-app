import type { ColumnAutomation, RunnerAutomationCapabilities } from '@maestrly/protocol'
import { Select } from '../../components/Select.js'
import { t } from '../../i18n/index.js'
import { Field } from './EditorField.js'
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
const providerLabel = (value: string) =>
  value === 'codex' ? 'Codex' : value === 'maestrly' ? 'Maestrly' : 'Claude Agent SDK'
const providerHint = (value: string) =>
  value === 'codex'
    ? t('Codex CLI on the runner.')
    : value === 'maestrly'
      ? t('Maestrly executor with the desktop accounts.')
      : t('Claude Agent SDK on the runner.')
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
  const shared = (provider: string, model: string) =>
    runners.some((r) => !r.personal && r.capabilities?.models.some((m) => m.provider === provider && m.model === model))
  const personalOnly = !!selected.length && !shared(config.provider, config.model)
  const modelHint = !models.length
    ? { text: t('No available models. Configure provider credentials on an authorized runner and start it.'), tone: 'warn' as const }
    : invalid
      ? { text: t('The saved model is not available on the selected runners.'), tone: 'warn' as const }
      : !config.model
        ? { text: t('Choose one of the models reported by the selected runners.'), tone: '' as const }
        : personalOnly
          ? { text: t('This model is available on your personal computer. Use Run on my computer on the card.'), tone: '' as const }
          : { text: t('Available on the shared runner pool.'), tone: 'good' as const }
  return (
    <>
      <Field label={t('Provider')} htmlFor="af-provider" hint={providerHint(config.provider)}>
        <Select
          id="af-provider"
          disabled={disabled || !providers.length}
          value={config.provider}
          label={t('Provider')}
          options={(providers.length ? providers : [config.provider]).map((value) => ({ value, label: providerLabel(value) }))}
          onChange={(value) =>
            update({ provider: value as ColumnAutomation['provider'], model: '', effort: null, fastMode: false, ...(value === 'maestrly' ? { approvalRequired: false } : {}) })
          }
        />
      </Field>
      <Field label={t('Model')} htmlFor="af-model" hint={modelHint.text} tone={modelHint.tone}>
        <Select
          id="af-model"
          disabled={disabled || !available.length}
          value={config.model}
          label={t('Model')}
          options={[
            { value: '', label: available.length ? t('Select a model') : t('No available models') },
            ...distinct.map((m) => ({ value: m.model, label: m.label })),
            ...(invalid ? [{ value: config.model, label: t('Unavailable') + ' · ' + config.model }] : []),
          ]}
          onChange={(model) => update({ model, effort: null, fastMode: false, ...(!shared(config.provider, model) ? { autoRun: false } : {}) })}
        />
      </Field>
      <Field
        label={t('Reasoning effort')}
        htmlFor="af-effort"
        hint={efforts.length ? t('Higher effort is slower and costs more.') : t('This model does not expose effort levels.')}
      >
        <Select
          id="af-effort"
          disabled={disabled || !efforts.length}
          value={efforts.length ? (config.effort ?? '') : ''}
          label={t('Reasoning effort')}
          options={
            efforts.length
              ? [
                  { value: '', label: t('Model default') },
                  ...efforts.map((value) => ({ value, label: t(value) })),
                  ...(config.effort && !efforts.includes(config.effort)
                    ? [{ value: config.effort, label: t('Unavailable') + ' · ' + config.effort }]
                    : []),
                ]
              : [{ value: '', label: t('Not supported by this model') }]
          }
          onChange={(effort) => update({ effort: effort || null })}
        />
      </Field>
      <Field
        label={t('Speed')}
        hint={fast ? t('Priority tier from the provider; higher cost.') : t('Fast mode is not available for this model.')}
      >
        <label className="af-switch">
          <input
            type="checkbox"
            disabled={disabled || !fast}
            checked={fast && config.fastMode}
            onChange={(e) => update({ fastMode: e.target.checked })}
          />
          <span className="af-switch-track" aria-hidden="true" />
          <span>{t('Fast mode')}</span>
        </label>
      </Field>
    </>
  )
}
