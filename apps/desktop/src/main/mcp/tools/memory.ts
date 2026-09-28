import { z } from 'zod'
import { memoryContentProblem } from '../../memory/content-safety'
import { LOCAL_MEMORY_SOURCES, LOCAL_MEMORY_STATUSES, MEMORY_TYPES, SHARED_MEMORY_TYPES } from '../../../shared/memory'
import { appendMemory, readMemory, writeMemory } from '../../memory-service'
import {
  archiveLocalMemory,
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  markLocalMemoriesUsed,
  restoreLocalMemory,
  updateLocalMemory,
  forgetLocalMemory,
  resolveLocalMemoryId,
} from '../../memory/local-memory-service'
import { promoteLocalMemory } from '../../memory/memory-center-service'
import { memorySpaceForConversation, type MemorySpace } from '../../memory/spaces'
import { searchMemorySpace } from '../../memory/search'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { err, ok } from './context'

const json = (value: unknown) => ok(JSON.stringify(value, null, 2))

export function registerMemoryTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  const conversation = getConversation(convId)
  // Project conversations keep their tools while memory is disabled (they report `memory-disabled`); other
  // conversations get memory only when a host registered a space for them (bots).
  if (!memorySpaceForConversation(convId) && conversation?.scope !== 'project') return
  const repositoryTools = conversation?.scope === 'project' && memorySpaceForConversation(convId)?.kind !== 'bot'
  const gate = (): { space: MemorySpace } | { error: ReturnType<typeof err> } => {
    const space = memorySpaceForConversation(convId)
    if (space) return { space }
    const current = getConversation(convId)
    if (current?.scope === 'project' && current.workspaceId) return { error: err('memory-disabled') }
    return { error: err(t('errors.convWsNotFound')) }
  }
  const resolve = (spaceId: string, id: string): { id: string } | { error: ReturnType<typeof err> } => {
    const resolved = resolveLocalMemoryId(spaceId, id)
    if (resolved === 'ambiguous') return { error: err('memory-id-ambiguous') }
    return resolved ? { id: resolved } : { error: err('memory-not-found') }
  }

  server.registerTool(
    'memory_search',
    {
      title: t('tools.memory_search.title'),
      description: t('tools.memory_search.description'),
      inputSchema: {
        query: z.string().min(1).max(4_000),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query, limit }) => {
      const g = gate()
      if ('error' in g) return g.error
      const hits = await searchMemorySpace(g.space, query, { mode: 'search', limit: limit ?? 5 })
      markLocalMemoriesUsed(
        g.space.id,
        hits.filter((hit) => hit.kind === 'local').map((hit) => hit.id)
      )
      return json({
        results: hits.map((hit) => ({
          id: hit.id,
          kind: hit.kind,
          type: hit.type,
          title: hit.title,
          relevance: Math.round(hit.relevance * 100) / 100,
          snippet: hit.snippet,
          ...(hit.pinned ? { pinned: true } : {}),
          ...(hit.updatedAt ? { updatedAt: new Date(hit.updatedAt).toISOString() } : {}),
          ...(hit.path ? { repo: hit.repo, path: hit.path, startLine: hit.startLine, endLine: hit.endLine } : {}),
        })),
        ...(hits.length === 0 ? { note: t('returns.memory.nothingRelevant') } : {}),
      })
    }
  )

  server.registerTool(
    'memory_list',
    {
      title: t('tools.memory_list.title'),
      description: t('tools.memory_list.description'),
      inputSchema: {
        status: z.enum(LOCAL_MEMORY_STATUSES).optional(),
        type: z.enum(MEMORY_TYPES).optional(),
        tag: z.string().max(80).optional(),
        scope: z.string().max(500).optional(),
        source: z.enum(LOCAL_MEMORY_SOURCES).optional(),
        pinned: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (filters) => {
      const g = gate()
      if ('error' in g) return g.error
      return json(listLocalMemories(g.space.id, filters))
    }
  )

  server.registerTool(
    'memory_read',
    {
      title: t('tools.memory_read.title'),
      description: t('tools.memory_read.description'),
      inputSchema: { id: z.string().min(1).max(200).optional() },
    },
    async ({ id }) => {
      const g = gate()
      if ('error' in g) return g.error
      if (!id)
        return g.space.kind === 'workspace'
          ? ok((await readMemory(g.space.id)) || t('returns.memory.empty'))
          : err('memory-id-required')
      const resolved = resolve(g.space.id, id)
      if ('error' in resolved) return resolved.error
      const memory = getLocalMemory(g.space.id, resolved.id)
      if (memory) markLocalMemoriesUsed(g.space.id, [memory.id])
      return memory ? json(memory) : err('memory-not-found')
    }
  )

  server.registerTool(
    'memory_upsert',
    {
      title: t('tools.memory_upsert.title'),
      description: t('tools.memory_upsert.description'),
      inputSchema: {
        id: z.string().min(1).max(200).optional(),
        title: z.string().min(1).max(240),
        content: z
          .string()
          .min(1)
          .max(256 * 1024),
        type: z.enum(MEMORY_TYPES),
        scope: z.string().max(500).optional(),
        tags: z.array(z.string().max(80)).max(64).optional(),
        importance: z.number().int().min(0).max(100).optional(),
        pinned: z.boolean().optional(),
        supersedes_id: z.string().min(1).max(200).optional(),
        origin_message_id: z.string().min(1).max(200).optional(),
      },
    },
    async ({ id, supersedes_id, origin_message_id, ...input }) => {
      const g = gate()
      if ('error' in g) return g.error
      const resolvedId = id ? resolveLocalMemoryId(g.space.id, id) : undefined
      if (resolvedId === 'ambiguous') return err('memory-id-ambiguous')
      if (supersedes_id) {
        const resolved = resolve(g.space.id, supersedes_id)
        if ('error' in resolved) return resolved.error
        supersedes_id = resolved.id
      }
      const existing = resolvedId ? getLocalMemory(g.space.id, resolvedId) : undefined
      if (!existing || existing.title !== input.title || existing.content !== input.content) {
        const problem = memoryContentProblem(`${input.title}\n${input.content}`)
        if (problem)
          return err(
            t(
              problem === 'invisible-characters'
                ? 'errors.memoryInvisibleCharacters'
                : 'errors.memoryInstructionInjection'
            )
          )
      }
      const result = existing
        ? updateLocalMemory(g.space.id, existing.id, {
            ...input,
            ...(supersedes_id ? { supersedesId: supersedes_id } : {}),
          })
        : createLocalMemory({
            ...input,
            ...(id ? { id } : {}),
            workspaceId: g.space.id,
            source: 'agent',
            originConversationId: convId,
            ...(origin_message_id ? { originMessageId: origin_message_id } : {}),
            ...(supersedes_id ? { supersedesId: supersedes_id } : {}),
          })
      return json(result)
    }
  )

  server.registerTool(
    'memory_archive',
    {
      title: t('tools.memory_archive.title'),
      description: t('tools.memory_archive.description'),
      inputSchema: { id: z.string().min(1).max(200) },
    },
    async ({ id }) => {
      const g = gate()
      if ('error' in g) return g.error
      const resolved = resolve(g.space.id, id)
      return 'error' in resolved ? resolved.error : json(archiveLocalMemory(g.space.id, resolved.id))
    }
  )
  server.registerTool(
    'memory_restore',
    {
      title: t('tools.memory_restore.title'),
      description: t('tools.memory_restore.description'),
      inputSchema: { id: z.string().min(1).max(200) },
    },
    async ({ id }) => {
      const g = gate()
      if ('error' in g) return g.error
      const resolved = resolve(g.space.id, id)
      return 'error' in resolved ? resolved.error : json(restoreLocalMemory(g.space.id, resolved.id))
    }
  )
  server.registerTool(
    'memory_forget',
    {
      title: t('tools.memory_forget.title'),
      description: t('tools.memory_forget.description'),
      inputSchema: { id: z.string().min(1).max(200), confirm: z.literal(true) },
    },
    async ({ id }) => {
      const g = gate()
      if ('error' in g) return g.error
      const resolved = resolve(g.space.id, id)
      return 'error' in resolved ? resolved.error : json({ forgotten: forgetLocalMemory(g.space.id, resolved.id) })
    }
  )
  if (!repositoryTools) return

  server.registerTool(
    'memory_promote_to_shared',
    {
      title: t('tools.memory_promote_to_shared.title'),
      description: t('tools.memory_promote_to_shared.description'),
      inputSchema: {
        id: z.string().min(1).max(200),
        repo: z.string().max(200).optional(),
        type: z.enum(SHARED_MEMORY_TYPES).optional(),
        scope: z.string().max(500).optional(),
        slug: z.string().max(120).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async ({ id, repo, ...options }) => {
      const g = gate()
      if ('error' in g) return g.error
      if (g.space.kind !== 'workspace') return err('memory-repository-required')
      const conv = getConversation(convId)!
      let repositoryRoot = conv.cwd
      if (conv.isMulti) {
        const selected = (conv.repos ?? []).find((item) => item.linkName === repo)
        if (!selected) return err('repo-required')
        repositoryRoot = selected.worktreePath
      }
      return json(
        await promoteLocalMemory({
          workspaceId: g.space.id,
          memoryId: id,
          repositoryRoot,
          ...options,
        })
      )
    }
  )

  // Deprecated aliases. They never replace the structured collection.
  server.registerTool(
    'memory_write',
    {
      title: t('tools.memory_write.title'),
      description: `[DEPRECATED] ${t('tools.memory_write.description')}`,
      inputSchema: { content: z.string().max(256 * 1024) },
    },
    async ({ content }) => {
      const g = gate()
      if ('error' in g) return g.error
      if (g.space.kind !== 'workspace') return err('memory-repository-required')
      await writeMemory(g.space.id, content, true)
      return ok(t('returns.memory.updated'))
    }
  )
  server.registerTool(
    'memory_append',
    {
      title: t('tools.memory_append.title'),
      description: `[DEPRECATED] ${t('tools.memory_append.description')}`,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(256 * 1024),
      },
    },
    async ({ text }) => {
      const g = gate()
      if ('error' in g) return g.error
      if (g.space.kind !== 'workspace') return err('memory-repository-required')
      await appendMemory(g.space.id, text, true)
      return ok(t('returns.memory.appended'))
    }
  )
}
