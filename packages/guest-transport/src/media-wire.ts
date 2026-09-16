import {
  MEDIA_CONTROL_PAYLOAD_MAX,
  MEDIA_FRAME,
  MEDIA_HEADER_BYTES,
  MEDIA_MAGIC,
  MEDIA_PAYLOAD_MAX,
  type MediaFrameType,
} from '@maestrly/host-protocol'

export type MediaFrame = { type: MediaFrameType; streamId: number; sequence: number; payload: Buffer }
export class MediaProtocolError extends Error {
  readonly code = 'MEDIA_PROTOCOL'
}
const TYPES = new Set<number>(Object.values(MEDIA_FRAME))
const u32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
/** Per-type payload rules. Control frames stay tiny; only DATA carries RFB bytes. */
export function validateMediaFrame(frame: MediaFrame) {
  const { type, streamId, sequence, payload } = frame
  if (!TYPES.has(type) || !u32(streamId) || !u32(sequence)) throw new MediaProtocolError('Invalid media frame header')
  const length = payload.length
  switch (type) {
    case MEDIA_FRAME.hello:
    case MEDIA_FRAME.welcome:
      if (streamId !== 0 || length < 2 || length > MEDIA_CONTROL_PAYLOAD_MAX) throw new MediaProtocolError('Invalid lane handshake')
      break
    case MEDIA_FRAME.open:
      if (streamId === 0 || length < 2 || length > MEDIA_CONTROL_PAYLOAD_MAX) throw new MediaProtocolError('Invalid open')
      break
    case MEDIA_FRAME.accept:
    case MEDIA_FRAME.end:
      if (streamId === 0 || length !== 0) throw new MediaProtocolError('Invalid stream signal')
      break
    case MEDIA_FRAME.data:
      if (streamId === 0 || length < 1 || length > MEDIA_PAYLOAD_MAX) throw new MediaProtocolError('Invalid data length')
      break
    case MEDIA_FRAME.credit:
      if (streamId === 0 || length !== 4 || payload.readUInt32BE(0) === 0) throw new MediaProtocolError('Invalid credit')
      break
    case MEDIA_FRAME.close:
      if (streamId === 0 || length > 64 || (length > 0 && !/^[A-Z_]{1,64}$/.test(payload.toString('latin1'))))
        throw new MediaProtocolError('Invalid close')
      break
  }
}
export function encodeMediaFrame(frame: MediaFrame): Buffer {
  validateMediaFrame(frame)
  const bytes = Buffer.alloc(MEDIA_HEADER_BYTES + frame.payload.length)
  bytes.writeUInt32BE(MEDIA_MAGIC, 0)
  bytes[4] = frame.type
  bytes.writeUInt32BE(frame.streamId, 8)
  bytes.writeUInt32BE(frame.sequence, 12)
  bytes.writeUInt32BE(frame.payload.length, 16)
  frame.payload.copy(bytes, MEDIA_HEADER_BYTES)
  return bytes
}
/**
 * Incremental decoder. A bad magic, nonzero reserved bytes, unknown type or a length
 * that lies beyond the per-type maximum is fatal: the lane cannot be resynchronized and
 * garbage is never handed to an RFB parser.
 */
export class MediaFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): MediaFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames: MediaFrame[] = []
    while (this.buffer.length >= MEDIA_HEADER_BYTES) {
      if (this.buffer.readUInt32BE(0) !== MEDIA_MAGIC) throw new MediaProtocolError('Bad media magic')
      if (this.buffer[5] || this.buffer[6] || this.buffer[7]) throw new MediaProtocolError('Reserved bytes must be zero')
      const type = this.buffer[4]
      if (!TYPES.has(type)) throw new MediaProtocolError('Unknown media frame type')
      const length = this.buffer.readUInt32BE(16)
      if (length > (type === MEDIA_FRAME.data ? MEDIA_PAYLOAD_MAX : MEDIA_CONTROL_PAYLOAD_MAX)) throw new MediaProtocolError('Media frame too large')
      if (this.buffer.length < MEDIA_HEADER_BYTES + length) break
      const frame: MediaFrame = {
        type: type as MediaFrameType,
        streamId: this.buffer.readUInt32BE(8),
        sequence: this.buffer.readUInt32BE(12),
        payload: Buffer.from(this.buffer.subarray(MEDIA_HEADER_BYTES, MEDIA_HEADER_BYTES + length)),
      }
      validateMediaFrame(frame)
      frames.push(frame)
      this.buffer = this.buffer.subarray(MEDIA_HEADER_BYTES + length)
    }
    return frames
  }
  get pending() {
    return this.buffer.length
  }
}
