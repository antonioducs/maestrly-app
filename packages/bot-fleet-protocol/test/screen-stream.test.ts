import { describe, expect, it } from 'vitest'
import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  ScreenProtocolError,
  containsIdr,
  decodeClientMessage,
  decodeServerMessage,
  encodeAck,
  encodeClipboard,
  encodeClipboardInput,
  encodeCursor,
  encodeFrame,
  encodeHello,
  encodeKey,
  encodeKeyframeRequest,
  encodePointerInput,
  encodeScreenMessage,
  encodeWheel,
  h264CodecString,
} from '../src/index.js'

const bytes = (values: number[]) => Uint8Array.from(values)
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

const decodeOne = (message: Uint8Array) =>
  decodeClientMessage(new ScreenMessageReader(SCREEN_LIMITS.clientPayloadMax).push(message)[0])

describe('screen stream', () => {
  it('reassembles messages split at every byte', () => {
    const frame = bytes([0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x65, 9])
    const stream = concat([
      encodeHello({ version: 1, width: 1280, height: 800, mode: 'control' }),
      encodeFrame(7, true, frame),
      encodeCursor(4, 8, PNG),
      encodeClipboard('ação ✓'),
    ])
    for (let i = 1; i < stream.byteLength; i++) {
      const reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
      const events = [...reader.push(stream.slice(0, i)), ...reader.push(stream.slice(i))].map(decodeServerMessage)
      expect(events).toEqual([
        { type: 'hello', hello: { version: 1, width: 1280, height: 800, mode: 'control' } },
        { type: 'frame', id: 7, key: true, data: frame },
        { type: 'cursor', hotX: 4, hotY: 8, png: PNG },
        { type: 'clipboard', tooLarge: false, text: 'ação ✓' },
      ])
    }
  })

  it('rejects a payload over the limit before buffering it', () => {
    const reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
    expect(() => reader.push(bytes([0x02, 0x01, 0x00, 0x00, 0x01]))).toThrow(ScreenProtocolError)
  })

  it('round-trips every client message', () => {
    expect(decodeOne(encodeAck(4294967295))).toEqual({ type: 'ack', id: 4294967295 })
    expect(decodeOne(encodeKeyframeRequest())).toEqual({ type: 'keyframe' })
    expect(decodeOne(encodePointerInput(1279, 799, 5))).toEqual({ type: 'pointer', x: 1279, y: 799, buttons: 5 })
    expect(decodeOne(encodeWheel(-2, 3))).toEqual({ type: 'wheel', dx: -2, dy: 3 })
    expect(decodeOne(encodeKey(0xffe1, true))).toEqual({ type: 'key', keysym: 0xffe1, down: true })
    expect(decodeOne(encodeKey(0x61, false))).toEqual({ type: 'key', keysym: 0x61, down: false })
    expect(decodeOne(encodeClipboardInput('olá 🚀'))).toEqual({ type: 'clipboard', text: 'olá 🚀' })
  })

  it('rejects malformed client messages', () => {
    const malformed = [
      { type: 0x7f, payload: new Uint8Array(0) },
      { type: 0x41, payload: bytes([0, 0, 1]) },
      { type: 0x43, payload: bytes([0, 1, 0, 1]) },
      { type: 0x46, payload: bytes([0xff]) },
    ]
    for (const message of malformed) expect(() => decodeClientMessage(message)).toThrow(ScreenProtocolError)
  })

  it('refuses clipboard text over 1 MiB', () => {
    expect(() => encodeClipboardInput('a'.repeat(1024 * 1024 + 1))).toThrow(ScreenProtocolError)
    const reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
    expect(decodeServerMessage(reader.push(encodeClipboard(null))[0])).toEqual({
      type: 'clipboard',
      tooLarge: true,
      text: '',
    })
    expect(decodeServerMessage(reader.push(encodeClipboard('a'.repeat(1024 * 1024 + 1)))[0])).toEqual({
      type: 'clipboard',
      tooLarge: true,
      text: '',
    })
  })

  it('rejects a bad hello', () => {
    const hello = (value: unknown) =>
      decodeServerMessage({ type: 0x01, payload: new TextEncoder().encode(JSON.stringify(value)) })
    expect(() => hello({ version: 2, width: 1280, height: 800, mode: 'view' })).toThrow(ScreenProtocolError)
    expect(() => hello({ version: 1, width: 0, height: 800, mode: 'view' })).toThrow(ScreenProtocolError)
    expect(() => hello({ version: 1, width: 1280, height: 800, mode: 'x' })).toThrow(ScreenProtocolError)
    expect(() => decodeServerMessage({ type: 0x01, payload: bytes([0x7b]) })).toThrow(ScreenProtocolError)
  })

  it('reads the codec and key frames from access units', () => {
    expect(h264CodecString(bytes([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 1]))).toBe('avc1.640028')
    expect(h264CodecString(bytes([0, 0, 1, 0x65, 1, 2, 3]))).toBeNull()
    expect(containsIdr(bytes([0, 0, 1, 0x65]))).toBe(true)
    expect(containsIdr(bytes([0, 0, 1, 0x41]))).toBe(false)
  })

  it('frames a message as a type byte and a big-endian length', () => {
    expect([...encodeScreenMessage(0x42)]).toEqual([0x42, 0, 0, 0, 0])
    expect([...encodeScreenMessage(0x41, bytes([9, 8]))]).toEqual([0x41, 0, 0, 0, 2, 9, 8])
  })
})
