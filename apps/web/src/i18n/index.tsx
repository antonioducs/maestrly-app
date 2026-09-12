import { Select } from '../components/Select.js'
import { useSyncExternalStore, useEffect } from 'react'
import { en, ptBR } from './catalogs.js'

export type Locale = 'en' | 'pt-BR'
export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'pt-BR') return saved
  for (const language of languages) {
    if (/^pt(?:-|$)/i.test(language)) return 'pt-BR'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}
function initialLocale(): Locale {
  let saved: string | null = null
  try { saved = localStorage.getItem('maestrly-language') } catch { /* Storage may be blocked. */ }
  return detectLocale(saved, typeof navigator === 'undefined' ? [] : navigator.languages)
}
let locale = initialLocale()
const listeners = new Set<() => void>()
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setLocale(value: Locale) {
  locale = value
  try { localStorage.setItem('maestrly-language', value) } catch { /* Keep the session preference. */ }
  document.documentElement.lang = value
  listeners.forEach(listener => listener())
}
export function translate(key: string, language: Locale, values: Record<string, string | number> = {}): string {
  const catalog = language === 'pt-BR' ? ptBR : en
  const template = Object.hasOwn(catalog, key) ? catalog[key as keyof typeof en] : key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
}
export const t = (key: string, values?: Record<string, string | number>) => translate(key, locale, values)
export const number = (value: number) => new Intl.NumberFormat(locale).format(value)
export const dateTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
export const duration = (seconds: number | null) => seconds == null ? '—' : new Intl.NumberFormat(locale, {style: 'unit', unit: seconds < 60 ? 'second' : 'minute', unitDisplay: 'short', maximumFractionDigits: 0}).format(seconds < 60 ? seconds : seconds / 60)
export function errorText(message: string) {
  if (Object.hasOwn(en, message)) return t(message)
  const request = /^Request failed \((\d+)\)$/.exec(message)
  if (request) return t('Request failed ({status})', {status: request[1]})
  return locale === 'en' ? message : t('Unexpected error: {message}', {message})
}
export function useLocale() { return useSyncExternalStore(subscribe, () => locale) }

export function LanguageSelector({ compact = false }: { compact?: boolean } = {}) {
  const language = useLocale()
  useEffect(() => {
    document.documentElement.lang = language
    document.title = t('Maestrly · Delivery control')
    // Native browser validation otherwise follows the browser's language.
    function validate(event: Event) {
      const input = event.target
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return
      input.setCustomValidity('')
      if (event.type === 'input') return
      const v = input.validity
      if (v.valueMissing) input.setCustomValidity(t('Please fill out this field.'))
      else if (v.typeMismatch) input.setCustomValidity(t('Please enter a valid email address.'))
      else if (v.tooShort && 'minLength' in input) input.setCustomValidity(t('Please use at least {count} characters.', {count: input.minLength}))
      else if (!v.valid) input.setCustomValidity(t('Please check this value.'))
    }
    document.addEventListener('invalid', validate, true)
    document.addEventListener('input', validate, true)
    document.querySelectorAll<HTMLInputElement>('input, textarea, select').forEach(input => input.setCustomValidity(''))
    return () => { document.removeEventListener('invalid', validate, true); document.removeEventListener('input', validate, true) }
  }, [language])
  return <div className="language-selector"><span className="sr-only">{t('Language')}</span>
    <Select value={language} onChange={value => setLocale(value as Locale)} label={t('Language')}
      options={[{value:'en',label:'English'},{value:'pt-BR',label:compact?'Português':'Português (Brasil)'}]} />
  </div>
}
