import { describe, expect, it } from 'vitest'
import {
  constrainFrame,
  type Hit,
  type HitWindow,
  hitTest,
  POPUP_CLOSE_WIDTH,
  type Rect,
} from '../../src/main/fleet/instance/desktop/hit-test'

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

/** The frameless browser fills the 1280x800 display with a 100 px chrome view above the page view. */
function browser(): HitWindow<string> {
  const content = rect(0, 0, 1280, 800)
  return {
    kind: 'browser',
    id: 1,
    frame: content,
    content,
    views: [
      { target: 'chrome', bounds: rect(0, 0, 1280, 100) },
      { target: 'page', bounds: rect(0, 100, 1280, 700) },
    ],
    windowTarget: 'browser-window',
  }
}

/** An OAuth popup whose openbox frame adds a 20 px title bar, 1 px side borders and a 5 px bottom edge. */
function popup(id: number, x = 300, y = 200): HitWindow<string> {
  return {
    kind: 'popup',
    id,
    frame: rect(x, y, 402, 325),
    content: rect(x + 1, y + 20, 400, 300),
    views: [{ target: `popup-page-${id}`, bounds: rect(x + 1, y + 20, 400, 280) }],
    windowTarget: `popup-window-${id}`,
  }
}

function asContent(hit: Hit<string> | null): Extract<Hit<string>, { kind: 'content' }> {
  expect(hit?.kind).toBe('content')
  return hit as Extract<Hit<string>, { kind: 'content' }>
}

describe('hitTest', () => {
  it('sends a point in the tab bar to the chrome view with local coordinates', () => {
    const hit = asContent(hitTest([browser()], 40, 30))
    expect(hit.target).toBe('chrome')
    expect(hit.x).toBe(40)
    expect(hit.y).toBe(30)
    expect(hit.window.id).toBe(1)
  })

  it('sends a point below the tab bar to the page view with local coordinates', () => {
    const hit = asContent(hitTest([browser()], 640, 400))
    expect(hit.target).toBe('page')
    expect(hit.x).toBe(640)
    expect(hit.y).toBe(300)
  })

  it('makes view edges inclusive at the top left and exclusive at the bottom right', () => {
    expect(asContent(hitTest([browser()], 0, 0)).target).toBe('chrome')
    expect(asContent(hitTest([browser()], 1279, 99)).target).toBe('chrome')
    const topOfPage = asContent(hitTest([browser()], 5, 100))
    expect(topOfPage.target).toBe('page')
    expect(topOfPage.y).toBe(0)
    expect(asContent(hitTest([browser()], 1279, 799)).target).toBe('page')
    expect(hitTest([browser()], 1280, 400)).toBeNull()
    expect(hitTest([browser()], 400, 800)).toBeNull()
    expect(hitTest([browser()], -1, 10)).toBeNull()
    expect(hitTest([browser()], 10, -1)).toBeNull()
  })

  it('prefers the topmost view when views overlap', () => {
    const window = browser()
    window.views = [{ target: 'overlay', bounds: rect(100, 150, 200, 100) }, ...window.views]
    const overlaid = asContent(hitTest([window], 150, 200))
    expect(overlaid.target).toBe('overlay')
    expect(overlaid.x).toBe(50)
    expect(overlaid.y).toBe(50)
    expect(asContent(hitTest([window], 50, 200)).target).toBe('page')
  })

  it('sends a point in the content but in no view to the window target', () => {
    const window = browser()
    window.views = [{ target: 'chrome', bounds: rect(0, 0, 1280, 100) }]
    const hit = asContent(hitTest([window], 200, 300))
    expect(hit.target).toBe('browser-window')
    expect(hit.x).toBe(200)
    expect(hit.y).toBe(300)
  })

  it('returns null outside every window', () => {
    expect(hitTest([], 10, 10)).toBeNull()
    expect(hitTest([popup(2)], 10, 10)).toBeNull()
    expect(hitTest([browser()], Number.NaN, 10)).toBeNull()
  })

  it('lets a popup above the browser win where they overlap', () => {
    const windows = [popup(2), browser()]
    const inPopup = asContent(hitTest(windows, 350, 250))
    expect(inPopup.target).toBe('popup-page-2')
    expect(inPopup.window.kind).toBe('popup')
    expect(inPopup.x).toBe(49)
    expect(inPopup.y).toBe(30)

    const outside = asContent(hitTest(windows, 100, 500))
    expect(outside.target).toBe('page')
    expect(outside.window.kind).toBe('browser')
  })

  it('lets the newest popup win over an older one', () => {
    const windows = [popup(3, 320, 220), popup(2), browser()]
    const hit = asContent(hitTest(windows, 400, 300))
    expect(hit.window.id).toBe(3)
    expect(hit.target).toBe('popup-page-3')
    const onlyOlder = asContent(hitTest(windows, 310, 300))
    expect(onlyOlder.window.id).toBe(2)
  })

  it('sends the popup area below its page view to the popup window target', () => {
    const hit = asContent(hitTest([popup(2), browser()], 400, 510))
    expect(hit.target).toBe('popup-window-2')
    expect(hit.x).toBe(99)
    expect(hit.y).toBe(290)
  })

  it('closes the popup from the last 24 px of its title bar', () => {
    const windows = [popup(2), browser()]
    // Frame spans x 300..702 and the title bar y 200..220.
    expect(POPUP_CLOSE_WIDTH).toBe(24)
    expect(hitTest(windows, 701, 210)).toMatchObject({ kind: 'close', window: { id: 2 } })
    expect(hitTest(windows, 702 - POPUP_CLOSE_WIDTH, 200)).toMatchObject({ kind: 'close' })
    expect(hitTest(windows, 702 - POPUP_CLOSE_WIDTH, 219)).toMatchObject({ kind: 'close' })
    expect(hitTest(windows, 702 - POPUP_CLOSE_WIDTH - 1, 210)).toMatchObject({ kind: 'titlebar' })
    // x = 702 is outside the popup, so it falls through to the browser page.
    expect(hitTest(windows, 702, 210)).toMatchObject({ kind: 'content', window: { kind: 'browser' } })
  })

  it('starts a drag from the rest of the title bar with frame-relative coordinates', () => {
    const hit = hitTest([popup(2), browser()], 350, 205)
    expect(hit).toMatchObject({ kind: 'titlebar', x: 50, y: 5, window: { id: 2 } })
    expect(hitTest([popup(2)], 300, 200)).toMatchObject({ kind: 'titlebar', x: 0, y: 0 })
    expect(hitTest([popup(2)], 300, 219)).toMatchObject({ kind: 'titlebar', y: 19 })
  })

  it('treats the popup side and bottom borders as frame, not as the browser underneath', () => {
    const windows = [popup(2), browser()]
    expect(hitTest(windows, 300, 300)).toMatchObject({ kind: 'frame', window: { id: 2 } })
    expect(hitTest(windows, 701, 300)).toMatchObject({ kind: 'frame', window: { id: 2 } })
    expect(hitTest(windows, 400, 523)).toMatchObject({ kind: 'frame', window: { id: 2 } })
    expect(hitTest(windows, 400, 525)).toMatchObject({ kind: 'content', window: { kind: 'browser' } })
  })

  it('only hits the content of the browser even if its frame is reported larger', () => {
    const window = { ...browser(), frame: rect(-10, -10, 1300, 820) }
    expect(hitTest([window], -5, 400)).toBeNull()
    expect(hitTest([window], 1279, 0)).toMatchObject({ kind: 'content', target: 'chrome' })
  })
})

