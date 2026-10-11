import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http'

/** Headers that describe one connection, never forwarded across the proxy (RFC 9110, section 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** The end-to-end headers of a message. Host is always kept: the artifact host validates it; callers may drop it. */
export function endToEnd(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token && token !== 'host')
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name)) result[name] = value
  return result
}

/**
 * The headers sent upstream. Body framing comes from the request itself, never from its Connection list: a length
 * when it declared one, otherwise explicit chunks, which Node would not add by default for DELETE.
 */
export function upstreamHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers = endToEnd(req.headers)
  delete headers['content-length']
  if (req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length']
  else if (req.headers['transfer-encoding'] !== undefined) headers['transfer-encoding'] = 'chunked'
  return headers
}
