export type SupportedLocale = 'en' | 'pt-BR'

export const LOCALES: readonly SupportedLocale[] = ['en', 'pt-BR']

export const DEFAULT_LOCALE: SupportedLocale = 'en'

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
}

export function isSupportedLocale(v: unknown): v is SupportedLocale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

export function normalizeOsLocale(raw: string | null | undefined): SupportedLocale {
  if (typeof raw === 'string' && raw.toLowerCase().startsWith('pt')) return 'pt-BR'
  return DEFAULT_LOCALE
}

export function coerceLocale(v: unknown): SupportedLocale {
  return isSupportedLocale(v) ? v : DEFAULT_LOCALE
}
