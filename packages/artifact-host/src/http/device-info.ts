/**
 * A coarse device label for the owner ("Safari on iPhone"). Only the browser and system families are kept; the raw
 * user agent is never stored.
 */
export function deviceInfo(userAgent: string | undefined): { browser: string; os: string } {
  const ua = userAgent ?? ''
  return { browser: browserOf(ua), os: osOf(ua) }
}

function browserOf(ua: string): string {
  if (/Electron\//.test(ua)) return 'Maestrly'
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari'
  return 'Browser'
}

function osOf(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Unknown'
}
