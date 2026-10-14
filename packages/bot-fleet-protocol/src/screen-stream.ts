/**
 * The screen stream between an environment and the app (`maestrly-video`, version 1), whose framing the environment's
 * screen encoder shares. A message is a type byte, a big-endian u32 payload length, then the payload; a stream may
 * arrive split anywhere, so readers reassemble it. See docs/superpowers/specs/2026-10-13-video-screens-design.md.
 */
export const SCREEN_STREAM_VERSION = 1
export const SCREEN_HEADER_BYTES = 5
export const SCREEN_LIMITS = {
  /** The largest message an environment sends; a key frame of a 1280×800 screen stays far below it. */
  serverPayloadMax: 16 * 1024 * 1024,
  /** Clipboard text in UTF-8 bytes, either way. */
  clipboardBytesMax: 1024 * 1024,
  /** The largest message the app sends: clipboard text. */
  clientPayloadMax: 1024 * 1024,
} as const
export const SCREEN_SERVER = { hello: 0x01, frame: 0x02, cursor: 0x03, pointer: 0x04, clipboard: 0x05 } as const
export const SCREEN_CLIENT = {
  ack: 0x41,
  keyframe: 0x42,
  pointer: 0x43,
  wheel: 0x44,
  key: 0x45,
  clipboard: 0x46,
} as const

export type ScreenMode = 'view' | 'control'
export type ScreenHello = { version: 1; width: number; height: number; mode: ScreenMode }
export type ScreenServerEvent =
  | { type: 'hello'; hello: ScreenHello }
  | { type: 'frame'; id: number; key: boolean; data: Uint8Array }
  | { type: 'cursor'; hotX: number; hotY: number; png: Uint8Array }
  | { type: 'pointer'; x: number; y: number }
  | { type: 'clipboard'; tooLarge: boolean; text: string }
export type ScreenClientEvent =
  | { type: 'ack'; id: number }
  | { type: 'keyframe' }
  | { type: 'pointer'; x: number; y: number; buttons: number }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'key'; keysym: number; down: boolean }
  | { type: 'clipboard'; text: string }
export type ScreenMessage = { type: number; payload: Uint8Array }

export class ScreenProtocolError extends Error {}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const EMPTY = new Uint8Array(0)

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
function utf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new ScreenProtocolError('Screen text is not UTF-8.')
  }
}
function expectSize(message: ScreenMessage, size: number): DataView {
  if (message.payload.byteLength !== size)
    throw new ScreenProtocolError(`Screen message ${message.type} has the wrong size.`)
  return view(message.payload)
}

export function encodeScreenMessage(type: number, payload: Uint8Array = EMPTY): Uint8Array {
  const out = new Uint8Array(SCREEN_HEADER_BYTES + payload.byteLength)
  const header = view(out)
  header.setUint8(0, type)
  header.setUint32(1, payload.byteLength)
  out.set(payload, SCREEN_HEADER_BYTES)
  return out
}

/** Reassembles messages from chunks split anywhere. A payload over `maxPayload` throws before it is buffered. */
export class ScreenMessageReader {
  private buffer: Uint8Array = EMPTY
  constructor(private readonly maxPayload: number) {}
  push(chunk: Uint8Array): ScreenMessage[] {
    const data = this.buffer.byteLength ? concat(this.buffer, chunk) : chunk
    const messages: ScreenMessage[] = []
    let offset = 0
    while (data.byteLength - offset >= SCREEN_HEADER_BYTES) {
      const header = new DataView(data.buffer, data.byteOffset + offset, SCREEN_HEADER_BYTES)
      const length = header.getUint32(1)
      if (length > this.maxPayload) throw new ScreenProtocolError(`A screen message of ${length} bytes is too large.`)
      const start = offset + SCREEN_HEADER_BYTES
      if (data.byteLength - start < length) break
      messages.push({ type: header.getUint8(0), payload: data.slice(start, start + length) })
      offset = start + length
    }
    this.buffer = offset === data.byteLength ? EMPTY : data.slice(offset)
    return messages
  }
}

export function encodeHello(hello: ScreenHello): Uint8Array {
  return encodeScreenMessage(SCREEN_SERVER.hello, encoder.encode(JSON.stringify(hello)))
}
export function encodeFrame(id: number, key: boolean, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(5 + data.byteLength)
  view(payload).setUint32(0, id >>> 0)
  payload[4] = key ? 1 : 0
  payload.set(data, 5)
  return encodeScreenMessage(SCREEN_SERVER.frame, payload)
}
export function encodeCursor(hotX: number, hotY: number, png: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + png.byteLength)
  view(payload).setUint16(0, hotX)
  view(payload).setUint16(2, hotY)
  payload.set(png, 4)
  return encodeScreenMessage(SCREEN_SERVER.cursor, payload)
}
export function encodePointer(x: number, y: number): Uint8Array {
  const payload = new Uint8Array(8)
  view(payload).setInt32(0, x)
  view(payload).setInt32(4, y)
  return encodeScreenMessage(SCREEN_SERVER.pointer, payload)
}
/** `null` tells the app the screen's clipboard holds more than the limit, so its copy fails visibly. */
export function encodeClipboard(text: string | null): Uint8Array {
  const bytes = text === null ? EMPTY : encoder.encode(text)
  if (bytes.byteLength > SCREEN_LIMITS.clipboardBytesMax) return encodeClipboard(null)
  return encodeScreenMessage(SCREEN_SERVER.clipboard, concat(new Uint8Array([text === null ? 1 : 0]), bytes))
}

