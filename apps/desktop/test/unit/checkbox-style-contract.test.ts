import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/renderer/styles.css', 'utf8')

describe('global checkbox visual contract', () => {
  it('themes every native checkbox with Maestrly colors and a real checked glyph', () => {
    expect(styles).toContain("input[type='checkbox']:not(.appearance-none)")
    expect(styles).toContain("input[type='checkbox']:not(.appearance-none):checked")
    expect(styles).toContain('background-color: var(--primary)')
    expect(styles).toContain('background-image: url("data:image/svg+xml')
  })

  it('covers keyboard, disabled and destructive states without overriding existing custom consent boxes', () => {
    expect(styles).toContain("input[type='checkbox']:not(.appearance-none):focus-visible")
    expect(styles).toContain("input[type='checkbox']:not(.appearance-none):disabled")
    expect(styles).toContain("input[type='checkbox']:not(.appearance-none).accent-destructive:checked")
  })
})
