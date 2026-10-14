/** Strict loopback URL policy shared by the drawer browser adapters. */

/** Return the canonical URL only for strict loopback HTTP. */
export function normalizeLoopbackPreviewUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2_048 || raw.trim() !== raw) return null
  // Check lexically before `URL`: the parser normalizes forms such as 127.1/2130706433 to
  // 127.0.0.1, but policy accepts only the three explicitly written authorities.
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(raw)) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return null
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') return null
  if (parsed.port) {
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  }
  parsed.hash = ''
  return parsed.toString()
}
