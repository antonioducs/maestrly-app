import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  decodeClientMessage,
  encodeCursor,
  encodeFrame,
  encodeHello,
  type ScreenClientEvent,
  type ScreenMode,
} from '@maestrly/bot-fleet-protocol'

/** A 640×480 key frame of solid #2266cc, encoded once with x264 for these tests (synthetic, no real screen). */
export const SCREEN_KEY_FRAME = readFileSync(
  fileURLToPath(new URL('../../fixtures/screen-640x480-key.h264', import.meta.url))
)
export const SCREEN_KEY_COLOR = [0x22, 0x66, 0xcc] as const
/** A 1×1 PNG: the remote pointer's sprite. */
export const SCREEN_CURSOR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/** An unmasked binary WebSocket frame, as a server sends it. */
export function wsBinary(payload: Uint8Array): Buffer {
  const length = payload.byteLength
  let header: Buffer
  if (length < 126) header = Buffer.from([0x82, length])
  else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[0] = 0x82
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** What a screen sends a client that joins: hello, the pointer's sprite, then its frames. */
export function screenStream(options: {
  width: number
  height: number
  mode: ScreenMode
  cursor?: boolean
  frames?: Array<{ id: number; key: boolean; data: Uint8Array }>
}): Buffer {
  return Buffer.concat([
    encodeHello({ version: 1, width: options.width, height: options.height, mode: options.mode }),
    ...(options.cursor === false ? [] : [encodeCursor(0, 0, SCREEN_CURSOR_PNG)]),
    ...(options.frames ?? []).map((frame) => encodeFrame(frame.id, frame.key, frame.data)),
  ])
}

/**
 * Reads what a client sends a fake gateway's screen socket: masked WebSocket frames, whose binary payloads carry the
 * screen stream's messages split anywhere. `close` tells of a close frame.
 */
export class ScreenClientReader {
  private buffered = Buffer.alloc(0)
  private readonly messages = new ScreenMessageReader(SCREEN_LIMITS.clientPayloadMax + 5)
  push(chunk: Buffer): { events: ScreenClientEvent[]; close: boolean } {
    this.buffered = Buffer.concat([this.buffered, chunk])
    const events: ScreenClientEvent[] = []
    while (this.buffered.length >= 2) {
      const opcode = this.buffered[0] & 15
      const masked = (this.buffered[1] & 128) !== 0
      let length = this.buffered[1] & 127
      let offset = 2
      if (length === 126) {
        if (this.buffered.length < 4) break
        length = this.buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffered.length < 10) break
        length = Number(this.buffered.readBigUInt64BE(2))
        offset = 10
      }
      const total = offset + (masked ? 4 : 0) + length
      if (this.buffered.length < total) break
      const payload = Buffer.from(this.buffered.subarray(offset + (masked ? 4 : 0), total))
      if (masked) {
        const mask = this.buffered.subarray(offset, offset + 4)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      this.buffered = this.buffered.subarray(total)
      if (opcode === 8) return { events, close: true }
      if (opcode === 2 || opcode === 0)
        for (const message of this.messages.push(payload)) events.push(decodeClientMessage(message))
    }
    return { events, close: false }
  }
}
