import { z } from 'zod'
import { EGRESS_LIMITS } from '@maestrly/host-protocol'

// Egress frames on the private virtio port. JSONL; data is base64 of at most 48 KiB.
const streamId = z.number().int().nonnegative().max(2 ** 31)
const data = z.string().max(Math.ceil((EGRESS_LIMITS.dataFrameBytes * 4) / 3) + 4)
export const guestEgressFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('open'), s: streamId, host: z.string().min(1).max(260), port: z.number().int().min(1).max(65535) }),
  z.strictObject({ t: z.literal('data'), s: streamId, d: data }),
  z.strictObject({ t: z.literal('end'), s: streamId }),
  z.strictObject({ t: z.literal('close'), s: streamId }),
  z.strictObject({ t: z.literal('ack'), s: streamId, n: z.number().int().positive().max(EGRESS_LIMITS.pendingBytesPerVm) }),
])
export const hostEgressFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('opened'), s: streamId }),
  z.strictObject({ t: z.literal('refused'), s: streamId, code: z.string().min(1).max(40), message: z.string().max(400) }),
  z.strictObject({ t: z.literal('data'), s: streamId, d: data }),
  z.strictObject({ t: z.literal('end'), s: streamId }),
  z.strictObject({ t: z.literal('close'), s: streamId }),
  z.strictObject({ t: z.literal('ack'), s: streamId, n: z.number().int().positive() }),
  z.strictObject({ t: z.literal('policy'), revision: z.number().int().nonnegative(), mode: z.enum(['offline', 'allowlist', 'blocklist']) }),
])
export type GuestEgressFrame = z.infer<typeof guestEgressFrameSchema>
export type HostEgressFrame = z.infer<typeof hostEgressFrameSchema>
export const EGRESS_FRAME_MAX = 80 * 1024
export const STREAM_WINDOW = 512 * 1024

/** Bounded JSONL decoder shared by broker and guest proxy tests. */
export class LineDecoder {
  private pending = Buffer.alloc(0)
  constructor(private readonly maxFrame = EGRESS_FRAME_MAX) {}
  push(chunk: Buffer): string[] {
    if (this.pending.length + chunk.length > this.maxFrame * 4) throw new Error('Egress buffer overflow')
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: string[] = []
    let end: number
    while ((end = this.pending.indexOf(10)) >= 0) {
      if (end > this.maxFrame) throw new Error('Egress frame exceeds limit')
      frames.push(this.pending.subarray(0, end).toString('utf8'))
      this.pending = this.pending.subarray(end + 1)
    }
    if (this.pending.length > this.maxFrame) throw new Error('Egress frame exceeds limit')
    return frames
  }
}
