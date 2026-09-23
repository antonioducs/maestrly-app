import { describe, expect, it } from 'vitest'
import { placeFixedPanel } from '../../src/renderer/lib/fixed-panel-position'

const viewport = { width: 1200, height: 900 }
const fullViewport = { left: 0, top: 0, right: 1200, bottom: 900 }
/** A centered dialog whose translate makes it the containing block of fixed descendants. */
const dialog = { left: 300, top: 150, right: 900, bottom: 750 }

describe('placeFixedPanel', () => {
  it('keeps viewport coordinates when no ancestor contains fixed elements', () => {
    const placement = placeFixedPanel({
      anchor: { left: 400, top: 200, right: 520, bottom: 230 },
      viewport,
      container: fullViewport,
      width: 320,
      estimatedHeight: 420,
    })
    expect(placement).toEqual({
      opensUp: false,
      style: { position: 'fixed', left: 400, top: 234, bottom: undefined, width: 320 },
    })
  })

  it('offsets coordinates by a transformed dialog so the panel stays under its trigger', () => {
    const placement = placeFixedPanel({
      anchor: { left: 340, top: 260, right: 460, bottom: 290 },
      viewport,
      container: dialog,
      width: 320,
      estimatedHeight: 420,
    })
    // The browser adds the dialog origin back: 300 + 40 = 340 and 150 + 144 = 294 (4px under the trigger).
    expect(placement.style).toMatchObject({ left: 40, top: 144 })
  })

  it('opens upward against the containing block bottom when the viewport lacks room below', () => {
    const placement = placeFixedPanel({
      anchor: { left: 340, top: 700, right: 460, bottom: 730 },
      viewport,
      container: dialog,
      width: 224,
      estimatedHeight: 288,
    })
    // Panel bottom edge in viewport = 750 - 54 = 696, i.e. 4px above the trigger.
    expect(placement).toEqual({
      opensUp: true,
      style: { position: 'fixed', left: 40, top: undefined, bottom: 54, width: 224 },
    })
  })

  it('clamps inside the viewport and supports end alignment', () => {
    const nearRight = placeFixedPanel({
      anchor: { left: 1100, top: 100, right: 1180, bottom: 120 },
      viewport,
      container: fullViewport,
      width: 320,
      estimatedHeight: 200,
    })
    expect(nearRight.style.left).toBe(1200 - 320 - 8)
    const endAligned = placeFixedPanel({
      anchor: { left: 600, top: 100, right: 700, bottom: 120 },
      viewport,
      container: fullViewport,
      width: 320,
      estimatedHeight: 200,
      align: 'end',
    })
    expect(endAligned.style.left).toBe(380)
    const nearLeft = placeFixedPanel({
      anchor: { left: 2, top: 100, right: 40, bottom: 120 },
      viewport,
      container: fullViewport,
      width: 320,
      estimatedHeight: 200,
    })
    expect(nearLeft.style.left).toBe(8)
  })
})
