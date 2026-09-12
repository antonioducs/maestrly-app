/** Initialize the renderer locale before mounting React, then synchronize language changes across
 * windows through main-process broadcasts. English is the fallback when preferences cannot be read. */

import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { useCallback } from 'react'
import { resources, namespaces, defaultNS } from '../../shared/i18n/resources'
import { DEFAULT_LOCALE, coerceLocale, type SupportedLocale } from '../../shared/locale'

export const i18n: I18nInstance = i18next.createInstance()

function applyDocumentLanguage(locale: SupportedLocale): void {
  document.documentElement.lang = locale
}

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  ns: [...namespaces],
  defaultNS,
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
  react: { useSuspense: false },
})

export async function initRendererI18n(): Promise<void> {
  try {
    const locale = coerceLocale(await window.api.getLocale())
    applyDocumentLanguage(locale)
    if (locale !== i18n.language) await i18n.changeLanguage(locale)
  } catch {
    applyDocumentLanguage(DEFAULT_LOCALE)
  }
  window.api.onLocaleChanged((locale) => {
    const next = coerceLocale(locale)
    applyDocumentLanguage(next)
    void i18n.changeLanguage(next)
  })
}

export function useLocale(): [SupportedLocale, (next: SupportedLocale) => void] {
  const { i18n: inst } = useTranslation()
  const locale = coerceLocale(inst.language)
  const setLocale = useCallback(
    (next: SupportedLocale) => {
      applyDocumentLanguage(next)
      void inst.changeLanguage(next)
      window.api.setLocale(next)
    },
    [inst]
  )
  return [locale, setLocale]
}
