import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'
import { mapCard, type CardRow, OptimisticConflictError } from '../cards/service.js'

export interface Scope {
  organizationId: string
  userId: string
}
export function fail(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode })
}
export const transaction = <T>(pool: DatabasePool, scope: Scope, fn: (client: DatabaseClient) => Promise<T>) =>
  inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, actor: { type: 'human', userId: scope.userId } },
    fn
  )

export async function boardLock(
  client: DatabaseClient,
  scope: Scope,
  boardId: string,
  expectedVersion?: number,
  allowArchived = false
) {
  const result = await client.query<{ id: string; project_id: string; archived_at: Date | null; version: string }>(
    'select * from boards where organization_id = $1 and id = $2 for update',
    [scope.organizationId, boardId]
  )
  const board = result.rows[0]
  if (!board) fail('Board not found.', 404)
  await authorizeProject(client, scope.organizationId, board.project_id, scope.userId, 'work:write')
  if (expectedVersion !== undefined && Number(board.version) !== expectedVersion)
    fail('The board changed. Reload before trying again.')
  if (board.archived_at && !allowArchived) fail('Restore this board before editing it.')
  return board
}

async function record(
  client: DatabaseClient,
  scope: Scope,
  projectId: string,
  type: string,
  aggregateType: string,
  aggregateId: string,
  data: Record<string, unknown> = {}
) {
  return appendDomainEvent(client, {
    organizationId: scope.organizationId,
    projectId,
    type,
    aggregateType,
    aggregateId,
    data,
    actor: { type: 'human', userId: scope.userId },
  })
}

export async function changeBoard(
  pool: DatabasePool,
  scope: Scope & { boardId: string; expectedVersion: number; name?: string; archived?: boolean }
) {
  return transaction(pool, scope, async (client) => {
    const board = await boardLock(client, scope, scope.boardId, scope.expectedVersion, true)
    const result = await client.query(
      `update boards set name = coalesce($3, name),
      archived_at = case when $4::boolean is null then archived_at when $4 then now() else null end,
      version = version + 1, updated_at = now() where organization_id = $1 and id = $2 returning *`,
      [scope.organizationId, scope.boardId, scope.name ?? null, scope.archived ?? null]
    )
    await record(client, scope, board.project_id, 'board.updated', 'board', scope.boardId, {
      name: scope.name,
      archived: scope.archived,
    })
    return { version: Number(result.rows[0].version) }
  })
}

