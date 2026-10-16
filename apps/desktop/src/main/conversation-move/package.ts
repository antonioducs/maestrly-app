import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { FLEET_HOST_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import tar from 'tar-stream'
import { z } from 'zod'
import {
  CONVERSATION_MOVE_PACKAGE_FORMAT,
  CONVERSATION_MOVE_PACKAGE_VERSION,
  type MoveDigest,
} from '../../shared/conversation-move'
import { hashFile } from '../transfer-io'
import { MoveError } from './errors'
import type { GitSnapshot } from './git-snapshot'
import type { MoveRows } from './rows'

/**
 * The one file a conversation move carries between hosts: a zstd-compressed tar whose first entry is a manifest that
 * declares every other entry by size and SHA-256. Reading it trusts nothing the manifest does not declare.
 */
export type MoveFileKind = 'attachment' | 'generated-image' | 'note' | 'ignored' | 'bundle'
export const MOVE_FILE_KINDS: readonly MoveFileKind[] = ['attachment', 'generated-image', 'note', 'ignored', 'bundle']

export interface MovePackageEntry {
  /** Where the entry sits in the package and, once extracted, under the extraction folder. */
  path: string
  kind: MoveFileKind
  relative: string
  size: number
  sha256: string
  mode: number
}
export interface MovePackageManifest {
  format: typeof CONVERSATION_MOVE_PACKAGE_FORMAT
  version: number
  appVersion: string
  operationId: string
  conversationId: string
  createdAt: number
  digest: MoveDigest
  snapshot: GitSnapshot
  rows: { size: number; sha256: string }
  entries: MovePackageEntry[]
}
export interface MovePackageSource {
  kind: MoveFileKind
  relative: string
  absolute: string
}

export const MOVE_PACKAGE_MAX_BYTES = FLEET_HOST_FILE_LIMITS.maxFileBytes
const MANIFEST = 'manifest.json'
const ROWS = 'rows.json'
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
// A transcript's rows are read whole into memory to be inserted in one transaction.
const MAX_ROWS_BYTES = 1024 * 1024 * 1024
export const BUNDLE_RELATIVE = 'branch.bundle'

const invalid = (message: string): MoveError => new MoveError('package-invalid', message)

/** A relative path that cannot leave the folder it is joined to: no absolute path, `..`, `.git` or NUL. */
export function exactRelative(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw))
    return null
  const segments = raw.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'))
    return null
  return raw
}

export const packageEntryPath = (kind: MoveFileKind, relative: string): string =>
  kind === 'bundle' ? `git/${relative}` : `files/${kind}/${relative}`

const sha = z.string().regex(/^[0-9a-f]{64}$/)
const oid = z.string().regex(/^[0-9a-f]{40,64}$/)
const count = z.number().int().nonnegative()
const manifestSchema = z.object({
  format: z.literal(CONVERSATION_MOVE_PACKAGE_FORMAT),
  version: z.literal(CONVERSATION_MOVE_PACKAGE_VERSION),
  appVersion: z.string().min(1).max(100),
  operationId: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(200),
  createdAt: count,
  digest: z.object({
    conversationId: z.string(),
    messages: count,
    lastSeq: z.number().int(),
    messagesSha256: sha,
    files: count,
    filesSha256: sha,
    headOid: oid,
    indexTree: oid,
    worktreeTree: oid,
  }),
  snapshot: z.object({
    branch: z.string().min(1),
    headOid: oid,
    indexTree: oid,
    worktreeTree: oid,
    indexCommit: oid,
    worktreeCommit: oid,
  }),
  rows: z.object({ size: count.max(MAX_ROWS_BYTES), sha256: sha }),
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(MOVE_FILE_KINDS as [MoveFileKind, ...MoveFileKind[]]),
      relative: z.string(),
      size: count,
      sha256: sha,
      mode: z.number().int().min(0).max(0o7777),
    })
  ),
})

