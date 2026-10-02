import { z } from 'zod'
import { MEMORY_TYPES, LOCAL_MEMORY_STATUSES, PERSONAL_MEMORY_SPACE_ID } from '../../shared/memory'
import { getMemoryIndexStatus, rebuildMemoryIndex } from './index'
import { memoryCenterLocal, exportLocalMemoryData } from './memory-center-service'

const fields = {
  title: z.string().trim().min(1).max(240),
  content: z
    .string()
    .trim()
    .min(1)
    .max(256 * 1024),
  type: z.enum(MEMORY_TYPES),
  scope: z.string().max(500).optional(),
  tags: z.array(z.string().max(80)).max(64).optional(),
  pinned: z.boolean().optional(),
  importance: z.number().finite().min(0).max(100).optional(),
}
const createSchema = z.object(fields).strict()
const updateSchema = createSchema
  .partial()
  .extend({ status: z.enum(LOCAL_MEMORY_STATUSES).optional() })
  .strict()
const idSchema = z.string().min(1).max(200)
const filtersSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    query: z.string().max(1000).optional(),
    type: z.enum(MEMORY_TYPES).optional(),
    status: z.enum(LOCAL_MEMORY_STATUSES).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()

export const personalMemoryService = {
  search: (query: unknown, filters?: unknown) =>
    memoryCenterLocal.list(PERSONAL_MEMORY_SPACE_ID, {
      ...filtersSchema.omit({ query: true }).parse(filters ?? {}),
      query: z.string().trim().min(1).max(1000).parse(query),
    }),
  indexStatus: () => getMemoryIndexStatus(PERSONAL_MEMORY_SPACE_ID),
  rebuild: () => rebuildMemoryIndex(PERSONAL_MEMORY_SPACE_ID, []),
  list: (filters?: unknown) => memoryCenterLocal.list(PERSONAL_MEMORY_SPACE_ID, filtersSchema.parse(filters ?? {})),
  get: (id: unknown) => memoryCenterLocal.get(PERSONAL_MEMORY_SPACE_ID, idSchema.parse(id)),
  create: (input: unknown) =>
    memoryCenterLocal.create({ ...createSchema.parse(input), workspaceId: PERSONAL_MEMORY_SPACE_ID, source: 'user' }),
  update: (id: unknown, patch: unknown) =>
    memoryCenterLocal.update(PERSONAL_MEMORY_SPACE_ID, idSchema.parse(id), updateSchema.parse(patch)),
  archive: (id: unknown) => memoryCenterLocal.archive(PERSONAL_MEMORY_SPACE_ID, idSchema.parse(id)),
  restore: (id: unknown) => memoryCenterLocal.restore(PERSONAL_MEMORY_SPACE_ID, idSchema.parse(id)),
  forget: (id: unknown, confirmed: unknown) => {
    if (confirmed !== true) throw new Error('confirmation-required')
    return memoryCenterLocal.forget(PERSONAL_MEMORY_SPACE_ID, idSchema.parse(id))
  },
  export: () => exportLocalMemoryData(PERSONAL_MEMORY_SPACE_ID),
}
