import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FLEET_FILE_LIMITS,
  FLEET_FILE_SETTINGS_DEFAULT,
  fleetFileOriginSchema,
  fleetFileQuotaBytes,
  fleetFileRefSchema,
  fleetFileSettingsSchema,
  type FleetFileOrigin,
  type FleetFileRef,
  type FleetFileSettings,
  type FleetFilesUsage,
  type FleetPublishedFile,
  type FleetRemovedFile,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'

export type StoredFleetFile = Omit<FleetPublishedFile, 'originGone'>
export type FleetFileQuotaReason = 'count' | 'space' | 'size'
export class FleetFileQuotaError extends Error {
  constructor(
    readonly reason: FleetFileQuotaReason,
    readonly fileBytes: number,
    readonly usage: FleetFilesUsage
  ) {
    super(`Published file ${reason} limit reached.`)
  }
}
export class FleetFileSettingsError extends Error {}

const fileId = /^f-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const storedFileSchema = fleetFileRefSchema
  .strict()
  .extend({ id: z.string().regex(fileId), sharedAt: z.iso.datetime(), origin: fleetFileOriginSchema })
const manifestV1Schema = z
  .object({
    version: z.literal(1),
    files: z
      .array(fleetFileRefSchema.strict().extend({ id: z.string().regex(fileId) }))
      .max(FLEET_FILE_LIMITS.publishedCountMax),
  })
  .strict()
const manifestV2Schema = z
  .object({
    version: z.literal(2),
    settings: fleetFileSettingsSchema,
    /** Every file's origin was looked for (version 1 files start without one). */
    originsKnown: z.boolean(),
    updatedAt: z.iso.datetime().nullable(),
    files: z.array(storedFileSchema).max(FLEET_FILE_LIMITS.publishedCountMax),
    removed: z
      .array(z.object({ id: z.string().regex(fileId), removedAt: z.iso.datetime() }).strict())
      .max(FLEET_FILE_LIMITS.removedKeptMax),
  })
  .strict()
const manifestSchema = z.discriminatedUnion('version', [manifestV1Schema, manifestV2Schema])
type State = Omit<z.infer<typeof manifestV2Schema>, 'version' | 'files'> & { files: StoredFleetFile[] }

