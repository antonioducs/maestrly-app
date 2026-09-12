import i18next, { type i18n as I18nInstance } from 'i18next'
import { resources, namespaces, defaultNS } from './resources'
import { DEFAULT_LOCALE, type SupportedLocale } from '../locale'

export type Namespace = (typeof namespaces)[number]

export type SharedTFunc = (key: string, vars?: Record<string, unknown>) => string

const instance: I18nInstance = i18next.createInstance()
void instance.init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  ns: [...namespaces],
  defaultNS,
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
})

export function tFor(locale: SupportedLocale, ns: Namespace): SharedTFunc {
  const fixed = instance.getFixedT(locale, ns)
  return (key, vars) => fixed(key, vars ?? {}) as unknown as string
}

export { instance as sharedI18n }
