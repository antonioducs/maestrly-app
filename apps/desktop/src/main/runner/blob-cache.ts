import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, statSync, type WriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { type Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import tar from 'tar-stream'
import { errnoOf } from './errors'

/**
 * The blobs of one bot (a scope) on this computer: file contents named by their SHA-256, kept at
 * `<root>/<scope>/<aa>/<digest>` so a job asks its environment only for what it lacks. A blob enters the cache only
 * after its digest and size were checked, and a file in the cache is never written again, so a job that changes a file
 * it was given changes a copy.
 */

const DIGEST = /^[a-f0-9]{64}$/
const TEMP = '.tmp'
const TOUCH_BATCH = 64

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new Error('Invalid blob digest')
}

export interface BlobIngestResult {
  /** Blobs that arrived whole and were kept. */
  added: string[]
  /** Names of entries that were not kept: a different digest or size than asked, a repeat, or not asked for at all. */
  mismatched: string[]
}

interface CachedBlob {
  file: string
  digest: string
  size: number
  mtimeMs: number
}

export class BlobCache {
  /**
   * @param root the folder that holds every scope's blobs
   * @param scope the bot this cache serves
   */
  constructor(
    readonly root: string,
    readonly scope: string
  ) {}

  get dir(): string {
    return path.join(this.root, this.scope)
  }

  /** Where a blob is, or would be. */
  path(digest: string): string {
    assertDigest(digest)
    return path.join(this.dir, digest.slice(0, 2), digest)
  }

  has(digest: string): boolean {
    try {
      return statSync(this.path(digest)).isFile()
    } catch {
      return false
    }
  }

  /** The digests the cache lacks, each once, in the order given. */
  missing(digests: Iterable<string>): string[] {
    const seen = new Set<string>()
    const lacking: string[] = []
    for (const digest of digests) {
      if (seen.has(digest)) continue
      seen.add(digest)
      if (!this.has(digest)) lacking.push(digest)
    }
    return lacking
  }

  /**
   * Reads an answer of the blobs route, a tar compressed with zstd of files named by digest, and keeps each file whose
   * digest and size are the ones asked for (`expected`, digest to size). Anything else is discarded and reported. A
   * stream that ends early, or cannot be read, throws; what was kept before stays.
   */
  async ingest(
    stream: Readable,
    expected: ReadonlyMap<string, number>,
    signal?: AbortSignal
  ): Promise<BlobIngestResult> {
    for (const digest of expected.keys()) assertDigest(digest)
    const temporary = path.join(this.dir, TEMP)
    await mkdir(temporary, { recursive: true })
    const added: string[] = []
    const mismatched: string[] = []
    const seen = new Set<string>()
    // Files being written, so a stream that dies mid-entry leaves none behind.
    const writing = new Map<string, WriteStream>()
    const reject = (name: string) => mismatched.push(name.slice(0, 128))

    const consume = async (header: tar.Header, entry: Readable): Promise<void> => {
      const size = expected.get(header.name)
      if (header.type !== 'file' || size === undefined || seen.has(header.name)) return void reject(header.name)
      seen.add(header.name)
      if ((header.size ?? 0) !== size) return void reject(header.name)
      const partial = path.join(temporary, randomUUID())
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk)
          bytes += chunk.length
          callback(null, chunk)
        },
      })
      const sink = createWriteStream(partial, { flags: 'wx', mode: 0o600 })
      writing.set(partial, sink)
      try {
        await pipeline(entry, meter, sink)
        if (bytes !== size || hash.digest('hex') !== header.name) return void reject(header.name)
        const destination = this.path(header.name)
        await mkdir(path.dirname(destination), { recursive: true })
        await rename(partial, destination)
        added.push(header.name)
      } finally {
        writing.delete(partial)
        await rm(partial, { force: true })
      }
    }

    const extract = tar.extract()
    extract.on('entry', (header, body, next) => {
      const entry = body as unknown as Readable
      consume(header, entry).then(
        () => {
          entry.resume()
          next()
        },
        (error: unknown) => {
          entry.resume()
          next(error as Error)
        }
      )
    })
    try {
      await pipeline(stream, createZstdDecompress(), extract as unknown as Writable, signal ? { signal } : {})
    } catch (error) {
      for (const [partial, sink] of writing) {
        sink.destroy()
        if (!sink.closed) await new Promise<void>((resolve) => sink.once('close', () => resolve()))
        await rm(partial, { force: true })
      }
      throw error
    }
    return { added, mismatched }
  }

  /** Marks blobs as used now, so eviction takes the ones unused longest first. */
  async touch(digests: Iterable<string>): Promise<void> {
    const all = [...new Set(digests)]
    const now = new Date()
    for (let start = 0; start < all.length; start += TOUCH_BATCH)
      await Promise.all(
        all.slice(start, start + TOUCH_BATCH).map((digest) =>
          utimes(this.path(digest), now, now).catch((error: unknown) => {
            if (errnoOf(error) !== 'ENOENT') throw error
          })
        )
      )
  }

  /** Every blob of every scope under the root. */
  private async *blobs(): AsyncGenerator<CachedBlob> {
    for (const scope of await readdir(this.root).catch(() => [] as string[])) {
      for (const prefix of await readdir(path.join(this.root, scope)).catch(() => [] as string[])) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue
        const folder = path.join(this.root, scope, prefix)
        for (const digest of await readdir(folder).catch(() => [] as string[])) {
          const file = path.join(folder, digest)
          const info = await stat(file).catch(() => null)
          if (info?.isFile()) yield { file, digest, size: info.size, mtimeMs: info.mtimeMs }
        }
      }
    }
  }

  /** Bytes of the blobs of every scope: what the cache cap bounds. */
  async bytes(): Promise<number> {
    let total = 0
    for await (const blob of this.blobs()) total += blob.size
    return total
  }

  /**
   * Deletes blobs, least recently used first across every scope, until all together fit in `capBytes`. Blobs whose
   * digest is in `keep` stay, in any scope: a digest names a content, so keeping a twin of it costs little. Returns the
   * bytes freed.
   */
  async evict(capBytes: number, keep: ReadonlySet<string>): Promise<number> {
    const all: CachedBlob[] = []
    let total = 0
    for await (const blob of this.blobs()) {
      all.push(blob)
      total += blob.size
    }
    if (total <= capBytes) return 0
    all.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))
    let freed = 0
    for (const blob of all) {
      if (total <= capBytes) break
      if (keep.has(blob.digest)) continue
      await rm(blob.file, { force: true })
      total -= blob.size
      freed += blob.size
    }
    return freed
  }

  /** Deletes the half-written files an interrupted ingest left in every scope; none may be running. */
  static async sweepTemporary(root: string): Promise<void> {
    for (const scope of await readdir(root).catch(() => [] as string[]))
      await rm(path.join(root, scope, TEMP), { recursive: true, force: true })
  }
}
