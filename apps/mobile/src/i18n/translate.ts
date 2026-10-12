import { en, ptBR } from './catalogs'

export type Locale = 'en' | 'pt-BR'
export type MessageKey = keyof typeof en
/** Keys with `.one` / `.other` forms, named without the suffix. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.other` ? Base : never }[MessageKey]
export type Values = Record<string, string | number>
export type Translate = (key: MessageKey, values?: Values) => string
export type Pluralize = (key: PluralKey, count: number, values?: Values) => string

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

export function pluralize(key: PluralKey, count: number, locale: Locale, values: Values = {}): string {
  const rule = new Intl.PluralRules(locale).select(count)
  const exact = `${key}.${rule}` as MessageKey
  const catalog: Record<string, string> = locale === 'pt-BR' ? ptBR : en
  const chosen = exact in catalog ? exact : (`${key}.other` as MessageKey)
  return translate(chosen, locale, { count, ...values })
}

export function translator(locale: Locale): { t: Translate; plural: Pluralize } {
  return {
    t: (key, values) => translate(key, locale, values),
    plural: (key, count, values) => pluralize(key, count, locale, values),
  }
}
