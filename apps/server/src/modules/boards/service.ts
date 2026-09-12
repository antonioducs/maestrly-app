import { boardLock, fail } from '../kanban/service.js'
import type { Board, BoardColumn, Card } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { appendDomainEvent } from '../events/store.js'
import { mapCard, type CardRow } from '../cards/service.js'

interface BoardRow { roles_configured:boolean;automation_limits:Record<string,number|null>; version: string; id: string; organization_id: string; project_id: string; name: string; archived_at: Date | null; created_at: Date; updated_at: Date }
interface ColumnRow { role:'backlog'|'normal'|'done'; id: string; organization_id: string; project_id: string; board_id: string; name: string; position: string; execution_policy_id: string | null; created_at: Date; updated_at: Date }

const mapBoard = (row: BoardRow): Board => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id, name: row.name, version: Number(row.version), rolesConfigured:row.roles_configured,automationLimits:row.automation_limits,
  archivedAt: row.archived_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
})
const mapColumn = (row: ColumnRow): BoardColumn => ({
  id: row.id, organizationId: row.organization_id, projectId: row.project_id, boardId: row.board_id, name: row.name,
  position: Number(row.position), executionPolicyId: row.execution_policy_id,role:row.role, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
})

export async function getBoard(
  pool: DatabasePool,
  input: { organizationId: string; boardId: string; userId: string },
): Promise<{ board: Board; columns: BoardColumn[]; cards: Card[]; archivedCards: Card[] }> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const boardResult = await client.query<BoardRow>('select * from boards where organization_id = $1 and id = $2', [input.organizationId, input.boardId])
    const board = boardResult.rows[0]
    if (!board) throw new Error('Board not found.')
    await authorizeProject(client, input.organizationId, board.project_id, input.userId, 'project:read')
    const [columns, cards, archivedCards] = await Promise.all([
      client.query<ColumnRow>('select * from board_columns where organization_id = $1 and board_id = $2 and deleted_at is null order by position', [input.organizationId, input.boardId]),
      client.query<CardRow>('select c.*, exists(select 1 from automation_dispatch_guards g where g.card_id=c.id and g.column_id=c.column_id and g.blocked_at is not null) as dispatch_blocked from cards c where organization_id = $1 and board_id = $2 and archived_at is null and deleted_at is null order by column_id, position', [input.organizationId, input.boardId]),
      client.query<CardRow>('select * from cards where organization_id=$1 and board_id=$2 and archived_at is not null and deleted_at is null order by updated_at desc', [input.organizationId, input.boardId]),
    ])
    return { board: mapBoard(board), columns: columns.rows.map(mapColumn), cards: cards.rows.map(mapCard), archivedCards: archivedCards.rows.map(mapCard) }
  })
}

export async function listBoards(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; userId: string; includeArchived?: boolean },
): Promise<Board[]> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'project:read')
    const result = await client.query<BoardRow>('select * from boards where organization_id = $1 and project_id = $2 and ($3 or archived_at is null) order by created_at', [input.organizationId, input.projectId, input.includeArchived ?? false])
    return result.rows.map(mapBoard)
  })
}

export async function createBoard(
  pool: DatabasePool,
  input: { organizationId: string; projectId: string; userId: string; name: string; template?: 'complete' | 'simple' | 'blank'; locale?: 'en' | 'pt-BR' },
): Promise<Board> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, projectId: input.projectId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    await authorizeProject(client, input.organizationId, input.projectId, input.userId, 'work:write')
    const result = await client.query<BoardRow>('insert into boards(organization_id, project_id, name) values ($1,$2,$3) returning *', [input.organizationId, input.projectId, input.name])
    await appendDomainEvent(client, { organizationId: input.organizationId, projectId: input.projectId, type: 'board.created', aggregateType: 'board', aggregateId: result.rows[0]!.id, actor: { type: 'human', userId: input.userId } })
    const names = input.template === 'blank' || !input.template ? [] : input.template === 'simple'
      ? input.locale === 'pt-BR' ? ['A fazer','Concluído'] : ['To do','Done']
      : input.locale === 'pt-BR' ? ['Backlog','Em andamento','Em revisão','Concluído'] : ['Backlog','In progress','Review','Done']
    for (const [position,name] of names.entries()) await client.query('insert into board_columns(organization_id,project_id,board_id,name,position,role) values($1,$2,$3,$4,$5,$6)', [input.organizationId,input.projectId,result.rows[0]!.id,name,position,position===0?'backlog':position===names.length-1?'done':'normal'])
    if(names.length){await client.query('update boards set roles_configured=true where id=$1',[result.rows[0]!.id]);result.rows[0]!.roles_configured=true}
    return mapBoard(result.rows[0]!)
  })
}

