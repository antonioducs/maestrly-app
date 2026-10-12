import { randomUUID } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { FLEET_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import { publishExclusive } from '../../transfer-io'
import type { FleetApiClient } from './api'

/** Main-process dependencies only; never accept a destination from the renderer. */
export interface FleetDownloadOptions {
  signal?: AbortSignal
  downloadsPath?: () => string | Promise<string>
  /** Bytes on disk against the announced size: first once the gateway answers, then after every written chunk. */
  onProgress?: (progress: { name: string; receivedBytes: number; totalBytes: number }) => void
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
    options.onProgress?.({ name: ref.name, receivedBytes: 0, totalBytes: ref.byteSize })
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
      options.onProgress?.({ name: ref.name, receivedBytes: size, totalBytes: ref.byteSize })
    }
    if (size !== ref.byteSize) throw new Error('Incomplete file')
    await handle.sync()
    await handle.close()
    handle = undefined
    return await publishExclusive(partial, directory, sanitizeFleetFilename(ref.name), options.signal)
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
