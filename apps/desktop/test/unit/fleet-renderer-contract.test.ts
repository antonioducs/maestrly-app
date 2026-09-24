import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

describe('fleet renderer wiring', () => {
  it('routes fleet views through the main override and clears them for local conversations', () => {
    const panels = source('lib/use-main-panels.ts')
    expect(panels).toContain("(fleetView ? 'fleet' : null)")
    expect(panels).toContain('setFleetView(null)')
    expect(panels).toContain('setActive(null)')
  })
  it('subscribes to all fleet state streams and disposes subscriptions', () => {
    const hook = source('lib/fleet/use-fleet.ts')
    for (const event of ['onFleetConnection', 'onFleetEvent', 'onFleetDigest']) expect(hook).toContain(event)
    for (const unsubscribe of ['offConnection()', 'offEvent()', 'offDigest()']) expect(hook).toContain(unsubscribe)
  })
  it('exposes keyboard accessible bot tabs and keeps the screen and settings extension points', () => {
    const view = source('components/fleet/BotView.tsx')
    expect(view).toContain('role="tablist"')
    expect(view).toContain('onKeyDown={onKeyDown}')
    expect(view).toContain("tab === 'conversation'")
    expect(view).toContain("['conversation', 'screen', 'settings']")
  })
})
