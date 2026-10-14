import { describe, expect, it } from 'vitest'
import { APP_CONTENT_SECURITY_POLICY } from '../../src/main/content-security-policy'
import { FLEET_MEDIA_SCHEME } from '../../src/shared/fleet-media'
import { GENUI_WIDGET_SCHEME } from '../../src/shared/genui-widget'

describe('production CSP for image previews', () => {
  const policy = APP_CONTENT_SECURITY_POLICY

  it('allows object URLs only as image sources', () => {
    expect(policy).toContain("img-src 'self' data: blob:")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toMatch(/(?:default|script|style)-src[^;]*blob:/)
  })

  it('plays media only from the app and its cache scheme, never from object URLs or the network', () => {
    const media = policy
      .match(/media-src([^;]*)/)?.[1]
      ?.trim()
      .split(/\s+/)
    expect(media).toEqual(["'self'", `${FLEET_MEDIA_SCHEME}:`])
    expect(policy).not.toMatch(/(?:default|script|style|img)-src[^;]*maestrly-media:/)
  })

  it('frames only the app and the inline-HTML scheme, and is never framed itself', () => {
    expect(
      policy
        .match(/frame-src([^;]*)/)?.[1]
        ?.trim()
        .split(/\s+/)
    ).toEqual(["'self'", `${GENUI_WIDGET_SCHEME}:`])
    expect(policy).not.toMatch(/(?:default|script|style|img|media)-src[^;]*maestrly-widget:/)
    expect(policy).toContain("frame-ancestors 'none'")
  })
})
