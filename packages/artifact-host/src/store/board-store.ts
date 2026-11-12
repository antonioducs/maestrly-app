import type { DatabaseSync } from 'node:sqlite'
import type { Author, Board, BoardElement, StoredElement } from '@maestrly/whiteboard'
import { transaction } from './db.js'

type Row = Record<string, unknown>

/** The elements of the host's whiteboards, one row each, and each board's revision on its artifact. */
export class BoardStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Elements were validated before they were saved, so they are read back as they are. */
  load(artifactId: string): Board {
    const artifact = this.db.prepare('SELECT board_revision FROM artifacts WHERE id = ?').get(artifactId) as
      | Row
      | undefined
    const elements = new Map<string, StoredElement>()
    const rows = this.db
      .prepare('SELECT id, rev, by, element_json FROM board_elements WHERE artifact_id = ? ORDER BY rev, id')
      .all(artifactId) as Row[]
    for (const row of rows)
      elements.set(row.id as string, {
        element: JSON.parse(row.element_json as string) as BoardElement,
        rev: row.rev as number,
        by: row.by as Author,
      })
    return { revision: (artifact?.board_revision as number | undefined) ?? 0, elements }
  }

  /** Upserts the given elements and sets the revision, in one transaction. */
  save(artifactId: string, board: Board, changedIds: readonly string[], now: number): void {
    transaction(this.db, () => {
      this.write(artifactId, board, changedIds)
      this.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(now, artifactId)
    })
  }

  /** `save` within the caller's transaction, such as an import's, leaving the artifact's update time alone. */
  write(artifactId: string, board: Board, changedIds: readonly string[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO board_elements (artifact_id, id, rev, by, element_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id, id) DO UPDATE SET rev = excluded.rev, by = excluded.by,
         element_json = excluded.element_json`
    )
    for (const id of changedIds) {
      const stored = board.elements.get(id)
      if (stored) upsert.run(artifactId, id, stored.rev, stored.by, JSON.stringify(stored.element))
    }
    this.db.prepare('UPDATE artifacts SET board_revision = ? WHERE id = ?').run(board.revision, artifactId)
  }

  bytes(artifactId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(LENGTH(CAST(element_json AS BLOB))), 0) AS n FROM board_elements WHERE artifact_id = ?'
      )
      .get(artifactId) as { n: number }
    return row.n
  }

  totalBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(CAST(element_json AS BLOB))), 0) AS n FROM board_elements')
      .get() as { n: number }
    return row.n
  }
}
