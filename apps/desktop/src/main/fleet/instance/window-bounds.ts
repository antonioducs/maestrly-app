import type { ScreenArea } from '../../conversation-screen'

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
 * openbox with the Clearlooks theme (deploy/bot-fleet/openbox-rc.xml) adds a 20 px title bar, 1 px side borders and
 * a 5 px bottom edge. The frame goes around the bounds the window asks for, so it lies outside them.
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
