/**
 * Content-addressed blob storage shared by run artifacts and delegation artifacts.
 *
 * Only storage lives here: authorization, size policy and database records stay with each domain. Paths are
 * always resolved back inside the configured root, and a write is atomic through a temporary file plus link.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, link, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface StoredBlob {
  storageKey: string
  digest: string
  sizeBytes: number
}

export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Resolve a storage key inside the root, refusing anything that would escape it. */
export function resolveInsideStorage(storageDirectory: string, storageKey: string): string {
  const root = path.resolve(storageDirectory)
  const target = path.resolve(root, storageKey)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Artifact storage path is invalid.')
  return target
}

function contentKey(prefix: string, organizationId: string, scope: string, name: string, digest: string): string {
  const nameDigest = createHash('sha256').update(name).digest('hex').slice(0, 16)
  return path.join(prefix, organizationId, scope, `${digest}-${nameDigest}`)
}

/** Write bytes once. A blob that already exists is reused rather than rewritten. */
export async function writeBlob(input: {
  storageDirectory: string
  prefix: string
  organizationId: string
  scope: string
  name: string
  bytes: Buffer
}): Promise<StoredBlob> {
  const digest = digestOf(input.bytes)
  const storageKey = contentKey(input.prefix, input.organizationId, input.scope, input.name, digest)
  const target = resolveInsideStorage(input.storageDirectory, storageKey)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, input.bytes, { mode: 0o600, flag: 'wx' })
  try {
    await link(temporary, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await rm(temporary, { force: true })
  }
  return { storageKey, digest, sizeBytes: input.bytes.byteLength }
}

export async function readBlob(storageDirectory: string, storageKey: string): Promise<Buffer> {
  return readFile(resolveInsideStorage(storageDirectory, storageKey))
}

export async function removeBlob(storageDirectory: string, storageKey: string): Promise<void> {
  await rm(resolveInsideStorage(storageDirectory, storageKey), { force: true })
}

/**
 * Append one chunk of a multi-part upload. The first chunk creates the file exclusively, so two concurrent
 * uploads can never share a temporary key.
 */
export async function appendUploadChunk(input: {
  storageDirectory: string
  tempKey: string
  bytes: Buffer
  first: boolean
}): Promise<void> {
  const target = resolveInsideStorage(input.storageDirectory, input.tempKey)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  if (input.first) {
    const handle = await open(target, 'wx', 0o600)
    try {
      await handle.write(input.bytes)
    } finally {
      await handle.close()
    }
    return
  }
  await appendFile(target, input.bytes)
}

export async function uploadSize(storageDirectory: string, tempKey: string): Promise<number> {
  try {
    return (await stat(resolveInsideStorage(storageDirectory, tempKey))).size
  } catch {
    return 0
  }
}

/** Promote a completed upload to a content-addressed blob, verifying the digest the client declared. */
export async function finalizeUpload(input: {
  storageDirectory: string
  tempKey: string
  prefix: string
  organizationId: string
  scope: string
  name: string
  expectedDigest: string
}): Promise<StoredBlob> {
  const bytes = await readBlob(input.storageDirectory, input.tempKey)
  const digest = digestOf(bytes)
  if (digest !== input.expectedDigest) {
    await removeBlob(input.storageDirectory, input.tempKey)
    throw Object.assign(new Error('The uploaded content does not match the declared digest.'), { statusCode: 409 })
  }
  const stored = await writeBlob({
    storageDirectory: input.storageDirectory,
    prefix: input.prefix,
    organizationId: input.organizationId,
    scope: input.scope,
    name: input.name,
    bytes,
  })
  await removeBlob(input.storageDirectory, input.tempKey)
  return stored
}
