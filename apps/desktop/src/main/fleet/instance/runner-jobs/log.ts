import type { Readable } from 'node:stream'
import { FLEET_RUNNER_TRANSFER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { realFs } from '../../../real-fs'
import { writeAt } from '../../../transfer-io'
import { conflict, errno, invalid, KeyedSerial } from './shared'

const fs = realFs.promises
const writes = new KeyedSerial()

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch (error) {
    if (errno(error) === 'ENOENT') return 0
    throw error
  }
}

/** The whole body, or an error when it is larger than `maxBytes`. */
async function readBody(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw invalid('Log batch too large.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

/**
 * Writes a batch of a job's log at `offset`: a batch sent again lands where it did the first time. An offset past
 * the end of the log leaves a gap and is a conflict that says how long the log is, so the sender resumes from there.
 */
export async function writeRunnerLog(file: string, offset: number, body: Readable, maxBytes: number): Promise<void> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('Invalid log offset.')
  // Read whole before anything is written: a batch that breaks off leaves the log as it was.
  const bytes = await readBody(body, maxBytes)
  await writes.run(file, async () => {
    const size = await sizeOf(file)
    if (offset > size) throw conflict(`The log holds ${size} bytes.`)
    if (!bytes.length) return
    const handle = await fs.open(file, realFs.constants.O_RDWR | realFs.constants.O_CREAT, 0o600)
    try {
      await writeAt(handle, bytes, offset)
    } finally {
      await handle.close()
    }
  })
}

/** The last `lines` lines of a job's log, from at most its last `bytes` bytes; empty when it has none. */
export async function tailRunnerLog(
  file: string,
  lines: number = FLEET_RUNNER_TRANSFER_LIMITS.logTailLines,
  bytes: number = FLEET_RUNNER_TRANSFER_LIMITS.logTailBytes
): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(file, 'r')
  } catch (error) {
    if (errno(error) === 'ENOENT') return ''
    throw error
  }
  let text: string
  let partial = false
  try {
    const size = (await handle.stat()).size
    // One byte before the window says whether its first line is whole.
    const start = Math.max(0, size - bytes - 1)
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read)
      if (!bytesRead) break
      read += bytesRead
    }
    partial = start > 0 && buffer[0] !== 0x0a
    text = buffer.subarray(start > 0 ? 1 : 0, read).toString('utf8')
  } finally {
    await handle.close()
  }
  const all = text.split('\n')
  // The window may start inside a line (and inside a character): that line is dropped, unless it is the only one.
  if (partial && all.length > 1) all.shift()
  else if (partial) all[0] = all[0].replace(/^\uFFFD+/, '')
  if (all.at(-1) === '') all.pop()
  return lines > 0 ? all.slice(-lines).join('\n') : ''
}
