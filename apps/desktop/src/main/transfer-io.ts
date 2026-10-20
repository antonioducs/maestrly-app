import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { realFs } from './real-fs'

// The files transfers read and publish are the person's own: a file named `*.asar` is a file, never an archive.
const { createReadStream } = realFs
const { link, unlink } = realFs.promises

/** What tells one version of a file from another: a range read from a file that changed since is refused. */
export const fileIdentity = (info: Stats): string => `${info.size}:${Math.floor(info.mtimeMs)}:${info.ino}`

export async function writeAt(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (!bytesWritten) throw new Error('File write failed')
    offset += bytesWritten
  }
}

/** Exactly `length` bytes from `position`, or an error when the file ends first. */
export async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset)
    if (!bytesRead) throw new Error('File ended before the expected range')
    offset += bytesRead
  }
  return bytes
}

/** SHA-256 (hex) of `length` bytes from `start`, or of the rest of the file. */
export async function hashFile(file: string, start = 0, length?: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  if (length !== 0) {
    const stream = createReadStream(file, {
      start,
      ...(length === undefined ? {} : { end: start + length - 1 }),
      ...(signal ? { signal } : {}),
    })
    for await (const chunk of stream) hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Publishes a finished partial file under `name` in `directory` with an exclusive hard link, so an existing file is
 * never replaced: a taken name gets ` (n)` before its extension. The partial file is removed once published.
 */
export async function publishExclusive(
  partial: string,
  directory: string,
  name: string,
  signal?: AbortSignal
): Promise<string> {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let suffix = 0; suffix < 10_000; suffix++) {
    signal?.throwIfAborted()
    const destination = join(directory, suffix ? `${stem} (${suffix})${extension}` : name)
    try {
      await link(partial, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      continue
    }
    if (signal?.aborted) {
      await unlink(destination)
      signal.throwIfAborted()
    }
    await unlink(partial).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return destination
  }
  throw new Error('Too many download filename collisions')
}
