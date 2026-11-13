import type { BoardRead } from '@maestrly/artifact-host'
import { opsSchema } from '@maestrly/whiteboard'
import { z } from 'zod'
import { getArtifactsService } from '../../artifacts'
import type { ArtifactsService } from '../../artifacts/service'
import { artifactToolFailure } from './artifacts'
import { type McpToolContext, ok } from './context'

/**
 * A whiteboard as data for the model. People outside the conversation write on it, so it comes after a notice and
 * inside an envelope that nothing on the board can close: every `<` is escaped in the JSON.
 */
export function whiteboardEnvelope(read: BoardRead, notice: string): string {
  const json = JSON.stringify(
    { title: read.title, editors: read.editors, outline: read.outline, warnings: read.warnings },
    null,
    2
  ).replaceAll('<', '\\u003c')
  return `${notice}\n<whiteboard id="${read.id}" revision="${read.revision}">\n${json}\n</whiteboard>`
}

/** The card the chat shows for a whiteboard the agent created or changed, as for a page. */
const card = (id: string, title: string) => ({ ok: true, artifact: { id, title, version: 1 } })

/**
 * Whiteboards: live boards the agent draws with ops, which the people it is shared with edit at the same time.
 * `snapshot` renders the board in the owner view, which only the owner's app can open.
 */
export function registerWhiteboardTools(
  ctx: McpToolContext,
  resolveService: () => ArtifactsService = getArtifactsService,
  options: { snapshot: boolean } = { snapshot: true }
): void {
  const { server, convId, t } = ctx
  const failure = artifactToolFailure(t)

  server.registerTool(
    'whiteboard_create',
    {
      title: t('tools.whiteboard_create.title'),
      description: t('tools.whiteboard_create.description'),
      inputSchema: {
        title: z.string().describe(t('tools.whiteboard_create.params.title')),
        description: z.string().optional().describe(t('tools.whiteboard_create.params.description')),
        ops: opsSchema.optional().describe(t('tools.whiteboard_create.params.ops')),
      },
    },
    async ({ title, description, ops }) => {
      try {
        const created = await resolveService().createBoard(convId, { title, description, ops })
        return ok(
          JSON.stringify({
            ...card(created.detail.id, created.detail.title),
            revision: created.revision,
            created: created.created,
            warnings: created.warnings,
            note: t('returns.whiteboards.note'),
          })
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'whiteboard_read',
    {
      title: t('tools.whiteboard_read.title'),
      description: t('tools.whiteboard_read.description'),
      inputSchema: {
        id: z.string().describe(t('tools.whiteboard_read.params.id')),
        since: z.number().int().min(0).optional().describe(t('tools.whiteboard_read.params.since')),
        section: z.string().optional().describe(t('tools.whiteboard_read.params.section')),
      },
    },
    async ({ id, since, section }) => {
      try {
        const read = await resolveService().readBoardForConversation(convId, id, {
          ...(since === undefined ? {} : { since }),
          ...(section === undefined ? {} : { section }),
        })
        return ok(whiteboardEnvelope(read, t('returns.whiteboards.readNotice')))
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'whiteboard_edit',
    {
      title: t('tools.whiteboard_edit.title'),
      description: t('tools.whiteboard_edit.description'),
      inputSchema: {
        id: z.string().describe(t('tools.whiteboard_edit.params.id')),
        baseRevision: z.number().int().min(0).describe(t('tools.whiteboard_edit.params.baseRevision')),
        ops: opsSchema.describe(t('tools.whiteboard_edit.params.ops')),
      },
    },
    async ({ id, baseRevision, ops }) => {
      try {
        const result = await resolveService().applyBoardForConversation(convId, { id, baseRevision, ops })
        // Conflicts and warnings name elements by ID only, so nothing a person wrote reaches the model here.
        return ok(
          JSON.stringify({
            ...card(id, result.title),
            revision: result.revision,
            applied: result.applied,
            conflicts: result.conflicts,
            created: result.created,
            warnings: result.warnings,
            ...(result.conflicts.length ? { note: t('returns.whiteboards.editNote') } : {}),
          })
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  if (!options.snapshot) return
  server.registerTool(
    'whiteboard_snapshot',
    {
      title: t('tools.whiteboard_snapshot.title'),
      description: t('tools.whiteboard_snapshot.description'),
      inputSchema: { id: z.string().describe(t('tools.whiteboard_snapshot.params.id')) },
    },
    async ({ id }) => {
      try {
        const { revision, image } = await resolveService().boardSnapshotForConversation(convId, id)
        return {
          content: [
            { type: 'image' as const, data: Buffer.from(image).toString('base64'), mimeType: 'image/jpeg' },
            { type: 'text' as const, text: t('returns.whiteboards.snapshot', { revision }) },
          ],
        }
      } catch (error) {
        return failure(error)
      }
    }
  )
}
