import { z } from 'zod'
import { LOCAL_MEMORY_SOURCES, LOCAL_MEMORY_STATUSES, MEMORY_TYPES, SHARED_MEMORY_TYPES } from '../../../shared/memory'
import { appendMemory, readMemory, writeMemory } from '../../memory-service'
import { isWorkspaceMemoryEnabled } from '../../memory/access'
import {
  archiveLocalMemory,
  createLocalMemory,
  getLocalMemory,
  listLocalMemories,
  markLocalMemoriesUsed,
  restoreLocalMemory,
  updateLocalMemory,
  forgetLocalMemory,
} from '../../memory/local-memory-service'
import { promoteLocalMemory } from '../../memory/memory-center-service'
import { retrieveHybridMemory } from '../../memory/retrieval'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { err, ok } from './context'

const json = (value: unknown) => ok(JSON.stringify(value, null, 2))

export function registerMemoryTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  const conversation = () => getConversation(convId)
  const workspaceId = () => conversation()?.workspaceId
  const enabledWorkspace = () => {
    const id = workspaceId()
    if (!id) return { error: err(t('errors.convWsNotFound')) }
    if (!isWorkspaceMemoryEnabled(id)) return { error: err('memory-disabled') }
    return { id }
  }
  const roots = () => {
    const conv = conversation()
    if (!conv) return []
    return conv.isMulti
      ? (conv.repos ?? []).map((repo) => ({ root: repo.worktreePath, linkName: repo.linkName }))
      : [{ root: conv.cwd }]
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      return json(
        await retrieveHybridMemory({
          workspaceId: gate.id!,
          query,
          roots: roots(),
          limit: limit ?? 5,
          maxChars: 8 * 1024,
          markUsed: true,
        })
      )
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      return json(listLocalMemories(gate.id!, filters))
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      if (!id) return ok((await readMemory(gate.id!)) || t('returns.memory.empty'))
      const memory = getLocalMemory(gate.id!, id)
      if (memory) markLocalMemoriesUsed(gate.id!, [memory.id])
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      const existing = id ? getLocalMemory(gate.id!, id) : undefined
      const result = existing
        ? updateLocalMemory(gate.id!, existing.id, {
            ...input,
            ...(supersedes_id ? { supersedesId: supersedes_id } : {}),
          })
        : createLocalMemory({
            ...input,
            ...(id ? { id } : {}),
            workspaceId: gate.id!,
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
      const gate = enabledWorkspace()
      return gate.error ?? json(archiveLocalMemory(gate.id!, id))
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
      const gate = enabledWorkspace()
      return gate.error ?? json(restoreLocalMemory(gate.id!, id))
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
      const gate = enabledWorkspace()
      return gate.error ?? json({ forgotten: forgetLocalMemory(gate.id!, id) })
    }
  )
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      const conv = conversation()!
      let repositoryRoot = conv.cwd
      if (conv.isMulti) {
        const selected = (conv.repos ?? []).find((item) => item.linkName === repo)
        if (!selected) return err('repo-required')
        repositoryRoot = selected.worktreePath
      }
      return json(
        await promoteLocalMemory({
          workspaceId: gate.id!,
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      await writeMemory(gate.id!, content, true)
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
      const gate = enabledWorkspace()
      if (gate.error) return gate.error
      await appendMemory(gate.id!, text, true)
      return ok(t('returns.memory.appended'))
    }
  )
}
