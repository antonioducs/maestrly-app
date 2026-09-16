import { expect, it } from 'vitest'
import { HumanInput, keysymFor } from '../src/desktop/human-input.js'
import type { X11Connection } from '../src/desktop/x11.js'
import { parseXauthority, selectCookie } from '../src/desktop/x11.js'
import { FakeX11 } from './fake-x11.js'

const key = (code: string, keysym: number, down: boolean) => ({ kind: 'key' as const, code, keysym, down })
function fixture() {
  const x = new FakeX11()
  return { x, input: new HumanInput(x as unknown as X11Connection) }
}
it('maps keys through the live keyboard map, adding or lifting Shift only when the level needs it', async () => {
  const { x, input } = fixture()
  await input.apply([key('KeyA', 0x61, true), key('KeyA', 0x61, false)])
  expect(x.events).toEqual(['press:10', 'release:10'])
  x.events.length = 0
  // Uppercase without the person's Shift: wrap the press with Shift.
  await input.apply([key('KeyA', 0x41, true), key('KeyA', 0x41, false)])
  expect(x.events).toEqual(['press:12', 'press:10', 'release:12', 'release:10'])
  x.events.length = 0
  // With Shift held, a shifted symbol goes straight through; an unshifted one lifts Shift briefly.
  await input.apply([key('ShiftLeft', 0xffe1, true), key('Digit1', 0x21, true), key('Digit1', 0x21, false)])
  expect(x.events).toEqual(['press:12', 'press:11', 'release:11'])
  x.events.length = 0
  await input.apply([key('Digit1', 0x31, true), key('Digit1', 0x31, false), key('ShiftLeft', 0xffe1, false)])
  expect(x.events).toEqual(['release:12', 'press:11', 'press:12', 'release:11', 'release:12'])
})
it('types Unicode and accents by binding spare keycodes, never replaying the whole string', async () => {
  const { x, input } = fixture()
  await input.apply([{ kind: 'text', text: 'aç€' }])
  expect(x.events).toEqual(['press:10', 'release:10', 'map:20:e7', 'press:20', 'release:20', 'map:19:10020ac', 'press:19', 'release:19'])
  expect(keysymFor('€'.codePointAt(0)!)).toBe(0x10020ac)
  expect(keysymFor('ç'.codePointAt(0)!)).toBe(0xe7)
})
it('releases every held key and button on releaseAll; stray key-ups are ignored', async () => {
  const { x, input } = fixture()
  await input.apply([key('KeyA', 0x61, true), { kind: 'button', button: 'right', down: true, x: 5, y: 6 }, key('KeyZ', 0x7a, false)])
  expect(input.pressed).toBe(2)
  await input.releaseAll()
  expect(input.pressed).toBe(0)
  expect(x.released()).toEqual(['key:10', 'button:3'])
  await input.releaseAll()
  expect(x.released()).toEqual(['key:10', 'button:3'])
})
it('keeps coordinates inside the framebuffer and maps wheel steps to buttons', async () => {
  const { x, input } = fixture()
  await expect(input.apply([{ kind: 'pointer', x: 1280, y: 0 }])).rejects.toMatchObject({ code: 'INVALID_COORDINATES' })
  await input.apply([{ kind: 'wheel', x: 100, y: 100, deltaX: -1, deltaY: 2 }])
  expect(x.events).toEqual(['move:100,100', 'down:5', 'up:5', 'down:5', 'up:5', 'down:6', 'up:6'])
})
it('rate limits bursts instead of applying a stale backlog later', async () => {
  const { input } = fixture()
  const batch = Array.from({ length: 64 }, (_, i) => ({ kind: 'pointer' as const, x: i, y: i }))
  for (let i = 0; i < 4; i++) await input.apply(batch)
  await expect(input.apply(batch)).rejects.toMatchObject({ code: 'INPUT_RATE_LIMITED' })
})
it('reads the session Xauthority cookie for the exact display', () => {
  const entry = (family: number, address: string, number: string, data: Buffer) => {
    const field = (value: Buffer) => Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value])
    return Buffer.concat([Buffer.from([family >> 8, family & 0xff]), field(Buffer.from(address)), field(Buffer.from(number)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(data)])
  }
  const cookie = Buffer.alloc(16, 7)
  const file = Buffer.concat([entry(256, 'guest', '11', Buffer.alloc(16, 1)), entry(256, 'guest', '10', cookie)])
  const entries = parseXauthority(file)
  expect(selectCookie(entries, '10', 'guest')?.data).toEqual(cookie)
  expect(selectCookie(entries, '12', 'guest')).toBeUndefined()
  expect(() => parseXauthority(file.subarray(0, file.length - 3))).toThrow()
})
