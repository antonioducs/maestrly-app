declare module '@novnc/novnc/core/input/keyboard.js' {
  /** Turns a target's key events into X keysyms while grabbed, with noVNC's Mac and Windows fixes. */
  export default class Keyboard {
    constructor(target: Element)
    onkeyevent: (keysym: number, code: string, down: boolean) => void
    grab(): void
    ungrab(): void
  }
}
