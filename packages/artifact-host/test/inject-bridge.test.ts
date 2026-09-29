import { describe, expect, it } from 'vitest'
import { deviceInfo } from '../src/http/device-info.js'
import { injectBridge } from '../src/http/inject-bridge.js'

describe('injectBridge', () => {
  const tag = '<script src="/c/CAP/_maestrly/bridge.js"></script>'
  const inject = (html: string) => injectBridge(html, '/c/CAP/_maestrly/bridge.js')

  it('puts the bridge first in the head', () => {
    expect(inject('<!doctype html><html><head lang="x"><script>1</script></head></html>')).toBe(
      `<!doctype html><html><head lang="x">${tag}<script>1</script></head></html>`
    )
    expect(inject('<HEAD><title>x</title>')).toBe(`<HEAD>${tag}<title>x</title>`)
  })

  it('falls back to the html element, the doctype, or the start', () => {
    expect(inject('<html lang="en"><header>x</header></html>')).toBe(`<html lang="en">${tag}<header>x</header></html>`)
    expect(inject('<!DOCTYPE html><p>x</p>')).toBe(`<!DOCTYPE html>${tag}<p>x</p>`)
    expect(inject('<p>x</p>')).toBe(`${tag}<p>x</p>`)
  })

  it('encodes a user-controlled bridge URL before placing it in an HTML attribute', () => {
    const injected = injectBridge('<head></head>', '/c/ID" onerror="alert(1)')
    expect(injected).toBe('<head><script src="/c/ID%22%20onerror=%22alert(1)"></script></head>')
  })
})

describe('deviceInfo', () => {
  it('keeps only the browser and system family', () => {
    expect(
      deviceInfo(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      )
    ).toEqual({ browser: 'Safari', os: 'iPhone' })
    expect(
      deviceInfo(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'
      )
    ).toEqual({ browser: 'Edge', os: 'Windows' })
    expect(
      deviceInfo(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Electron/38.0 Safari/537.36'
      )
    ).toEqual({ browser: 'Maestrly', os: 'macOS' })
    expect(deviceInfo(undefined)).toEqual({ browser: 'Browser', os: 'Unknown' })
  })
})
