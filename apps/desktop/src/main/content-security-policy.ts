import { FLEET_MEDIA_SCHEME } from '../shared/fleet-media'
import { GENUI_WIDGET_SCHEME, isGenUiWidgetUrl } from '../shared/genui-widget'

/** Policy of every response the app's own session loads in production. */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "img-src 'self' data: blob:",
  `media-src 'self' ${FLEET_MEDIA_SCHEME}:`,
  `frame-src 'self' ${GENUI_WIDGET_SCHEME}:`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The headers a response gets, or null to keep its own: the inline-HTML frame is served with a separate policy, and
 * adding the app's would both refuse its scripts and forbid framing it.
 */
export function appPolicyHeaders(
  url: string,
  headers: Record<string, string | string[]> | undefined
): Record<string, string | string[]> | null {
  if (isGenUiWidgetUrl(url)) return null
  return { ...headers, 'Content-Security-Policy': [APP_CONTENT_SECURITY_POLICY] }
}
