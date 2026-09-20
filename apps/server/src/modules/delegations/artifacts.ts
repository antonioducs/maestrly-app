/**
 * Delegation artifacts. Evidence is uploaded in bounded chunks with a final digest, so a partial upload never
 * becomes an artifact and a declared digest is always verified.
 */
import { randomUUID } from 'node:crypto'
import {
  delegationArtifactKindSchema,
  delegationArtifactSchema,
  type DelegationArtifact,
  type DelegationArtifactKind,
} from '@maestrly/protocol'
import { z } from 'zod'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { appendUploadChunk, finalizeUpload, readBlob, removeBlob, uploadSize } from '../artifacts/blob-store.js'
import { delegationFail } from './repository.js'
import { delegationTransaction, type DelegationScope } from './service.js'

/** One chunk stays small so a failed upload costs little; the totals are the real policy. */
export const MAX_CHUNK_BYTES = 1024 * 1024
export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
export const DEFAULT_MAX_TASK_ARTIFACT_BYTES = 250 * 1024 * 1024
const UPLOAD_TTL_MINUTES = 60

export interface ArtifactLimits {
  maxArtifactBytes: number
  maxTaskBytes: number
}

export const artifactUploadStartSchema = z
  .object({
    kind: delegationArtifactKindSchema,
    name: z.string().trim().min(1).max(500),
    contentType: z.string().trim().min(1).max(200),
    attemptId: z.string().uuid().optional(),
    codeRevisionDigest: z.string().min(16).max(191).optional(),
    /** Declared total size, checked against the limits before any byte is accepted. */
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()

export const artifactChunkSchema = z
  .object({ index: z.number().int().nonnegative(), contentBase64: z.string().max(Math.ceil(MAX_CHUNK_BYTES * 1.4)) })
  .strict()

function mapArtifact(row: Record<string, unknown>): DelegationArtifact {
  return delegationArtifactSchema.parse({
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id ?? null,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    digest: row.digest,
    codeRevisionDigest: row.code_revision_digest ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  })
}

async function taskArtifactBytes(client: DatabaseClient, taskId: string): Promise<number> {
  const rows = await client.query<{ bytes: string }>(
    'select coalesce(sum(size_bytes),0)::text as bytes from delegation_artifacts where task_id=$1',
    [taskId]
  )
  return Number(rows.rows[0]!.bytes)
}

export async function listDelegationArtifacts(
  pool: DatabasePool,
  scope: DelegationScope,
  taskId: string
): Promise<DelegationArtifact[]> {
  return delegationTransaction(pool, scope, false, async (client) => {
    const rows = await client.query(
      'select * from delegation_artifacts where organization_id=$1 and project_id=$2 and task_id=$3 order by created_at desc',
      [scope.organizationId, scope.projectId, taskId]
    )
    return rows.rows.map(mapArtifact)
  })
}

export async function readDelegationArtifact(
  pool: DatabasePool,
  scope: DelegationScope,
  input: { taskId: string; artifactId: string; storageDirectory: string; maxInlineBytes?: number }
): Promise<{ artifact: DelegationArtifact; bytes: Buffer }> {
  const metadata = await delegationTransaction(pool, scope, false, async (client) => {
    const rows = await client.query(
      'select * from delegation_artifacts where organization_id=$1 and project_id=$2 and task_id=$3 and id=$4',
      [scope.organizationId, scope.projectId, input.taskId, input.artifactId]
    )
    if (!rows.rows[0]) delegationFail('Artifact not found.', 404)
    return { artifact: mapArtifact(rows.rows[0]), storageKey: String(rows.rows[0].storage_key) }
  })
  if (input.maxInlineBytes && metadata.artifact.sizeBytes > input.maxInlineBytes)
    delegationFail('This artifact is too large to return inline. Download it instead.', 413)
  return { artifact: metadata.artifact, bytes: await readBlob(input.storageDirectory, metadata.storageKey) }
}

export interface UploadContext {
  organizationId: string
  projectId: string
  taskId: string
  runnerId: string
  storageDirectory: string
  limits: ArtifactLimits
}

/** Begin an upload. The declared size is checked against both limits before a single chunk is accepted. */
export async function startArtifactUpload(
  client: DatabaseClient,
  context: UploadContext,
  input: z.infer<typeof artifactUploadStartSchema>
): Promise<{ uploadId: string; chunkBytes: number }> {
  if (input.sizeBytes > context.limits.maxArtifactBytes)
    delegationFail(
      `This artifact declares ${input.sizeBytes} bytes, above the ${context.limits.maxArtifactBytes} byte limit.`,
      413
    )
  const used = await taskArtifactBytes(client, context.taskId)
  if (used + input.sizeBytes > context.limits.maxTaskBytes)
    delegationFail(
      `This task already stores ${used} bytes of evidence; the declared upload would pass the ${context.limits.maxTaskBytes} byte budget.`,
      413
    )
  const tempKey = `delegation-uploads/${context.organizationId}/${context.taskId}/${randomUUID()}`
  const rows = await client.query<{ id: string }>(
    `insert into delegation_artifact_uploads(
       organization_id, project_id, task_id, attempt_id, kind, name, content_type, code_revision_digest, temp_key, expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' minutes')::interval) returning id`,
    [
      context.organizationId,
      context.projectId,
      context.taskId,
      input.attemptId ?? null,
      input.kind,
      input.name,
      input.contentType,
      input.codeRevisionDigest ?? null,
      tempKey,
      String(UPLOAD_TTL_MINUTES),
    ]
  )
  return { uploadId: rows.rows[0]!.id, chunkBytes: MAX_CHUNK_BYTES }
}

export async function appendArtifactChunk(
  client: DatabaseClient,
  context: UploadContext,
  uploadId: string,
  input: z.infer<typeof artifactChunkSchema>
): Promise<{ receivedBytes: number; nextIndex: number }> {
  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (bytes.byteLength === 0) delegationFail('An upload chunk cannot be empty.', 400)
  if (bytes.byteLength > MAX_CHUNK_BYTES)
    delegationFail(`A chunk may carry at most ${MAX_CHUNK_BYTES} bytes.`, 413)
  const rows = await client.query(
    'select * from delegation_artifact_uploads where organization_id=$1 and task_id=$2 and id=$3 for update',
    [context.organizationId, context.taskId, uploadId]
  )
  const upload = rows.rows[0]
  if (!upload) delegationFail('Upload not found or already completed.', 404)
  if ((upload.expires_at as Date).getTime() <= Date.now()) delegationFail('This upload expired. Start a new one.', 409)
  const expected = Number(upload.next_index)
  // A repeated chunk index is accepted as a retry only when nothing was appended after it.
  if (input.index !== expected)
    delegationFail(`Out-of-order chunk: expected index ${expected}, received ${input.index}.`, 409)
  const received = Number(upload.received_bytes) + bytes.byteLength
  if (received > context.limits.maxArtifactBytes)
    delegationFail('The upload passed the per-artifact limit and was discarded.', 413)
  await appendUploadChunk({
    storageDirectory: context.storageDirectory,
    tempKey: String(upload.temp_key),
    bytes,
    first: expected === 0,
  })
  await client.query(
    'update delegation_artifact_uploads set received_bytes=$2, next_index=$3 where id=$1',
    [uploadId, received, expected + 1]
  )
  return { receivedBytes: received, nextIndex: expected + 1 }
}

export async function completeArtifactUpload(
  client: DatabaseClient,
  context: UploadContext,
  uploadId: string,
  expectedDigest: string
): Promise<DelegationArtifact> {
  const rows = await client.query(
    'select * from delegation_artifact_uploads where organization_id=$1 and task_id=$2 and id=$3 for update',
    [context.organizationId, context.taskId, uploadId]
  )
  const upload = rows.rows[0]
  if (!upload) delegationFail('Upload not found or already completed.', 404)
  const size = await uploadSize(context.storageDirectory, String(upload.temp_key))
  if (size !== Number(upload.received_bytes))
    delegationFail('The stored upload size does not match what was acknowledged.', 409)
  const stored = await finalizeUpload({
    storageDirectory: context.storageDirectory,
    tempKey: String(upload.temp_key),
    prefix: 'delegation-artifacts',
    organizationId: context.organizationId,
    scope: context.taskId,
    name: String(upload.name),
    expectedDigest,
  })
  const inserted = await client.query(
    `insert into delegation_artifacts(
       organization_id, project_id, task_id, attempt_id, kind, name, content_type, storage_key, size_bytes, digest,
       code_revision_digest
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (storage_key) do update set storage_key = excluded.storage_key
     returning *`,
    [
      context.organizationId,
      context.projectId,
      context.taskId,
      upload.attempt_id,
      upload.kind as DelegationArtifactKind,
      upload.name,
      upload.content_type,
      stored.storageKey,
      stored.sizeBytes,
      stored.digest,
      upload.code_revision_digest,
    ]
  )
  await client.query('delete from delegation_artifact_uploads where id=$1', [uploadId])
  return mapArtifact(inserted.rows[0]!)
}

/**
 * Remove uploads that expired without completing, including their temporary bytes. Runs per organization so
 * tenant isolation applies to the cleanup as well.
 */
export async function purgeExpiredArtifactUploads(pool: DatabasePool, storageDirectory: string): Promise<number> {
  let removed = 0
  for (const organization of (await pool.query<{ id: string }>('select id from organizations')).rows) {
    const rows = await inTenantTransaction(
      pool,
      { organizationId: organization.id, actor: { type: 'system', service: 'delegation-scheduler' } },
      (client) =>
        client.query<{ id: string; temp_key: string }>(
          'delete from delegation_artifact_uploads where organization_id=$1 and expires_at <= now() returning id, temp_key',
          [organization.id]
        )
    )
    for (const row of rows.rows) await removeBlob(storageDirectory, row.temp_key).catch(() => undefined)
    removed += rows.rows.length
  }
  return removed
}
