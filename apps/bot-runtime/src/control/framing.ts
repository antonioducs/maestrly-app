import { CONTROL_FRAME_MAX } from '@maestrly/host-protocol'
export function encodeFrame(frame: unknown): Buffer {
  const data = Buffer.from(`${JSON.stringify(frame)}\n`)
  if (data.length > CONTROL_FRAME_MAX) throw new Error('Control frame exceeds limit')
  return data
}
export class FrameDecoder {
  constructor(private readonly maxFrame = CONTROL_FRAME_MAX) {}
  private buffer = Buffer.alloc(0)
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = []
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      if (this.buffer.length + end - offset + 1 > this.maxFrame) throw new Error('Control frame exceeds limit')
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)])
      if (newline < 0) break
      frames.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer)))
      this.buffer = Buffer.alloc(0)
      offset = newline + 1
    }
    return frames
  }
}
