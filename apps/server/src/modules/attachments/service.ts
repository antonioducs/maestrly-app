import { cardScope, fail } from '../kanban/service.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Attachment } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export async function uploadAttachment(
  pool: DatabasePool,
  storageDirectory: string,
  input: { organizationId: string; cardId: string; userId: string; filename: string; contentType: string; bytes: Buffer },
): Promise<Attachment> {
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error('Attachment exceeds the 5 MiB limit.'), { statusCode: 413 })
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  const id = randomUUID()
  const storageKey = path.join(input.organizationId, id.slice(0, 2), id)
  const root = path.resolve(storageDirectory)
  const target = path.resolve(root, storageKey)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Attachment storage path is invalid.')
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp`
  await writeFile(temporary, input.bytes, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
  try {
    return await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
      const current=await cardScope(client,input,input.cardId,true)
      if(current.archived_at)fail('Restore this card before editing it.')
      const card = await client.query<{ project_id: string; board_id: string }>('select project_id, board_id from cards where organization_id = $1 and id = $2', [input.organizationId, input.cardId])
      const scope = card.rows[0]
      if (!scope) throw Object.assign(new Error('Card not found.'), { statusCode: 404 })
      await authorizeProject(client, input.organizationId, scope.project_id, input.userId, 'work:write')
      const row = await client.query<{ created_at: Date }>(`
        insert into attachments(id, organization_id, project_id, board_id, card_id, storage_key, filename, content_type, size_bytes, digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning created_at
      `, [id, input.organizationId, scope.project_id, scope.board_id, input.cardId, storageKey, input.filename, input.contentType, input.bytes.byteLength, digest])
      await appendDomainEvent(client, {
        organizationId: input.organizationId, projectId: scope.project_id, type: 'attachment.created', aggregateType: 'card',
        aggregateId: input.cardId, actor: { type: 'human', userId: input.userId }, data: { attachmentId: id, filename: input.filename },
      })
      return {
        id, organizationId: input.organizationId, projectId: scope.project_id, cardId: input.cardId,
        filename: input.filename, contentType: input.contentType, sizeBytes: input.bytes.byteLength,
        createdAt: row.rows[0]!.created_at.toISOString(),
      }
    })
  } catch (error) {
    await rm(target, { force: true })
    throw error
  }
}

export async function readAuthorizedAttachment(
  pool: DatabasePool,
  storageDirectory: string,
  input: { organizationId: string; attachmentId: string; userId: string },
): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  const metadata = await inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const result = await client.query<{ storage_key: string; filename: string; content_type: string; project_id: string }>(`
      select storage_key, filename, content_type, project_id from attachments where organization_id = $1 and id = $2
    `, [input.organizationId, input.attachmentId])
    const row = result.rows[0]
    if (!row) throw Object.assign(new Error('Attachment not found.'), { statusCode: 404 })
    await authorizeProject(client, input.organizationId, row.project_id, input.userId, 'project:read')
    return row
  })
  const root = path.resolve(storageDirectory)
  const target = path.resolve(root, metadata.storage_key)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Attachment storage path is invalid.')
  return { bytes: await readFile(target), filename: metadata.filename, contentType: metadata.content_type }
}
