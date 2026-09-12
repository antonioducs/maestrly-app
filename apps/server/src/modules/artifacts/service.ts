import { createHash } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Artifact } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

export async function uploadRunArtifact(
  pool: DatabasePool,
  storageDirectory: string,
  input: {
    organizationId: string; runnerId: string; runId: string; leaseId: string; kind: Artifact['kind'];
    name: string; contentType: string; bytes: Buffer
  },
) {
  if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) throw Object.assign(new Error('Artifact exceeds the 10 MiB limit.'), { statusCode: 413 })
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  const nameDigest = createHash('sha256').update(input.name).digest('hex').slice(0, 16)
  const storageKey = path.join('artifacts', input.organizationId, input.runId, `${digest}-${nameDigest}`)
  const root = path.resolve(storageDirectory)
  const target = path.resolve(root, storageKey)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Artifact storage path is invalid.')
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, input.bytes, { mode: 0o600, flag: 'wx' })
  let created = false
  try {
    await link(temporary, target)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally { await rm(temporary, { force: true }) }
  try {
    return await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'runner', runnerId: input.runnerId } }, async (client) => {
      const run = await client.query<{ project_id: string }>(`
        select project_id from runs where organization_id = $1 and id = $2 and runner_id = $3 and lease_id = $4
          and state in ('claimed', 'running', 'cancelling') and lease_expires_at > now()
      `, [input.organizationId, input.runId, input.runnerId, input.leaseId])
      if (!run.rows[0]) throw Object.assign(new Error('Artifact does not belong to the active lease.'), { statusCode: 409 })
      const result = await client.query<{ id: string }>(`
        insert into artifacts(organization_id, project_id, run_id, kind, name, content_type, storage_key, size_bytes, digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (storage_key) do update set storage_key = excluded.storage_key
        returning id
      `, [input.organizationId, run.rows[0].project_id, input.runId, input.kind, input.name, input.contentType, storageKey, input.bytes.byteLength, digest])
      return {
        id: result.rows[0]!.id, kind: input.kind, name: input.name, contentType: input.contentType,
        sizeBytes: input.bytes.byteLength, digest, storageKey,
      }
    })
  } catch (error) {
    if (created) await rm(target, { force: true })
    throw error
  }
}

export async function readAuthorizedArtifact(
  pool: DatabasePool,
  storageDirectory: string,
  input: { organizationId: string; artifactId: string; userId: string },
): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  const metadata = await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const result = await client.query<{ storage_key: string; name: string; content_type: string; project_id: string }>('select storage_key, name, content_type, project_id from artifacts where organization_id = $1 and id = $2', [input.organizationId, input.artifactId])
    const row = result.rows[0]
    if (!row) throw Object.assign(new Error('Artifact not found.'), { statusCode: 404 })
    await authorizeProject(client, input.organizationId, row.project_id, input.userId, 'project:read')
    return row
  })
  const root = path.resolve(storageDirectory)
  const target = path.resolve(root, metadata.storage_key)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Artifact storage path is invalid.')
  return { bytes: await readFile(target), filename: metadata.name, contentType: metadata.content_type }
}
