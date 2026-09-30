import { CONTENT_SANDBOX } from '../shell/contract.js'

export const SANDBOX_TOKENS = CONTENT_SANDBOX

/** The only third-party origins artifact content may load scripts, styles, images and fonts from. */
export const CDN_SOURCES =
  'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com'

/**
 * Headers of every content response. The sandbox gives the document an opaque origin even when it is opened directly,
 * and sources name the capability directory explicitly because `'self'` varies between engines in opaque origins.
 */
export function contentHeaders(origin: string, capabilityPath: string): Record<string, string> {
  const cap = `${origin}${capabilityPath}/`
  const csp = [
    `sandbox ${SANDBOX_TOKENS}`,
    "default-src 'none'",
    `script-src ${cap} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${CDN_SOURCES}`,
    `style-src ${cap} 'unsafe-inline' ${CDN_SOURCES}`,
    `img-src ${cap} data: blob: ${CDN_SOURCES}`,
    `font-src ${cap} data: ${CDN_SOURCES}`,
    `media-src ${cap} data: blob:`,
    `connect-src ${cap}`,
    'worker-src blob:',
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origin}`,
  ].join('; ')
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Module scripts and fetch of the artifact's own files come from an opaque origin; reading still needs the path.
    'access-control-allow-origin': '*',
    'cache-control': 'private, max-age=43200',
    'x-robots-tag': 'noindex',
  }
}

export function shellHeaders(origin: string): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      `frame-src ${origin}/c/`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex',
  }
}

export const API_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
}
