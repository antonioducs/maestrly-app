import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ArtifactHostError } from '../errors.js'

const SHA256 = /^[0-9a-f]{64}$/
const PREFIX = /^[0-9a-f]{2}$/

/**
 * Content-addressed file storage. Files are written to `tmp/` and renamed into `<sha[0..2]>/<sha>`, so a reader
 * never sees a partial blob and an interrupted write leaves only a temporary file.
 */
export class BlobStore {
  private bytes = 0
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly tmp: string

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.tmp = path.join(root, 'tmp')
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 })
    for (const sha of this.listAll()) this.bytes += statSync(this.pathFor(sha)).size
  }

  static sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }

  pathFor(sha: string): string {
    if (!SHA256.test(sha)) throw new ArtifactHostError('storage', 'Invalid blob hash')
    return path.join(this.root, sha.slice(0, 2), sha)
  }

  has(sha: string): boolean {
    return existsSync(this.pathFor(sha))
  }

  async put(bytes: Uint8Array): Promise<string> {
    const sha = BlobStore.sha256(bytes)
    const pending = this.inflight.get(sha)
    if (pending) {
      await pending
      return sha
    }
    if (this.has(sha)) return sha
    const write = this.write(sha, bytes).finally(() => this.inflight.delete(sha))
    this.inflight.set(sha, write)
    await write
    return sha
  }

  private async write(sha: string, bytes: Uint8Array): Promise<void> {
    const temp = path.join(this.tmp, randomBytes(12).toString('hex'))
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      mkdirSync(path.dirname(this.pathFor(sha)), { recursive: true, mode: 0o700 })
      await rename(temp, this.pathFor(sha))
      this.bytes += bytes.byteLength
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw new ArtifactHostError('storage', `Could not store a file: ${(error as Error).message}`)
    }
  }

  async read(sha: string): Promise<Uint8Array | null> {
    const file = this.pathFor(sha)
    try {
      const stat = await lstat(file)
      if (!stat.isFile()) return null
      return new Uint8Array(await readFile(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ArtifactHostError('storage', 'Could not read a stored file')
    }
  }

  async remove(sha: string): Promise<void> {
    const file = this.pathFor(sha)
    try {
      const { size } = await lstat(file)
      await rm(file, { force: true })
      this.bytes = Math.max(0, this.bytes - size)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  listAll(): string[] {
    const hashes: string[] = []
    for (const prefix of readdirSync(this.root)) {
      if (!PREFIX.test(prefix)) continue
      const dir = path.join(this.root, prefix)
      if (!lstatSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) {
        if (SHA256.test(name) && name.startsWith(prefix) && lstatSync(path.join(dir, name)).isFile()) hashes.push(name)
      }
    }
    return hashes.sort()
  }

  totalBytes(): number {
    return this.bytes
  }

  clearTemp(): void {
    for (const name of readdirSync(this.tmp)) rmSync(path.join(this.tmp, name), { recursive: true, force: true })
  }
}
