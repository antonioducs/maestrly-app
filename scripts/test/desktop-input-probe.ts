// Linux-only probe for the XTEST human input path against a real X server. Bundled by
// scripts/verify-bot-desktop.mjs and executed inside a disposable Ubuntu container.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { X11Connection } from '../../apps/bot-runtime/src/desktop/x11.js'
import { HumanInput } from '../../apps/bot-runtime/src/desktop/human-input.js'

const sh = (command: string) => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const typedFile = process.argv[2] ?? '/tmp/typed.txt'
export async function probeInput() {
  const x = await X11Connection.open({ display: process.env.DISPLAY ?? ':10', xauthority: process.env.XAUTHORITY })
  const input = new HumanInput(x)
  const report: Record<string, unknown> = { width: x.width, height: x.height }
  // Pointer: absolute framebuffer coordinates.
  await input.apply([{ kind: 'pointer', x: 400, y: 300 }])
  report.pointer = await x.pointer()
  await input.apply([{ kind: 'pointer', x: 1279, y: 799 }])
  report.corner = await x.pointer()
  try {
    await input.apply([{ kind: 'pointer', x: 1280, y: 10 }])
    report.outOfBounds = 'accepted'
  } catch (error) {
    report.outOfBounds = (error as { code?: string }).code
  }
  // Keyboard into the focused terminal: ASCII, Shift, accents, € and IME-like text.
  sh('xdotool search --class xterm windowfocus')
  await sleep(200)
  const key = (code: string, keysym: number, down: boolean) => ({ kind: 'key' as const, code, keysym, down })
  await input.apply([
    key('KeyO', 0x6f, true), key('KeyO', 0x6f, false),
    key('ShiftLeft', 0xffe1, true), key('KeyK', 0x4b, true), key('KeyK', 0x4b, false), key('ShiftLeft', 0xffe1, false),
    { kind: 'text', text: ' ação çé €' },
    key('Enter', 0xff0d, true), key('Enter', 0xff0d, false),
  ])
  await sleep(400)
  report.typed = readFileSync(typedFile, 'utf8')
  // A key left down is released by releaseAll (blur, disconnect, expiry, return).
  await input.apply([key('KeyZ', 0x7a, true)])
  report.pressedBeforeRelease = input.pressed
  await input.releaseAll()
  report.pressedAfterRelease = input.pressed
  // Buttons and wheel keep working with the pointer moved inside bounds.
  await input.apply([
    { kind: 'button', button: 'left', down: true, x: 50, y: 50 },
    { kind: 'pointer', x: 80, y: 60 },
    { kind: 'button', button: 'left', down: false, x: 80, y: 60 },
    { kind: 'wheel', x: 80, y: 60, deltaX: 0, deltaY: 2 },
  ])
  report.afterDrag = await x.pointer()
  const clipboard = await x.internAtom('CLIPBOARD')
  report.clipboardOwner = await x.selectionOwner(clipboard)
  x.close()
  return report
}
const result = await probeInput()
process.stdout.write(`${JSON.stringify(result)}\n`)
