export function relativeTime(locale: string, ts: number): string {
  if (!ts) return ''
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return rtf.format(0, 'second')
  const m = Math.floor(s / 60)
  if (m < 60) return rtf.format(-m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 24) return rtf.format(-h, 'hour')
  const d = Math.floor(h / 24)
  return d < 7 ? rtf.format(-d, 'day') : rtf.format(-Math.floor(d / 7), 'week')
}

export type AgeUnit = 'Minutes' | 'Hours' | 'Days' | 'Weeks' | 'Months' | 'Years'

/**
 * How long ago something happened, in the largest whole unit: the sidebar shows it as `3d` or `2w`, through the
 * `sidebar.age*` keys. Null for no timestamp; a future one (another machine's clock) counts as now.
 */
export function compactAge(ts: number, now = Date.now()): { unit: 'Now' } | { unit: AgeUnit; count: number } | null {
  if (!ts) return null
  const minutes = Math.floor((now - ts) / 60_000)
  if (minutes < 1) return { unit: 'Now' }
  if (minutes < 60) return { unit: 'Minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'Hours', count: hours }
  const days = Math.floor(hours / 24)
  if (days < 7) return { unit: 'Days', count: days }
  if (days < 30) return { unit: 'Weeks', count: Math.floor(days / 7) }
  if (days < 365) return { unit: 'Months', count: Math.floor(days / 30) }
  return { unit: 'Years', count: Math.floor(days / 365) }
}