export async function createColumn(
  pool: DatabasePool,
  input: { organizationId: string; boardId: string; userId: string; name: string },
): Promise<BoardColumn> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const board = await client.query<{ project_id: string }>('select project_id from boards where organization_id = $1 and id = $2 and archived_at is null for update', [input.organizationId, input.boardId])
    const projectId = board.rows[0]?.project_id
    if (!projectId) throw Object.assign(new Error('Board not found.'), { statusCode: 404 })
    await authorizeProject(client, input.organizationId, projectId, input.userId, 'work:write')
    const result = await client.query<ColumnRow>(`
      insert into board_columns(organization_id, project_id, board_id, name, position)
      values ($1,$2,$3,$4,(select coalesce(max(position) + 1, 0) from board_columns where board_id = $3)) returning *
    `, [input.organizationId, projectId, input.boardId, input.name])
    await appendDomainEvent(client, { organizationId: input.organizationId, projectId, type: 'column.created', aggregateType: 'column', aggregateId: result.rows[0]!.id, actor: { type: 'human', userId: input.userId }, data: { boardId: input.boardId } })
    await client.query('update boards set version=version+1 where id=$1',[result.rows[0]!.board_id])
    const done=await client.query<{id:string}>("select id from board_columns where board_id=$1 and role='done' and deleted_at is null",[result.rows[0]!.board_id])
    if(done.rows[0]&&done.rows[0].id!==result.rows[0]!.id) {
      const ids=(await client.query<{id:string}>("select id from board_columns where board_id=$1 order by deleted_at nulls first,case when role='done' then 1 else 0 end,position",[result.rows[0]!.board_id])).rows.map(r=>r.id)
      await client.query('update board_columns set position=position+(select max(position)+1 from board_columns where board_id=$1) where board_id=$1',[result.rows[0]!.board_id])
      for(const [position,id] of ids.entries())await client.query('update board_columns set position=$2 where id=$1',[id,position])
      result.rows[0]!.position=String(ids.indexOf(result.rows[0]!.id))
    }
    return mapColumn(result.rows[0]!)
  })
}

export async function updateColumn(
  pool: DatabasePool,
  input: { organizationId: string; columnId: string; userId: string; name: string },
): Promise<BoardColumn> {
  return inTenantTransaction(pool, { organizationId: input.organizationId, actor: { type: 'human', userId: input.userId } }, async (client) => {
    const scope=await client.query<{board_id:string}>('select board_id from board_columns where organization_id=$1 and id=$2 and deleted_at is null',[input.organizationId,input.columnId])
    if(!scope.rows[0]) fail('Column not found.',404)
    await boardLock(client,input,scope.rows[0].board_id)
    const existing = await client.query<ColumnRow>('select * from board_columns where organization_id = $1 and id = $2 for update', [input.organizationId, input.columnId])
    if (!existing.rows[0]) throw Object.assign(new Error('Column not found.'), { statusCode: 404 })
    if(existing.rows[0].role!=='normal')fail('Fixed columns cannot be renamed or removed.',400)
    await authorizeProject(client, input.organizationId, existing.rows[0].project_id, input.userId, 'work:write')
    const result = await client.query<ColumnRow>('update board_columns set name = $3, updated_at = now() where organization_id = $1 and id = $2 returning *', [input.organizationId, input.columnId, input.name])
    await appendDomainEvent(client, { organizationId: input.organizationId, projectId: existing.rows[0].project_id, type: 'column.updated', aggregateType: 'column', aggregateId: input.columnId, actor: { type: 'human', userId: input.userId } })
    await client.query('update boards set version=version+1 where id=$1',[result.rows[0]!.board_id])
    const done=await client.query<{id:string}>("select id from board_columns where board_id=$1 and role='done' and deleted_at is null",[result.rows[0]!.board_id])
    if(done.rows[0]&&done.rows[0].id!==result.rows[0]!.id) {
      const ids=(await client.query<{id:string}>("select id from board_columns where board_id=$1 order by deleted_at nulls first,case when role='done' then 1 else 0 end,position",[result.rows[0]!.board_id])).rows.map(r=>r.id)
      await client.query('update board_columns set position=position+(select max(position)+1 from board_columns where board_id=$1) where board_id=$1',[result.rows[0]!.board_id])
      for(const [position,id] of ids.entries())await client.query('update board_columns set position=$2 where id=$1',[id,position])
      result.rows[0]!.position=String(ids.indexOf(result.rows[0]!.id))
    }
    return mapColumn(result.rows[0]!)
  })
}
