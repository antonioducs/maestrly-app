/**
 * Moves one artifact between hosts with its ID, history, comments and previews: chat cards and agents keep pointing at
 * it. Nothing is deleted from the source before the copy on the target was read back and found identical.
 */
import {
  type ArtifactAdmin,
  type ArtifactExport,
  ArtifactHostError,
  MAX_FILES_PER_VERSION,
  sameContent,
} from '@maestrly/artifact-host'
import type { LegacyMoveStep } from '../../shared/artifacts'

/** Bytes sent in one call; with base64 and JSON, the request stays under the gateway's 72 MiB upload limit. */
export const MAX_BLOB_BATCH_BYTES = 40 * 1024 * 1024

/** A placeholder owner: the gateway records the paired device that moves the artifact as its owner. */
const MOVED_OWNER = { kind: 'device' as const, id: 'device' }

interface PendingBlob {
  sha256: string
  bytes: number
  read: () => Promise<Uint8Array>
}

const missing = (what: string) =>
  new ArtifactHostError('storage', `A stored file of the artifact is missing: ${what}`, { reason: 'missing_source' })

/** Every distinct file and preview of an artifact once, with a way to read it from the source. */
function blobsOf(source: ArtifactAdmin, manifest: ArtifactExport): PendingBlob[] {
  const blobs = new Map<string, PendingBlob>()
  for (const version of manifest.versions)
    for (const file of version.files)
      if (!blobs.has(file.sha256))
        blobs.set(file.sha256, {
          sha256: file.sha256,
          bytes: file.bytes,
          read: async () => {
            const read = await source.readFile(manifest.id, version.number, file.path)
            if (!read) throw missing(file.path)
            return read.bytes
          },
        })
  for (const thumbnail of manifest.thumbnails)
    if (!blobs.has(thumbnail.sha256))
      blobs.set(thumbnail.sha256, {
        sha256: thumbnail.sha256,
        bytes: thumbnail.bytes,
        read: async () => {
          const image = await source.getThumbnail(manifest.id, thumbnail.version)
          if (!image || image.version !== thumbnail.version) throw missing(`preview of version ${thumbnail.version}`)
          return image.bytes
        },
      })
  return [...blobs.values()]
}

/** Groups blobs into calls of at most `MAX_BLOB_BATCH_BYTES` and `MAX_FILES_PER_VERSION` files. */
export function batchBlobs<T extends { bytes: number }>(blobs: readonly T[]): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let size = 0
  for (const blob of blobs) {
    if (current.length && (size + blob.bytes > MAX_BLOB_BATCH_BYTES || current.length >= MAX_FILES_PER_VERSION)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(blob)
    size += blob.bytes
  }
  if (current.length) batches.push(current)
  return batches
}

const isMissingBlob = (error: unknown) =>
  error instanceof ArtifactHostError && error.code === 'storage' && error.details?.reason === 'missing_blob'

/**
 * Copies an artifact to `target`, checks the copy, then deletes it from `source`. A failure at any step leaves the
 * source untouched; running it again after a failure resumes safely, since importing an identical artifact twice is
 * answered as done.
 */
export async function transferArtifact(
  source: ArtifactAdmin,
  target: ArtifactAdmin,
  id: string,
  onStep: (step: LegacyMoveStep, progress: number) => void,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const manifest = await source.exportArtifact(id)
  const blobs = blobsOf(source, manifest)
  const total = blobs.reduce((sum, blob) => sum + blob.bytes, 0)

  const upload = async () => {
    let sent = 0
    onStep('upload', 0)
    for (const batch of batchBlobs(blobs)) {
      signal?.throwIfAborted()
      const bytes = await Promise.all(batch.map((blob) => blob.read()))
      const { sha256 } = await target.putBlobs(bytes)
      if (sha256.some((sha, index) => sha !== batch[index]!.sha256))
        throw new ArtifactHostError('storage', 'A file changed while it was being sent', { reason: 'verify_failed' })
      sent += batch.reduce((sum, blob) => sum + blob.bytes, 0)
      onStep('upload', total ? sent / total : 1)
    }
  }
  const importOnce = () => target.importArtifact({ ...manifest, owner: MOVED_OWNER })

  await upload()
  signal?.throwIfAborted()
  try {
    await importOnce()
  } catch (error) {
    // Stored blobs nothing references yet are removed when the server's host restarts: send them again, once.
    if (!isMissingBlob(error)) throw error
    await upload()
    signal?.throwIfAborted()
    await importOnce()
  }

  onStep('verify', 0)
  const copy = await target.exportArtifact(id)
  if (!sameContent(copy, manifest))
    throw new ArtifactHostError('storage', 'The copy on the bot server does not match', { reason: 'verify_failed' })
  onStep('verify', 1)

  signal?.throwIfAborted()
  onStep('remove', 0)
  await source.delete(id)
  onStep('remove', 1)
}
