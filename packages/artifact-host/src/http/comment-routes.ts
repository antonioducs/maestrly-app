// Comments in the viewer: whoever can open the artifact reads them, and writes them while comments are on.
import type { Access } from '../access.js'
import type { CommentAuthor, CommentService, CommentView } from '../comments.js'
import { ArtifactHostError } from '../errors.js'
import type { CommentPage, PublicComment } from '../shell/contract.js'
import { type ApiContext, apiForbidden, apiNotFound, json, noContent } from './respond.js'

export interface CommentRouteDeps {
  comments: CommentService
  /** The owner's display name, stored with the comments the owner writes. */
  ownerName: string
}

export interface CommentRoutes {
  list(ctx: ApiContext): void
  create(ctx: ApiContext): void
  reply(ctx: ApiContext): void
  resolve(ctx: ApiContext): void
  remove(ctx: ApiContext): void
}

const LIMIT = /^[1-9]\d{0,2}$/

export function createCommentRoutes(deps: CommentRouteDeps): CommentRoutes {
  const { comments } = deps

  const isSelf = (access: Access, comment: CommentView): boolean =>
    access.kind === 'owner'
      ? comment.author.kind === 'owner'
      : comment.author.principalId !== null && comment.author.principalId === access.principal.id

  /** What one viewer sees of a comment. The author's internal ID stays in the host. */
  function toPublic(access: Access, comment: CommentView): PublicComment {
    const self = isSelf(access, comment)
    return {
      id: comment.id,
      version: comment.version,
      parentId: comment.parentId,
      author: { kind: comment.author.kind, name: comment.author.name, verified: comment.author.verified, self },
      body: comment.body,
      anchor: comment.anchor,
      status: comment.status,
      createdAt: comment.createdAt,
      canDelete: access.kind === 'owner' || self,
    }
  }

  const authorOf = (access: Access): CommentAuthor =>
    access.kind === 'owner'
      ? { kind: 'owner', name: deps.ownerName, principalId: null }
      : { kind: access.principal.kind, name: access.principal.name, principalId: access.principal.id }

  /** Turns the comment rules' refusals into answers; anything else is a real failure. */
  function attempt(ctx: ApiContext, action: () => void): void {
    try {
      action()
    } catch (error) {
      if (!(error instanceof ArtifactHostError)) throw error
      if (error.code === 'not_found') apiNotFound(ctx.res)
      else if (error.code === 'limit_reached') json(ctx.res, 409, { error: 'too_many_comments' })
      else if (error.code === 'invalid_input') json(ctx.res, 400, { error: 'invalid_comment' })
      else throw error
    }
  }

  /** Writing needs comments turned on and, for a guest, a name to sign with. */
  function writer(ctx: ApiContext): Access | null {
    if (!ctx.access) {
      apiNotFound(ctx.res)
      return null
    }
    if (!ctx.sharing.commentsEnabled) {
      json(ctx.res, 403, { error: 'comments_disabled' })
      return null
    }
    if (ctx.access.kind === 'person' && !ctx.access.principal.name) {
      json(ctx.res, 409, { error: 'name_required' })
      return null
    }
    return ctx.access
  }

  return {
    list(ctx) {
      const access = ctx.access
      if (!access) return apiNotFound(ctx.res)
      const limit = ctx.query.get('limit')
      if (limit !== null && !LIMIT.test(limit)) return json(ctx.res, 400, { error: 'invalid_comment' })
      attempt(ctx, () => {
        const page = comments.list(ctx.artifactId, {
          cursor: ctx.query.get('cursor') ?? undefined,
          limit: limit === null ? undefined : Number(limit),
        })
        const body: CommentPage = {
          comments: page.comments.map((comment) => toPublic(access, comment)),
          nextCursor: page.nextCursor,
        }
        json(ctx.res, 200, body)
      })
    },

    create(ctx) {
      const access = writer(ctx)
      if (!access) return
      attempt(ctx, () => {
        const { version, body, anchor } = ctx.body
        // Only what a new thread takes: a reply goes through its own route.
        const created = comments.add(ctx.artifactId, authorOf(access), {
          version,
          body,
          ...(anchor === undefined ? {} : { anchor }),
        } as Parameters<CommentService['add']>[2])
        json(ctx.res, 201, toPublic(access, created))
      })
    },

    reply(ctx) {
      const access = writer(ctx)
      if (!access) return
      attempt(ctx, () => {
        const parent = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!parent) return apiNotFound(ctx.res)
        const created = comments.add(ctx.artifactId, authorOf(access), {
          body: ctx.body.body,
          parentId: parent.id,
        } as Parameters<CommentService['add']>[2])
        json(ctx.res, 201, toPublic(access, created))
      })
    },

    resolve(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      if (ctx.access.kind !== 'owner') return apiForbidden(ctx.res)
      const resolved = ctx.body.resolved
      if (typeof resolved !== 'boolean') return json(ctx.res, 400, { error: 'invalid_comment' })
      attempt(ctx, () => {
        const comment = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!comment) return apiNotFound(ctx.res)
        comments.setResolved(ctx.artifactId, comment.id, resolved)
        noContent(ctx.res)
      })
    },

    remove(ctx) {
      const access = ctx.access
      if (!access) return apiNotFound(ctx.res)
      attempt(ctx, () => {
        const comment = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!comment) return apiNotFound(ctx.res)
        if (access.kind !== 'owner' && !isSelf(access, comment)) return apiForbidden(ctx.res)
        comments.remove(ctx.artifactId, comment.id)
        noContent(ctx.res)
      })
    },
  }
}
