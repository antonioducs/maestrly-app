import { createHash } from 'node:crypto'
import type { MoveDigest } from '../../shared/conversation-move'
import { getDb } from '../store/db'
import { OWNED_FILE_KINDS } from './files'
import type { MoveFileKind } from './package'

/**
 * What the source exported and the destination imported, reduced to counts and hashes both compute independently:
 * the transcript in order, the conversation's own files, and the Git state of its checkout.
 */
export async function computeMoveDigest(
  conversationId: string,
  files: Array<{ kind: MoveFileKind; relative: string; sha256: string }>,
  git: { headOid: string; indexTree: string; worktreeTree: string }
): Promise<MoveDigest> {
  const messages = getDb()
    .prepare(
      'SELECT id, role, seq, created_at, parts_json, meta_json FROM chat_messages WHERE conversation_id = ? ORDER BY seq'
    )
    .all(conversationId) as Array<{
    id: string
    role: string
    seq: number
    created_at: number
    parts_json: string
    meta_json: string | null
  }>
  const messageHash = createHash('sha256')
  for (const row of messages) {
    messageHash.update(
      `${JSON.stringify([row.id, row.role, Number(row.seq), Number(row.created_at), row.parts_json, row.meta_json])}\n`
    )
  }
  const owned = files
    .filter((file) => OWNED_FILE_KINDS.has(file.kind))
    .map((file) => `${file.kind}/${file.relative}:${file.sha256}`)
    .sort()
  return {
    conversationId,
    messages: messages.length,
    lastSeq: messages.length ? Number(messages[messages.length - 1].seq) : -1,
    messagesSha256: messageHash.digest('hex'),
    files: owned.length,
    filesSha256: createHash('sha256').update(owned.join('\n')).digest('hex'),
    headOid: git.headOid,
    indexTree: git.indexTree,
    worktreeTree: git.worktreeTree,
  }
}