export async function manageColumns(
  pool: DatabasePool,
  scope: Scope & {
    boardId: string
    expectedVersion: number
    action: 'create' | 'rename' | 'reorder' | 'delete'
    columnId?: string
    name?: string
    order?: string[]
    destinationId?: string
    expectedCardIds?: string[]
  }
) {
  return transaction(pool, scope, async (client) => {
    const board = await boardLock(client, scope, scope.boardId, scope.expectedVersion)
    const columns = await client.query<{ id: string; name: string; role:string }>(
      'select id, name, role from board_columns where board_id = $1 and deleted_at is null order by position',
      [scope.boardId]
    )
    const ids = columns.rows.map((c) => c.id)
    if (scope.action !== 'create' && scope.action !== 'reorder' && !ids.includes(scope.columnId ?? ''))
      fail('Column not found.', 404)
    if(['rename','delete'].includes(scope.action)&&columns.rows.find(c=>c.id===scope.columnId)?.role!=='normal')fail('Fixed columns cannot be renamed or removed.',400)
    let columnId = scope.columnId
    if (scope.action === 'create') {
      if (!scope.name) fail('Enter a column name.', 400)
      const created = await client.query<{ id: string }>(
        `insert into board_columns(organization_id,project_id,board_id,name,position)
        values($1,$2,$3,$4,(select coalesce(max(position)+1,0) from board_columns where board_id=$3)) returning id`,
        [scope.organizationId, board.project_id, scope.boardId, scope.name]
      )
      columnId = created.rows[0]!.id
      const normalOrder=[...columns.rows.filter(c=>c.role!=='done').map(c=>c.id),columnId,...columns.rows.filter(c=>c.role==='done').map(c=>c.id)]
      const deleted=(await client.query<{id:string}>('select id from board_columns where board_id=$1 and deleted_at is not null order by position',[scope.boardId])).rows.map(c=>c.id)
      await client.query('update board_columns set position=position+(select max(position)+1 from board_columns where board_id=$1) where board_id=$1',[scope.boardId])
      for(const [position,id] of [...normalOrder,...deleted].entries())await client.query('update board_columns set position=$2 where id=$1',[id,position])
    } else if (scope.action === 'rename') {
      if (!scope.name) fail('Enter a column name.', 400)
      await client.query('update board_columns set name=$2, updated_at=now() where id=$1', [scope.columnId, scope.name])
    } else if (scope.action === 'reorder') {
      if (
        !scope.order ||
        scope.order.length !== ids.length ||
        new Set(scope.order).size !== ids.length ||
        scope.order.some((id) => !ids.includes(id))
      )
        fail('Column order changed. Reload before trying again.')
      const backlog=columns.rows.find(c=>c.role==='backlog'),done=columns.rows.find(c=>c.role==='done')
      if(backlog&&scope.order[0]!==backlog.id||done&&scope.order.at(-1)!==done.id)fail('Fixed columns must remain at the board boundaries.',400)
      // Move all positions out of the target range before assigning the new unique positions.
      await client.query(
        'update board_columns set position=position+(select coalesce(max(position),0)+1 from board_columns where board_id=$1) where board_id=$1',
        [scope.boardId]
      )
      for (const [index, id] of scope.order.entries())
        await client.query('update board_columns set position=$2,updated_at=now() where id=$1', [id, index])
      const deleted = await client.query<{ id: string }>(
        'select id from board_columns where board_id=$1 and deleted_at is not null order by id',
        [scope.boardId]
      )
      for (const [index, row] of deleted.rows.entries())
        await client.query('update board_columns set position=$2 where id=$1', [row.id, ids.length + index])
    } else {
      const cards = await client.query<CardRow>(
        'select * from cards where column_id=$1 and deleted_at is null order by position,id for update',
        [scope.columnId]
      )
      const actualIds = cards.rows.map((card) => card.id).sort()
      if (!scope.expectedCardIds || JSON.stringify([...scope.expectedCardIds].sort()) !== JSON.stringify(actualIds))
        fail('Column contents changed. Reload before trying again.')
      if (
        cards.rows.length &&
        (!scope.destinationId || scope.destinationId === scope.columnId || !ids.includes(scope.destinationId))
      )
        fail('Choose another column for the cards.', 400)
      if (scope.destinationId && !ids.includes(scope.destinationId)) fail('Destination column not found.', 404)
      for (const card of cards.rows) {
        await client.query(
          `update cards set column_id=$2,position=(select coalesce(max(position)+1,0) from cards where column_id=$2),
          version=version+1,updated_at=now() where id=$1`,
          [card.id, scope.destinationId]
        )
        await record(client, scope, board.project_id, 'card.column_migrated', 'card', card.id, {
          fromColumnId: scope.columnId,
          toColumnId: scope.destinationId,
          administrative: true,
        })
      }
      // Tombstone retains references in older snapshots; administrative migration never invokes moveCard.
      await client.query('update board_columns set deleted_at=now(),updated_at=now() where id=$1', [scope.columnId])
    }
    const result = await client.query<{ version: string }>(
      'update boards set version=version+1,updated_at=now() where id=$1 returning version',
      [scope.boardId]
    )
    await record(client, scope, board.project_id, 'column.' + scope.action, 'column', columnId ?? scope.boardId, {
      boardId: scope.boardId,
      destinationId: scope.destinationId,
      order: scope.order,
    })
    return { columnId, version: Number(result.rows[0]!.version) }
  })
}

