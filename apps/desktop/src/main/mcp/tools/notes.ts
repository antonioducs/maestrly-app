import { z } from 'zod'
import {
  listPages,
  readPage,
  writePage,
  appendPage,
  createPage,
  deletePage,
  type PageMeta,
} from '../../notes/notes-service'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { ok, err } from './context'

export function registerConversationNotesTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  // Conversation/project Markdown notebooks with nested pages. Tool writes are reflected live in the notes
  // UI.
  const NOTES_NOTE = t('notes.notes')
  // Content-writing tools advertise Mermaid support so the model can create diagrams rendered by notes UI.
  const MERMAID_HINT = t('notes.mermaid')
  server.registerTool(
    'notes_list_pages',
    {
      title: t('tools.notes_list_pages.title'),
      description: t('tools.notes_list_pages.description') + NOTES_NOTE,
      inputSchema: {},
    },
    async () => ok(JSON.stringify(await listPages('conv', convId), null, 2))
  )
  server.registerTool(
    'notes_create_page',
    {
      title: t('tools.notes_create_page.title'),
      description: t('tools.notes_create_page.description') + NOTES_NOTE,
      inputSchema: {
        title: z.string().describe(t('tools.notes_create_page.params.title')),
        parentId: z.string().optional().describe(t('tools.notes_create_page.params.parentId')),
      },
    },
    async ({ title, parentId }) => {
      const p = await createPage('conv', convId, { title, parentId: parentId ?? null })
      return p ? ok(t('returns.notes.pageCreated', { id: p.id, title: p.title })) : err(t('errors.pageCreateFailed'))
    }
  )
  server.registerTool(
    'notes_read_page',
    {
      title: t('tools.notes_read_page.title'),
      description: t('tools.notes_read_page.description') + NOTES_NOTE,
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => ok((await readPage('conv', convId, pageId)) || t('returns.notes.pageEmpty'))
  )
  server.registerTool(
    'notes_write_page',
    {
      title: t('tools.notes_write_page.title'),
      description: t('tools.notes_write_page.description') + NOTES_NOTE + MERMAID_HINT,
      inputSchema: { pageId: z.string(), content: z.string().describe(t('tools.notes_write_page.params.content')) },
    },
    async ({ pageId, content }) => {
      await writePage('conv', convId, pageId, content, true) // external write immediately updates the Notes tab
      return ok(t('returns.notes.pageUpdated'))
    }
  )
  server.registerTool(
    'notes_append_page',
    {
      title: t('tools.notes_append_page.title'),
      description: t('tools.notes_append_page.description') + NOTES_NOTE + MERMAID_HINT,
      inputSchema: { pageId: z.string(), text: z.string().describe(t('tools.notes_append_page.params.text')) },
    },
    async ({ pageId, text }) => {
      await appendPage('conv', convId, pageId, text, true)
      return ok(t('returns.notes.appended'))
    }
  )
  server.registerTool(
    'notes_delete_page',
    {
      title: t('tools.notes_delete_page.title'),
      description: t('tools.notes_delete_page.description') + NOTES_NOTE,
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      await deletePage('conv', convId, pageId)
      return ok(t('returns.notes.pageDeleted'))
    }
  )
  server.registerTool(
    'notes_quick_append',
    {
      title: t('tools.notes_quick_append.title'),
      description: t('tools.notes_quick_append.description') + NOTES_NOTE + MERMAID_HINT,
      inputSchema: { text: z.string().describe(t('tools.notes_quick_append.params.text')) },
    },
    async ({ text }) => {
      const pages = await listPages('conv', convId)
      let page: PageMeta | undefined =
        pages.filter((p) => p.parentId === null).sort((a, b) => a.order - b.order)[0] ?? pages[0]
      if (!page) page = (await createPage('conv', convId, { title: t('returns.notes.quickPageTitle') })) ?? undefined
      if (!page) return err(t('errors.pageCreateFailed'))
      await appendPage('conv', convId, page.id, text, true)
      return ok(t('returns.notes.quickAppended', { title: page.title }))
    }
  )
}

