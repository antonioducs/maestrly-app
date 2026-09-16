import { desktopInputBatchSchema, DESKTOP_LIMITS, type DesktopInput } from '@maestrly/host-protocol'
import { runtimeError } from '../turns/service.js'
import { X_EVENT, type X11Connection } from './x11.js'

const SHIFT = new Set([0xffe1, 0xffe2])
const MODIFIERS = new Set([0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe5, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec, 0xfe03])
const BUTTON = { left: 1, middle: 2, right: 3 } as const
/** Unicode code point to X keysym (Latin-1 is identical; others use the 0x01000000 plane). */
export function keysymFor(codePoint: number) {
  return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff) ? codePoint : 0x01000000 + codePoint
}
type Target = { keycode: number; column: number }

/**
 * Applies already-authorized human input to one X display. It keeps the pressed keys
 * and buttons so every blur, disconnect, expiry or return can release them; nothing is
 * replayed and no event is applied twice for the same sequence.
 */
export class HumanInput {
  private perKeycode = 0
  private keysyms: number[] = []
  private pressedCodes = new Map<string, number>()
  private buttons = new Set<number>()
  private remapped = new Map<number, number>()
  private tokens: number = DESKTOP_LIMITS.eventsPerSecond
  private refilled = Date.now()
  private queue: Promise<unknown> = Promise.resolve()
  private stale = true
  constructor(private readonly x: X11Connection) {
    x.onMappingChanged(() => {
      this.stale = true
    })
  }
  get width() {
    return this.x.width
  }
  get height() {
    return this.x.height
  }
  get pressed() {
    return this.pressedCodes.size + this.buttons.size
  }
  private async mapping() {
    if (!this.stale && this.keysyms.length) return
    const map = await this.x.keyboardMapping()
    this.perKeycode = map.perKeycode
    this.keysyms = map.keysyms
    this.stale = false
  }
  private column(keycode: number, column: number) {
    return this.keysyms[(keycode - this.x.minKeycode) * this.perKeycode + column] ?? 0
  }
  private lookup(keysym: number): Target | undefined {
    for (const column of [0, 1])
      for (let keycode = this.x.minKeycode; keycode <= this.x.maxKeycode; keycode++)
        if (this.column(keycode, column) === keysym) return { keycode, column }
    const remapped = this.remapped.get(keysym)
    return remapped ? { keycode: remapped, column: 0 } : undefined
  }
  /** Binds an unmapped keysym (accents, symbols, IME text) to a spare keycode. */
  private async bind(keysym: number): Promise<Target> {
    const inUse = new Set([...this.pressedCodes.values()])
    let spare: number | undefined
    for (let keycode = this.x.maxKeycode; keycode >= this.x.minKeycode && spare === undefined; keycode--) {
      let empty = true
      for (let column = 0; column < this.perKeycode; column++) if (this.column(keycode, column)) empty = false
      if (empty && !inUse.has(keycode)) spare = keycode
    }
    if (spare === undefined) {
      const reusable = [...this.remapped.entries()].find(([, keycode]) => !inUse.has(keycode))
      if (!reusable) throw runtimeError('DESKTOP_INPUT_REJECTED', 'No keycode available for this character')
      this.remapped.delete(reusable[0])
      spare = reusable[1]
    }
    const row = Array.from({ length: this.perKeycode }, (_, column) => (column < 2 ? keysym : 0))
    this.x.changeKeyboardMapping(spare, this.perKeycode, row)
    row.forEach((value, column) => {
      this.keysyms[(spare! - this.x.minKeycode) * this.perKeycode + column] = value
    })
    this.remapped.delete([...this.remapped.entries()].find(([, keycode]) => keycode === spare)?.[0] ?? -1)
    this.remapped.set(keysym, spare)
    // Clients see MappingNotify before the key event because both are ordered.
    await this.x.sync()
    return { keycode: spare, column: 0 }
  }
  private shiftKeycode() {
    return this.lookup(0xffe1)?.keycode
  }
  private shiftHeld() {
    for (const keycode of this.pressedCodes.values()) if (SHIFT.has(this.column(keycode, 0))) return true
    return false
  }
  /** Presses a target with the Shift level it needs, restoring the user's own modifiers. */
  private press(target: Target, keysym: number) {
    const held = this.shiftHeld()
    const shift = this.shiftKeycode()
    const shifted = this.column(target.keycode, 1)
    if (target.column === 1 && !held && shift) {
      this.x.fakeInput(X_EVENT.keyPress, shift)
      this.x.fakeInput(X_EVENT.keyPress, target.keycode)
      this.x.fakeInput(X_EVENT.keyRelease, shift)
    } else if (target.column === 0 && held && shifted && shifted !== keysym && !MODIFIERS.has(keysym)) {
      const shifts = [...this.pressedCodes.values()].filter((keycode) => SHIFT.has(this.column(keycode, 0)))
      for (const keycode of shifts) this.x.fakeInput(X_EVENT.keyRelease, keycode)
      this.x.fakeInput(X_EVENT.keyPress, target.keycode)
      for (const keycode of shifts) this.x.fakeInput(X_EVENT.keyPress, keycode)
    } else this.x.fakeInput(X_EVENT.keyPress, target.keycode)
  }
  private point(x: number, y: number) {
    if (x >= this.x.width || y >= this.x.height) throw runtimeError('INVALID_COORDINATES', 'Coordinates must be inside this desktop')
    this.x.fakeInput(X_EVENT.motion, 0, x, y)
  }
  private spend(count: number) {
    const now = Date.now()
    this.tokens = Math.min(DESKTOP_LIMITS.eventsPerSecond, this.tokens + ((now - this.refilled) * DESKTOP_LIMITS.eventsPerSecond) / 1000)
    this.refilled = now
    if (count > this.tokens) throw runtimeError('INPUT_RATE_LIMITED', 'Too many input events; resynchronize before continuing')
    this.tokens -= count
  }
  /** Applies one ordered, validated batch; serialized so events never interleave. */
  apply(raw: DesktopInput[]): Promise<number> {
    const events = desktopInputBatchSchema.parse(raw)
    const run = this.queue.then(() => this.applyNow(events))
    this.queue = run.catch(() => {})
    return run
  }
  private async applyNow(events: DesktopInput[]) {
    this.spend(events.reduce((sum, event) => sum + (event.kind === 'text' ? [...event.text].length : 1), 0))
    await this.mapping()
    for (const event of events) {
      if (event.kind === 'pointer') this.point(event.x, event.y)
      else if (event.kind === 'button') {
        this.point(event.x, event.y)
        const button = BUTTON[event.button]
        if (event.down) {
          this.buttons.add(button)
          this.x.fakeInput(X_EVENT.buttonPress, button)
        } else if (this.buttons.delete(button)) this.x.fakeInput(X_EVENT.buttonRelease, button)
      } else if (event.kind === 'wheel') {
        this.point(event.x, event.y)
        const steps: [number, number][] = [
          [event.deltaY > 0 ? 5 : 4, Math.abs(event.deltaY)],
          [event.deltaX > 0 ? 7 : 6, Math.abs(event.deltaX)],
        ]
        for (const [button, count] of steps)
          for (let step = 0; step < count; step++) {
            this.x.fakeInput(X_EVENT.buttonPress, button)
            this.x.fakeInput(X_EVENT.buttonRelease, button)
          }
      } else if (event.kind === 'key') {
        if (event.down) {
          const previous = this.pressedCodes.get(event.code)
          const target = previous !== undefined ? { keycode: previous, column: 0 } : (this.lookup(event.keysym) ?? (await this.bind(event.keysym)))
          if (previous === undefined) this.press(target, event.keysym)
          else this.x.fakeInput(X_EVENT.keyPress, previous)
          this.pressedCodes.set(event.code, target.keycode)
        } else {
          const keycode = this.pressedCodes.get(event.code)
          if (keycode === undefined) continue
          this.pressedCodes.delete(event.code)
          this.x.fakeInput(X_EVENT.keyRelease, keycode)
        }
      } else if (event.kind === 'text') {
        for (const character of event.text) {
          const keysym = keysymFor(character.codePointAt(0)!)
          const target = this.lookup(keysym) ?? (await this.bind(keysym))
          this.press(target, keysym)
          this.x.fakeInput(X_EVENT.keyRelease, target.keycode)
        }
      } else this.releaseNow()
    }
    await this.x.sync()
    return events.length
  }
  private releaseNow() {
    for (const keycode of this.pressedCodes.values()) this.x.fakeInput(X_EVENT.keyRelease, keycode)
    this.pressedCodes.clear()
    for (const button of this.buttons) this.x.fakeInput(X_EVENT.buttonRelease, button)
    this.buttons.clear()
  }
  /** Releases every key and button this controller pressed; safe to call repeatedly. */
  releaseAll(): Promise<void> {
    const run = this.queue.then(async () => {
      if (!this.x.alive) return
      this.releaseNow()
      await this.x.sync()
    })
    this.queue = run.catch(() => {})
    return run
  }
}
