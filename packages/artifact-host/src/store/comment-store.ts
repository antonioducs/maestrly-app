import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import type { CommentAuthorKind } from '../shell/contract.js'

export type { CommentAuthorKind } from '../shell/contract.js'
export type CommentStatus = 'open' | 'resolved'

export interface CommentRecord {
  id: string
  artifactId: string
  version: number
  /** The thread a reply belongs to; null for the comment that starts a thread. */
  parentId: string | null
  authorKind: CommentAuthorKind
  principalId: string | null
  authorName: string
  body: string
  /** The anchor as stored JSON; the comments module validates it on the way in and out. */
  anchorJson: string | null
  status: CommentStatus
  createdAt: number
}

export interface CommentListFilter {
  /** `open` leaves out resolved threads and their replies. */
  status?: 'open' | 'all'
  version?: number
  /** Only comments stored after this position. */
  after?: number
  limit: number
}

type Row = Record<string, unknown>

const toComment = (row: Row): CommentRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  version: row.version as number,
  parentId: (row.parent_id as string | null) ?? null,
  authorKind: row.author_kind as CommentAuthorKind,
  principalId: (row.principal_id as string | null) ?? null,
  authorName: row.author_name as string,
  body: row.body as string,
  anchorJson: (row.anchor_json as string | null) ?? null,
  status: row.status as CommentStatus,
  createdAt: row.created_at as number,
})

/** Comments on artifacts. Deleted comments stay as rows, out of every read, until their artifact goes. */
export class CommentStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(comment: CommentRecord): void {
    this.db
      .prepare(
        `INSERT INTO comments (id, artifact_id, version, parent_id, author_kind, principal_id, author_name, body,
           anchor_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        comment.id,
        comment.artifactId,
        comment.version,
        comment.parentId,
        comment.authorKind,
        comment.principalId,
        comment.authorName,
        comment.body,
        comment.anchorJson,
        comment.status,
        comment.createdAt
      )
  }

  get(id: string): CommentRecord | null {
    const row = this.db.prepare('SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? toComment(row) : null
  }

  count(artifactId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM comments WHERE artifact_id = ? AND deleted_at IS NULL')
        .get(artifactId) as Row
    ).n as number
  }

  /** In the order they were written, each with the position to continue from. */
  list(artifactId: string, filter: CommentListFilter): { comment: CommentRecord; position: number }[] {
    const clauses = ['c.artifact_id = ?', 'c.deleted_at IS NULL']
    const params: SQLInputValue[] = [artifactId]
    if (filter.status === 'open')
      clauses.push(`COALESCE((SELECT p.status FROM comments p WHERE p.id = c.parent_id), c.status) = 'open'`)
    if (filter.version !== undefined) {
      clauses.push('c.version = ?')
      params.push(filter.version)
    }
    if (filter.after !== undefined) {
      clauses.push('c.rowid > ?')
      params.push(filter.after)
    }
    return (
      this.db
        .prepare(
          `SELECT c.*, c.rowid AS position FROM comments c WHERE ${clauses.join(' AND ')} ORDER BY c.rowid LIMIT ?`
        )
        .all(...params, filter.limit) as Row[]
    ).map((row) => ({ comment: toComment(row), position: row.position as number }))
  }

  setStatus(id: string, status: CommentStatus): void {
    this.db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, id)
  }

  /** Deletes a comment and, when it starts a thread, the replies with it. */
  softDelete(id: string, now: number): void {
    this.db
      .prepare('UPDATE comments SET deleted_at = ? WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL')
      .run(now, id, id)
  }
}