const mime: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.gz': 'application/gzip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
function displayName(value: string): string {
  const clean = path.posix
    .basename(value.replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  // Replace lone surrogates, and never truncate in the middle of a Unicode character.
  return (
    Buffer.from(clean, 'utf8')
      .toString('utf8')
      .slice(0, 200)
      .replace(/[\uD800-\uDBFF]$/, '') || 'download'
  )
}
function same(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Check every component, then bind reads to a verified handle rather than reopening a pathname. */
export async function openScopedFile(root: string, target: string): Promise<FileHandle> {
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('File is outside the allowed directory.')
  const components = [root]
  for (const part of relative.split(path.sep)) components.push(path.join(components.at(-1)!, part))
  const before = await Promise.all(components.map((component) => lstat(component)))
  if (
    before.some(
      (stat, index) => stat.isSymbolicLink() || (index === before.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
  )
    throw new Error('Only regular files without symlinks can be shared.')
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const after = await Promise.all(components.map((component) => lstat(component)))
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      !same(stat, before.at(-1)!) ||
      after.some((item, index) => !same(item, before[index]!)) ||
      (await realpath(root)) !== root ||
      (await realpath(target)) !== target
    )
      throw new Error('File changed while opening.')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Private immutable snapshots, with where each was shared. Quotas refuse new publications; the owner deletes them. */
export class FleetFileStore {
  private refs = new Map<string, StoredFleetFile>()
  private state: Omit<State, 'files'> = {
    settings: FLEET_FILE_SETTINGS_DEFAULT,
    originsKnown: true,
    updatedAt: null,
    removed: [],
  }
  private root: string
  private loaded = false
  private rootIdentity: { dev: number; ino: number } | undefined
  private pending: Promise<unknown> = Promise.resolve()

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run)
    this.pending = result.catch(() => undefined)
    return result
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get needsOrigins(): boolean {
    return this.loaded && !this.state.originsKnown
  }

  async load(): Promise<void> {
    return this.serialize(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error('File store cannot be a symlink.')
      this.root = await realpath(this.root)
      const identity = await lstat(this.root)
      if (this.rootIdentity && !same(this.rootIdentity, identity)) throw new Error('File store directory changed.')
      this.rootIdentity = identity
      let handle: FileHandle
      try {
        handle = await openScopedFile(this.root, path.join(this.root, 'manifest.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.refs = new Map()
        this.state = {
          settings: FLEET_FILE_SETTINGS_DEFAULT,
          originsKnown: true,
          updatedAt: null,
          removed: [],
        }
        this.loaded = true
        for (const name of await readdir(this.root))
          if (fileId.test(name)) await unlink(path.join(this.root, name)).catch(() => undefined)
        return
      }
      try {
        if ((await handle.stat()).size > 1024 * 1024) throw new Error('Invalid file manifest.')
        const buffer = Buffer.alloc(1024 * 1024 + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length === buffer.length) throw new Error('Invalid file manifest.')
        const manifest = manifestSchema.parse(JSON.parse(buffer.toString('utf8', 0, length)))
        const files: StoredFleetFile[] =
          manifest.version === 1
            ? await Promise.all(
                manifest.files.map(async (ref) => ({
                  ...ref,
                  sharedAt:
                    (await lstat(path.join(this.root, ref.id)).catch(() => null))?.mtime.toISOString() ??
                    new Date().toISOString(),
                  origin: { kind: 'unknown' as const },
                }))
              )
            : manifest.files
        const refs = new Map(files.map((file) => [file.id, Object.freeze(file)]))
        if (
          refs.size !== files.length ||
          files.reduce((sum, file) => sum + file.byteSize, 0) >
            fleetFileQuotaBytes(FLEET_FILE_LIMITS.publishedQuotaGbMax)
        )
          throw new Error('Invalid file manifest quota.')
        this.refs = refs
        this.state =
          manifest.version === 1
            ? {
                settings: FLEET_FILE_SETTINGS_DEFAULT,
                originsKnown: false,
                updatedAt: null,
                removed: [],
              }
            : {
                settings: manifest.settings,
                originsKnown: manifest.originsKnown,
                updatedAt: manifest.updatedAt,
                removed: manifest.removed,
              }
        this.loaded = true
      } finally {
        await handle.close()
      }
      // A delete renames the manifest before it unlinks: a crash in between leaves blobs no manifest names.
      for (const name of await readdir(this.root))
        if (fileId.test(name) && !this.refs.has(name)) await unlink(path.join(this.root, name)).catch(() => undefined)
    })
  }

  private async checkRoot(): Promise<void> {
    const stat = await lstat(this.root)
    if (
      !this.rootIdentity ||
      !stat.isDirectory() ||
      !same(stat, this.rootIdentity) ||
      (await realpath(this.root)) !== this.root
    )
      throw new Error('File store directory changed.')
  }

  /** Replaces the manifest with `next`, then adopts it; nothing changes in memory when the replacement fails. */
  private async commit(next: State): Promise<void> {
    const temporary = path.join(this.root, `.manifest-${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 2, ...next, files: next.files }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.checkRoot()
      await rename(temporary, path.join(this.root, 'manifest.json'))
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    this.refs = new Map(next.files.map((file) => [file.id, Object.freeze(file)]))
    const { files: _files, ...state } = next
    this.state = state
  }

  private snapshot(): State {
    return { ...this.state, files: [...this.refs.values()] }
  }

  meta(id: string): FleetFileRef | null {
    const file = this.refs.get(id)
    if (!file) return null
    const { sharedAt: _sharedAt, origin: _origin, ...ref } = file
    return Object.freeze(ref)
  }

  list(): StoredFleetFile[] {
    return [...this.refs.values()]
  }

  removedFiles(): FleetRemovedFile[] {
    return [...this.state.removed]
  }

  settings(): FleetFileSettings {
    return this.state.settings
  }

  usage(): FleetFilesUsage {
    const files = [...this.refs.values()]
    return {
      usedBytes: files.reduce((sum, file) => sum + file.byteSize, 0),
      count: files.length,
      quotaBytes: fleetFileQuotaBytes(this.state.settings.quotaGb),
      countMax: FLEET_FILE_LIMITS.publishedCountMax,
      deleteWithConversations: this.state.settings.deleteWithConversations,
      updatedAt: this.state.updatedAt,
    }
  }

  idsFrom(laneId: string): string[] {
    return [...this.refs.values()]
      .filter(
        (file) =>
          (file.origin.kind === 'routine' && file.origin.runId === laneId) ||
          (file.origin.kind === 'thread' && file.origin.threadId === laneId)
      )
      .map((file) => file.id)
  }

  async diskFreeBytes(): Promise<number | null> {
    try {
      const stats = await statfs(this.root)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return null
    }
  }

  async open(id: string): Promise<{ ref: FleetFileRef; handle: FileHandle } | null> {
    const ref = this.meta(id)
    if (!ref) return null
    await this.checkRoot()
    let handle: FileHandle
    try {
      handle = await openScopedFile(this.root, path.join(this.root, id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      if ((await handle.stat()).size !== ref.byteSize)
        throw new Error('Published file size does not match its metadata.')
      return { ref, handle }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  publish(
    source: { root: string; target: string },
    options: { name?: string; origin?: FleetFileOrigin } = {}
  ): Promise<FleetFileRef> {
    const { name, origin = { kind: 'primary' } } = options
    return this.serialize(async () => {
      if (!this.loaded) throw new Error('File store has not loaded.')
      if (this.refs.size >= FLEET_FILE_LIMITS.publishedCountMax)
        throw new FleetFileQuotaError('count', 0, this.usage())
      const input = await openScopedFile(path.resolve(source.root), path.resolve(source.target))
      const id = `f-${randomUUID()}`
      const target = path.join(this.root, id)
      let created = false
      try {
        const before = await input.stat()
        const usage = this.usage()
        if (before.size > FLEET_FILE_LIMITS.downloadMaxBytes)
          throw new FleetFileQuotaError('size', before.size, usage)
        const free = usage.quotaBytes - usage.usedBytes
        if (before.size > free) throw new FleetFileQuotaError('space', before.size, usage)
        const limit = Math.min(FLEET_FILE_LIMITS.downloadMaxBytes, free)
        await this.checkRoot()
        const output = await open(target, 'wx', 0o600)
        created = true
        let byteSize = 0
        try {
          const buffer = Buffer.alloc(64 * 1024)
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
            if (!bytesRead) break
            byteSize += bytesRead
            if (byteSize > limit)
              throw new FleetFileQuotaError(
                byteSize > FLEET_FILE_LIMITS.downloadMaxBytes ? 'size' : 'space',
                byteSize,
                usage
              )
            let offset = 0
            while (offset < bytesRead) {
              const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
              if (!bytesWritten) throw new Error('Could not write published file.')
              offset += bytesWritten
            }
          }
          const after = await input.stat()
          if (
            byteSize !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          )
            throw new Error('Source file changed while publishing.')
          await output.sync()
        } finally {
          await output.close()
        }
        const safeName = displayName(name ?? path.basename(source.target))
        const ref = Object.freeze(
          fleetFileRefSchema.parse({
            id,
            name: safeName,
            mediaType: mime[path.extname(safeName).toLowerCase()] ?? 'application/octet-stream',
            byteSize,
          })
        )
        const stored: StoredFleetFile = Object.freeze({
          ...ref,
          sharedAt: new Date().toISOString(),
          origin,
        })
        const current = this.snapshot()
        await this.commit({
          ...current,
          files: [...current.files, stored],
          updatedAt: stored.sharedAt,
        })
        return ref
      } catch (error) {
        if (created) await unlink(target).catch(() => undefined)
        throw error
      } finally {
        await input.close()
      }
    })
  }

  remove(ids: readonly string[]): Promise<{ deleted: string[]; freedBytes: number }> {
    return this.serialize(async () => {
      if (!this.loaded) throw new Error('File store has not loaded.')
      const deleted = [...new Set(ids)].filter((id) => this.refs.has(id))
      if (!deleted.length) return { deleted, freedBytes: 0 }
      const at = new Date().toISOString()
      const freedBytes = deleted.reduce((sum, id) => sum + this.refs.get(id)!.byteSize, 0)
      const current = this.snapshot()
      await this.commit({
        ...current,
        files: current.files.filter((file) => !deleted.includes(file.id)),
        removed: [...current.removed, ...deleted.map((id) => ({ id, removedAt: at }))].slice(
          -FLEET_FILE_LIMITS.removedKeptMax
        ),
        updatedAt: at,
      })
      for (const id of deleted) await unlink(path.join(this.root, id)).catch(() => undefined)
      return { deleted, freedBytes }
    })
  }

  setSettings(next: FleetFileSettings): Promise<FleetFilesUsage> {
    return this.serialize(async () => {
      if (!this.loaded) throw new Error('File store has not loaded.')
      if (fleetFileQuotaBytes(next.quotaGb) < this.usage().usedBytes)
        throw new FleetFileSettingsError('The space is smaller than what the shared files take.')
      const current = this.snapshot()
      await this.commit({
        ...current,
        settings: next,
        updatedAt: new Date().toISOString(),
      })
      return this.usage()
    })
  }

  assignOrigins(found: ReadonlyMap<string, { origin: FleetFileOrigin; sharedAt: string }>): Promise<void> {
    return this.serialize(async () => {
      if (!this.loaded) throw new Error('File store has not loaded.')
      const current = this.snapshot()
      const files = current.files.map((file) => {
        if (file.origin.kind !== 'unknown') return file
        const match = found.get(file.id)
        return match ? { ...file, origin: match.origin, sharedAt: match.sharedAt } : file
      })
      await this.commit({
        ...current,
        files,
        originsKnown: true,
      })
    })
  }
}
