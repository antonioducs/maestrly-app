import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')

describe('production CSP for image previews', () => {
  const policy = mainSource.match(/"default-src[^"]+frame-ancestors 'none'"/)?.[0] ?? ''

  it('allows object URLs only as image sources', () => {
    expect(policy).toContain("img-src 'self' data: blob:")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toMatch(/(?:default|script|style)-src[^;]*blob:/)
  })
})