/** Streams manifest.json, rows.json, then each file under files/<kind>/<relative> (the bundle at git/branch.bundle). */
export async function writeMovePackage(
  destination: string,
  input: { manifest: Omit<MovePackageManifest, 'entries' | 'rows'>; rows: MoveRows; sources: MovePackageSource[] }
): Promise<{ path: string; size: number; sha256: string }> {
  const rowsBytes = Buffer.from(JSON.stringify(input.rows))
  const entries: MovePackageEntry[] = []
  const seen = new Set<string>()
  let total = rowsBytes.length
  for (const source of input.sources) {
    const relative = exactRelative(source.relative)
    if (!relative) throw invalid(`Unsafe package path: ${source.relative}`)
    const entryPath = packageEntryPath(source.kind, relative)
    if (seen.has(entryPath)) throw invalid(`Duplicate package path: ${entryPath}`)
    seen.add(entryPath)
    const info = await lstat(source.absolute)
    if (!info.isFile()) throw invalid(`Not a regular file: ${source.absolute}`)
    total += info.size
    entries.push({
      path: entryPath,
      kind: source.kind,
      relative,
      size: info.size,
      sha256: await hashFile(source.absolute),
      mode: info.mode & 0o777,
    })
  }
  if (total > MOVE_PACKAGE_MAX_BYTES) throw invalid('The conversation is too large to move.')
  const manifest: MovePackageManifest = {
    ...input.manifest,
    rows: { size: rowsBytes.length, sha256: createHash('sha256').update(rowsBytes).digest('hex') },
    entries,
  }

  const partial = `${destination}.${randomUUID()}.partial`
  const pack = tar.pack()
  const written = pipeline(pack, createZstdCompress(), createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
  try {
    const add = (name: string, bytes: Buffer) =>
      new Promise<void>((resolve, reject) =>
        pack.entry({ name, size: bytes.length, mode: 0o600 }, bytes, (error) => (error ? reject(error) : resolve()))
      )
    await add(MANIFEST, Buffer.from(JSON.stringify(manifest)))
    await add(ROWS, rowsBytes)
    for (const [index, entry] of entries.entries()) {
      const hash = createHash('sha256')
      await new Promise<void>((resolve, reject) => {
        const sink = pack.entry({ name: entry.path, size: entry.size, mode: entry.mode }, (error) =>
          error ? reject(error) : resolve()
        )
        const hashing = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk)
            callback(null, chunk)
          },
        })
        pipeline(createReadStream(input.sources[index].absolute), hashing, sink).catch(reject)
      })
      // The sources are frozen while they are packaged; a change here means something wrote to them anyway.
      if (hash.digest('hex') !== entry.sha256) throw invalid(`${entry.path} changed while it was packaged.`)
    }
    pack.finalize()
    await written
    await rename(partial, destination)
  } catch (error) {
    pack.destroy()
    await written.catch(() => undefined)
    await rm(partial, { force: true })
    throw error
  }
  const info = await lstat(destination)
  return { path: destination, size: info.size, sha256: await hashFile(destination) }
}

