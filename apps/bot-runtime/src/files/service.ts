import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { link, lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FILE_CHUNK_BYTES, type BotFile, type HostToGuestRequest } from '@maestrly/host-protocol'
type WriteParams = Extract<HostToGuestRequest, { method: 'files.write' }>['params']
export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
export class FileService {
  private transfers = new Map<
    string,
    { path: string; temp: string; offset: number; overwrite: boolean; expectedDigest?: string }
  >()
  constructor(readonly workspace: string) {}
  async init() {
    await mkdir(this.workspace, { recursive: true })
    this.workspaceRoot = await realpath(this.workspace)
  }
  private workspaceRoot = ''
  async safePath(path: string, missing = false): Promise<string> {
    if (!this.workspaceRoot) await this.init()
    if (
      isAbsolute(path) ||
      path.includes('\0') ||
      path.split(/[\\/]/).some((p) => p === '..' || p === '.maestrly-private')
    )
      throw new Error('Invalid workspace path')
    const target = resolve(this.workspaceRoot, path)
    let check = target
    for (;;) {
      try {
        const actual = await realpath(check)
        if (actual !== this.workspaceRoot && !actual.startsWith(`${this.workspaceRoot}${sep}`))
          throw new Error('Path escapes workspace')
        if (relative(this.workspaceRoot, actual).split(sep).includes('.maestrly-private'))
          throw new Error('Private path')
        const info = await stat(actual)
        if (!info.isFile() && !info.isDirectory()) throw new Error('Unsupported file type')
        return check === target ? actual : target
      } catch (error) {
        if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || check === this.workspaceRoot) throw error
        // A dangling symlink is never a valid new target.
        const entry = await lstat(check).catch(() => undefined)
        if (entry?.isSymbolicLink()) throw new Error('Dangling symlink')
        check = dirname(check)
      }
    }
  }
  private async file(path: string) {
    const target = await this.safePath(path)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) {
      await handle.close()
      throw new Error('Not a regular file')
    }
    return handle
  }
  private async hash(path: string) {
    const handle = await this.file(path)
    try {
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      return hash.digest('hex')
    } finally {
      await handle.close()
    }
  }
  async list({ path }: { path: string }): Promise<BotFile[]> {
    const target = await this.safePath(path)
    if (!(await stat(target)).isDirectory()) throw new Error('Not a directory')
    const entries: BotFile[] = []
    for await (const entry of await opendir(target)) {
      if (entries.length >= 2000) break
      if (entry.name === '.maestrly-private' || entry.name.includes('.part-')) continue
      const name = join(path, entry.name)
      try {
        const safe = await this.safePath(name)
        const info = await stat(safe)
        entries.push({
          path: name,
          name: entry.name,
          kind: info.isDirectory() ? 'directory' : 'file',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        })
      } catch {
        /* Unsafe entries are not exposed. */
      }
    }
    return entries
  }
  async stat({ path }: { path: string }) {
    const info = await stat(await this.safePath(path))
    return {
      kind: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      digest: info.isFile() ? await this.hash(path) : digest(''),
      modifiedAt: info.mtime.toISOString(),
    }
  }
  async read({ path, offset, length }: { path: string; offset: number; length: number }) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > FILE_CHUNK_BYTES
    )
      throw new Error('Invalid read range')
    const handle = await this.file(path)
    try {
      // Hash and select the range from the same pass over the same opened file.
      const hash = createHash('sha256')
      const selected: Buffer[] = []
      let position = 0
      for await (const raw of handle.createReadStream({ autoClose: false })) {
        const chunk = Buffer.from(raw)
        hash.update(chunk)
        const start = Math.max(0, offset - position)
        const end = Math.min(chunk.length, offset + length - position)
        if (end > start) selected.push(chunk.subarray(start, end))
        position += chunk.length
      }
      return { dataBase64: Buffer.concat(selected).toString('base64'), digest: hash.digest('hex') }
    } finally {
      await handle.close()
    }
  }
  async write(params: WriteParams) {
    if (!/^[a-zA-Z0-9_-]+$/.test(params.transferId)) throw new Error('Invalid transfer id')
    const data = Buffer.from(params.dataBase64, 'base64')
    if (data.length > FILE_CHUNK_BYTES || data.toString('base64') !== params.dataBase64)
      throw new Error('Invalid file chunk')
    let transfer = this.transfers.get(params.transferId)
    if (!transfer) {
      if (params.offset !== 0) throw new Error('Transfer must start at zero')
      const target = await this.safePath(params.path, true)
      await mkdir(dirname(target), { recursive: true })
      await this.safePath(params.path, true)
      const temp = `${params.path}.part-${params.transferId}`
      const tempPath = await this.safePath(temp, true)
      const handle = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      await handle.close()
      transfer = {
        path: params.path,
        temp,
        offset: 0,
        overwrite: params.overwrite,
        expectedDigest: params.expectedDigest,
      }
      this.transfers.set(params.transferId, transfer)
    }
    if (
      transfer.path !== params.path ||
      transfer.offset !== params.offset ||
      transfer.overwrite !== params.overwrite ||
      transfer.expectedDigest !== params.expectedDigest
    )
      throw new Error('Transfer parameters changed')
    const handle = await open(
      await this.safePath(transfer.temp),
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Not a regular file')
      let written = 0
      while (written < data.length)
        written += (await handle.write(data, written, data.length - written, params.offset + written)).bytesWritten
      await handle.sync()
    } finally {
      await handle.close()
    }
    transfer.offset += data.length
    if (!params.final) return { written: data.length }
    const fileDigest = await this.hash(transfer.temp)
    if (params.expectedDigest && fileDigest !== params.expectedDigest) throw new Error('Digest mismatch')
    const target = await this.safePath(params.path, true)
    const temp = await this.safePath(transfer.temp)
    if (params.overwrite) await rename(temp, target)
    else {
      await link(temp, target)
      await unlink(temp)
    } // Atomic no-clobber publication.
    this.transfers.delete(params.transferId)
    return { written: data.length, digest: fileDigest }
  }
  async abort({ transferId }: { transferId: string }) {
    const transfer = this.transfers.get(transferId)
    if (transfer) {
      await unlink(await this.safePath(transfer.temp)).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      this.transfers.delete(transferId)
    }
    return { aborted: true }
  }
  async snapshot() {
    const result = new Map<string, string>()
    const visited = new Set<string>()
    const visit = async (path: string, depth: number) => {
      if (depth > 32 || result.size >= 20_000) return
      const actual = await this.safePath(path)
      if (visited.has(actual)) return
      visited.add(actual)
      for (const entry of await this.list({ path })) {
        if (entry.kind === 'directory') await visit(entry.path, depth + 1)
        else result.set(entry.path, `${entry.modifiedAt}:${entry.size}`)
      }
    }
    await visit('', 0)
    return result
  }
  async produced(before: Map<string, string>) {
    const after = await this.snapshot()
    const result = []
    for (const [path, fingerprint] of after) {
      if (before.get(path) === fingerprint) continue
      const info = await this.stat({ path })
      result.push({ path, name: basename(path), size: info.size, digest: info.digest })
      if (result.length === 200) break
    }
    return result
  }
}
