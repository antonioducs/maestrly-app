import { useTranslation } from 'react-i18next'
import type { PluginInputDto } from '../../../shared/plugins'
import { inputCls } from './plugin-ui'

/** Values a plugin asks for. Sensitive ones are masked; saved values are never shown, only replaced. */
export function PluginInputsForm({
  inputs,
  values,
  onChange,
  disabled,
}: {
  inputs: PluginInputDto[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('plugins')
  if (!inputs.length) return null
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-[12px] font-medium text-foreground">{t('install.inputs')}</legend>
      {inputs.map((input) => {
        const fieldId = `plugin-input-${input.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
        return (
          <div key={input.id} className="flex flex-col gap-0.5">
            <label htmlFor={fieldId} className="text-[12px] text-foreground">
              {input.label}{' '}
              <span className="text-[10px] text-muted-foreground">
                {input.required ? t('install.required') : t('install.optional')}
              </span>
            </label>
            {input.description && <span className="text-[11px] text-muted-foreground">{input.description}</span>}
            <input
              id={fieldId}
              type={input.sensitive ? 'password' : 'text'}
              autoComplete="off"
              className={inputCls}
              value={values[input.id] ?? ''}
              placeholder={input.set ? t('install.keepValue') : ''}
              onChange={(event) => onChange({ ...values, [input.id]: event.target.value })}
            />
          </div>
        )
      })}
    </fieldset>
  )
}
