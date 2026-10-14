import { describe, expect, it } from 'vitest'
import {
  WHEEL_LINE_PX,
  WHEEL_STEP_PX,
  WheelSteps,
  contentBox,
  crispRendering,
  cursorStyle,
  screenButtons,
  screenPoint,
} from '../../src/renderer/lib/fleet/screen-geometry'

describe('screen geometry', () => {
  it('letterboxes the screen inside its element', () => {
    expect(contentBox({ left: 10, top: 20, width: 1000, height: 800 }, 1280, 800)).toEqual({
      left: 10,
      top: 107.5,
      width: 1000,
      height: 625,
      scale: 0.78125,
    })
    // A narrow element pillarboxes instead.
    expect(contentBox({ left: 0, top: 0, width: 2560, height: 800 }, 1280, 800)).toMatchObject({
      left: 640,
      top: 0,
      scale: 1,
    })
  })

  it('maps a client point to a screen pixel, held to the screen', () => {
    const box = contentBox({ left: 0, top: 0, width: 640, height: 400 }, 1280, 800)
    expect(screenPoint(320, 200, box, 1280, 800)).toEqual({ x: 640, y: 400 })
    expect(screenPoint(-50, 1000, box, 1280, 800)).toEqual({ x: 0, y: 799 })
    expect(screenPoint(9999, -1, box, 1280, 800)).toEqual({ x: 1279, y: 0 })
  })

  it('maps browser buttons to the left, middle and right bits of the stream', () => {
    expect(screenButtons(0)).toBe(0)
    expect(screenButtons(1)).toBe(0b001)
    expect(screenButtons(4)).toBe(0b010)
    expect(screenButtons(2)).toBe(0b100)
    expect(screenButtons(6)).toBe(0b110)
    expect(screenButtons(7 | 8)).toBe(0b111)
  })

  it('turns wheel deltas into whole steps, keeping the remainder', () => {
    expect([WHEEL_STEP_PX, WHEEL_LINE_PX]).toEqual([50, 19])
    const steps = new WheelSteps()
    expect(steps.add(0, 20, 0, 800)).toEqual({ dx: 0, dy: 0 })
    expect(steps.add(0, 20, 0, 800)).toEqual({ dx: 0, dy: 0 })
    expect(steps.add(0, 20, 0, 800)).toEqual({ dx: 0, dy: 1 })
    // 10 px were left over: 40 more make another step.
    expect(steps.add(0, 40, 0, 800)).toEqual({ dx: 0, dy: 1 })
    // Lines are 19 px, pages the page height.
    const lines = new WheelSteps()
    expect(lines.add(0, 3, 1, 800)).toEqual({ dx: 0, dy: 1 })
    expect(lines.add(-1, 0, 2, 800)).toEqual({ dx: -16, dy: 0 })
  })

  it('draws crisp pixels only at a whole scale', () => {
    const box = (scale: number) => ({ left: 0, top: 0, width: 1280 * scale, height: 800 * scale, scale })
    expect(crispRendering(box(1), 2)).toBe('pixelated')
    expect(crispRendering(box(1), 1)).toBe('pixelated')
    expect(crispRendering(box(0.5), 2)).toBe('pixelated')
    expect(crispRendering(box(0.9), 2)).toBe('auto')
    expect(crispRendering(box(0.4), 2)).toBe('auto')
  })

  it('makes a CSS cursor of a sprite at its hot spot', () => {
    expect(cursorStyle(0, 0, new Uint8Array(0))).toBe('none')
    expect(cursorStyle(4, 7, Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(
      'url("data:image/png;base64,iVBORw==") 4 7, default'
    )
  })
})
