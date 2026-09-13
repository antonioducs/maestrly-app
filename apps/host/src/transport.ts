import { requestSchema, responseSchema, type Request, type Response } from '@maestrly/host-protocol'
export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_PENDING_REQUESTS = 16
export const SOCKET_PATH = '/Library/MaestrlyHost/run/host.sock'
export const EXECUTABLE_PATH = '/Library/MaestrlyHost/bin/maestrly-host'
export class FrameDecoder {
  private pending = Buffer.alloc(0)
  push(chunk: Buffer): string[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: string[] = []
    let end: number
    while ((end = this.pending.indexOf(10)) >= 0) {
      if (end > MAX_FRAME_BYTES) throw Error('Frame limit exceeded')
      frames.push(new TextDecoder('utf-8', { fatal: true }).decode(this.pending.subarray(0, end)))
      this.pending = this.pending.subarray(end + 1)
    }
    if (this.pending.length > MAX_FRAME_BYTES) throw Error('Frame limit exceeded')
    return frames
  }
  get incomplete(): boolean {
    return this.pending.length !== 0
  }
}
export function failure(id: string, code: string, message: string): Response {
  return { version: 1, id, error: { code, message } }
}
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'error' && item
          ? { code: 'HOST_ERROR', message: 'Host request failed' }
          : key === 'reason' && typeof item === 'string'
            ? 'Runtime unavailable'
            : sanitize(item),
      ])
    )
  return value
}
export async function handleFrame(frame: string, dispatch: (request: Request) => Promise<Response>): Promise<Response> {
  let json: unknown
  try {
    json = JSON.parse(frame)
  } catch {
    return failure('invalid', 'INVALID_REQUEST', 'Invalid host request')
  }
  const parsed = requestSchema.safeParse(json)
  if (!parsed.success) return failure('invalid', 'INVALID_REQUEST', 'Invalid host request')
  try {
    const response = responseSchema.parse(await dispatch(parsed.data))
    if (response.id !== parsed.data.id) throw Error('Mismatched response')
    // Core errors may contain provider paths or subprocess output. Preserve only stable codes.
    if (response.error)
      return failure(
        response.id,
        /^[A-Z_]{1,64}$/.test(response.error.code) ? response.error.code : 'HOST_ERROR',
        'Host request failed'
      )
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_FRAME_BYTES)
      return failure(response.id, 'RESPONSE_TOO_LARGE', 'Response exceeds host limit')
    return { ...response, result: sanitize(response.result) }
  } catch {
    return failure(parsed.data.id, 'HOST_ERROR', 'Host request failed')
  }
}
