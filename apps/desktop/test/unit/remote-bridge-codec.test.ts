import { describe, expect, it } from 'vitest'
import {
  BridgeFrameError,
  decodeBridgeValue,
  decodeClientFrame,
  decodeHostFrame,
  encodeBridgeFrame,
  encodeBridgeValue,
} from '../../src/main/remote-host/bridge-codec'
import { type BridgeHostFrame, REMOTE_BRIDGE_LIMITS } from '../../src/shared/remote-bridge'

/** What the other side receives: the encoded value through JSON text and back. */
const roundTrip = (value: unknown): unknown => decodeBridgeValue(JSON.parse(JSON.stringify(encodeBridgeValue(value))))

describe('bridge values', () => {
  it('keeps JSON values as they are', () => {
    const value = { a: [1, 'two', true, null, { b: { c: [] } }], d: '', e: 0, f: false, g: null }
    expect(roundTrip(value)).toEqual(value)
  })

  it('carries binary values with their type', () => {
    const bytes = roundTrip(new Uint8Array([1, 2, 250]))
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect([...(bytes as Uint8Array)]).toEqual([1, 2, 250])

    const fromBuffer = roundTrip(Buffer.from([9, 8]))
    expect(fromBuffer).toBeInstanceOf(Uint8Array)
    expect([...(fromBuffer as Uint8Array)]).toEqual([9, 8])

    // A view over part of a larger buffer sends only its own bytes.
    const view = new Uint8Array(new Uint8Array([0, 5, 6, 0]).buffer, 1, 2)
    expect([...(roundTrip(view) as Uint8Array)]).toEqual([5, 6])

    const buffer = roundTrip(new Uint8Array([7, 7, 7]).buffer)
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(buffer as ArrayBuffer)]).toEqual([7, 7, 7])

    const floats = roundTrip(new Float32Array([0.5, -2]))
    expect(floats).toBeInstanceOf(Float32Array)
    expect([...(floats as Float32Array)]).toEqual([0.5, -2])
  })

  it('keeps undefined array entries, so positional IPC arguments do not shift or turn into null', () => {
    const value = roundTrip([1, undefined, 3]) as unknown[]
    expect(value).toHaveLength(3)
    expect(value[1]).toBeUndefined()
    expect(1 in value).toBe(true)
    expect(roundTrip(undefined)).toBeUndefined()
  })

  it('drops object properties that IPC would not carry', () => {
    expect(roundTrip({ a: 1, b: undefined, c: () => 1, d: Symbol('x') })).toEqual({ a: 1 })
  })

  it('does not mistake user data for its own tags', () => {
    for (const value of [{ $bin: 'u8', b64: 'x' }, { $undef: 1 }, { $esc: { a: 1 } }, { list: [{ $undef: 1 }] }])
      expect(roundTrip(value)).toEqual(value)
  })

  it('sends dates as ISO strings and big integers as numbers', () => {
    expect(roundTrip(new Date('2026-09-29T12:00:00.000Z'))).toBe('2026-09-29T12:00:00.000Z')
    expect(roundTrip(12n)).toBe(12)
  })

  it('refuses cycles but allows the same object twice', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encodeBridgeValue(cyclic)).toThrow(BridgeFrameError)
    const shared = { n: 1 }
    expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } })
  })

  it('refuses a binary tag whose bytes do not fit its type', () => {
    expect(() => decodeBridgeValue({ $bin: 'f32', b64: Buffer.from([1, 2, 3]).toString('base64') })).toThrow(
      BridgeFrameError
    )
    expect(() => decodeBridgeValue({ $bin: 'u16', b64: '' })).toThrow(BridgeFrameError)
  })
})

describe('bridge frames', () => {
  it('decodes the arguments of an invoke with their binary values', () => {
    const text = encodeBridgeFrame({ t: 'invoke', id: 1, origin: 3, channel: 'x', args: [new Uint8Array([1, 2]), 'a'] })
    const frame = decodeClientFrame(text)
    expect(frame).toMatchObject({ t: 'invoke', id: 1, origin: 3, channel: 'x' })
    if (frame.t !== 'invoke') throw new Error('unexpected frame')
    expect(frame.args[0]).toBeInstanceOf(Uint8Array)
    expect(frame.args[1]).toBe('a')
  })

  it('refuses unknown or malformed client frames', () => {
    for (const text of ['{"t":"nope"}', 'not json', '{"t":"invoke","id":1,"origin":1,"channel":"","args":[]}', '[]'])
      expect(() => decodeClientFrame(text)).toThrow(BridgeFrameError)
    // A panel origin names its conversation and panel; a main origin names neither.
    expect(() => decodeClientFrame('{"t":"open","origin":1,"role":"panel"}')).toThrow(BridgeFrameError)
    expect(decodeClientFrame('{"t":"open","origin":1,"role":"panel","convId":"c","panel":"terminal"}')).toEqual({
      t: 'open',
      origin: 1,
      role: 'panel',
      convId: 'c',
      panel: 'terminal',
    })
    expect(decodeClientFrame('{"t":"open","origin":1,"role":"main"}')).toEqual({ t: 'open', origin: 1, role: 'main' })
  })

  it('decodes host frames, including a result without a value', () => {
    expect(decodeHostFrame(encodeBridgeFrame({ t: 'result', id: 4, ok: true }))).toEqual({
      t: 'result',
      id: 4,
      ok: true,
    })
    expect(decodeHostFrame(encodeBridgeFrame({ t: 'result', id: 4, ok: true, value: null }))).toEqual({
      t: 'result',
      id: 4,
      ok: true,
      value: null,
    })
    expect(
      decodeHostFrame(
        encodeBridgeFrame({ t: 'result', id: 5, ok: false, error: { message: 'no', code: 'remote-unsupported' } })
      )
    ).toEqual({ t: 'result', id: 5, ok: false, error: { message: 'no', code: 'remote-unsupported' } })
    expect(() => decodeHostFrame('{"t":"hello"}')).toThrow(BridgeFrameError)
  })

  it('refuses to encode a frame above the limit', () => {
    expect(REMOTE_BRIDGE_LIMITS.maxFrameBytes).toBe(64 * 1024 * 1024)
    const frame: BridgeHostFrame = { t: 'event', origin: 1, channel: 'x', args: ['y'.repeat(200)] }
    expect(() => encodeBridgeFrame(frame, 100)).toThrow(BridgeFrameError)
    expect(encodeBridgeFrame(frame, 1_000)).toContain('"event"')
  })
})