describe('constrainFrame', () => {
  const bounds = rect(0, 0, 1280, 800)
  const frame = rect(300, 200, 402, 325)

  it('moves the frame by the delta when it stays inside the bounds', () => {
    expect(constrainFrame(frame, 50, -30, bounds)).toEqual({ x: 350, y: 170 })
  })

  it('clamps every edge of the frame inside the bounds', () => {
    expect(constrainFrame(frame, -1000, 0, bounds)).toEqual({ x: 0, y: 200 })
    expect(constrainFrame(frame, 2000, 0, bounds)).toEqual({ x: 1280 - 402, y: 200 })
    expect(constrainFrame(frame, 0, -1000, bounds)).toEqual({ x: 300, y: 0 })
    expect(constrainFrame(frame, 0, 2000, bounds)).toEqual({ x: 300, y: 800 - 325 })
  })

  it('respects bounds that are offset from the origin', () => {
    const offset = rect(100, 50, 800, 600)
    expect(constrainFrame(rect(150, 100, 200, 100), -500, -500, offset)).toEqual({ x: 100, y: 50 })
    expect(constrainFrame(rect(150, 100, 200, 100), 5000, 5000, offset)).toEqual({ x: 700, y: 550 })
  })

  it('pins a frame larger than the bounds to the top left', () => {
    expect(constrainFrame(rect(10, 10, 2000, 1000), 30, 30, bounds)).toEqual({ x: 0, y: 0 })
  })

  it('leaves an already contained frame in place for a zero delta', () => {
    expect(constrainFrame(frame, 0, 0, bounds)).toEqual({ x: 300, y: 200 })
  })

  it('pulls a frame that starts outside the bounds back in', () => {
    expect(constrainFrame(rect(-50, 900, 200, 100), 0, 0, bounds)).toEqual({ x: 0, y: 700 })
  })
})
