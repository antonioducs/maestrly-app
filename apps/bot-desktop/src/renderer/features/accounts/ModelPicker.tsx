import type { Bot, ModelCatalogEntry } from '@maestrly/host-protocol'
import { Select } from '../../ui'
import { useT } from '../../i18n'
export function recommendedSelection(models: ModelCatalogEntry[], previous?: Bot['model']): Bot['model'] {
  const entry = models.find(model => model.id === previous?.model) ?? models.find(model => model.recommended) ?? models[0]
  if (!entry) return undefined
  const effort = previous?.model === entry.id && previous.effort && entry.efforts.includes(previous.effort) ? previous.effort : entry.defaultEffort ?? entry.efforts[0]
  return { model: entry.id, ...(effort ? { effort } : {}), source: previous?.model === entry.id ? previous.source : 'recommended' }
}
export function ModelPicker({ models, value, onChange, disabled = false }: { models: ModelCatalogEntry[]; value?: Bot['model']; onChange: (value: NonNullable<Bot['model']>) => void; disabled?: boolean }) {
  const t = useT()
  const current = models.find(model => model.id === value?.model)
  return <div className="model-fields">
    <label>{t('model')}<Select aria-label={t('model')} disabled={disabled || !models.length} value={value?.model ?? ''} onValueChange={id => {
      const next = recommendedSelection(models, { model: id, source: 'custom' })
      if (next) onChange({ ...next, source: 'custom' })
    }}>
      {!current && <option value="">{t('chooseModel')}</option>}
      {models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
    </Select></label>
    {!!current?.efforts.length && <label>{t('effort')}<Select aria-label={t('effort')} value={value?.effort ?? ''} disabled={disabled} onValueChange={effort => {
      if (value) onChange({ ...value, effort: effort as NonNullable<Bot['model']>['effort'], source: 'custom' })
    }}>{current.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</Select></label>}
  </div>
}