export async function cardScope(client: DatabaseClient, scope: Scope, cardId: string, write = false) {
  const result = await client.query<CardRow>(
    'select * from cards where organization_id=$1 and id=$2 and deleted_at is null',
    [scope.organizationId, cardId]
  )
  if (!result.rows[0]) fail('Card not found.', 404)
  const card = result.rows[0]
  if (write) await boardLock(client, scope, card.board_id)
  await authorizeProject(
    client,
    scope.organizationId,
    card.project_id,
    scope.userId,
    write ? 'work:write' : 'project:read'
  )
  if (!write) return card
  const locked = await client.query<CardRow>('select * from cards where id=$1 and deleted_at is null for update', [
    cardId,
  ])
  if (!locked.rows[0]) fail('Card not found.', 404)
  return locked.rows[0]
}

export async function lifecycleCard(
  pool: DatabasePool,
  scope: Scope & { cardId: string; expectedVersion: number; action: 'archive' | 'restore' | 'delete' | 'cancel' }
) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    if (Number(card.version) !== scope.expectedVersion) throw new OptimisticConflictError(mapCard(card))
    const family = await client.query<{ id: string }>(
      'select id from cards where (id=$1 or parent_card_id=$1) and deleted_at is null order by id for update',
      [card.id]
    )
    const ids = family.rows.map((c) => c.id)
    const jobs = await client.query<{ id: string }>(
      'select id from jobs where card_id=any($1::uuid[]) order by id for update',
      [ids]
    )
    const jobIds = jobs.rows.map((j) => j.id)
    const active = await client.query(
      "select id from runs where job_id=any($1::uuid[]) and state in ('claimed','running','cancelling')",
      [jobIds]
    )
    if (scope.action !== 'cancel' && scope.action !== 'restore' && active.rowCount)
      fail('Cancel active executions before removing this card.')
    if (scope.action !== 'restore') {
      await client.query(
        "update jobs set state='cancelled',updated_at=now() where id=any($1::uuid[]) and state <> 'completed'",
        [jobIds]
      )
      await client.query(
        "update runs set state='cancelling' where job_id=any($1::uuid[]) and state in ('claimed','running')",
        [jobIds]
      )
      await client.query(
        "update approvals set status='revoked',decided_at=now(),decided_by_user_id=$2 where job_id=any($1::uuid[]) and status='pending'",
        [jobIds, scope.userId]
      )
    }
    if (scope.action === 'restore' && card.parent_card_id) {
      const parent = await client.query(
        'select id from cards where id=$1 and archived_at is null and deleted_at is null',
        [card.parent_card_id]
      )
      if (!parent.rowCount) fail('Restore the parent card first.')
    }
    if (scope.action !== 'cancel') {
      const assignment =
        scope.action === 'delete'
          ? 'deleted_at=now(),archived_at=now()'
          : scope.action === 'archive'
            ? 'archived_at=now()'
            : 'archived_at=null'
      await client.query(`update cards set ${assignment},version=version+1,updated_at=now() where id=any($1::uuid[])`, [
        ids,
      ])
    }
    for (const id of ids)
      await record(client, scope, card.project_id, 'card.' + scope.action, 'card', id, { parentActionCardId: card.id })
    return { ok: true, affected: ids.length }
  })
}

export async function cardTimeline(pool: DatabasePool, scope: Scope & { cardId: string; cursor: number }) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId)
    const result = await client.query(
      `select e.id,e.type,e.actor,e.data,e.reason,e.sequence::int,e.created_at as "createdAt",
      coalesce(u.name,ar.name) as "actorName",
      (select name from board_columns where id::text=e.data->>'fromColumnId') as "fromColumnName",
      (select name from board_columns where id::text=e.data->>'toColumnId') as "toColumnName"
      from domain_events e left join "user" u on u.id=e.actor->>'userId'
      left join runners ar on ar.id::text=e.actor->>'runnerId' and ar.organization_id=e.organization_id
      where e.organization_id=$1 and e.project_id=$2 and (e.aggregate_type='card' and e.aggregate_id=$3
        or e.aggregate_type='job' and exists(select 1 from jobs j where j.id=e.aggregate_id and j.card_id=$3)
        or e.aggregate_type='run' and exists(select 1 from runs r join jobs j on j.id=r.job_id where r.id=e.aggregate_id and j.card_id=$3))
        and e.sequence>$4
      order by e.sequence limit 50`,
      [scope.organizationId, card.project_id, card.id, scope.cursor]
    )
    return { items: result.rows, nextCursor: result.rows.length === 50 ? result.rows.at(-1).sequence : null }
  })
}

