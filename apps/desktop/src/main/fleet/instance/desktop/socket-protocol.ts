/**
 * The wire format of the per-bot desktop socket (`~/.cache/maestrly-bots/<botId>/desktop.sock`).
 *
 * A connection starts with a line of UTF-8 fields separated by tabs and ended by a newline; free text is base64.
 * The first line names the role:
 *
 * - `cmd\t<browser|terminal|files|url>[\t<b64>]`: the service answers `ok` or `err\t<b64>` and closes.
 * - `pty\t<b64 id>\t<cols>\t<rows>`: the service answers `ok` or `err\t<b64>`; after `ok` both sides exchange frames
 *   `[type u8][length u32 BE][data]`. Type 1 carries data (terminal output from the service, typing from the client),
 *   type 2 a size (cols u16, rows u16; client to service) and type 3 the exit (code i32 and a localized message;
 *   service to client).
 * - `presenter\t1`: the browser presenter's connection, answered `ok` or `err\t<b64>` and then run by its own handler.
 *
 * `deploy/bot-fleet/desktop/bin/maestrly-desktop` and `maestrly-pty-attach` speak the same format with no
 * dependencies, so a change here needs the same change there.
 */

/** The longest line, without its newline. */
export const DESKTOP_LINE_MAX = 2 * 1024 * 1024
/** The largest frame payload. */
export const DESKTOP_FRAME_MAX = 1024 * 1024
export const FRAME = { data: 1, size: 2, exit: 3 } as const
export type FrameType = (typeof FRAME)[keyof typeof FRAME]

/** The terminal size limits, for both the `pty` role and the size frames. */
const DIMENSION_MAX = 1000
const FRAME_HEADER_BYTES = 5
const NEWLINE = 0x0a

/** A peer broke the protocol. The message is a diagnostic fit to send back in an `err` line. */
export class DesktopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopProtocolError'
  }
}

export type DesktopCommand = 'browser' | 'terminal' | 'files' | 'url'
export type DesktopRole =
  | { role: 'cmd'; command: DesktopCommand; argument: string | null }
  | { role: 'pty'; ptyId: string; cols: number; rows: number }
  | { role: 'presenter'; version: 1 }

const COMMANDS: ReadonlySet<string> = new Set<DesktopCommand>(['browser', 'terminal', 'files', 'url'])
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DIMENSION_PATTERN = /^[0-9]{1,4}$/

/** Joins the fields with tabs and ends the line. Fields that hold a tab or a newline would break the framing. */
export function encodeLine(fields: readonly string[]): Buffer {
  for (const field of fields) {
    if (field.includes('\t') || field.includes('\n')) throw new DesktopProtocolError('A field holds a tab or a newline')
  }
  return Buffer.from(`${fields.join('\t')}\n`, 'utf8')
}

export function encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** Decodes canonical base64 of valid UTF-8; anything else is a protocol error. */
export function decodeText(base64: string): string {
  if (!BASE64_PATTERN.test(base64)) throw new DesktopProtocolError('Invalid base64')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) throw new DesktopProtocolError('Invalid base64')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new DesktopProtocolError('Invalid UTF-8')
  }
}

/**
 * Splits a byte stream into lines of fields. Bytes that follow the last complete line wait for the next chunk, and
 * `takeRest` gives them back when the connection leaves the line format.
 */
export class LineReader {
  /** Bytes after the last line returned. When `clean`, none of them is a newline. */
  private pending: Buffer[] = []
  private size = 0
  private clean = true

  /**
   * Returns the complete lines received so far, up to `maxLines` of them; what remains stays buffered. Throws a
   * `DesktopProtocolError` for a line above `DESKTOP_LINE_MAX`, complete or not.
   */
  push(chunk: Buffer, maxLines = Number.POSITIVE_INFINITY): string[][] {
    if (chunk.length > 0) {
      const wasClean = this.clean
      this.pending.push(chunk)
      this.size += chunk.length
      if (wasClean && !chunk.includes(NEWLINE)) {
        // The usual case for a long line arriving in pieces: no copying until its end shows up.
        if (this.size > DESKTOP_LINE_MAX) throw new DesktopProtocolError('Line too long')
        return []
      }
      this.clean = false
    }
    if (this.clean || maxLines <= 0) return []

    const bytes = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
    const lines: string[][] = []
    let start = 0
    while (lines.length < maxLines) {
      const end = bytes.indexOf(NEWLINE, start)
      if (end < 0) break
      if (end - start > DESKTOP_LINE_MAX) throw new DesktopProtocolError('Line too long')
      lines.push(bytes.toString('utf8', start, end).split('\t'))
      start = end + 1
    }
    const rest = bytes.subarray(start)
    this.pending = rest.length > 0 ? [rest] : []
    this.size = rest.length
    this.clean = !rest.includes(NEWLINE)
    if (this.clean && this.size > DESKTOP_LINE_MAX) throw new DesktopProtocolError('Line too long')
    return lines
  }

  /** The bytes after the last line returned, which the reader forgets. */
  takeRest(): Buffer {
    const rest = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
    this.pending = []
    this.size = 0
    this.clean = true
    return rest
  }
}

function parseDimension(field: string, name: string): number {
  if (!DIMENSION_PATTERN.test(field)) throw new DesktopProtocolError(`Invalid ${name}`)
  const value = Number(field)
  if (value < 1 || value > DIMENSION_MAX) throw new DesktopProtocolError(`Invalid ${name}`)
  return value
}

