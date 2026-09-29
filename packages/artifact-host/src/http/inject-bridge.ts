const HEAD = /<head(?:\s[^>]*)?>/i
const HTML = /<html(?:\s[^>]*)?>/i
const DOCTYPE = /<!doctype[^>]*>/i

/**
 * Inserts the bridge as the first element of `<head>` (or after `<html>`, the doctype, or at the start), so its error
 * handlers are registered before any of the page's own scripts run.
 */
export function injectBridge(html: string, bridgeSrc: string): string {
  const tag = `<script src="${bridgeSrc}"></script>`
  for (const pattern of [HEAD, HTML, DOCTYPE]) {
    const match = pattern.exec(html)
    if (match) {
      const at = match.index + match[0].length
      return html.slice(0, at) + tag + html.slice(at)
    }
  }
  return tag + html
}
