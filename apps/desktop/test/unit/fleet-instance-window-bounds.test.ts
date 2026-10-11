import { describe, expect, it } from 'vitest'
import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import {
  DEFAULT_PRESENTER_GEOMETRY,
  ENVIRONMENT_WINDOW_FRAME,
  PRESENTED_BROWSER_LIMITS,
  centerInArea,
  clampPresentedSize,
  floatingStripHeight,
  insideWindowFrame,
  popupArea,
  presentedBrowserBounds,
} from '../../src/main/fleet/instance/window-bounds'

describe("a bot's presented browser window", () => {
  const tile = fleetEnvironmentTile(2)

  it('sits at the top left of its tile at the size its desktop presents', () => {
    expect(presentedBrowserBounds(tile, { width: 1120, height: 640 })).toEqual({
      x: tile.x,
      y: tile.y,
      width: 1120,
      height: 640,
    })
    // The presented window can be resized on the desktop; the browser follows within the limits of its tile.
    expect(presentedBrowserBounds(tile, { width: 2000, height: 100 })).toEqual({
      x: tile.x,
      y: tile.y,
      width: 1280,
      height: 320,
    })
  })

  it('keeps sizes within the limits, rounding them and refusing nonsense', () => {
    expect(PRESENTED_BROWSER_LIMITS).toEqual({ minWidth: 480, minHeight: 320, maxWidth: 1280, maxHeight: 800 })
    expect(clampPresentedSize({ width: 100, height: 5000 })).toEqual({ width: 480, height: 800 })
    expect(clampPresentedSize({ width: 900.6, height: 600.2 })).toEqual({ width: 901, height: 600 })
    expect(clampPresentedSize({ width: Number.NaN, height: Number.POSITIVE_INFINITY })).toEqual({
      width: DEFAULT_PRESENTER_GEOMETRY.width,
      height: DEFAULT_PRESENTER_GEOMETRY.height,
    })
    // Centered, below the 42 px title bar of the Maestrly theme and above the dock.
    expect(DEFAULT_PRESENTER_GEOMETRY).toEqual({ x: 80, y: 56, width: 1120, height: 640 })
  })

  it('opens its popups centered inside the presented browser, frames included', () => {
    const area = popupArea(tile, { width: 900, height: 600 })
    expect(area).toEqual({ x: tile.x, y: tile.y, width: 900, height: 600 })
    const popup = centerInArea({ width: 500, height: 400 }, insideWindowFrame(area))
    expect(popup.x - ENVIRONMENT_WINDOW_FRAME.left).toBeGreaterThanOrEqual(tile.x)
    expect(popup.x + popup.width + ENVIRONMENT_WINDOW_FRAME.right).toBeLessThanOrEqual(tile.x + 900)
    expect(popup.y - ENVIRONMENT_WINDOW_FRAME.top).toBeGreaterThanOrEqual(tile.y)
    expect(popup.y + popup.height + ENVIRONMENT_WINDOW_FRAME.bottom).toBeLessThanOrEqual(tile.y + 600)
    // A browser that is not presented keeps its popups in its whole tile, as before.
    expect(popupArea(tile, null)).toEqual(tile)
  })

  it('has no identity strip, unlike other floating windows', () => {
    expect(floatingStripHeight(true, 32)).toBe(0)
    expect(floatingStripHeight(false, 32)).toBe(32)
  })
})
