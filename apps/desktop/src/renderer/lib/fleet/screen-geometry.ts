/** Where a remote screen of `width`×`height` pixels is drawn inside its element, letterboxed (`object-fit: contain`). */
export type ContentBox = { left: number; top: number; width: number; height: number; scale: number }

export function contentBox(
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number
): ContentBox {
  const scale = Math.max(0, Math.min(rect.width / width, rect.height / height))
  const drawnWidth = width * scale
  const drawnHeight = height * scale
  return {
    left: rect.left + (rect.width - drawnWidth) / 2,
    top: rect.top + (rect.height - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
    scale,
  }
}

/** The screen pixel under a client point, held to the screen. */
export function screenPoint(
  clientX: number,
  clientY: number,
  box: ContentBox,
  width: number,
  height: number
): { x: number; y: number } {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)
  const scale = box.scale || 1
  return {
    x: clamp(Math.round((clientX - box.left) / scale), width - 1),
    y: clamp(Math.round((clientY - box.top) / scale), height - 1),
  }
}

/** Browser buttons (1 primary, 2 secondary, 4 auxiliary) as the stream's bits: left, middle, right. */
export function screenButtons(buttons: number): number {
  return (buttons & 1 ? 0b001 : 0) | (buttons & 4 ? 0b010 : 0) | (buttons & 2 ? 0b100 : 0)
}

/** A wheel step on the remote screen, in pixels of scrolling here, and how long a line is: noVNC's values. */
export const WHEEL_STEP_PX = 50
export const WHEEL_LINE_PX = 19

/** Gathers wheel deltas into whole steps of the remote wheel, keeping what is left for the next delta. */
export class WheelSteps {
  private x = 0
  private y = 0
  /** `deltaMode` is the DOM wheel event's: 0 pixels, 1 lines, 2 pages of `pageHeight` pixels. */
  add(deltaX: number, deltaY: number, deltaMode: number, pageHeight: number): { dx: number; dy: number } {
    const unit = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? pageHeight : 1
    this.x += deltaX * unit
    this.y += deltaY * unit
    const dx = Math.trunc(this.x / WHEEL_STEP_PX)
    const dy = Math.trunc(this.y / WHEEL_STEP_PX)
    this.x -= dx * WHEEL_STEP_PX
    this.y -= dy * WHEEL_STEP_PX
    return { dx: dx || 0, dy: dy || 0 }
  }
}

/**
 * Crisp pixels when each remote pixel covers a whole number of device pixels, so text stays sharp; smoothing
 * otherwise, which reads better than uneven pixel doubling.
 */
export function crispRendering(box: ContentBox, devicePixelRatio: number): 'pixelated' | 'auto' {
  const ratio = box.scale * devicePixelRatio
  return ratio >= 0.99 && Math.abs(ratio - Math.round(ratio)) <= 0.01 ? 'pixelated' : 'auto'
}

/** A PNG as a data URL. */
export function pngDataUrl(png: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < png.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...png.subarray(offset, offset + 0x8000))
  return `data:image/png;base64,${btoa(binary)}`
}

/** A CSS cursor of the remote pointer's sprite at its hot spot; an empty sprite hides the pointer. */
export function cursorStyle(hotX: number, hotY: number, png: Uint8Array): string {
  if (png.byteLength === 0) return 'none'
  return `url("${pngDataUrl(png)}") ${hotX} ${hotY}, default`
}
