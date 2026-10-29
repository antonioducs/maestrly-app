import { FLEET_RUNNER_LIMITS, type FleetRunnerJobLogPage } from '@maestrly/bot-fleet-protocol'
import { realFs } from '../real-fs'

const fs = realFs.promises
const NEWLINE = 0x0a

/** Whether a byte continues a UTF-8 character rather than starting one. */
const continuation = (byte: number): boolean => (byte & 0xc0) === 0x80

/** How many bytes the UTF-8 character that starts with `byte` has; 1 for a byte that starts none. */
function sequenceLength(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf7) return 4
  if (byte >= 0xe0) return 3
  if (byte >= 0xc0) return 2
  return 1
}

/** Where `bytes` can be cut without splitting its last character: its length, or the start of an unfinished one. */
function completeLength(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const index = bytes.length - back
    if (continuation(bytes[index])) continue
    return sequenceLength(bytes[index]) > back ? index : bytes.length
  }
  return bytes.length
}

/**
 * Where to cut `body` near `wanted` bytes without splitting a character: before the one `wanted` falls in, or after it
 * when it is the first, so a piece smaller than a character still moves on. At the end of `body`, an unfinished last
 * character is left for the next read.
 */
function cutAt(body: Buffer, wanted: number): number {
  if (wanted >= body.length) return completeLength(body)
  let cut = wanted
  while (cut > 0 && continuation(body[cut])) cut--
  if (cut > 0) return cut
  const whole = sequenceLength(body[0])
  return whole <= body.length ? whole : completeLength(body)
}

/** The number of `limit`, bounded to what a read may return. */
function pageBytes(limit: number | undefined): number {
  const value = limit === undefined || !Number.isSafeInteger(limit) ? FLEET_RUNNER_LIMITS.logPageBytesDefault : limit
  return Math.min(FLEET_RUNNER_LIMITS.logPageBytesMax, Math.max(1, value))
}

/**
 * A piece of a job's log file, as `FleetRunnerJobLogPage` describes it: from `offset` on, or, when it is null, the end of
 * the log from the start of a line. The piece never starts or ends inside a character, so reading on from `next` loses
 * nothing even while the log grows. A log that does not exist yet is empty.
 */
export async function readLogPage(file: string, offset: number | null, limit?: number): Promise<FleetRunnerJobLogPage> {
  const bytes = pageBytes(limit)
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { start: 0, next: 0, size: 0, text: '' }
    throw error
  }
  try {
    const size = (await handle.stat()).size
    const tail = offset === null
    let start = tail ? Math.max(0, size - bytes) : Math.min(Math.max(0, Math.trunc(offset)), size)
    // Up to a character more than asked, so the piece can end on a whole one.
    const length = Math.min(bytes + 3, size - start)
    let chunk = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(chunk, read, length - read, start + read)
      if (!bytesRead) break
      read += bytesRead
    }
    chunk = chunk.subarray(0, read)
    let from = 0
    if (tail && start > 0) {
      // The end of the log reads from a whole line when the piece holds one.
      const newline = chunk.indexOf(NEWLINE)
      if (newline >= 0 && newline < chunk.length - 1) from = newline + 1
    }
    while (from < chunk.length && continuation(chunk[from])) from++
    const body = chunk.subarray(from)
    const end = cutAt(body, bytes - Math.min(from, bytes - 1))
    start += from
    return { start, next: start + end, size, text: body.subarray(0, end).toString('utf8') }
  } finally {
    await handle.close()
  }
}
