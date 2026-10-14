import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  type EncoderEvent,
  type EncoderProcess,
  ScreenEncoder,
  type ScreenLevel,
} from '../../src/main/fleet/instance/screen-encoder'

function message(type: number, payload: Uint8Array | number[] = []): Buffer {
  const body = Buffer.from(payload)
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
function framePayload(id: number, ref: number, flags: number, data: number[]): Buffer {
  const head = Buffer.alloc(9)
  head.writeUInt32BE(id, 0)
  head.writeInt32BE(ref, 4)
  head[8] = flags
  return Buffer.concat([head, Buffer.from(data)])
}
function cursorPayload(hotX: number, hotY: number, png: number[]): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(hotX, 0)
  head.writeUInt16BE(hotY, 2)
  return Buffer.concat([head, Buffer.from(png)])
}
function pointerPayload(x: number, y: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeInt32BE(x, 0)
  out.writeInt32BE(y, 4)
  return out
}
const READY = message(0x01, json({ width: 1280, height: 800, capture: 'XShm', encoder: 'x264' }))

function setup() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn()
  const child: EncoderProcess = { stdin, stdout, stderr, exited: new Promise(() => undefined), kill }
  const events: EncoderEvent[] = []
  const logs: string[] = []
  const encoder = new ScreenEncoder(
    child,
    (event) => events.push(event),
    (text) => logs.push(text)
  )
  const written = () => {
    const chunks: Buffer[] = []
    for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }
  return { stdin, stdout, stderr, kill, events, logs, encoder, written }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('ScreenEncoder', () => {
  it('emits ready, frames, cursors, pointer, clipboard and log across chunk splits', async () => {
    const { stdout, events } = setup()
    const stream = Buffer.concat([
      READY,
      message(0x02, framePayload(9, -2, 1, [0, 0, 1, 0x65, 7])),
      message(0x03, cursorPayload(4, 8, [0x89, 0x50, 0x4e, 0x47])),
      message(0x04, pointerPayload(-1, -1)),
      message(0x05, [1]),
      message(0x05, Buffer.concat([Buffer.from([0]), Buffer.from('ação ✓')])),
      message(0x06, Buffer.from('capture started')),
    ])
    for (const byte of stream) stdout.write(Buffer.from([byte]))
    await settle()
    expect(events).toEqual([
      { type: 'ready', width: 1280, height: 800, capture: 'XShm', encoder: 'x264' },
      { type: 'frame', id: 9, ref: -2, key: true, data: Uint8Array.from([0, 0, 1, 0x65, 7]) },
      { type: 'cursor', hotX: 4, hotY: 8, png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
      { type: 'pointer', x: -1, y: -1 },
      { type: 'clipboard', tooLarge: true, text: '' },
      { type: 'clipboard', tooLarge: false, text: 'ação ✓' },
      { type: 'log', text: 'capture started' },
    ])
  })

  it('ignores frames before ready, and holds what else came first until then', async () => {
    const { stdout, events } = setup()
    stdout.write(message(0x02, framePayload(1, -1, 1, [0, 0, 1, 0x65])))
    stdout.write(message(0x03, cursorPayload(1, 2, [0x89])))
    await settle()
    expect(events).toEqual([])
    stdout.write(READY)
    await settle()
    expect(events.map((event) => event.type)).toEqual(['ready', 'cursor'])
  })

  it('encodes each command', () => {
    const { encoder, written } = setup()
    const hex = () => written().toString('hex')
    encoder.keyframe()
    expect(hex()).toBe('8100000000')
    encoder.invalidate(7)
    expect(hex()).toBe('820000000400000007')
    encoder.pointer(1, 2, 5)
    expect(hex()).toBe('84000000050001000205')
    encoder.wheel(-1, 2)
    expect(hex()).toBe('8500000004ffff0002')
    encoder.key(0x41, true)
    expect(hex()).toBe('86000000050000004101')
    encoder.clipboard('ç')
    expect(hex()).toBe('8700000002c3a7')
    encoder.watch({ pointer: true, clipboard: true })
    expect(hex()).toBe('880000000103')
    encoder.watch({ pointer: false, clipboard: true })
    expect(hex()).toBe('880000000102')
    encoder.release()
    expect(hex()).toBe('8900000000')
    const level: ScreenLevel = { crf: 30, fps: 30, paintoverCrf: 18, paintoverBurst: 3 }
    encoder.tune(level)
    const tune = written()
    expect(tune[0]).toBe(0x83)
    expect(JSON.parse(tune.subarray(5).toString('utf8'))).toEqual(level)
    expect(tune.readUInt32BE(1)).toBe(tune.length - 5)
  })

  it('kills an encoder that sends a malformed stream', async () => {
    const { stdout, kill, logs, events } = setup()
    stdout.write(READY)
    stdout.write(Buffer.from([0x02, 0x01, 0x00, 0x00, 0x01]))
    await settle()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(logs.some((line) => line.includes('Screen encoder sent an invalid message'))).toBe(true)
    // Nothing after the bad message is read.
    stdout.write(message(0x04, pointerPayload(1, 1)))
    await settle()
    expect(events.map((event) => event.type)).toEqual(['ready'])
  })

  it('kills an encoder that sends an unknown message or a bad ready', async () => {
    for (const bad of [message(0x7f), message(0x01, json({ width: 0, height: 800 })), message(0x04, [1, 2])]) {
      const { stdout, kill } = setup()
      if (bad[0] !== 0x01) stdout.write(READY)
      stdout.write(bad)
      await settle()
      expect(kill).toHaveBeenCalledWith('SIGTERM')
    }
  })

  it('logs stderr lines', async () => {
    const { stderr, logs } = setup()
    stderr.write('[X11] Enc')
    stderr.write('oder\n' + 'x'.repeat(600) + '\n')
    await settle()
    expect(logs[0]).toBe('Screen encoder: [X11] Encoder')
    expect(logs[1]).toBe('Screen encoder: ' + 'x'.repeat(500))
  })

  it('stop() ends stdin, and a broken pipe neither throws nor writes', () => {
    const { stdin, encoder } = setup()
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    encoder.stop()
    expect(stdin.writableEnded).toBe(true)
    expect(() => encoder.keyframe()).not.toThrow()
  })
})
