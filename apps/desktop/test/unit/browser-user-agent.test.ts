import { describe, expect, it } from 'vitest'
import { websiteUserAgent } from '../../src/main/drawer/browser-user-agent'

describe('embedded browser user agent', () => {
  it('drops the app and Electron products and reduces Chrome to its major version', () => {
    expect(
      websiteUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Maestrly/0.25.0 ' +
          'Chrome/144.0.7559.60 Electron/44.7.2 Safari/537.36'
      )
    ).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36')
  })

  it('drops an app name with spaces', () => {
    expect(
      websiteUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Maestrly Dev/0.0.1 ' +
          'Chrome/144.0.7559.60 Electron/44.7.2 Safari/537.36'
      )
    ).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 ' +
        'Safari/537.36'
    )
  })

  it('keeps a Chromium user agent as it is', () => {
    const chromium =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    expect(websiteUserAgent(chromium)).toBe(chromium)
  })
})
