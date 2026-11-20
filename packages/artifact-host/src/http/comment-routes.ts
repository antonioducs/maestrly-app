// Comments in the viewer: whoever can open the artifact reads them, and writes them while comments are on.
import { z } from 'zod'
import { type Access, isReplaced, seesHistory } from '../access.js'
import type { ArtifactAdmin } from '../admin.js'
import type { CommentAuthor, CommentService, CommentView, TokenSuggestion } from '../comments.js'
import { buildTokenEdits, DesignActionError, type DesignService, formatTokenSummary } from '../design.js'
import { ArtifactHostError } from '../errors.js'
import { MAX_SUGGESTION_CHANGES, MAX_SUMMARY_CHARS } from '../limits.js'
import type { CommentPage, PublicComment, TokenChange, ViewerVersion } from '../shell/contract.js'
import { tokenDraftKey } from '../shell/design-model.js'
import { tokenChangeInputSchema } from './design-routes.js'
import type { RateLimiter } from './rate-limit.js'
import { type ApiContext, apiForbidden, apiNotFound, apiVersionReplaced, json, noContent } from './respond.js'

export interface CommentRouteDeps {
  comments: CommentService
  design: DesignService
  admin: ArtifactAdmin
  limiter: RateLimiter
  /** The owner's display name, stored with the comments the owner writes. */
  ownerName: string
}

export interface CommentRoutes {
  list(ctx: ApiContext): void
  create(ctx: ApiContext): Promise<void>
  reply(ctx: ApiContext): void
  resolve(ctx: ApiContext): void
  apply(ctx: ApiContext): Promise<void>
  remove(ctx: ApiContext): void
}

const LIMIT = /^[1-9]\d{0,2}$/

const createSuggestionInputSchema = z
  .object({
    changes: z.array(tokenChangeInputSchema).min(1).max(MAX_SUGGESTION_CHANGES),
  })
  .strict()

const applySuggestionBodySchema = z
  .object({
    baseVersion: z.number().int().min(1),
  })
  .strict()