export function decodeServerMessage(message: ScreenMessage): ScreenServerEvent {
  const { type, payload } = message
  if (type === SCREEN_SERVER.hello) {
    let hello: unknown
    try {
      hello = JSON.parse(utf8(payload))
    } catch {
      throw new ScreenProtocolError('Invalid screen hello.')
    }
    const h = (hello ?? {}) as Partial<ScreenHello>
    const side = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 8192
    if (h.version !== 1 || !side(h.width) || !side(h.height) || (h.mode !== 'view' && h.mode !== 'control'))
      throw new ScreenProtocolError('Invalid screen hello.')
    return { type: 'hello', hello: { version: 1, width: h.width!, height: h.height!, mode: h.mode } }
  }
  if (type === SCREEN_SERVER.frame) {
    if (payload.byteLength < 6) throw new ScreenProtocolError('Empty screen frame.')
    return { type: 'frame', id: view(payload).getUint32(0), key: (payload[4] & 1) === 1, data: payload.subarray(5) }
  }
  if (type === SCREEN_SERVER.cursor) {
    if (payload.byteLength < 4) throw new ScreenProtocolError('Invalid screen cursor.')
    return {
      type: 'cursor',
      hotX: view(payload).getUint16(0),
      hotY: view(payload).getUint16(2),
      png: payload.subarray(4),
    }
  }
  if (type === SCREEN_SERVER.pointer) {
    const fields = expectSize(message, 8)
    return { type: 'pointer', x: fields.getInt32(0), y: fields.getInt32(4) }
  }
  if (type === SCREEN_SERVER.clipboard) {
    if (payload.byteLength < 1) throw new ScreenProtocolError('Invalid screen clipboard.')
    const tooLarge = (payload[0] & 1) === 1
    return { type: 'clipboard', tooLarge, text: tooLarge ? '' : utf8(payload.subarray(1)) }
  }
  throw new ScreenProtocolError(`Unknown screen message ${type}.`)
}

export const encodeAck = (id: number): Uint8Array => {
  const payload = new Uint8Array(4)
  view(payload).setUint32(0, id >>> 0)
  return encodeScreenMessage(SCREEN_CLIENT.ack, payload)
}
export const encodeKeyframeRequest = (): Uint8Array => encodeScreenMessage(SCREEN_CLIENT.keyframe)
export function encodePointerInput(x: number, y: number, buttons: number): Uint8Array {
  const payload = new Uint8Array(5)
  view(payload).setUint16(0, x)
  view(payload).setUint16(2, y)
  payload[4] = buttons & 0b111
  return encodeScreenMessage(SCREEN_CLIENT.pointer, payload)
}
export function encodeWheel(dx: number, dy: number): Uint8Array {
  const payload = new Uint8Array(4)
  view(payload).setInt16(0, dx)
  view(payload).setInt16(2, dy)
  return encodeScreenMessage(SCREEN_CLIENT.wheel, payload)
}
export function encodeKey(keysym: number, down: boolean): Uint8Array {
  const payload = new Uint8Array(5)
  view(payload).setUint32(0, keysym >>> 0)
  payload[4] = down ? 1 : 0
  return encodeScreenMessage(SCREEN_CLIENT.key, payload)
}
export function encodeClipboardInput(text: string): Uint8Array {
  const bytes = encoder.encode(text)
  if (bytes.byteLength > SCREEN_LIMITS.clipboardBytesMax) throw new ScreenProtocolError('Clipboard text is too large.')
  return encodeScreenMessage(SCREEN_CLIENT.clipboard, bytes)
}

export function decodeClientMessage(message: ScreenMessage): ScreenClientEvent {
  switch (message.type) {
    case SCREEN_CLIENT.ack:
      return { type: 'ack', id: expectSize(message, 4).getUint32(0) }
    case SCREEN_CLIENT.keyframe:
      expectSize(message, 0)
      return { type: 'keyframe' }
    case SCREEN_CLIENT.pointer: {
      const fields = expectSize(message, 5)
      return { type: 'pointer', x: fields.getUint16(0), y: fields.getUint16(2), buttons: fields.getUint8(4) & 0b111 }
    }
    case SCREEN_CLIENT.wheel: {
      const fields = expectSize(message, 4)
      return { type: 'wheel', dx: fields.getInt16(0), dy: fields.getInt16(2) }
    }
    case SCREEN_CLIENT.key: {
      const fields = expectSize(message, 5)
      return { type: 'key', keysym: fields.getUint32(0), down: fields.getUint8(4) === 1 }
    }
    case SCREEN_CLIENT.clipboard:
      if (message.payload.byteLength > SCREEN_LIMITS.clipboardBytesMax)
        throw new ScreenProtocolError('Clipboard text is too large.')
      return { type: 'clipboard', text: utf8(message.payload) }
    default:
      throw new ScreenProtocolError(`Unknown screen message ${message.type}.`)
  }
}

/** Offsets of the first byte (the NAL header) of each NAL unit in an Annex-B access unit. */
function nalUnits(au: Uint8Array): number[] {
  const starts: number[] = []
  for (let i = 0; i + 3 < au.byteLength; i++)
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      starts.push(i + 3)
      i += 2
    }
  return starts
}
/** The WebCodecs codec string (`avc1.PPCCLL`) of an access unit's SPS, or null without one. */
export function h264CodecString(au: Uint8Array): string | null {
  for (const at of nalUnits(au)) {
    if ((au[at] & 0x1f) !== 7 || at + 3 >= au.byteLength) continue
    const hex = (value: number) => value.toString(16).padStart(2, '0')
    return `avc1.${hex(au[at + 1])}${hex(au[at + 2])}${hex(au[at + 3])}`
  }
  return null
}
/** Whether an access unit holds an IDR slice, the only frame a decoder can start from. */
export function containsIdr(au: Uint8Array): boolean {
  return nalUnits(au).some((at) => (au[at] & 0x1f) === 5)
}
