import type { Readable, Writable } from 'node:stream'
import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  ScreenProtocolError,
  encodeScreenMessage,
  type ScreenMessage,
} from '@maestrly/bot-fleet-protocol'

/**
 * The screen encoder of the bot image (deploy/bot-fleet/screen/maestrly-screen-encoder): one process per screen, which
 * captures a region of an X display as H.264 and types the owner's input into it. It talks over stdin and stdout with
 * the framing of the screen stream (a type byte, a big-endian u32 length, the payload).
 */
export const SCREEN_ENCODER_PROGRAM = '/usr/local/bin/maestrly-screen-encoder'

export interface EncoderProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  /** Resolves with the exit code, or `null` when a signal ended the process. */
  exited: Promise<number | null>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

/** The live tunables of a capture: its quality, frame rate and the quality of the paint-over of a still screen. */
export type ScreenLevel = { crf: number; fps: number; paintoverCrf: number; paintoverBurst: number }
/** A level, whether the encoder paints a still screen over, and after how many still frames. */
export type ScreenTuning = ScreenLevel & { paintover: boolean; paintoverAfterFrames: number }

export type EncoderEvent =
  | { type: 'ready'; width: number; height: number; capture: string | null; encoder: string | null }
  /** `ref` is the frame this one predicts from: -1 decodes on its own, -2 is not tracked by the encoder. */
  | { type: 'frame'; id: number; ref: number; key: boolean; data: Uint8Array }
  | { type: 'cursor'; hotX: number; hotY: number; png: Uint8Array }
  /** The pointer relative to the region, or -1, -1 off it. */
  | { type: 'pointer'; x: number; y: number }
  | { type: 'clipboard'; tooLarge: boolean; text: string }
  | { type: 'log'; text: string }

const FROM = { ready: 0x01, frame: 0x02, cursor: 0x03, pointer: 0x04, clipboard: 0x05, log: 0x06 } as const
const TO = {
  keyframe: 0x81,
  invalidate: 0x82,
  tune: 0x83,
  pointer: 0x84,
  wheel: 0x85,
  key: 0x86,
  clipboard: 0x87,
  watch: 0x88,
  release: 0x89,
} as const
const LOG_LINE_MAX = 500
/** Events an encoder may send before it is ready: its first cursor and a few diagnostics. */
const EARLY_MAX = 32
const utf8 = new TextDecoder('utf-8', { fatal: true })
const lenient = new TextDecoder('utf-8')
const encoder = new TextEncoder()

function fields(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
}
function invalid(): never {
  throw new ScreenProtocolError('Invalid screen encoder message.')
}
const side = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

function decode(message: ScreenMessage): EncoderEvent {
  const { type, payload } = message
  switch (type) {
    case FROM.ready: {
      let ready: Record<string, unknown>
      try {
        ready = JSON.parse(utf8.decode(payload)) as Record<string, unknown>
      } catch {
        return invalid()
      }
      if (!ready || !side(ready.width) || !side(ready.height)) return invalid()
      const text = (value: unknown) => (typeof value === 'string' ? value : null)
      return {
        type: 'ready',
        width: ready.width,
        height: ready.height,
        capture: text(ready.capture),
        encoder: text(ready.encoder),
      }
    }
    case FROM.frame: {
      if (payload.byteLength < 10) return invalid()
      const view = fields(payload)
      return {
        type: 'frame',
        id: view.getUint32(0),
        ref: view.getInt32(4),
        key: (payload[8] & 1) === 1,
        data: payload.subarray(9),
      }
    }
    case FROM.cursor: {
      if (payload.byteLength < 4) return invalid()
      const view = fields(payload)
      return { type: 'cursor', hotX: view.getUint16(0), hotY: view.getUint16(2), png: payload.subarray(4) }
    }
    case FROM.pointer: {
      if (payload.byteLength !== 8) return invalid()
      const view = fields(payload)
      return { type: 'pointer', x: view.getInt32(0), y: view.getInt32(4) }
    }
    case FROM.clipboard: {
      if (payload.byteLength < 1) return invalid()
      const tooLarge = (payload[0] & 1) === 1
      if (tooLarge) return { type: 'clipboard', tooLarge, text: '' }
      try {
        return { type: 'clipboard', tooLarge, text: utf8.decode(payload.subarray(1)) }
      } catch {
        return invalid()
      }
    }
    case FROM.log:
      return { type: 'log', text: lenient.decode(payload) }
    default:
      return invalid()
  }
}

