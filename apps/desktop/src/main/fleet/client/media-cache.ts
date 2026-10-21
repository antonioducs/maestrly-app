import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { FLEET_FILE_LIMITS, fleetFileRefSchema, type FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { fleetVideoMediaType } from '../../../shared/fleet-media'
import type { FleetApiClient } from './api'

/** Videos the owner watched stay on this computer up to this total; the least recently watched go first. */
export const FLEET_MEDIA_CACHE_MAX_BYTES = 1024 * 1024 * 1024

export type FleetMediaEntry = { path: string; ref: FleetFileRef; mediaType: string }
export type FleetMediaProgress = { botId: string; fileId: string; received: number; total: number }
export type FleetMediaOpen = (signal?: AbortSignal) => ReturnType<FleetApiClient['openFile']>

const metaSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    botId: z.string(),
    fileId: z.string(),
    ref: fleetFileRefSchema.strict(),
  })
  .strict()
type Meta = z.infer<typeof metaSchema>
const entryName = /^([0-9a-f]{64})\.(media|json)$/
const temporaryName = /^\.([0-9a-f]{64})\.[0-9a-f-]{36}\.(?:partial|tmp)$/

/**
 * Bot videos copied to a private folder so `<video>` can seek through them without the gateway token. A file is
 * published by rename only once complete; its sidecar records which pairing, bot and file it is.
 */