async function readBuffer(stream: Readable, limit: number, name: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    if (size > limit) throw invalid(`${name} is too large.`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parseManifest(bytes: Buffer, expected: { appVersion: string }): MovePackageManifest {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw invalid('The package manifest is not JSON.')
  }
  const head = raw as { format?: unknown; version?: unknown; appVersion?: unknown } | null
  if (head?.format !== CONVERSATION_MOVE_PACKAGE_FORMAT || head.version !== CONVERSATION_MOVE_PACKAGE_VERSION)
    throw invalid('This is not a conversation move package this app can read.')
  if (head.appVersion !== expected.appVersion)
    throw new MoveError(
      'version-mismatch',
      `The package was made by Maestrly ${String(head.appVersion)}; this host runs ${expected.appVersion}.`
    )
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw invalid('The package manifest is malformed.')
  const manifest = parsed.data as MovePackageManifest
  let total = manifest.rows.size
  const paths = new Set<string>()
  for (const entry of manifest.entries) {
    const relative = exactRelative(entry.relative)
    if (!relative || entry.path !== packageEntryPath(entry.kind, relative) || paths.has(entry.path))
      throw invalid(`Unsafe or duplicate package entry: ${entry.path}`)
    if (entry.kind === 'bundle' && relative !== BUNDLE_RELATIVE) throw invalid('Unexpected bundle entry.')
    paths.add(entry.path)
    total += entry.size
  }
  if (total > MOVE_PACKAGE_MAX_BYTES) throw invalid('The package is too large.')
  return manifest
}

/** Extracts into `directory`, which must not exist yet; every byte is checked against the manifest. */
export async function readMovePackage(
  file: string,
  directory: string,
  expected: { appVersion: string }
): Promise<{ manifest: MovePackageManifest; rows: MoveRows; files: Array<MovePackageEntry & { absolute: string }> }> {
  await mkdir(directory, { recursive: false })
  const read: { manifest: MovePackageManifest | null; rows: MoveRows | null } = { manifest: null, rows: null }
  const files: Array<MovePackageEntry & { absolute: string }> = []
  const declared = new Map<string, MovePackageEntry>()
  const seen = new Set<string>()
  let failure: unknown = null

  const extract = tar.extract()
  const consume = async (header: tar.Header, stream: Readable): Promise<void> => {
    if (header.type !== 'file') throw invalid(`Unsupported package entry: ${header.name}`)
    const manifest = read.manifest
    if (!manifest) {
      if (header.name !== MANIFEST) throw invalid('The package does not start with its manifest.')
      read.manifest = parseManifest(await readBuffer(stream, MAX_MANIFEST_BYTES, MANIFEST), expected)
      for (const entry of read.manifest.entries) declared.set(entry.path, entry)
      return
    }
    if (seen.has(header.name)) throw invalid(`Duplicate package entry: ${header.name}`)
    seen.add(header.name)
    if (header.name === ROWS) {
      const bytes = await readBuffer(stream, manifest.rows.size, ROWS)
      if (
        bytes.length !== manifest.rows.size ||
        createHash('sha256').update(bytes).digest('hex') !== manifest.rows.sha256
      )
        throw invalid('The conversation rows differ from the manifest.')
      try {
        read.rows = JSON.parse(bytes.toString('utf8')) as MoveRows
      } catch {
        throw invalid('The conversation rows are not JSON.')
      }
      return
    }
    const entry = declared.get(header.name)
    if (!entry) throw invalid(`Undeclared package entry: ${header.name}`)
    if (header.size !== entry.size) throw invalid(`${entry.path} differs from the manifest.`)
    const absolute = path.join(directory, entry.path)
    await mkdir(path.dirname(absolute), { recursive: true })
    const handle = await open(absolute, 'wx', entry.mode & 0o777)
    const hash = createHash('sha256')
    let size = 0
    try {
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > entry.size) return callback(invalid(`${entry.path} is larger than declared.`))
          hash.update(chunk)
          handle.write(chunk).then(() => callback(), callback)
        },
      })
      await pipeline(stream, sink)
      await handle.chmod(entry.mode & 0o777)
    } finally {
      await handle.close()
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha256)
      throw invalid(`${entry.path} differs from the manifest.`)
    files.push({ ...entry, absolute })
  }
  extract.on('entry', (header, stream, next) => {
    if (failure) {
      stream.resume()
      return next()
    }
    // tar-stream's entries are streamx streams, which Node's pipeline and async iteration accept.
    consume(header, stream as unknown as Readable).then(
      () => next(),
      (error) => {
        failure = error
        stream.resume()
        next()
      }
    )
  })
  try {
    await pipeline(createReadStream(file), createZstdDecompress(), extract)
  } catch (error) {
    failure ??= error instanceof MoveError ? error : invalid(`The package cannot be read: ${(error as Error).message}`)
  }
  if (!failure && !read.manifest) failure = invalid('The package is empty.')
  if (!failure && !read.rows) failure = invalid('The package has no conversation rows.')
  if (!failure && seen.size !== declared.size + 1) failure = invalid('The package is missing declared entries.')
  if (failure) {
    await rm(directory, { recursive: true, force: true })
    throw failure
  }
  return { manifest: read.manifest!, rows: read.rows!, files }
}
