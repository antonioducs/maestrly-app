import { getLocales } from 'expo-localization'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { prefs } from '../prefs'
import { detectLocale, translator, type Locale, type Pluralize, type Translate } from './translate'

export { detectLocale, translate, pluralize, translator } from './translate'
export type { Locale, MessageKey, PluralKey, Pluralize, Translate } from './translate'

export type LocalePreference = 'system' | Locale
type I18n = {
  locale: Locale
  preference: LocalePreference
  setPreference: (value: LocalePreference) => void
  t: Translate
  plural: Pluralize
  ready: boolean
}

const systemLanguages = () => getLocales().map((locale) => locale.languageTag)
const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>('system')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void prefs.get('prefs.locale').then((saved) => {
      if (saved === 'en' || saved === 'pt-BR') setPreferenceState(saved)
      setReady(true)
    })
  }, [])
  const setPreference = useCallback((value: LocalePreference) => {
    setPreferenceState(value)
    void prefs.set('prefs.locale', value)
  }, [])
  const value = useMemo(() => {
    const locale = detectLocale(preference === 'system' ? null : preference, systemLanguages())
    return { locale, preference, setPreference, ready, ...translator(locale) }
  }, [preference, setPreference, ready])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
