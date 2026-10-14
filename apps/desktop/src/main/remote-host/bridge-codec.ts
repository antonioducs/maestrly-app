import { z } from 'zod'
import { type BridgeClientFrame, type BridgeHostFrame, REMOTE_BRIDGE_LIMITS } from '../../shared/remote-bridge'

export class BridgeFrameError extends Error {}

const BIN = '$bin'
const UNDEF = '$undef'
const ESC = '$esc'

const base64 = (view: ArrayBufferView): string =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64')

/**
 * The JSON form of an IPC value. Electron's IPC carries more than JSON does, and handlers rely on it: attachments and
 * audio are binary, and positional arguments may be `undefined`. Binary goes as base64 with its type (`Uint8Array`,
 * `ArrayBuffer` or `Float32Array`; any other view arrives as a `Uint8Array` of its bytes), `undefined` array entries
 * keep their place, and an object that happens to use one of the tag names is wrapped so it reads back unchanged.
 */
export function encodeBridgeValue(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return { [UNDEF]: 1 }
  if (typeof value === 'bigint') return Number(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Float32Array) return { [BIN]: 'f32', b64: base64(value) }
  if (ArrayBuffer.isView(value)) return { [BIN]: 'u8', b64: base64(value) }
  if (value instanceof ArrayBuffer) return { [BIN]: 'ab', b64: Buffer.from(value).toString('base64') }
  if (value instanceof Date) return value.toISOString()
  if (ancestors.has(value)) throw new BridgeFrameError('Cyclic value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encodeBridgeValue(item, ancestors))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = encodeBridgeValue(item, ancestors)
    }
    return BIN in out || UNDEF in out || ESC in out ? { [ESC]: out } : out
  } finally {
    ancestors.delete(value)
  }
}

export function decodeBridgeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBridgeValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && record[UNDEF] === 1) return undefined
  if (keys.length === 2 && BIN in record && typeof record.b64 === 'string') {
    const data = Buffer.from(record.b64, 'base64')
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    if (record[BIN] === 'u8') return new Uint8Array(buffer)
    if (record[BIN] === 'ab') return buffer
    if (record[BIN] === 'f32' && buffer.byteLength % 4 === 0) return new Float32Array(buffer)
    throw new BridgeFrameError('Invalid binary value')
  }
  const escaped = keys.length === 1 && record[ESC] && typeof record[ESC] === 'object' && !Array.isArray(record[ESC])
  const source = escaped ? (record[ESC] as Record<string, unknown>) : record
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) out[key] = decodeBridgeValue(item)
  return out
}

export function encodeBridgeFrame(
  frame: BridgeClientFrame | BridgeHostFrame,
  maxBytes: number = REMOTE_BRIDGE_LIMITS.maxFrameBytes
): string {
  const text = JSON.stringify(encodeBridgeValue(frame))
  if (Buffer.byteLength(text) > maxBytes) throw new BridgeFrameError('Frame too large')
  return text
}

const id = z.int()
const origin = z.int()
const os = z.enum(['mac', 'win', 'linux'])
const channel = z.string().min(1).max(200)
const args = z.array(z.unknown())

const clientFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.int(),
    appVersion: z.string().max(64),
    client: z.object({
      deviceName: z.string().max(128),
      os: z.enum(['mac', 'win', 'linux', 'ios', 'android']),
      locale: z.string().max(16),
      kind: z.enum(['desktop', 'mobile']).optional(),
      mobileApi: z.int().optional(),
    }),
  }),
  z.object({
    t: z.literal('open'),
    origin,
    role: z.enum(['main', 'panel']),
    convId: z.string().min(1).max(200).optional(),
    panel: z.string().min(1).max(40).optional(),
  }),
  z.object({ t: z.literal('close'), origin }),
  z.object({ t: z.literal('invoke'), id, origin, channel, args }),
  z.object({ t: z.literal('send'), origin, channel, args }),
  z.object({ t: z.literal('ping'), n: z.number() }),
  z.object({ t: z.literal('pong'), n: z.number() }),
])

const hostInfo = z.object({
  os,
  hostName: z.string(),
  homeDir: z.string(),
  roots: z.array(z.string()),
  desktopEffects: z.boolean(),
  editor: z.boolean(),
  browser: z.boolean(),
})
const hostFrame = z.union([
  z.object({
    t: z.literal('welcome'),
    protocol: z.int(),
    appVersion: z.string(),
    host: hostInfo,
    mobileApi: z.int().optional(),
  }),
  z.object({ t: z.literal('refused'), reason: z.enum(['protocol', 'version', 'mobile-api']), hostVersion: z.string() }),
  z.object({ t: z.literal('result'), id, ok: z.literal(true), value: z.unknown().optional() }),
  z.object({
    t: z.literal('result'),
    id,
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
  z.object({ t: z.literal('event'), origin, channel: z.string(), args }),
  z.object({ t: z.literal('ping'), n: z.number() }),
  z.object({ t: z.literal('pong'), n: z.number() }),
])

function parse<T>(text: string, schema: z.ZodType<T>): T {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BridgeFrameError('Invalid JSON')
  }
  const result = schema.safeParse(decodeBridgeValue(raw))
  if (!result.success) throw new BridgeFrameError('Invalid frame')
  return result.data
}

export function decodeClientFrame(text: string): BridgeClientFrame {
  const frame = parse(text, clientFrame)
  if (frame.t !== 'open') return frame
  if (frame.role === 'main') return { t: 'open', origin: frame.origin, role: 'main' }
  if (!frame.convId || !frame.panel) throw new BridgeFrameError('Invalid frame')
  return { t: 'open', origin: frame.origin, role: 'panel', convId: frame.convId, panel: frame.panel }
}

export const decodeHostFrame = (text: string): BridgeHostFrame => parse(text, hostFrame) as BridgeHostFrame
