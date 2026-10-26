import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export type ResponseAuthorKind = 'owner' | 'invited' | 'approved' | 'guest'

export interface ResponseRecord {
  id: string
  artifactId: string
  /** A person's ID, `owner`, or null for a response brought with an artifact from another host. */
  respondent: string | null
  authorKind: ResponseAuthorKind
  authorName: string
  /** The version it was last sent from. */
  version: number
  /** The data as stored JSON; the responses module validates it on the way in. */
  dataJson: string
  createdAt: number
  updatedAt: number
}

type Row = Record<string, unknown>

const toResponse = (row: Row): ResponseRecord => ({
  id: row.id as string,
  artifactId: row.artifact_id as string,
  respondent: (row.respondent as string | null) ?? null,
  authorKind: row.author_kind as ResponseAuthorKind,
  authorName: row.author_name as string,
  version: row.version as number,
  dataJson: row.data_json as string,
  createdAt: row.created_at as number,
  updatedAt: row.updated_at as number,
})

/** One response per person and artifact; the rows go with their artifact. */
export class ResponseStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: ResponseRecord): void {
    this.db
      .prepare(
        `INSERT INTO responses (id, artifact_id, respondent, author_kind, author_name, version, data_json, created_at,
           updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.artifactId,
        record.respondent,
        record.authorKind,
        record.authorName,
        record.version,
        record.dataJson,
        record.createdAt,
        record.updatedAt
      )
  }

  /** Replaces what a response says; when it was first sent stays. */
  update(
    id: string,
    fields: Pick<ResponseRecord, 'authorKind' | 'authorName' | 'version' | 'dataJson' | 'updatedAt'>
  ): void {
    this.db
      .prepare(
        `UPDATE responses SET author_kind = ?, author_name = ?, version = ?, data_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(fields.authorKind, fields.authorName, fields.version, fields.dataJson, fields.updatedAt, id)
  }

  get(id: string): ResponseRecord | null {
    const row = this.db.prepare('SELECT * FROM responses WHERE id = ?').get(id) as Row | undefined
    return row ? toResponse(row) : null
  }

  findByRespondent(artifactId: string, respondent: string): ResponseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM responses WHERE artifact_id = ? AND respondent = ?')
      .get(artifactId, respondent) as Row | undefined
    return row ? toResponse(row) : null
  }

  count(artifactId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE artifact_id = ?').get(artifactId) as Row)
      .n as number
  }

  /** In the order they were first sent, each with the position to continue from. */
  list(
    artifactId: string,
    filter: { after?: number; limit: number }
  ): { response: ResponseRecord; position: number }[] {
    const clauses = ['r.artifact_id = ?']
    const params: SQLInputValue[] = [artifactId]
    if (filter.after !== undefined) {
      clauses.push('r.rowid > ?')
      params.push(filter.after)
    }
    return (
      this.db
        .prepare(
          `SELECT r.*, r.rowid AS position FROM responses r WHERE ${clauses.join(' AND ')} ORDER BY r.rowid LIMIT ?`
        )
        .all(...params, filter.limit) as Row[]
    ).map((row) => ({ response: toResponse(row), position: row.position as number }))
  }

  /** Every response of an artifact, in the order they were first sent. */
  listAll(artifactId: string): ResponseRecord[] {
    return (
      this.db.prepare('SELECT * FROM responses WHERE artifact_id = ? ORDER BY rowid').all(artifactId) as Row[]
    ).map(toResponse)
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM responses WHERE id = ?').get(id) !== undefined
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM responses WHERE id = ?').run(id)
  }

  /** Responses brought with an imported artifact; the caller runs this inside the artifact's import transaction. */
  importResponses(records: readonly ResponseRecord[]): void {
    for (const record of records) this.insert(record)
  }
}
