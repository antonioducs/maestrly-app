import path from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createZstdCompress } from 'node:zlib'
import { FLEET_RUNNER_TRANSFER_LIMITS } from '@maestrly/bot-fleet-protocol'
import tar from 'tar-stream'
import { realFs } from '../../../real-fs'
import type { RunnerBlobs } from './manifest'
import { conflict, invalid } from './shared'

const fs = realFs.promises
const READ_BYTES = 1024 * 1024

/** Exactly `size` bytes of the file; a file that is shorter now is an error, never padding. */
async function* exactly(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
  changed: () => Error
): AsyncGenerator<Buffer> {
  let position = 0
  while (position < size) {
    const length = Math.min(READ_BYTES, size - position)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (!bytesRead) throw changed()
    position += bytesRead
    yield bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
  }
  // Longer now: what was sent is not what the manifest described.
  if ((await handle.stat()).size !== size) throw changed()
}

/**
 * Streams the blobs a runner asked for into `output` as a tar compressed with zstd level 1 (media barely compresses):
 * one regular file per distinct digest, named by it, in the order asked, each exactly the size the manifest gave. A
 * request is refused before a byte is written when it names a digest the manifest does not hold, more than
 * `blobBatchDigestsMax` digests, or (for more than one blob) more than `blobBatchBytesMax` bytes; a lone blob may be
 * larger, as it cannot be split. A file that is not as the manifest described it, or that changes while it is sent,
 * ends the stream with an error instead of sending other bytes.
 */
export async function packRunnerBlobs(input: {
  folder: string
  blobs: RunnerBlobs
  digests: readonly string[]
  output: Writable
  signal?: AbortSignal
}): Promise<void> {
  const { folder, blobs, digests, output, signal } = input
  if (digests.length > FLEET_RUNNER_TRANSFER_LIMITS.blobBatchDigestsMax)
    throw invalid(`At most ${FLEET_RUNNER_TRANSFER_LIMITS.blobBatchDigestsMax} blobs may be asked for at once.`)
  const wanted = [...new Set(digests)].map((digest) => {
    const blob = blobs.get(digest)
    if (!blob) throw invalid(`Blob ${digest} is not in this job's manifest.`)
    return { digest, size: blob.size, absolute: path.join(folder, ...blob.path.split('/')), relative: blob.path }
  })
  const total = wanted.reduce((sum, blob) => sum + blob.size, 0)
  if (wanted.length > 1 && total > FLEET_RUNNER_TRANSFER_LIMITS.blobBatchBytesMax)
    throw invalid(`At most ${FLEET_RUNNER_TRANSFER_LIMITS.blobBatchBytesMax} bytes of blobs may be asked for at once.`)
  const changed = (relative: string) => () => conflict(`${relative} changed since the manifest was built.`)
  // Refused now, with a proper answer, rather than half way into the stream.
  for (const blob of wanted) {
    signal?.throwIfAborted()
    const info = await fs.lstat(blob.absolute).catch(() => null)
    if (!info?.isFile() || info.size !== blob.size) throw changed(blob.relative)()
  }

  const pack = tar.pack()
  const written = pipeline(
    pack,
    createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 } }),
    output,
    signal ? { signal } : {}
  )
  // An output that fails ends the pack; waiting on an entry must not outlive it.
  const failed = new Promise<never>((_resolve, reject) => {
    written.catch(reject)
  })
  failed.catch(() => undefined)
  const add = async (blob: (typeof wanted)[number]): Promise<void> => {
    const handle = await fs
      .open(blob.absolute, realFs.constants.O_RDONLY | (realFs.constants.O_NOFOLLOW ?? 0))
      .catch(() => {
        throw changed(blob.relative)()
      })
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== blob.size) throw changed(blob.relative)()
      const header = { name: blob.digest, type: 'file' as const, size: blob.size, mode: 0o644 }
      await new Promise<void>((resolve, reject) => {
        const callback = (error?: Error | null) => (error ? reject(error) : resolve())
        if (!blob.size) pack.entry(header, Buffer.alloc(0), callback)
        else {
          const sink = pack.entry(header, callback)
          // tar-stream's entries are streamx streams, which Node's pipeline accepts.
          pipeline(
            Readable.from(exactly(handle, blob.size, changed(blob.relative))),
            sink as unknown as Writable
          ).catch(reject)
        }
      })
    } finally {
      await handle.close()
    }
  }
  try {
    for (const blob of wanted) {
      signal?.throwIfAborted()
      const adding = add(blob)
      adding.catch(() => undefined)
      await Promise.race([adding, failed])
    }
    pack.finalize()
    await written
  } catch (error) {
    pack.destroy()
    await written.catch(() => undefined)
    throw error
  }
}
