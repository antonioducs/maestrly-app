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

/**
 * A web address an interactive answer may open, with the host it reaches. React Native's URL is not a full parser,
 * so this reads the address itself and takes only plain ones: no credentials or `@`, backslashes, spaces or control
 * characters, which a browser and the phone could read as different hosts.
 */
const PLAIN_WEB_URL = /^https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:[/?#][^\s\\@\u0000-\u001f]*)?$/i
export function interfaceLink(value: string): { url: string; host: string } | null {
  const match = PLAIN_WEB_URL.exec(value)
  if (!match) return null
  return { url: value, host: match[1].toLowerCase() + (match[2] ? `:${match[2]}` : '') }
}
