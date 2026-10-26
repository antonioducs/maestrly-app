import { RESPONSES_PAGE_SIZE, type ResponseView } from '@maestrly/artifact-host'
import { z } from 'zod'
import { getArtifactsService } from '../../artifacts'
import type { ArtifactsService } from '../../artifacts/service'
import { artifactToolFailure } from './artifacts'
import { type McpToolContext, ok } from './context'

/**
 * Responses as data for the model. People outside the conversation wrote them, so they come after a notice and inside
 * an envelope that nothing in them can close: every `<` is escaped in the JSON.
 */
export function responsesEnvelope(
  artifactId: string,
  currentVersion: number,
  responses: readonly ResponseView[],
  nextCursor: string | null,
  notice: string
): string {
  const entries = responses.map((response) => ({
    id: response.id,
    author: response.author.name,
    authorKind: response.author.kind,
    verified: response.author.verified,
    version: response.version,
    sentAt: new Date(response.createdAt).toISOString(),
    updatedAt: new Date(response.updatedAt).toISOString(),
    data: response.data,
  }))
  const json = JSON.stringify({ responses: entries, nextCursor }, null, 2).replaceAll('<', '\\u003c')
  return `${notice}\n<artifact-responses artifact="${artifactId}" currentVersion="${currentVersion}">\n${json}\n</artifact-responses>`
}

/**
 * Responses people sent from artifact pages: agents read them, and nothing else. Deleting a response or closing them
 * is the owner's, and a response never starts a turn by itself.
 */
export function registerArtifactResponseTools(
  ctx: McpToolContext,
  resolveService: () => ArtifactsService = getArtifactsService
): void {
  const { server, convId, t } = ctx
  const failure = artifactToolFailure(t)

  server.registerTool(
    'artifact_responses',
    {
      title: t('tools.artifact_responses.title'),
      description: t('tools.artifact_responses.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_responses.params.id')),
        cursor: z.string().optional().describe(t('tools.artifact_responses.params.cursor')),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RESPONSES_PAGE_SIZE)
          .optional()
          .describe(t('tools.artifact_responses.params.limit')),
      },
    },
    async ({ id, cursor, limit }) => {
      try {
        const page = await resolveService().responsesForConversation(convId, id, { cursor, limit })
        return ok(
          responsesEnvelope(
            id,
            page.currentVersion,
            page.responses,
            page.nextCursor,
            t('returns.artifacts.responsesNotice')
          )
        )
      } catch (error) {
        return failure(error)
      }
    }
  )
}