export function createCommentRoutes(deps: CommentRouteDeps): CommentRoutes {
  const { comments, design, admin, limiter } = deps

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
      suggestion: comment.suggestion,
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
  async function attempt(ctx: ApiContext, action: () => void | Promise<void>): Promise<void> {
    try {
      await action()
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
      void attempt(ctx, () => {
        const page = comments.list(ctx.artifactId, {
          ...(seesHistory(ctx.sharing, access) ? {} : { version: ctx.currentVersion }),
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

    async create(ctx) {
      const access = writer(ctx)
      if (!access) return
      await attempt(ctx, async () => {
        const { version, body: rawBody, anchor, suggestion: rawSuggestion } = ctx.body
        if (typeof version === 'number' && isReplaced(ctx.sharing, access, version, ctx.currentVersion))
          return apiVersionReplaced(ctx.res)

        let suggestion: TokenSuggestion | undefined
        let bodyToSave = rawBody
        if (rawSuggestion !== undefined) {
          if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
            return json(ctx.res, 400, { error: 'invalid_comment' })
          }
          const parsedSuggestion = createSuggestionInputSchema.safeParse(rawSuggestion)
          if (!parsedSuggestion.success) {
            return json(ctx.res, 400, { error: 'invalid_comment' })
          }
          const detail = await admin.get(ctx.artifactId)
          if (!detail?.versions.some((v) => v.number === version)) {
            return apiNotFound(ctx.res)
          }
          const loaded = await design.loadEditable(ctx.artifactId, version)
          if (!loaded) {
            return json(ctx.res, 409, { error: 'no_design_contract' })
          }
          let built: ReturnType<typeof buildTokenEdits>
          try {
            built = buildTokenEdits(
              loaded.design.tokenFile,
              loaded.source,
              loaded.parsed,
              parsedSuggestion.data.changes
            )
          } catch (error) {
            if (error instanceof DesignActionError) {
              return json(ctx.res, 400, { error: 'invalid_comment' })
            }
            throw error
          }
          suggestion = {
            file: loaded.design.tokenFile,
            changes: built.appliedChanges,
            appliedVersion: null,
          }
          if (rawBody === undefined || (typeof rawBody === 'string' && rawBody.trim() === '')) {
            bodyToSave = formatTokenSummary(built.appliedChanges)
          }
        }

        // Only what a new thread takes: a reply goes through its own route.
        const created = comments.add(ctx.artifactId, authorOf(access), {
          version,
          body: bodyToSave,
          ...(anchor === undefined ? {} : { anchor }),
          ...(suggestion === undefined ? {} : { suggestion }),
        } as Parameters<CommentService['add']>[2])
        json(ctx.res, 201, toPublic(access, created))
      })
    },

    reply(ctx) {
      const access = writer(ctx)
      if (!access) return
      if (ctx.body.suggestion !== undefined) return json(ctx.res, 400, { error: 'invalid_comment' })
      void attempt(ctx, () => {
        const parent = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!parent) return apiNotFound(ctx.res)
        if (isReplaced(ctx.sharing, access, parent.version, ctx.currentVersion)) return apiVersionReplaced(ctx.res)
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
      void attempt(ctx, () => {
        const comment = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!comment) return apiNotFound(ctx.res)
        comments.setResolved(ctx.artifactId, comment.id, resolved)
        noContent(ctx.res)
      })
    },

    async apply(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      if (ctx.access.kind !== 'owner') return apiForbidden(ctx.res)
      if (!limiter.allow('tokenSave', ctx.artifactId)) return json(ctx.res, 429, { error: 'rate_limited' })

      const parsedBody = applySuggestionBodySchema.safeParse(ctx.body)
      if (!parsedBody.success) return json(ctx.res, 400, { error: 'invalid_comment' })
      if (parsedBody.data.baseVersion !== ctx.currentVersion) {
        return json(ctx.res, 409, { error: 'version_conflict', currentVersion: ctx.currentVersion })
      }

      const existing = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
      if (!existing) return apiNotFound(ctx.res)
      if (existing.parentId !== null || !existing.suggestion) {
        return json(ctx.res, 400, { error: 'invalid_comment' })
      }
      if (existing.suggestion.appliedVersion !== null) {
        return json(ctx.res, 409, { error: 'already_applied' })
      }

      const loaded = await design.loadEditable(ctx.artifactId, ctx.currentVersion)
      if (!loaded) return json(ctx.res, 409, { error: 'no_design_contract' })
      if (loaded.design.tokenFile !== existing.suggestion.file) {
        return json(ctx.res, 409, { error: 'suggestion_conflict' })
      }

      const pendingChanges: TokenChange[] = []
      for (const change of existing.suggestion.changes) {
        const key = tokenDraftKey(change.name, change.theme ?? null)
        const span = loaded.parsed.spans.get(key)
        if (!span || !loaded.parsed.canonicalNames.has(change.name)) {
          return json(ctx.res, 409, { error: 'suggestion_conflict' })
        }
        if (span.value !== change.from && span.value !== change.to) {
          return json(ctx.res, 409, { error: 'suggestion_conflict' })
        }
        if (span.value === change.from) {
          pendingChanges.push({
            name: change.name,
            value: change.to,
            ...(change.theme ? { theme: change.theme } : {}),
          })
        }
      }

      if (pendingChanges.length === 0) {
        const detail = await admin.get(ctx.artifactId)
        if (!detail) return apiNotFound(ctx.res)
        const verInfo = detail.versions.find((v) => v.number === ctx.currentVersion)!
        const updatedComment = comments.markSuggestionApplied(ctx.artifactId, existing.id, ctx.currentVersion)
        const viewerVersion: ViewerVersion = {
          number: verInfo.number,
          createdAt: verInfo.createdAt,
          summary: verInfo.summary,
        }
        return json(ctx.res, 200, {
          version: viewerVersion,
          design: loaded.design,
          comment: toPublic(ctx.access, updatedComment),
        })
      }

      let built: ReturnType<typeof buildTokenEdits>
      try {
        built = buildTokenEdits(loaded.design.tokenFile, loaded.source, loaded.parsed, pendingChanges)
      } catch (error) {
        if (error instanceof DesignActionError) {
          return json(ctx.res, 409, { error: 'suggestion_conflict' })
        }
        throw error
      }

      const diffText = formatTokenSummary(built.appliedChanges).replace(/^Tokens:\s*/, '')
      const summary = `Tokens (suggested by ${existing.author.name}): ${diffText}`.slice(0, MAX_SUMMARY_CHARS)
      try {
        const updated = await admin.update({
          id: ctx.artifactId,
          baseVersion: ctx.currentVersion,
          summary,
          createdBy: 'owner',
          change: { kind: 'edits', edits: built.edits },
        })
        const updatedComment = comments.markSuggestionApplied(ctx.artifactId, existing.id, updated.currentVersion)
        const verInfo = updated.versions.find((v) => v.number === updated.currentVersion)!
        const viewerVersion: ViewerVersion = {
          number: verInfo.number,
          createdAt: verInfo.createdAt,
          summary: verInfo.summary,
        }
        const nextDesign = await design.getDesign(ctx.artifactId, updated.currentVersion)
        json(ctx.res, 200, {
          version: viewerVersion,
          design: nextDesign,
          comment: toPublic(ctx.access, updatedComment),
        })
      } catch (error) {
        if (error instanceof ArtifactHostError) {
          if (error.code === 'version_conflict')
            return json(ctx.res, 409, { error: 'version_conflict', currentVersion: ctx.currentVersion })
          if (error.code === 'version_limit') return json(ctx.res, 409, { error: 'version_limit' })
          if (error.code === 'quota_exceeded') return json(ctx.res, 413, { error: 'quota_exceeded' })
          if (error.code === 'not_found') return apiNotFound(ctx.res)
        }
        throw error
      }
    },

    remove(ctx) {
      const access = ctx.access
      if (!access) return apiNotFound(ctx.res)
      void attempt(ctx, () => {
        const comment = ctx.commentId ? comments.find(ctx.artifactId, ctx.commentId) : null
        if (!comment) return apiNotFound(ctx.res)
        if (isReplaced(ctx.sharing, access, comment.version, ctx.currentVersion)) return apiVersionReplaced(ctx.res)
        if (access.kind !== 'owner' && !isSelf(access, comment)) return apiForbidden(ctx.res)
        comments.remove(ctx.artifactId, comment.id)
        noContent(ctx.res)
      })
    },
  }
}