export function registerProjectNotesTools(ctx: McpToolContext): void {
  const { server, convId, t } = ctx
  // Content-writing tools advertise Mermaid support so the model can create diagrams rendered by notes UI.
  const MERMAID_HINT = t('notes.mermaid')
  server.registerTool(
    'project_notes_list_pages',
    {
      title: t('tools.project_notes_list_pages.title'),
      description: t('tools.project_notes_list_pages.description'),
      inputSchema: {},
    },
    async () => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      return ok(JSON.stringify(await listPages('project', conv.workspaceId), null, 2))
    }
  )
  server.registerTool(
    'project_notes_create_page',
    {
      title: t('tools.project_notes_create_page.title'),
      description: t('tools.project_notes_create_page.description'),
      inputSchema: {
        title: z.string().describe(t('tools.project_notes_create_page.params.title')),
        parentId: z.string().optional().describe(t('tools.project_notes_create_page.params.parentId')),
      },
    },
    async ({ title, parentId }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      const p = await createPage('project', conv.workspaceId, { title, parentId: parentId ?? null })
      return p ? ok(t('returns.notes.pageCreated', { id: p.id, title: p.title })) : err(t('errors.pageCreateFailed'))
    }
  )
  server.registerTool(
    'project_notes_read_page',
    {
      title: t('tools.project_notes_read_page.title'),
      description: t('tools.project_notes_read_page.description'),
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      return ok((await readPage('project', conv.workspaceId, pageId)) || t('returns.notes.pageEmpty'))
    }
  )
  server.registerTool(
    'project_notes_write_page',
    {
      title: t('tools.project_notes_write_page.title'),
      description: t('tools.project_notes_write_page.description') + MERMAID_HINT,
      inputSchema: {
        pageId: z.string(),
        content: z.string().describe(t('tools.project_notes_write_page.params.content')),
      },
    },
    async ({ pageId, content }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      await writePage('project', conv.workspaceId, pageId, content, true)
      return ok(t('returns.notes.pageUpdated'))
    }
  )
  server.registerTool(
    'project_notes_append_page',
    {
      title: t('tools.project_notes_append_page.title'),
      description: t('tools.project_notes_append_page.description') + MERMAID_HINT,
      inputSchema: { pageId: z.string(), text: z.string().describe(t('tools.project_notes_append_page.params.text')) },
    },
    async ({ pageId, text }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      await appendPage('project', conv.workspaceId, pageId, text, true)
      return ok(t('returns.notes.appended'))
    }
  )
  server.registerTool(
    'project_notes_delete_page',
    {
      title: t('tools.project_notes_delete_page.title'),
      description: t('tools.project_notes_delete_page.description'),
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      await deletePage('project', conv.workspaceId, pageId)
      return ok(t('returns.notes.pageDeleted'))
    }
  )
  server.registerTool(
    'project_notes_quick_append',
    {
      title: t('tools.project_notes_quick_append.title'),
      description: t('tools.project_notes_quick_append.description') + MERMAID_HINT,
      inputSchema: { text: z.string().describe(t('tools.project_notes_quick_append.params.text')) },
    },
    async ({ text }) => {
      const conv = getConversation(convId)
      if (!conv) return err(t('errors.convNotFound'))
      const pages = await listPages('project', conv.workspaceId)
      let page: PageMeta | undefined =
        pages.filter((p) => p.parentId === null).sort((a, b) => a.order - b.order)[0] ?? pages[0]
      if (!page)
        page =
          (await createPage('project', conv.workspaceId, { title: t('returns.notes.quickPageTitle') })) ?? undefined
      if (!page) return err(t('errors.pageCreateFailed'))
      await appendPage('project', conv.workspaceId, page.id, text, true)
      return ok(t('returns.notes.quickAppended', { title: page.title }))
    }
  )
}
