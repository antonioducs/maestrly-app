import { z } from 'zod'
import type { DatabaseClient } from '../../db/pool.js'
export const chatCardSearchSchema = z
  .object({
    query: z.string().trim().max(2000).default(''),
    boardId: z.string().uuid().optional(),
    done: z.boolean().optional(),
    archived: z.boolean().optional(),
    after: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
export async function searchProjectCards(
  c: DatabaseClient,
  organizationId: string,
  projectId: string,
  input: z.infer<typeof chatCardSearchSchema>
) {
  const rows = await c.query(
    `select c.id,c.board_id as "boardId",c.column_id as "columnId",c.title,c.version::int,
    left(c.description,600) as snippet,c.archived_at as "archivedAt",col.role='done' as done,col.name as "columnName"
    from cards c join board_columns col on col.id=c.column_id
    where c.organization_id=$1 and c.project_id=$2 and c.deleted_at is null
      and ($3='' or c.id::text=$3 or to_tsvector('simple',coalesce(c.title,'')||' '||coalesce(c.description,'')) @@ websearch_to_tsquery('simple',$3))
      and ($4::uuid is null or c.board_id=$4) and ($5::boolean is null or (col.role='done')=$5)
      and ($6::boolean is null or (c.archived_at is not null)=$6) and ($7::uuid is null or c.id>$7)
    order by c.id limit $8`,
    [
      organizationId,
      projectId,
      input.query,
      input.boardId ?? null,
      input.done ?? null,
      input.archived ?? null,
      input.after ?? null,
      input.limit + 1,
    ]
  )
  return {
    items: rows.rows.slice(0, input.limit),
    nextCursor: rows.rows.length > input.limit ? rows.rows[input.limit - 1].id : null,
  }
}
