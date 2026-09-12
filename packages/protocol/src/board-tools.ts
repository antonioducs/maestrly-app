import { z } from 'zod'
import { cardPatchSchema, prioritySchema } from './boards.js'

const id = z.string().uuid()
const version = z.number().int().positive()
const search = z
  .object({
    query: z.string().trim().max(2000).optional(),
    boardId: id.optional(),
    done: z.boolean().optional(),
    archived: z.boolean().optional(),
    after: id.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
const createCard = z
  .object({
    boardId: id,
    columnId: id.optional(),
    parentCardId: id.optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(100000).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(4000)).max(100).optional(),
    priority: prioritySchema.optional(),
    labels: z.array(z.string().min(1).max(80)).max(100).optional(),
    assigneeUserIds: z.array(z.string().min(1).max(191)).max(100).optional(),
  })
  .strict()

/** One catalog for local agents and the GPT Web bridge. Scope comes from the host, never tool input. */
export const linkedBoardToolSchemas = {
  board_list_members: z.object({}).strict(),
  board_list_boards: z.object({ includeArchived: z.boolean().optional() }).strict(),
  board_get_board: z.object({ boardId: id }).strict(),
  board_list_cards: search,
  board_search_cards: search,
  board_get_card: z.object({ cardId: id }).strict(),
  board_card_history: z.object({ cardId: id }).strict(),
  board_card_events: z.object({ cardId: id, cursor: z.number().int().nonnegative().default(0) }).strict(),
  board_create_card: createCard,
  board_create_subtask: createCard.required({ parentCardId: true }),
  board_update_card: cardPatchSchema.extend({ cardId: id }).strict(),
  board_comment: z.object({ cardId: id, body: z.string().min(1).max(100000) }).strict(),
  board_update_comment: z
    .object({
      cardId: id,
      commentId: id,
      expectedVersion: version,
      body: z.string().min(1).max(100000).optional(),
      deleted: z.boolean().optional(),
    })
    .strict(),
  board_move_card: z
    .object({
      cardId: id,
      expectedVersion: version,
      targetColumnId: id,
      targetPosition: z.number().int().nonnegative(),
    })
    .strict(),
  board_card_lifecycle: z
    .object({ cardId: id, expectedVersion: version, action: z.enum(['archive', 'restore', 'delete', 'cancel']) })
    .strict(),
  board_restore_description: z.object({ cardId: id, expectedVersion: version, versionId: id }).strict(),
  board_create_board: z
    .object({
      name: z.string().trim().min(1).max(160),
      template: z.enum(['complete', 'simple', 'blank']).default('blank'),
      locale: z.enum(['en', 'pt-BR']).default('en'),
    })
    .strict(),
  board_update_board: z
    .object({
      boardId: id,
      expectedVersion: version,
      name: z.string().trim().min(1).max(160).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  board_manage_columns: z
    .object({
      boardId: id,
      expectedVersion: version,
      action: z.enum(['create', 'rename', 'reorder', 'delete']),
      columnId: id.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      order: z.array(id).max(200).optional(),
      destinationId: id.optional(),
      expectedCardIds: z.array(id).max(100000).optional(),
    })
    .strict(),
}
export type LinkedBoardToolName = keyof typeof linkedBoardToolSchemas
export const linkedBoardReadTools = new Set<LinkedBoardToolName>([
  'board_list_members',
  'board_list_boards',
  'board_get_board',
  'board_list_cards',
  'board_search_cards',
  'board_get_card',
  'board_card_history',
  'board_card_events',
])
export const linkedBoardToolDescriptions: Record<LinkedBoardToolName, string> = {
  board_list_members: 'List current project members and their IDs for assigning cards.',
  board_list_boards: 'List boards in the linked Kanban project, including their IDs and versions.',
  board_get_board: 'Read board metadata and columns. Use board_list_cards for paginated cards.',
  board_list_cards:
    'List project cards with pagination. Filter by board, done or archived; follow nextCursor with after.',
  board_search_cards:
    'Search linked project cards, including completed and archived work. Returns snippets; read a card for full details.',
  board_get_card: 'Read any card in the linked project, including comments, subtasks and attachments metadata.',
  board_card_history: 'Read the description version history of a project card.',
  board_card_events: 'Read the audit timeline of a project card, starting after cursor.',
  board_create_card: 'Create a card in the linked project with title, description, priority, labels and assignees.',
  board_create_subtask: 'Create a subtask under parentCardId in its board.',
  board_update_card:
    'Update a project card using its current expectedVersion. Reload on conflict; never overwrite silently.',
  board_comment: 'Add a comment attributed to this agent conversation.',
  board_update_comment: 'Edit or delete a card comment using its current version and account permissions.',
  board_move_card:
    'Move a card within its board. Does not launch an automation chain or imply completion of an execution.',
  board_card_lifecycle:
    'Archive, restore, soft-delete or cancel a card, with version checking. Only do this when requested.',
  board_restore_description: 'Restore a historical card description using versionId and the current card version.',
  board_create_board: 'Create a board in the linked project with a complete, simple or blank column template.',
  board_update_board: 'Rename, archive or restore a board using its current version.',
  board_manage_columns:
    'Create, rename, reorder or delete columns using the board version. Deleting a populated column requires destinationId and the exact expectedCardIds.',
}

/** JSON Schema is the version-independent boundary consumed by desktop MCP runtimes. */
export function linkedBoardToolJsonSchema(name: LinkedBoardToolName) {
  return z.toJSONSchema(linkedBoardToolSchemas[name], { target: 'draft-7', io: 'input' })
}
