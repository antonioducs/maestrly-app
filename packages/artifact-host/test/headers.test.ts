import { describe, expect, it } from 'vitest'
import { API_HEADERS, contentHeaders, shellHeaders } from '../src/http/headers.js'

const ORIGIN = 'http://127.0.0.1:4010'

describe('content headers', () => {
  const headers = contentHeaders(ORIGIN, '/c/CAP')
  const csp = headers['content-security-policy']!

  it('sandbox the content without same-origin or top navigation', () => {
    expect(
      csp.startsWith('sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox;')
    ).toBe(true)
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).not.toContain('allow-top-navigation')
  })

  it('limit network access to the capability path and the CDN allowlist', () => {
    expect(csp).toContain("default-src 'none';")
    expect(csp).toContain('connect-src http://127.0.0.1:4010/c/CAP/;')
    expect(csp).toContain(
      "script-src http://127.0.0.1:4010/c/CAP/ 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net"
    )
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp.endsWith(`frame-ancestors ${ORIGIN}`)).toBe(true)
  })

  it('set the remaining isolation headers', () => {
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['cache-control']).toBe('private, max-age=43200')
  })
})

describe('shell headers', () => {
  it('forbid framing and caching', () => {
    const headers = shellHeaders(ORIGIN)
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['content-security-policy']).toContain(`frame-src ${ORIGIN}/c/;`)
    expect(headers['content-security-policy']).toContain("script-src 'self';")
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['cache-control']).toBe('no-store')
    expect(API_HEADERS['cache-control']).toBe('no-store')
  })
})
