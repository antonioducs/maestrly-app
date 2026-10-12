/**
 * Geometry of the remote browser surface: where a frame of the host's page is drawn in the surface, and how points
 * and rectangles move between the two. Frame coordinates are the page viewport's pixels on the host (see
 * shared/browser-stream); surface coordinates are CSS pixels of the canvas.
 */

export interface Size {
  width: number
  height: number
}

export interface FrameFit {
  /** The frame's drawn rectangle in the surface. */
  x: number
  y: number
  width: number
  height: number
  /** Surface pixels per frame pixel. */
  scale: number
}

/**
 * Where a frame is drawn: whole, centered, as large as the surface allows. A sign-in window keeps its own size unless
 * the surface is smaller, since it is a window above the page rather than the page itself.
 */
export function fitFrame(surface: Size, frame: Size, kind: 'tab' | 'popup'): FrameFit {
  if (surface.width <= 0 || surface.height <= 0 || frame.width <= 0 || frame.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0, scale: 1 }
  const contain = Math.min(surface.width / frame.width, surface.height / frame.height)
  const scale = kind === 'popup' ? Math.min(1, contain) : contain
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (surface.width - width) / 2, y: (surface.height - height) / 2, width, height, scale }
}

/** The frame point under a surface point, clamped to the frame; `inside` tells whether it was on the frame at all. */
export function toFramePoint(
  point: { x: number; y: number },
  fit: FrameFit,
  frame: Size
): { x: number; y: number; inside: boolean } {
  const x = (point.x - fit.x) / fit.scale
  const y = (point.y - fit.y) / fit.scale
  const inside = x >= 0 && y >= 0 && x < frame.width && y < frame.height
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, frame.width - 1)),
    y: Math.min(Math.max(y, 0), Math.max(0, frame.height - 1)),
    inside,
  }
}

/** A frame rectangle (an element of the page) in surface coordinates. */
export function toSurfaceRect(rect: { x: number; y: number; width: number; height: number }, fit: FrameFit) {
  return {
    x: fit.x + rect.x * fit.scale,
    y: fit.y + rect.y * fit.scale,
    width: rect.width * fit.scale,
    height: rect.height * fit.scale,
  }
}

/** Wheel deltas in pixels, whatever unit the event used. */
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number) {
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? Math.max(1, pageHeight) : 1
  return { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit }
}