/**
 * Reads a screen encoder's events and writes its commands. Frames before the encoder says it is ready are dropped;
 * anything else that comes first (its first cursor) is delivered right after `ready`. A malformed stream ends the
 * encoder: nothing it sends afterwards is read.
 */
export class ScreenEncoder {
  private readonly reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
  private ready = false
  private broken = false
  private early: EncoderEvent[] = []
  private stderrLine = ''

  constructor(
    private readonly child: EncoderProcess,
    private readonly onEvent: (event: EncoderEvent) => void,
    private readonly log: (message: string) => void
  ) {
    // A write to an encoder that already exited fails with EPIPE; its exit is handled by whoever awaits `exited`.
    child.stdin.on('error', () => undefined)
    child.stdout.on('error', () => undefined)
    child.stderr.on('error', () => undefined)
    child.stdout.on('data', (chunk: Uint8Array) => this.receive(chunk))
    child.stderr.on('data', (chunk: Uint8Array) => this.stderr(chunk))
  }

  keyframe(): void {
    this.write(TO.keyframe)
  }
  invalidate(frameId: number): void {
    const payload = new Uint8Array(4)
    fields(payload).setUint32(0, frameId >>> 0)
    this.write(TO.invalidate, payload)
  }
  tune(tuning: ScreenTuning): void {
    const { crf, fps, paintoverCrf, paintoverBurst, paintover, paintoverAfterFrames } = tuning
    const json = JSON.stringify({ crf, fps, paintoverCrf, paintoverBurst, paintover, paintoverAfterFrames })
    this.write(TO.tune, encoder.encode(json))
  }
  pointer(x: number, y: number, buttons: number): void {
    const payload = new Uint8Array(5)
    fields(payload).setUint16(0, x)
    fields(payload).setUint16(2, y)
    payload[4] = buttons & 0b111
    this.write(TO.pointer, payload)
  }
  wheel(dx: number, dy: number): void {
    const payload = new Uint8Array(4)
    fields(payload).setInt16(0, dx)
    fields(payload).setInt16(2, dy)
    this.write(TO.wheel, payload)
  }
  key(keysym: number, down: boolean): void {
    const payload = new Uint8Array(5)
    fields(payload).setUint32(0, keysym >>> 0)
    payload[4] = down ? 1 : 0
    this.write(TO.key, payload)
  }
  clipboard(text: string): void {
    this.write(TO.clipboard, encoder.encode(text))
  }
  watch(flags: { pointer: boolean; clipboard: boolean }): void {
    this.write(TO.watch, Uint8Array.of((flags.pointer ? 1 : 0) | (flags.clipboard ? 2 : 0)))
  }
  release(): void {
    this.write(TO.release)
  }
  /** Closes stdin, which makes the encoder exit; the owner escalates with `kill`. */
  stop(): void {
    if (!this.child.stdin.writableEnded) this.child.stdin.end()
  }

  private write(type: number, payload?: Uint8Array): void {
    const stdin = this.child.stdin
    if (!stdin.writable || stdin.writableEnded || stdin.destroyed) return
    stdin.write(encodeScreenMessage(type, payload))
  }

  private receive(chunk: Uint8Array): void {
    if (this.broken) return
    let events: EncoderEvent[]
    try {
      events = this.reader.push(chunk).map(decode)
    } catch (error) {
      this.broken = true
      const reason = error instanceof Error ? error.message : String(error)
      this.log(`Screen encoder sent an invalid message (${reason}); stopping it.`)
      this.child.kill('SIGTERM')
      return
    }
    for (const event of events) {
      if (event.type === 'ready') {
        if (this.ready) continue
        this.ready = true
        this.onEvent(event)
        const early = this.early
        this.early = []
        for (const held of early) this.onEvent(held)
      } else if (this.ready) this.onEvent(event)
      else if (event.type !== 'frame' && this.early.length < EARLY_MAX) this.early.push(event)
    }
  }

  private stderr(chunk: Uint8Array): void {
    const lines = (this.stderrLine + lenient.decode(chunk)).split('\n')
    this.stderrLine = lines.pop() ?? ''
    if (this.stderrLine.length > LOG_LINE_MAX * 4) this.stderrLine = this.stderrLine.slice(0, LOG_LINE_MAX)
    for (const line of lines) {
      const text = line.trimEnd()
      if (text) this.log(`Screen encoder: ${text.slice(0, LOG_LINE_MAX)}`)
    }
  }
}