export class FleetMediaCache {
  private inflight = new Map<string, Promise<FleetMediaEntry>>()
  private sweeping: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly options: {
      root: () => string
      maxBytes?: number
      /** `scope` is the pairing the video was fetched through: which server's bot shared it. */
      onProgress?: (progress: FleetMediaProgress & { scope: string }) => void
      /** Last-use clock, in milliseconds; injectable so tests can order uses within one millisecond. */
      now?: () => number
    }
  ) {}

  private key(scope: string, botId: string, fileId: string): string {
    return createHash('sha256').update(`${scope}\0${botId}\0${fileId}`).digest('hex')
  }

  private files(key: string): { media: string; meta: string } {
    const root = this.options.root()
    return { media: path.join(root, key + '.media'), meta: path.join(root, key + '.json') }
  }

  /** A cached copy of the video, downloaded once however many callers ask for it at the same time. */
  prepare(
    scope: string,
    botId: string,
    fileId: string,
    openFile: FleetMediaOpen,
    signal?: AbortSignal
  ): Promise<FleetMediaEntry> {
    const key = this.key(scope, botId, fileId)
    const running = this.inflight.get(key)
    if (running) return running
    const task = (async () => {
      const cached = await this.read(key, { scope, botId, fileId })
      if (cached) {
        await this.touch(cached.path)
        return cached
      }
      const entry = await this.download(key, { scope, botId, fileId }, openFile, signal)
      await this.evict(key)
      return entry
    })().finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  private async read(key: string, identity: Omit<Meta, 'version' | 'ref'>): Promise<FleetMediaEntry | null> {
    const files = this.files(key)
    let meta: Meta
    try {
      meta = metaSchema.parse(JSON.parse(await readFile(files.meta, 'utf8')))
    } catch {
      return null
    }
    const mediaType = fleetVideoMediaType(meta.ref)
    if (
      !mediaType ||
      meta.scope !== identity.scope ||
      meta.botId !== identity.botId ||
      meta.fileId !== identity.fileId ||
      meta.ref.id !== identity.fileId
    )
      return null
    try {
      const stat = await lstat(files.media)
      if (!stat.isFile() || stat.size !== meta.ref.byteSize) return null
    } catch {
      return null
    }
    return { path: files.media, ref: meta.ref, mediaType }
  }

  private async touch(file: string): Promise<void> {
    const at = new Date(this.options.now?.() ?? Date.now())
    await utimes(file, at, at).catch(() => undefined)
  }

  private async download(
    key: string,
    identity: Omit<Meta, 'version' | 'ref'>,
    openFile: FleetMediaOpen,
    signal?: AbortSignal
  ): Promise<FleetMediaEntry> {
    const root = this.options.root()
    await mkdir(root, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    const { ref, response } = await openFile(signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing file body')
    const files = this.files(key)
    const partial = path.join(root, `.${key}.${randomUUID()}.partial`)
    const temporary = path.join(root, `.${key}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const mediaType = fleetVideoMediaType(ref)
      if (!mediaType || ref.id !== identity.fileId) throw new Error('FLEET_MEDIA_UNSUPPORTED')
      handle = await open(partial, 'wx', 0o600)
      let size = 0
      let reported = 0
      for (;;) {
        signal?.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > ref.byteSize || size > FLEET_FILE_LIMITS.downloadMaxBytes) throw new Error('File too large')
        let offset = 0
        while (offset < next.value.byteLength) {
          const { bytesWritten } = await handle.write(next.value, offset, next.value.byteLength - offset)
          if (!bytesWritten) throw new Error('File write failed')
          offset += bytesWritten
        }
        // Every 1% is enough for a progress bar and keeps a 100 MiB video to about a hundred messages.
        if (size - reported >= ref.byteSize / 100) {
          reported = size
          this.options.onProgress?.({
            scope: identity.scope,
            botId: identity.botId,
            fileId: identity.fileId,
            received: size,
            total: ref.byteSize,
          })
        }
      }
      if (size !== ref.byteSize) throw new Error('Incomplete file')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(partial, files.media)
      await this.touch(files.media)
      const meta: Meta = { version: 1, ...identity, ref }
      await writeAtomically(temporary, files.meta, JSON.stringify(meta))
      return { path: files.media, ref, mediaType }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await handle?.close().catch(() => undefined)
      await unlink(partial).catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  /** Removes interrupted copies, then the least recently used videos until the cache fits. */
  private evict(keep: string): Promise<void> {
    const run = this.sweeping.then(async () => {
      const root = this.options.root()
      const names = await readdir(root).catch(() => [] as string[])
      const busy = (key: string) => key === keep || this.inflight.has(key)
      const entries = new Map<string, { media?: number; used?: number; meta?: boolean }>()
      for (const name of names) {
        const temporary = temporaryName.exec(name)
        if (temporary) {
          if (!busy(temporary[1]!)) await rm(path.join(root, name), { force: true }).catch(() => undefined)
          continue
        }
        const match = entryName.exec(name)
        if (!match) continue
        const entry = entries.get(match[1]!) ?? {}
        if (match[2] === 'json') entry.meta = true
        else {
          const stat = await lstat(path.join(root, name)).catch(() => null)
          if (stat?.isFile()) {
            entry.media = stat.size
            entry.used = stat.mtimeMs
          }
        }
        entries.set(match[1]!, entry)
      }
      const complete: { key: string; size: number; used: number }[] = []
      for (const [key, entry] of entries) {
        if (entry.meta && entry.media !== undefined) complete.push({ key, size: entry.media, used: entry.used ?? 0 })
        else if (!busy(key)) await this.remove(key)
      }
      let total = complete.reduce((sum, entry) => sum + entry.size, 0)
      const limit = this.options.maxBytes ?? FLEET_MEDIA_CACHE_MAX_BYTES
      for (const entry of complete.sort((a, b) => a.used - b.used)) {
        if (total <= limit) break
        if (busy(entry.key)) continue
        await this.remove(entry.key)
        total -= entry.size
      }
    })
    this.sweeping = run.catch(() => undefined)
    return run
  }

  private async remove(key: string): Promise<void> {
    const files = this.files(key)
    // The sidecar goes first: a video without one is never served, whatever happens next.
    await rm(files.meta, { force: true }).catch(() => undefined)
    await rm(files.media, { force: true }).catch(() => undefined)
  }

  /** Forgets one video, as when its bot deleted it; a download of it running now finishes first. */
  async forget(scope: string, botId: string, fileId: string): Promise<void> {
    const key = this.key(scope, botId, fileId)
    await this.inflight.get(key)?.catch(() => undefined)
    await this.remove(key)
  }

  /** Forgets every video of a bot, as when it is removed. */
  async purgeBot(scope: string, botId: string): Promise<void> {
    await this.purge((meta) => meta.scope === scope && meta.botId === botId)
  }

  /** Forgets every video fetched through one pairing, as when this computer leaves that server. */
  async purgeScope(scope: string): Promise<void> {
    await this.purge((meta) => meta.scope === scope)
  }

  private async purge(matches: (meta: { scope: string; botId: string }) => boolean): Promise<void> {
    const root = this.options.root()
    const names = await readdir(root).catch(() => [] as string[])
    for (const name of names) {
      const match = entryName.exec(name)
      if (match?.[2] !== 'json' || this.inflight.has(match[1]!)) continue
      try {
        const meta = metaSchema.parse(JSON.parse(await readFile(path.join(root, name), 'utf8')))
        if (matches(meta)) await this.remove(match[1]!)
      } catch {
        /* An unreadable sidecar is removed by the next sweep. */
      }
    }
  }

  /** Forgets every video, as when this computer's local data is reset. */
  async clear(): Promise<void> {
    await rm(this.options.root(), { recursive: true, force: true })
  }
}

async function writeAtomically(temporary: string, target: string, text: string): Promise<void> {
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
}
