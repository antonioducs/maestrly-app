import { describe, expect, it } from 'vitest'
import {
  ScreenMessageReader,
  ScreenStreamCore,
  decodeClientMessage,
  encodeClipboard,
  encodeCursor,
  encodeFrame,
  encodeHello,
  encodePointer,
  type ScreenCoreSink,
} from '../src/index.js'

const KEY = Uint8Array.of(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 1, 0, 0, 1, 0x65, 9)
const DELTA = Uint8Array.of(0, 0, 1, 0x41, 7)

function setup() {
  const sent: Uint8Array[] = []
  const calls: [string, ...unknown[]][] = []
  const sink: ScreenCoreSink = {
    hello: (hello) => void calls.push(['hello', hello]),
    decode: (frame) => void calls.push(['decode', frame.id, frame.key, frame.codec]),
    cursor: (hotX, hotY, png) => void calls.push(['cursor', hotX, hotY, png.byteLength]),
    pointer: (x, y) => void calls.push(['pointer', x, y]),
    clipboard: (text) => void calls.push(['clipboard', text]),
    protocolError: (error) => void calls.push(['protocolError', error.message]),
  }
  const core = new ScreenStreamCore((bytes) => sent.push(bytes), sink)
  const sentMessages = () => {
    const reader = new ScreenMessageReader(1024 * 1024)
    return sent.flatMap((bytes) => reader.push(bytes)).map(decodeClientMessage)
  }
  return { core, sent, calls, sentMessages }
}

describe('screen stream core', () => {
  it('reads messages split anywhere', () => {
    const { core, calls } = setup()
    const stream = new Uint8Array([
      ...encodeHello({ version: 1, width: 640, height: 480, mode: 'view' }),
      ...encodeCursor(1, 2, Uint8Array.of(9, 9)),
      ...encodePointer(-1, -1),
      ...encodeFrame(3, true, KEY),
    ])
    for (const byte of stream) core.receive(Uint8Array.of(byte))
    expect(calls).toEqual([
      ['hello', { version: 1, width: 640, height: 480, mode: 'view' }],
      ['cursor', 1, 2, 2],
      ['pointer', -1, -1],
      ['decode', 3, true, 'avc1.640028'],
    ])
  })

  it('withholds and acknowledges delta frames until a key frame, then decodes with its codec', () => {
    const { core, calls, sentMessages } = setup()
    core.receive(encodeFrame(1, false, DELTA))
    expect(calls).toEqual([])
    // A dropped frame is acknowledged, so the screen never counts it as still in flight.
    expect(sentMessages()).toEqual([{ type: 'ack', id: 1 }])
    core.receive(encodeFrame(2, true, KEY))
    core.receive(encodeFrame(3, false, DELTA))
    expect(calls).toEqual([
      ['decode', 2, true, 'avc1.640028'],
      ['decode', 3, false, 'avc1.640028'],
    ])
  })

  it('asks for a key frame after a decoder failure and drops deltas until one comes', () => {
    const { core, calls, sent, sentMessages } = setup()
    core.receive(encodeFrame(1, true, KEY))
    sent.length = 0
    core.decoderFailed()
    expect(Buffer.from(sent[0]).toString('hex')).toBe('4200000000')
    core.receive(encodeFrame(2, false, DELTA))
    expect(calls.filter(([name]) => name === 'decode')).toHaveLength(1)
    expect(sentMessages()).toEqual([{ type: 'keyframe' }, { type: 'ack', id: 2 }])
    core.receive(encodeFrame(3, true, KEY))
    expect(calls.at(-1)).toEqual(['decode', 3, true, 'avc1.640028'])
  })

  it('asks for a key frame when a key frame names no codec', () => {
    const { core, calls, sentMessages } = setup()
    core.receive(encodeFrame(1, true, Uint8Array.of(0, 0, 1, 0x65, 1)))
    expect(calls).toEqual([])
    expect(sentMessages()).toEqual([{ type: 'ack', id: 1 }, { type: 'keyframe' }])
  })

  it('acknowledges decoded frames and sends input', () => {
    const { core, sentMessages } = setup()
    core.decoded(9)
    core.pointer(10, 20, 1)
    core.wheel(0, -2)
    core.key(0x61, true)
    core.clipboard('ação ✓')
    expect(sentMessages()).toEqual([
      { type: 'ack', id: 9 },
      { type: 'pointer', x: 10, y: 20, buttons: 1 },
      { type: 'wheel', dx: 0, dy: -2 },
      { type: 'key', keysym: 0x61, down: true },
      { type: 'clipboard', text: 'ação ✓' },
    ])
    expect(() => core.clipboard('a'.repeat(1024 * 1024 + 1))).toThrow()
  })

  it("passes the screen's clipboard on, and a clipboard too large to send as null", () => {
    const { core, calls } = setup()
    core.receive(encodeClipboard('copiado'))
    core.receive(encodeClipboard(null))
    expect(calls).toEqual([
      ['clipboard', 'copiado'],
      ['clipboard', null],
    ])
  })

  it('reports a broken stream once and reads nothing after it', () => {
    const { core, calls } = setup()
    core.receive(Uint8Array.of(0x7f, 0, 0, 0, 0))
    core.receive(encodeHello({ version: 1, width: 640, height: 480, mode: 'view' }))
    expect(calls).toEqual([['protocolError', 'Unknown screen message 127.']])
  })
})
