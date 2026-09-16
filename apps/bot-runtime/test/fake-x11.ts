import { X_EVENT } from '../src/desktop/x11.js'

/** In-memory X server keyboard map and XTEST recorder for input unit tests. */
export class FakeX11 {
  width = 1280
  height = 800
  minKeycode = 8
  maxKeycode = 20
  alive = true
  events: string[] = []
  perKeycode = 2
  keysyms: number[] = []
  private listeners = new Set<() => void>()
  constructor() {
    const rows: Record<number, [number, number]> = {
      10: [0x61, 0x41], // a A
      11: [0x31, 0x21], // 1 !
      12: [0xffe1, 0], // Shift_L
      13: [0xff0d, 0], // Return
      14: [0x20, 0], // space
    }
    for (let keycode = this.minKeycode; keycode <= this.maxKeycode; keycode++) this.keysyms.push(...(rows[keycode] ?? [0, 0]))
  }
  onMappingChanged(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async keyboardMapping() {
    return { perKeycode: this.perKeycode, keysyms: [...this.keysyms] }
  }
  changeKeyboardMapping(keycode: number, perKeycode: number, row: number[]) {
    row.slice(0, perKeycode).forEach((keysym, column) => {
      this.keysyms[(keycode - this.minKeycode) * perKeycode + column] = keysym
    })
    this.events.push(`map:${keycode}:${row[0].toString(16)}`)
  }
  fakeInput(type: number, detail: number, x = 0, y = 0) {
    const name = { [X_EVENT.keyPress]: 'press', [X_EVENT.keyRelease]: 'release', [X_EVENT.buttonPress]: 'down', [X_EVENT.buttonRelease]: 'up', [X_EVENT.motion]: 'move' }[type]
    this.events.push(type === X_EVENT.motion ? `move:${x},${y}` : `${name}:${detail}`)
  }
  async sync() {}
  released() {
    return this.events.flatMap((event) => {
      const [kind, value] = event.split(':')
      return kind === 'release' ? [`key:${value}`] : kind === 'up' ? [`button:${value}`] : []
    })
  }
  close() {
    this.alive = false
  }
}
