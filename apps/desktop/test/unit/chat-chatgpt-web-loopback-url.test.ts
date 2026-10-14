import { describe, expect, it } from 'vitest'
import { normalizeLoopbackPreviewUrl } from '../../src/main/chat/chatgpt-web/loopback-url'

describe('loopback URL policy', () => {
  it('accepts only plain HTTP on exact loopback hosts and valid ports', () => {
    expect(normalizeLoopbackPreviewUrl('http://localhost:5173/app#hash')).toBe('http://localhost:5173/app')
    expect(normalizeLoopbackPreviewUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/')
    expect(normalizeLoopbackPreviewUrl('http://[::1]:4321/')).toBe('http://[::1]:4321/')
    expect(normalizeLoopbackPreviewUrl('http://localhost/')).toBe('http://localhost/')

    for (const url of [
      'https://localhost:5173/',
      'http://0.0.0.0:5173/',
      'http://192.168.1.10:5173/',
      'http://example.com/',
      'http://localhost.evil.test:5173/',
      'http://localhost.:5173/',
      'http://127.1:5173/',
      'http://2130706433:5173/',
      'http://user:pass@localhost:5173/',
      'http://localhost:65536/',
      'file:///tmp/index.html',
      'data:text/html,hello',
      'javascript:alert(1)',
    ]) {
      expect(normalizeLoopbackPreviewUrl(url), url).toBeNull()
    }
  })
})
