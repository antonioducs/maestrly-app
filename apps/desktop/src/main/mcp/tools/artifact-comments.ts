import { type CommentView, MAX_COMMENT_CHARS } from '@maestrly/artifact-host'
import { z } from 'zod'
import { getArtifactsService } from '../../artifacts'
import type { ArtifactsService } from '../../artifacts/service'
import { artifactToolFailure } from './artifacts'
import { type McpToolContext, ok } from './context'

interface EnvelopeReply {
  id: string
  /** Set when the thread the reply belongs to is not on this page. */
  replyTo?: string
  author: string
  authorKind: CommentView['author']['kind']
  verified: boolean
  body: string
}

interface EnvelopeThread extends Omit<EnvelopeReply, 'replyTo'> {
  version: number
  status: CommentView['status']
  quote: string | null
  replies: EnvelopeReply[]
}

const replyEntry = (comment: CommentView): EnvelopeReply => ({
  id: comment.id,
  author: comment.author.name,
  authorKind: comment.author.kind,
  verified: comment.author.verified,
  body: comment.body,
})

/**
 * Comments as data for the model. They are written by people outside the conversation, so they come after a notice
 * and inside an envelope that nothing in them can close: every `<` is escaped in the JSON.
 */
export function commentsEnvelope(
  artifactId: string,
  currentVersion: number,
  comments: readonly CommentView[],
  nextCursor: string | null,
  notice: string
): string {
  const threads = new Map<string, EnvelopeThread>()
  const entries: (EnvelopeThread | EnvelopeReply)[] = []
  for (const comment of comments) {
    if (comment.parentId !== null) continue
    const { id, author, authorKind, verified, body } = replyEntry(comment)
    const thread: EnvelopeThread = {
      id,
      version: comment.version,
      author,
      authorKind,
      verified,
      status: comment.status,
      quote: comment.anchor?.quote?.exact ?? null,
      body,
      replies: [],
    }
    threads.set(comment.id, thread)
    entries.push(thread)
  }
  for (const comment of comments) {
    if (comment.parentId === null) continue
    const thread = threads.get(comment.parentId)
    if (thread) thread.replies.push(replyEntry(comment))
    else {
      const { id, ...rest } = replyEntry(comment)
      entries.push({ id, replyTo: comment.parentId, ...rest })
    }
  }
  const json = JSON.stringify({ comments: entries, nextCursor }, null, 2).replaceAll('<', '\\u003c')
  return `${notice}\n<artifact-comments artifact="${artifactId}" currentVersion="${currentVersion}">\n${json}\n</artifact-comments>`
}

/**
 * Comments on artifacts: agents read what people wrote, answer on the owner's behalf and resolve threads. Nothing
 * here shares an artifact or changes who can open it, and a comment never starts a turn by itself.
 */
export function registerArtifactCommentTools(
  ctx: McpToolContext,
  resolveService: () => ArtifactsService = getArtifactsService
): void {
  const { server, convId, t } = ctx
  const failure = artifactToolFailure(t, resolveService)

  server.registerTool(
    'artifact_comments',
    {
      title: t('tools.artifact_comments.title'),
      description: t('tools.artifact_comments.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_comments.params.id')),
        status: z.enum(['open', 'all']).optional().describe(t('tools.artifact_comments.params.status')),
        version: z.number().int().optional().describe(t('tools.artifact_comments.params.version')),
        cursor: z.string().optional().describe(t('tools.artifact_comments.params.cursor')),
      },
    },
    async ({ id, status, version, cursor }) => {
      try {
        const page = await resolveService().commentsForConversation(convId, id, {
          status: status ?? 'open',
          version,
          cursor,
        })
        return ok(
          commentsEnvelope(
            id,
            page.currentVersion,
            page.comments,
            page.nextCursor,
            t('returns.artifacts.commentsNotice')
          )
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_comment_reply',
    {
      title: t('tools.artifact_comment_reply.title'),
      description: t('tools.artifact_comment_reply.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_comment_reply.params.id')),
        commentId: z.string().describe(t('tools.artifact_comment_reply.params.commentId')),
        body: z.string().trim().min(1).max(MAX_COMMENT_CHARS).describe(t('tools.artifact_comment_reply.params.body')),
      },
    },
    async ({ id, commentId, body }) => {
      try {
        const reply = await resolveService().replyForConversation(convId, id, commentId, body)
        return ok(JSON.stringify({ ok: true, comment: { id: reply.id, replyTo: reply.parentId } }))
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_comment_resolve',
    {
      title: t('tools.artifact_comment_resolve.title'),
      description: t('tools.artifact_comment_resolve.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_comment_resolve.params.id')),
        commentId: z.string().describe(t('tools.artifact_comment_resolve.params.commentId')),
      },
    },
    async ({ id, commentId }) => {
      try {
        await resolveService().resolveForConversation(convId, id, commentId)
        return ok(t('returns.artifacts.commentResolved'))
      } catch (error) {
        return failure(error)
      }
    }
  )
}
