import { Button, Checkbox, Select } from '../../ui'
import { useState } from 'react'
import type { UiPreferences } from '../../../shared/types'
import { useT } from '../../i18n'
import { AdvancedSettings } from './AdvancedSettings'
export function Settings({
  preferences,
  save,
  computers,
}: {
  preferences: UiPreferences
  save: (preferences: Partial<UiPreferences>) => Promise<void>
  computers: () => void
}) {
  const t = useT()
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState('')
  const update = (value: Partial<UiPreferences>) => void save(value).catch((error) => setError(String(error)))
  return (
    <section className="settings">
      <h1>{t('settings')}</h1>
      <label>
        {t('theme')}
        <Select
          aria-label={t('theme')}
          value={preferences.theme}
          onValueChange={(value) => update({ theme: value as UiPreferences['theme'] })}
        >
          {(['system', 'light', 'dark'] as const).map((theme) => (
            <option key={theme} value={theme}>
              {t(theme)}
            </option>
          ))}
        </Select>
      </label>
      <label>
        {t('language')}
        <Select
          aria-label={t('language')}
          value={preferences.locale}
          onValueChange={(value) => update({ locale: value as UiPreferences['locale'] })}
        >
          <option value="pt-BR">Português (Brasil)</option>
          <option value="en">English</option>
        </Select>
      </label>
      <label className="check">
        <Checkbox
          checked={preferences.advanced}
          onChange={(event) => update({ advanced: event.target.checked })}
        />
        {t('showAdvanced')}
      </label>
      <p>{t('presentationOnly')}</p>
      <Button onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {t('advanced')}
      </Button>
      {advanced && <AdvancedSettings computers={computers} />}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
