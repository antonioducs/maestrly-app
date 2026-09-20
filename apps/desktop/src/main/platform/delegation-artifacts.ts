/**
 * Evidence upload from the executor. Bytes travel in bounded chunks with a final digest, so a partial upload
 * never becomes an artifact and the server can always verify what it stored.
 */
import { createHash } from 'node:crypto'
import type { DelegationArtifact, DelegationArtifactKind } from '@maestrly/protocol'

export const UPLOAD_CHUNK_BYTES = 1024 * 1024

export interface ArtifactUploader {
  start(input: {
    taskId: string
    kind: DelegationArtifactKind
    name: string
    contentType: string
    sizeBytes: number
    attemptId?: string
    codeRevisionDigest?: string
  }): Promise<{ uploadId: string; chunkBytes: number }>
  chunk(input: { taskId: string; uploadId: string; index: number; contentBase64: string }): Promise<{ nextIndex: number }>
  complete(input: { taskId: string; uploadId: string; digest: string }): Promise<DelegationArtifact>
}

export interface UploadEvidenceInput {
  taskId: string
  kind: DelegationArtifactKind
  name: string
  contentType: string
  bytes: Buffer
  attemptId?: string
  codeRevisionDigest?: string
}

/**
 * Upload one artifact. The digest is computed locally and sent last; the server refuses the artifact when the
 * stored bytes do not match, so a truncated transfer cannot be mistaken for evidence.
 */
export async function uploadEvidence(
  uploader: ArtifactUploader,
  input: UploadEvidenceInput
): Promise<DelegationArtifact> {
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  const started = await uploader.start({
    taskId: input.taskId,
    kind: input.kind,
    name: input.name,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.codeRevisionDigest ? { codeRevisionDigest: input.codeRevisionDigest } : {}),
  })
  const size = Math.min(started.chunkBytes || UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES)
  let index = 0
  for (let offset = 0; offset < input.bytes.byteLength; offset += size) {
    const slice = input.bytes.subarray(offset, Math.min(offset + size, input.bytes.byteLength))
    const acknowledged = await uploader.chunk({
      taskId: input.taskId,
      uploadId: started.uploadId,
      index,
      contentBase64: slice.toString('base64'),
    })
    if (acknowledged.nextIndex !== index + 1)
      throw new Error(`The server acknowledged chunk ${acknowledged.nextIndex - 1}, expected ${index}.`)
    index += 1
  }
  // An empty artifact still completes, so an intentionally empty patch remains recorded evidence.
  return uploader.complete({ taskId: input.taskId, uploadId: started.uploadId, digest })
}