/** Reads the first line of a connection. */
export function parseRoleLine(fields: string[]): DesktopRole {
  switch (fields[0]) {
    case 'cmd': {
      const command = fields[1]
      if (fields.length < 2 || fields.length > 3 || !COMMANDS.has(command))
        throw new DesktopProtocolError('Unknown command')
      if (command === 'url') {
        if (fields.length !== 3) throw new DesktopProtocolError('The url command needs an address')
        return { role: 'cmd', command, argument: decodeText(fields[2]) }
      }
      if (fields.length !== 2) throw new DesktopProtocolError('This command takes no argument')
      return { role: 'cmd', command: command as DesktopCommand, argument: null }
    }
    case 'pty': {
      if (fields.length !== 4) throw new DesktopProtocolError('Invalid pty request')
      const ptyId = decodeText(fields[1])
      if (ptyId === '') throw new DesktopProtocolError('Missing terminal id')
      return { role: 'pty', ptyId, cols: parseDimension(fields[2], 'width'), rows: parseDimension(fields[3], 'height') }
    }
    case 'presenter':
      if (fields.length !== 2 || fields[1] !== '1') throw new DesktopProtocolError('Unsupported presenter version')
      return { role: 'presenter', version: 1 }
    default:
      throw new DesktopProtocolError('Unknown role')
  }
}

function isFrameType(type: number): type is FrameType {
  return type === FRAME.data || type === FRAME.size || type === FRAME.exit
}

export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (!isFrameType(type)) throw new DesktopProtocolError('Unknown frame type')
  if (payload.length > DESKTOP_FRAME_MAX) throw new DesktopProtocolError('Frame too large')
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

export interface DesktopFrame {
  type: number
  payload: Buffer
}

/** Splits a byte stream into frames. After a protocol error the reader refuses all further input. */
export class FrameReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private header: { type: number; length: number } | null = null
  private failure: DesktopProtocolError | null = null

  push(chunk: Buffer): DesktopFrame[] {
    if (this.failure) throw this.failure
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const frames: DesktopFrame[] = []
    try {
      for (;;) {
        if (!this.header) {
          if (this.buffered < FRAME_HEADER_BYTES) break
          const bytes = this.take(FRAME_HEADER_BYTES)
          const type = bytes.readUInt8(0)
          const length = bytes.readUInt32BE(1)
          if (!isFrameType(type)) throw new DesktopProtocolError('Unknown frame type')
          if (length > DESKTOP_FRAME_MAX) throw new DesktopProtocolError('Frame too large')
          this.header = { type, length }
        }
        if (this.buffered < this.header.length) break
        frames.push({ type: this.header.type, payload: this.take(this.header.length) })
        this.header = null
      }
    } catch (error) {
      this.failure = error as DesktopProtocolError
      this.chunks = []
      this.buffered = 0
      throw error
    }
    return frames
  }

  /** Removes and returns the next `count` buffered bytes. */
  private take(count: number): Buffer {
    if (count === 0) return Buffer.alloc(0)
    const first = this.chunks[0]
    if (first.length >= count) {
      if (first.length === count) this.chunks.shift()
      else this.chunks[0] = first.subarray(count)
      this.buffered -= count
      return first.subarray(0, count)
    }
    const parts: Buffer[] = []
    let missing = count
    while (missing > 0) {
      const next = this.chunks[0]
      if (next.length <= missing) {
        parts.push(next)
        missing -= next.length
        this.chunks.shift()
      } else {
        parts.push(next.subarray(0, missing))
        this.chunks[0] = next.subarray(missing)
        missing = 0
      }
    }
    this.buffered -= count
    return Buffer.concat(parts)
  }
}

export function sizePayload(cols: number, rows: number): Buffer {
  if (!Number.isInteger(cols) || cols < 1 || cols > DIMENSION_MAX) throw new DesktopProtocolError('Invalid width')
  if (!Number.isInteger(rows) || rows < 1 || rows > DIMENSION_MAX) throw new DesktopProtocolError('Invalid height')
  const payload = Buffer.allocUnsafe(4)
  payload.writeUInt16BE(cols, 0)
  payload.writeUInt16BE(rows, 2)
  return payload
}

export function parseSizePayload(payload: Buffer): { cols: number; rows: number } {
  if (payload.length !== 4) throw new DesktopProtocolError('Invalid size frame')
  const cols = payload.readUInt16BE(0)
  const rows = payload.readUInt16BE(2)
  if (cols < 1 || cols > DIMENSION_MAX || rows < 1 || rows > DIMENSION_MAX)
    throw new DesktopProtocolError('Invalid size')
  return { cols, rows }
}

export function exitPayload(code: number, message: string): Buffer {
  const head = Buffer.allocUnsafe(4)
  head.writeInt32BE(code | 0, 0)
  return Buffer.concat([head, Buffer.from(message, 'utf8')])
}

export function parseExitPayload(payload: Buffer): { code: number; message: string } {
  if (payload.length < 4) throw new DesktopProtocolError('Invalid exit frame')
  let message: string
  try {
    message = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(4))
  } catch {
    throw new DesktopProtocolError('Invalid UTF-8')
  }
  return { code: payload.readInt32BE(0), message }
}
