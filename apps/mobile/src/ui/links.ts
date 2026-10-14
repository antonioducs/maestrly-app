/**
 * Where a link in a reply may lead: web pages and email. Anything else, such as the app's own `maestrly://` links,
 * phone numbers or files, stays plain text, so a reply cannot start a pairing or another app's action.
 */
export function safeLink(href: string): string | null {
  let url: URL
  try {
    url = new URL(href.trim())
  } catch {
    return null
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.username || url.password ? null : url.href
  if (url.protocol === 'mailto:') return url.href
  return null
}

/** What names an image a reply links to without showing it: its description, else its host. */
export function imageLabel(href: string, alt?: string, title?: string): string {
  const text = (alt || title || '').trim()
  if (text) return text
  try {
    return new URL(href).host || href
  } catch {
    return href
  }
}
