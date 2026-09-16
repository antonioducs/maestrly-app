import { Duplex } from 'node:stream'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { MEDIA_FRAME, MEDIA_HEADER_BYTES, MEDIA_INITIAL_CREDIT, MEDIA_PAYLOAD_MAX } from '@maestrly/host-protocol'
import { encodeMediaFrame, MediaFrameDecoder, MediaMux, type MediaStream } from '../src/index.js'

const muxes: MediaMux[] = []
afterEach(() => {
  for (const mux of muxes.splice(0)) mux.destroy()
})
function pipePair() {
  const a = new Duplex({ read() {}, write(bytes, _e, cb) { queueMicrotask(() => { if (!z.destroyed) z.push(Buffer.from(bytes)); cb() }) } })
  const z = new Duplex({ read() {}, write(bytes, _e, cb) { queueMicrotask(() => { if (!a.destroyed) a.push(Buffer.from(bytes)); cb() }) } })
  a.on('close', () => z.destroy())
  z.on('close', () => a.destroy())
  return { a, z }
}
function lane(options: { stallMs?: number; accept?: (stream: MediaStream, payload: unknown) => void } = {}) {
  const { a, z } = pipePair()
  const host = new MediaMux(a, 'host', { stallMs: options.stallMs })
  const guest = new MediaMux(z, 'guest', { stallMs: options.stallMs })
  muxes.push(host, guest)
  guest.on('open', (stream: MediaStream, payload: unknown) => (options.accept ? options.accept(stream, payload) : stream.accept()))
  return { host, guest, a, z }
}
const closed = (stream: MediaStream) => new Promise<void>((resolve) => (stream.destroyed ? resolve() : stream.once('close', () => resolve())))
const frame = (type: number, streamId: number, sequence: number, payload = Buffer.alloc(0)) =>
  encodeMediaFrame({ type: type as never, streamId, sequence, payload })

