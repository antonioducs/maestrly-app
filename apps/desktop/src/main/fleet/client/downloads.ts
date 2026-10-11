import { randomUUID } from 'node:crypto'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { FLEET_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import type { FleetApiClient } from './api'

/** Main-process dependencies only; never accept a destination from the renderer. */
export interface FleetDownloadOptions {
  signal?: AbortSignal
  downloadsPath?: () => string | Promise<string>
}

export function sanitizeFleetFilename(name: string): string {
  let safe = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
  // Keep UTF-8 names comfortably below filesystem component limits, including collision suffixes.
  const suffix = extname(safe)
  const extension = /^\.[A-Za-z0-9]{1,16}$/.test(suffix) ? suffix : ''
  let stem = extension ? safe.slice(0, -extension.length) : safe
  stem = Array.from(stem)
    .slice(0, 120 - extension.length)
    .join('')
  while (Buffer.byteLength(stem + extension) > 180) stem = Array.from(stem).slice(0, -1).join('')
  safe = (stem || 'download') + extension
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(safe)) safe = '_' + safe
  return safe
}

/** Saves exact bytes, atomically publishing with an exclusive hard link; existing files are never replaced. */
export async function saveFleetFile(
  api: Pick<FleetApiClient, 'openFile'>,
  botId: string,
  fileId: string,
  options: FleetDownloadOptions = {}
): Promise<string> {
  const directory = await (options.downloadsPath?.() ?? import('electron').then(({ app }) => app.getPath('downloads')))
  options.signal?.throwIfAborted()
  await mkdir(directory, { recursive: true })
  const { ref, response } = await api.openFile(botId, fileId, options.signal)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing file body')
  const partial = join(directory, '.maestrly-' + randomUUID() + '.partial')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    handle = await open(partial, 'wx', 0o600)
    let size = 0
    for (;;) {
      options.signal?.throwIfAborted()
      const next = await reader.read()
      options.signal?.throwIfAborted()
      if (next.done) break
      size += next.value.byteLength
      if (size > ref.byteSize || size > FLEET_FILE_LIMITS.downloadMaxBytes) throw new Error('File too large')
      let offset = 0
      while (offset < next.value.byteLength) {
        const { bytesWritten } = await handle.write(next.value, offset, next.value.byteLength - offset)
        if (!bytesWritten) throw new Error('File write failed')
        offset += bytesWritten
      }
    }
    if (size !== ref.byteSize) throw new Error('Incomplete file')
    await handle.sync()
    await handle.close()
    handle = undefined
    const name = sanitizeFleetFilename(ref.name)
    const extension = extname(name)
    const stem = name.slice(0, name.length - extension.length)
    for (let suffix = 0; suffix < 10_000; suffix++) {
      options.signal?.throwIfAborted()
      const destination = join(directory, suffix ? `${stem} (${suffix})${extension}` : name)
      try {
        await link(partial, destination)
        if (options.signal?.aborted) {
          await unlink(destination)
          options.signal.throwIfAborted()
        }
        return destination
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error('Too many download filename collisions')
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle?.close().catch(() => undefined)
    await unlink(partial).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
