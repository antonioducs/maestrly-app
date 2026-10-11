import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { FLEET_FILE_LIMITS, fleetFileRefSchema, type FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'

const fileId = /^f-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const manifestSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(fleetFileRefSchema.strict().extend({ id: z.string().regex(fileId) }))
      .max(FLEET_FILE_LIMITS.publishedCountMax),
  })
  .strict()
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

/** Private immutable snapshots. Quotas refuse new publications; only bot purge removes retained files. */
export class FleetFileStore {
  private refs = new Map<string, FleetFileRef>()
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
        this.loaded = true
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
        const refs = new Map(manifest.files.map((ref) => [ref.id, Object.freeze(ref)]))
        if (
          refs.size !== manifest.files.length ||
          manifest.files.reduce((sum, ref) => sum + ref.byteSize, 0) > FLEET_FILE_LIMITS.publishedTotalMaxBytes
        )
          throw new Error('Invalid file manifest quota.')
        this.refs = refs
        this.loaded = true
      } finally {
        await handle.close()
      }
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

  meta(id: string): FleetFileRef | null {
    return this.refs.get(id) ?? null
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

  publish(source: { root: string; target: string }, name?: string): Promise<FleetFileRef> {
    return this.serialize(async () => {
      if (!this.loaded) throw new Error('File store has not loaded.')
      if (this.refs.size >= FLEET_FILE_LIMITS.publishedCountMax) throw new Error('Published file count quota reached.')
      const input = await openScopedFile(path.resolve(source.root), path.resolve(source.target))
      const id = `f-${randomUUID()}`
      const target = path.join(this.root, id)
      const temporary = path.join(this.root, `.manifest-${randomUUID()}.tmp`)
      let created = false
      try {
        const before = await input.stat()
        const total = [...this.refs.values()].reduce((sum, ref) => sum + ref.byteSize, 0)
        const limit = Math.min(FLEET_FILE_LIMITS.downloadMaxBytes, FLEET_FILE_LIMITS.publishedTotalMaxBytes - total)
        if (before.size > limit) throw new Error('Published file size quota exceeded.')
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
            if (byteSize > limit) throw new Error('Published file size quota exceeded.')
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
        const manifest = await open(temporary, 'wx', 0o600)
        try {
          await manifest.writeFile(JSON.stringify({ version: 1, files: [...this.refs.values(), ref] }))
          await manifest.sync()
        } finally {
          await manifest.close()
        }
        await this.checkRoot()
        await rename(temporary, path.join(this.root, 'manifest.json'))
        this.refs.set(id, ref)
        return ref
      } catch (error) {
        if (created) await unlink(target).catch(() => undefined)
        throw error
      } finally {
        await input.close()
        await unlink(temporary).catch(() => undefined)
      }
    })
  }
}
