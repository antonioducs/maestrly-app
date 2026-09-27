import type { ScreenArea } from '../../conversation-screen'

/** A bot's primary browser uses its whole virtual screen; other floating windows retain their saved bounds. */
export function initialFloatingBounds<T>(
  tab: string,
  botMode: boolean,
  primaryWorkArea: T,
  saved: T | undefined
): T | undefined {
  return botMode && tab === 'browser' ? primaryWorkArea : saved
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
