/**
 * Content-addressed blob storage for run artifacts.
 *
 * Only storage lives here: authorization, size policy and database records stay with each domain. Paths are
 * always resolved back inside the configured root, and a write is atomic through a temporary file plus link.
 */
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
