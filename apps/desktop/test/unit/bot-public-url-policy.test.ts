import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/main/store', () => ({ getDb: vi.fn() }))
import { normalizeBotPublicUrl } from '../../src/main/bot/oauth'

describe('the published bot endpoint identity', () => {
  it('normalizes a public HTTPS origin', () => {
    expect(normalizeBotPublicUrl('https://maestrly.example/')).toBe('https://maestrly.example')
  })

  it.each([
    'http://127.0.0.1:14310',
    'https://127.0.0.1:14310',
    'https://localhost',
    'https://fixture.localhost',
    'https://[::1]',
    'https://0.0.0.0',
    'https://user:password@maestrly.example',
    'http://maestrly.example',
    'https://maestrly.example?token=fixture',
    'https://maestrly.example#fragment',
    'https://maestrly.example/nested',
  ])('rejects an unusable or credential-bearing public URL: %s', (url) => {
    expect(() => normalizeBotPublicUrl(url)).toThrow()
  })
})