export async function descriptionHistory(pool: DatabasePool, scope: Scope & { cardId: string }) {
  return transaction(pool, scope, async (client) => {
    await cardScope(client, scope, scope.cardId)
    const result = await client.query(
      `select id,body,card_version::int as version,actor,created_at as "createdAt" from card_description_versions
      where organization_id=$1 and card_id=$2 order by card_version desc limit 100`,
      [scope.organizationId, scope.cardId]
    )
    return result.rows
  })
}

export async function restoreDescription(
  pool: DatabasePool,
  scope: Scope & { cardId: string; versionId: string; expectedVersion: number }
) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    if (Number(card.version) !== scope.expectedVersion) throw new OptimisticConflictError(mapCard(card))
    const old = await client.query<{ body: string }>(
      'select body from card_description_versions where organization_id=$1 and card_id=$2 and id=$3',
      [scope.organizationId, scope.cardId, scope.versionId]
    )
    if (!old.rows[0]) fail('Description version not found.', 404)
    const updated = await client.query<CardRow>(
      'update cards set description=$2,version=version+1,updated_at=now() where id=$1 returning *',
      [card.id, old.rows[0].body]
    )
    // Even restoring identical content is an explicit, new history entry.
    await client.query(
      `insert into card_description_versions(organization_id,project_id,board_id,card_id,card_version,body,actor)
      values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [
        scope.organizationId,
        card.project_id,
        card.board_id,
        card.id,
        updated.rows[0]!.version,
        old.rows[0].body,
        { type: 'human', userId: scope.userId },
      ]
    )
    await record(client, scope, card.project_id, 'card.description_restored', 'card', card.id, {
      versionId: scope.versionId,
    })
    return mapCard(updated.rows[0]!)
  })
}

export async function changeComment(
  pool: DatabasePool,
  scope: Scope & { cardId: string; commentId: string; expectedVersion: number; body?: string; deleted?: boolean }
) {
  return transaction(pool, scope, async (client) => {
    const card = await cardScope(client, scope, scope.cardId, true)
    const comment = await client.query<{ version: string; author_type: string; author_id: string }>(
      'select * from comments where card_id=$1 and id=$2 and deleted_at is null for update',
      [card.id, scope.commentId]
    )
    const row = comment.rows[0]
    if (!row) fail('Comment not found.', 404)
    const grants = await authorizeProject(client, scope.organizationId, card.project_id, scope.userId, 'work:write')
    if (
      !(row.author_type === 'human' && row.author_id === scope.userId) &&
      !['owner', 'admin'].includes(grants.organizationRole) &&
      grants.projectRole !== 'maintainer'
    )
      fail('Only the author or a maintainer can change this comment.', 403)
    if (Number(row.version) !== scope.expectedVersion) fail('The comment changed. Reload before trying again.')
    await client.query(
      `update comments set body=coalesce($2,body),deleted_at=case when $3 then now() else deleted_at end,
      version=version+1,updated_at=now() where id=$1`,
      [scope.commentId, scope.body ?? null, scope.deleted ?? false]
    )
    await record(
      client,
      scope,
      card.project_id,
      scope.deleted ? 'comment.deleted' : 'comment.updated',
      'card',
      card.id,
      { commentId: scope.commentId }
    )
    return { ok: true }
  })
}
