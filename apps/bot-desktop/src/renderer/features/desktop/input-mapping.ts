import { DESKTOP_LIMITS, type DesktopInput } from '@maestrly/host-protocol'

export type Box = { left: number; top: number; width: number; height: number }
export type Size = { width: number; height: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
/**
 * Maps a viewport point to framebuffer pixels. The canvas box already excludes the
 * letterbox, and CSS pixels (not Retina device pixels) are what the image is scaled to.
 */
export function toFramebuffer(clientX: number, clientY: number, box: Box, framebuffer: Size, clampInside = false) {
  if (box.width <= 0 || box.height <= 0 || framebuffer.width <= 0 || framebuffer.height <= 0) return undefined
  let x = Math.floor(((clientX - box.left) * framebuffer.width) / box.width)
  let y = Math.floor(((clientY - box.top) * framebuffer.height) / box.height)
  if (clampInside) {
    x = clamp(x, 0, framebuffer.width - 1)
    y = clamp(y, 0, framebuffer.height - 1)
  }
  if (x < 0 || y < 0 || x >= framebuffer.width || y >= framebuffer.height) return undefined
  return { x, y }
}
export function buttonName(button: number): 'left' | 'middle' | 'right' | undefined {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : undefined
}
/** Accumulates trackpad deltas into discrete wheel steps, both axes. */
export class WheelSteps {
  private x = 0
  private y = 0
  constructor(private readonly pixelsPerStep = 50) {}
  step(deltaX: number, deltaY: number, deltaMode: number) {
    const scale = deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1
    this.x += deltaX * scale
    this.y += deltaY * scale
    const dx = Math.trunc(this.x / this.pixelsPerStep) || 0
    const dy = Math.trunc(this.y / this.pixelsPerStep) || 0
    this.x -= dx * this.pixelsPerStep
    this.y -= dy * this.pixelsPerStep
    return { deltaX: clamp(dx, -DESKTOP_LIMITS.wheelStepMax, DESKTOP_LIMITS.wheelStepMax), deltaY: clamp(dy, -DESKTOP_LIMITS.wheelStepMax, DESKTOP_LIMITS.wheelStepMax) }
  }
  reset() {
    this.x = 0
    this.y = 0
  }
}
/** Printable text only, split into bounded commits; control characters are dropped. */
export function textEvents(text: string): DesktopInput[] {
  const clean = [...text].filter((character) => !/[\u0000-\u001f\u007f-\u009f]/.test(character))
  const events: DesktopInput[] = []
  for (let offset = 0; offset < clean.length; offset += DESKTOP_LIMITS.textMax) events.push({ kind: 'text', text: clean.slice(offset, offset + DESKTOP_LIMITS.textMax).join('') })
  return events
}
/**
 * Orders input for the main process. Pointer motion is coalesced to the display rate;
 * clicks and keys are never coalesced and flush any pending motion first so order holds.
 */
export class InputQueue {
  private events: DesktopInput[] = []
  private pointer?: { x: number; y: number }
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly send: (events: DesktopInput[]) => void,
    private readonly hz: number = DESKTOP_LIMITS.moveHz
  ) {}
  move(x: number, y: number) {
    this.pointer = { x, y }
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 1000 / this.hz)
  }
  push(...events: DesktopInput[]) {
    if (this.pointer) {
      this.events.push({ kind: 'pointer', ...this.pointer })
      this.pointer = undefined
    }
    this.events.push(...events)
    this.flush()
  }
  flush() {
    if (this.pointer) {
      this.events.push({ kind: 'pointer', ...this.pointer })
      this.pointer = undefined
    }
    while (this.events.length) this.send(this.events.splice(0, DESKTOP_LIMITS.inputBatchMax))
  }
  clear() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pointer = undefined
    this.events = []
  }
}
