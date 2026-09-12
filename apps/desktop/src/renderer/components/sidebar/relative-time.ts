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