it('round-trips frames delivered one byte at a time', () => {
  const decoder = new MediaFrameDecoder()
  const bytes = Buffer.concat([
    frame(MEDIA_FRAME.hello, 0, 0, Buffer.from('{"a":1}')),
    frame(MEDIA_FRAME.data, 3, 7, Buffer.alloc(MEDIA_PAYLOAD_MAX, 9)),
    frame(MEDIA_FRAME.close, 3, 8, Buffer.from('STALLED')),
  ])
  const frames = []
  for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])))
  expect(frames.map((f) => [f.type, f.streamId, f.sequence, f.payload.length])).toEqual([
    [MEDIA_FRAME.hello, 0, 0, 7],
    [MEDIA_FRAME.data, 3, 7, MEDIA_PAYLOAD_MAX],
    [MEDIA_FRAME.close, 3, 8, 7],
  ])
  expect(decoder.pending).toBe(0)
})
it('rejects corrupt magic, reserved bits, unknown types, lying lengths and invalid control payloads before buffering', () => {
  const good = frame(MEDIA_FRAME.data, 1, 0, Buffer.from('x'))
  const cases: Buffer[] = []
  const magic = Buffer.from(good); magic[0] = 0x58; cases.push(magic)
  const reserved = Buffer.from(good); reserved[6] = 1; cases.push(reserved)
  const type = Buffer.from(good); type[4] = 99; cases.push(type)
  const lying = Buffer.from(good.subarray(0, MEDIA_HEADER_BYTES)); lying.writeUInt32BE(MEDIA_PAYLOAD_MAX + 1, 16); cases.push(lying)
  const credit = Buffer.from(frame(MEDIA_FRAME.credit, 1, 0, Buffer.from([0, 0, 0, 1]))); credit.writeUInt32BE(0, MEDIA_HEADER_BYTES); cases.push(credit)
  const bigControl = Buffer.from(frame(MEDIA_FRAME.open, 1, 0, Buffer.from('{}'))); bigControl.writeUInt32BE(4096, 16); cases.push(bigControl)
  const dataOnZero = Buffer.from(good); dataOnZero.writeUInt32BE(0, 8); cases.push(dataOnZero)
  for (const bytes of cases) expect(() => new MediaFrameDecoder().push(bytes)).toThrow()
  expect(() => encodeMediaFrame({ type: MEDIA_FRAME.close, streamId: 1, sequence: 0, payload: Buffer.from('lower') })).toThrow()
})
it('carries large payloads intact in both directions through credit-bounded streams', async () => {
  const { host } = lane({
    accept: (stream) => {
      stream.accept()
      stream.on('data', (bytes) => stream.write(bytes))
      stream.on('end', () => stream.end())
    },
  })
  const stream = await host.open({ grant: 1 })
  const expected = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < expected.length; i++) expected[i] = (i * 31) & 0xff
  const received: Buffer[] = []
  stream.on('data', (bytes) => received.push(bytes))
  const ended = once(stream, 'end')
  stream.end(expected)
  await ended
  expect(Buffer.concat(received).equals(expected)).toBe(true)
})
it('a stalled viewer is bounded by credit, does not starve a sibling, and is closed by the watchdog', async () => {
  const accepted: MediaStream[] = []
  const { host } = lane({ stallMs: 150, accept: (stream) => { stream.accept(); accepted.push(stream) } })
  const slow = await host.open({ viewer: 'slow' })
  const fast = await host.open({ viewer: 'fast' })
  slow.pause()
  accepted[0].write(Buffer.alloc(2 * 1024 * 1024, 1))
  accepted[1].on('data', (bytes) => accepted[1].write(bytes))
  const reply = once(fast, 'data')
  fast.write('still responsive')
  expect(String((await reply)[0])).toBe('still responsive')
  expect(slow.readableLength).toBeLessThanOrEqual(MEDIA_INITIAL_CREDIT)
  expect(accepted[0].sendCredit).toBe(0)
  await closed(accepted[0])
  expect(accepted[0].destroyed).toBe(true)
  expect(fast.destroyed).toBe(false)
})
it('refusal codes reach the opener and the guest never accepts opens it did not validate', async () => {
  const { host } = lane({ accept: (stream, payload) => ((payload as { grant?: string }).grant === 'ok' ? stream.accept() : stream.refuse('GRANT_INVALID')) })
  await expect(host.open({ grant: 'forged' })).rejects.toMatchObject({ code: 'GRANT_INVALID' })
  const stream = await host.open({ grant: 'ok' })
  expect(stream.accepted).toBe(true)
})
it('closes only the stream that violates credit or sequence; the lane and siblings survive', async () => {
  const accepted: MediaStream[] = []
  const { host, a } = lane({ accept: (stream) => { stream.accept(); accepted.push(stream) } })
  const one = await host.open({ n: 1 })
  const two = await host.open({ n: 2 })
  const twoClosed = closed(two)
  // Guest-side forgery: a DATA frame with a sequence gap on stream 2.
  a.push(frame(MEDIA_FRAME.data, two.id, 42, Buffer.from('forged')))
  await twoClosed
  expect(two.destroyed).toBe(true)
  expect(host.alive).toBe(true)
  const echo = once(one, 'data')
  accepted[0].write('alive')
  expect(String((await echo)[0])).toBe('alive')
  // Credit abuse: more than the window without acknowledgements.
  const three = await host.open({ n: 3 })
  three.pause()
  const abused = closed(three)
  let sequence = 1
  for (let sent = 0; sent <= MEDIA_INITIAL_CREDIT; sent += MEDIA_PAYLOAD_MAX) a.push(frame(MEDIA_FRAME.data, three.id, sequence++, Buffer.alloc(MEDIA_PAYLOAD_MAX)))
  await abused
  expect(host.alive).toBe(true)
})
it('a malformed frame destroys the whole lane instead of handing garbage to RFB parsers', async () => {
  const { host, a } = lane()
  const stream = await host.open({})
  const laneClosed = once(host, 'close')
  a.push(Buffer.from('GET / HTTP/1.1\r\nHost: evil\r\n\r\n'))
  await laneClosed
  expect(host.alive).toBe(false)
  expect(stream.destroyed).toBe(true)
})
it('enforces stream limits, role rules and handshake direction', async () => {
  const { host, guest } = lane()
  const hello = once(host, 'hello')
  guest.hello({ protocol: 'bot.desktop.v1' })
  expect((await hello)[0]).toEqual({ protocol: 'bot.desktop.v1' })
  await expect(guest.open({})).rejects.toThrow()
  expect(() => host.hello({})).toThrow()
  const streams = []
  for (let i = 0; i < 8; i++) streams.push(await host.open({ i }))
  await expect(host.open({ i: 9 })).rejects.toMatchObject({ code: 'VIEWER_LIMIT' })
})
