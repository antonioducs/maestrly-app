import { en, ptBR } from './catalogs'

export type Locale = 'en' | 'pt-BR'
export type MessageKey = keyof typeof en
/** Keys with `.one` / `.other` forms, named without the suffix. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.other` ? Base : never }[MessageKey]
export type Values = Record<string, string | number>
export type Translate = (key: MessageKey, values?: Values) => string
export type Pluralize = (key: PluralKey, count: number, values?: Values) => string
/** What pure modules need to produce user-facing text. */
export type Text = { t: Translate; plural: Pluralize }

/** A saved choice wins; otherwise the first supported system language, and English for anything else. */
export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'pt-BR') return saved
  for (const language of languages) {
    if (/^pt(?:-|_|$)/i.test(language)) return 'pt-BR'
    if (/^en(?:-|_|$)/i.test(language)) return 'en'
  }
  return 'en'
}

export function translate(key: MessageKey, locale: Locale, values: Values = {}): string {
  const catalog: Record<MessageKey, string> = locale === 'pt-BR' ? ptBR : en
  const template = catalog[key] ?? en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}

/**
 * The plural form of a count, by CLDR's rules for the app's languages: English says "1 file", Portuguese also says
 * "0 arquivo". Hermes, the engine the app runs on, has no `Intl.PluralRules`.
 */
export function pluralCategory(count: number, locale: Locale): 'one' | 'other' {
  const whole = Math.trunc(Math.abs(count))
  if (locale === 'pt-BR') return whole <= 1 ? 'one' : 'other'
  return count === 1 ? 'one' : 'other'
}

export function pluralize(key: PluralKey, count: number, locale: Locale, values: Values = {}): string {
  const exact = `${key}.${pluralCategory(count, locale)}` as MessageKey
  const catalog: Record<string, string> = locale === 'pt-BR' ? ptBR : en
  const chosen = exact in catalog ? exact : (`${key}.other` as MessageKey)
  return translate(chosen, locale, { count, ...values })
}

export function translator(locale: Locale): Text {
  return {
    t: (key, values) => translate(key, locale, values),
    plural: (key, count, values) => pluralize(key, count, locale, values),
  }
}
