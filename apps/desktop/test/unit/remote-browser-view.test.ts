import { describe, expect, it } from 'vitest'
import { fitFrame, toFramePoint, toSurfaceRect, wheelPixels } from '../../src/renderer/lib/remote-browser-view'

describe('remote browser view geometry', () => {
  it('draws a page that matches the surface one to one', () => {
    expect(fitFrame({ width: 800, height: 600 }, { width: 800, height: 600 }, 'tab')).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      scale: 1,
    })
  })

  it('letterboxes a page of another shape and maps points through the bars', () => {
    const frame = { width: 1280, height: 800 }
    const fit = fitFrame({ width: 1000, height: 1000 }, frame, 'tab')
    expect(fit).toEqual({ x: 0, y: 187.5, width: 1000, height: 625, scale: 0.78125 })
    expect(toFramePoint({ x: 500, y: 500 }, fit, frame)).toEqual({ x: 640, y: 400, inside: true })
    // A point on the bar is outside the page; drags clamp to its edge.
    expect(toFramePoint({ x: 10, y: 50 }, fit, frame)).toEqual({ x: 12.8, y: 0, inside: false })
    expect(toSurfaceRect({ x: 640, y: 400, width: 128, height: 32 }, fit)).toEqual({
      x: 500,
      y: 500,
      width: 100,
      height: 25,
    })
  })

  it('enlarges a page smaller than the surface but never a sign-in window', () => {
    const surface = { width: 1600, height: 1000 }
    expect(fitFrame(surface, { width: 800, height: 500 }, 'tab').scale).toBe(2)
    const popup = fitFrame(surface, { width: 500, height: 600 }, 'popup')
    expect(popup).toEqual({ x: 550, y: 200, width: 500, height: 600, scale: 1 })
    expect(fitFrame({ width: 400, height: 300 }, { width: 500, height: 600 }, 'popup').scale).toBe(0.5)
  })

  it('handles an empty surface or frame', () => {
    expect(fitFrame({ width: 0, height: 0 }, { width: 800, height: 600 }, 'tab').width).toBe(0)
  })

  it('turns wheel lines and pages into pixels', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ deltaX: 0, deltaY: 120 })
    expect(wheelPixels({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 600)).toEqual({ deltaX: 600, deltaY: 0 })
    expect(wheelPixels({ deltaX: 2, deltaY: -7, deltaMode: 0 }, 600)).toEqual({ deltaX: 2, deltaY: -7 })
  })
})
