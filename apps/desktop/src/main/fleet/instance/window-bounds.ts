import type { ScreenArea } from '../../conversation-screen'
import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'

/** A bot's primary browser is the one floating window that fills its whole screen area. */
export function fillsScreenArea(tab: string, botMode: boolean): boolean {
  return botMode && tab === 'browser'
}

/** A bot's primary browser uses its whole virtual screen; other floating windows retain their saved bounds. */
export function initialFloatingBounds<T>(
  tab: string,
  botMode: boolean,
  primaryWorkArea: T,
  saved: T | undefined
): T | undefined {
  return fillsScreenArea(tab, botMode) ? primaryWorkArea : saved
}

/**
 * What the environment display's window manager draws around a framed window, as its `_NET_FRAME_EXTENTS` report:
 * openbox with the Clearlooks theme (deploy/bot-fleet/openbox-environment-rc.xml) adds a 20 px title bar, 1 px side
 * borders and a 5 px bottom edge. The frame goes around the bounds the window asks for, so it lies outside them.
 */
export const ENVIRONMENT_WINDOW_FRAME = Object.freeze({ left: 1, right: 1, top: 20, bottom: 5 })

/** The part of an area that a framed window may use so that its frame stays inside the area too. */
export function insideWindowFrame(area: ScreenArea, frame = ENVIRONMENT_WINDOW_FRAME): ScreenArea {
  return {
    x: area.x + frame.left,
    y: area.y + frame.top,
    width: Math.max(1, area.width - frame.left - frame.right),
    height: Math.max(1, area.height - frame.top - frame.bottom),
  }
}

/** Keep the environment settings window's native decorations inside tile zero as well. */
export function environmentScreenBounds(display: ScreenArea): ScreenArea {
  return insideWindowFrame(clampToArea(fleetEnvironmentTile(0), display))
}

/** A side length that fits the area; an unusable length takes the whole side. */
function fit(length: number, limit: number): number {
  return Number.isFinite(length) ? Math.min(Math.max(1, Math.round(length)), limit) : limit
}

/** Shrink bounds that do not fit the area, then move them inside it. */
export function clampToArea(bounds: ScreenArea, area: ScreenArea): ScreenArea {
  const width = fit(bounds.width, area.width)
  const height = fit(bounds.height, area.height)
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return centerInArea({ width, height }, area)
  return {
    x: Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width),
    y: Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height),
    width,
    height,
  }
}

/** Center a window in the area, shrinking it when it is larger. */
export function centerInArea(size: Pick<ScreenArea, 'width' | 'height'>, area: ScreenArea): ScreenArea {
  const width = fit(size.width, area.width)
  const height = fit(size.height, area.height)
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  }
}

/**
 * A unified bot desktop presents the bot's browser window, which stays on the environment display, inside a window of
 * the bot's own display. The presented window may be resized there between these limits; the browser follows it.
 */
export const PRESENTED_BROWSER_LIMITS = Object.freeze({ minWidth: 480, minHeight: 320, maxWidth: 1280, maxHeight: 800 })
/**
 * Where the presented browser window opens on the bot's display the first time: its client area, centered, below the
 * 42 px title bar of the Maestrly theme and above the dock.
 */
export const DEFAULT_PRESENTER_GEOMETRY = Object.freeze({ x: 80, y: 56, width: 1120, height: 640 })

export interface PresentedSize {
  width: number
  height: number
}

const presentedSide = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** A size of the presented browser within its limits; a side that is not a number takes its default. */
export function clampPresentedSize(size: PresentedSize): PresentedSize {
  const { minWidth, minHeight, maxWidth, maxHeight } = PRESENTED_BROWSER_LIMITS
  return {
    width: presentedSide(size.width, minWidth, maxWidth, DEFAULT_PRESENTER_GEOMETRY.width),
    height: presentedSide(size.height, minHeight, maxHeight, DEFAULT_PRESENTER_GEOMETRY.height),
  }
}

/** The presented browser window: frameless, at the top left of the bot's tile, at the size its desktop shows. */
export function presentedBrowserBounds(area: ScreenArea, size: PresentedSize): ScreenArea {
  const clamped = clampPresentedSize(size)
  return {
    x: area.x,
    y: area.y,
    width: Math.min(clamped.width, area.width),
    height: Math.min(clamped.height, area.height),
  }
}

/** Where a bot's popups open: inside its presented browser, so the desktop shows them, or else its whole tile. */
export function popupArea(area: ScreenArea, presented: PresentedSize | null): ScreenArea {
  return presented ? presentedBrowserBounds(area, presented) : area
}

/** The identity strip of a floating window; a presented bot browser has none, as its desktop window shows its name. */
export function floatingStripHeight(presented: boolean, stripHeight: number): number {
  return presented ? 0 : stripHeight
}
