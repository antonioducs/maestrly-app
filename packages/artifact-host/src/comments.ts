import { z } from 'zod'
import { normalizeBundlePath } from './bundle-paths.js'
import { ArtifactHostError } from './errors.js'
import { isArtifactId, randomId } from './ids.js'
import {
  COMMENTS_PAGE_SIZE,
  MAX_COMMENT_CHARS,
  MAX_COMMENTS_PER_ARTIFACT,
  MAX_PATH_CHARS,
  MAX_SUGGESTION_CHANGES,
} from './limits.js'
import { parseInput } from './schemas.js'
import type { ActivityRecorder } from './sharing-admin.js'
import {
  type CommentAnchor,
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_CONTEXT_CHARS,
  MAX_SELECTOR_CHARS,
  type TokenSuggestion,
} from './shell/contract.js'
import type { ArtifactStore } from './store/artifact-store.js'
import type { CommentAuthorKind, CommentRecord, CommentStore } from './store/comment-store.js'

export type { CommentAuthorKind } from './store/comment-store.js'

export type { CommentAnchor, TokenSuggestion } from './shell/contract.js'

export interface CommentView {
  id: string
  /** The version the thread was started on; replies carry their thread's version. */
  version: number
  parentId: string | null
  /** Owner, agent, invited and approved authors are verified; a guest's name is whatever they typed. */
  author: { kind: CommentAuthorKind; name: string; verified: boolean; principalId: string | null }
  body: string
  anchor: CommentAnchor | null
  suggestion: TokenSuggestion | null
  status: 'open' | 'resolved'
  createdAt: number
}

export interface CommentAuthor {
  kind: CommentAuthorKind
  name: string
  principalId: string | null
}

export interface CommentListInput {
  status?: 'open' | 'all'
  version?: number
  cursor?: string
  limit?: number
}

export interface NewComment {
  /** Needed to start a thread; a reply takes its thread's version. */
  version?: number
  body: string
  anchor?: CommentAnchor
  suggestion?: TokenSuggestion
  parentId?: string
}

const context = z.string().max(MAX_QUOTE_CONTEXT_CHARS)

export const commentAnchorSchema: z.ZodType<CommentAnchor> = z
  .object({
    quote: z
      .object({ exact: z.string().min(1).max(MAX_QUOTE_CHARS), prefix: context, suffix: context })
      .strict()
      .optional(),
    point: z
      .object({
        selector: z.string().min(1).max(MAX_SELECTOR_CHARS),
        rx: z.number().min(0).max(1),
        ry: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    hint: z
      .object({ selector: z.string().min(1).max(MAX_SELECTOR_CHARS) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((anchor) => !(anchor.quote && anchor.point), 'Anchor a comment to a passage or to a spot, not both')

const tokenSuggestionChangeSchema = z
  .object({
    name: z.string().refine(isValidTokenName, 'Invalid token name'),
    theme: z.string().refine(isValidThemeSelector, 'Invalid theme selector').optional(),
    from: z.string().refine(isValidTokenValue, 'Invalid token value'),
    to: z.string().refine(isValidTokenValue, 'Invalid token value'),
  })
  .strict()
  .refine((change) => change.from !== change.to, 'Token suggestion must change value')

export const tokenSuggestionSchema: z.ZodType<TokenSuggestion> = z
  .object({
    file: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARS)
      .refine((value) => {
        try {
          return normalizeBundlePath(value) === value && value.endsWith('.css')
        } catch {
          return false
        }
      }, 'Invalid tokens file path'),
    changes: z
      .array(tokenSuggestionChangeSchema)
      .min(1)
      .max(MAX_SUGGESTION_CHANGES)
      .refine(
        (changes) => new Set(changes.map((c) => `${c.theme ?? ''}\0${c.name}`)).size === changes.length,
        'Duplicate token in suggestion'
      ),
    appliedVersion: z.number().int().min(1).nullable(),
  })
  .strict()

export const commentBody = z.string().trim().min(1).max(MAX_COMMENT_CHARS)

const newComment = z
  .object({
    version: z.number().int().min(1).optional(),
    body: commentBody,
    anchor: commentAnchorSchema.optional(),
    suggestion: tokenSuggestionSchema.optional(),
    parentId: z.string().optional(),
  })
  .strict()

const listInput = z
  .object({
    status: z.enum(['open', 'all']).optional(),
    version: z.number().int().min(1).optional(),
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,14}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(COMMENTS_PAGE_SIZE).optional(),
  })
  .strict()

function parseAnchor(json: string | null): CommentAnchor | null {
  if (json === null) return null
  try {
    const parsed = commentAnchorSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parseSuggestion(json: string | null | undefined): TokenSuggestion | null {
  if (!json) return null
  try {
    const parsed = tokenSuggestionSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const toCommentView = (comment: CommentRecord): CommentView => ({
  id: comment.id,
  version: comment.version,
  parentId: comment.parentId,
  author: {
    kind: comment.authorKind,
    name: comment.authorName,
    verified: comment.authorKind !== 'guest',
    principalId: comment.principalId,
  },
  body: comment.body,
  anchor: parseAnchor(comment.anchorJson),
  suggestion: parseSuggestion(comment.suggestionJson),
  status: comment.status,
  createdAt: comment.createdAt,
})

export interface CommentService {
  list(artifactId: string, input?: CommentListInput): { comments: CommentView[]; nextCursor: string | null }
  /** The comment, when it exists on that artifact. */
  find(artifactId: string, commentId: string): CommentView | null
  add(artifactId: string, author: CommentAuthor, input: NewComment): CommentView
  setResolved(artifactId: string, commentId: string, resolved: boolean): void
  markSuggestionApplied(artifactId: string, commentId: string, appliedVersion: number): CommentView
  remove(artifactId: string, commentId: string): void
}

export interface CommentServiceDeps {
  store: ArtifactStore
  comments: CommentStore
  clock: () => number
  maxComments?: number
  onChange?: (artifactId: string) => void
  /** Tells the owner about comments from other people. */
  record?: ActivityRecorder
}

const notFound = (what: string) => new ArtifactHostError('not_found', `${what} not found`)

/** The rules of comments, the same for the owner, agents and visitors; who may do what is decided by the callers. */
export function createCommentService(deps: CommentServiceDeps): CommentService {
  const { store, comments, clock } = deps
  const maxComments = deps.maxComments ?? MAX_COMMENTS_PER_ARTIFACT

  function artifact(id: string): void {
    if (!isArtifactId(id) || !store.getArtifact(id)) throw notFound('Artifact')
  }

  function existing(artifactId: string, commentId: string): CommentRecord {
    artifact(artifactId)
    const comment = typeof commentId === 'string' ? comments.get(commentId) : null
    if (!comment || comment.artifactId !== artifactId) throw notFound('Comment')
    return comment
  }

  return {
    list(artifactId, raw = {}) {
      artifact(artifactId)
      const input = parseInput(listInput, raw)
      const limit = input.limit ?? COMMENTS_PAGE_SIZE
      // One more than asked for tells whether there is another page.
      const rows = comments.list(artifactId, {
        status: input.status,
        version: input.version,
        after: input.cursor === undefined ? undefined : Number(input.cursor),
        limit: limit + 1,
      })
      const page = rows.slice(0, limit)
      return {
        comments: page.map((row) => toCommentView(row.comment)),
        nextCursor: rows.length > limit ? String(page[page.length - 1]!.position) : null,
      }
    },

    find(artifactId, commentId) {
      const comment = typeof commentId === 'string' ? comments.get(commentId) : null
      return comment && comment.artifactId === artifactId ? toCommentView(comment) : null
    },

    add(artifactId, author, raw) {
      artifact(artifactId)
      const input = parseInput(newComment, raw)
      let version: number
      let parentId: string | null = null
      if (input.parentId !== undefined) {
        const parent = comments.get(input.parentId)
        // Threads are one level deep: a reply answers the comment that started the thread.
        if (!parent || parent.artifactId !== artifactId || parent.parentId !== null) throw notFound('Comment')
        if (input.anchor) throw new ArtifactHostError('invalid_input', 'A reply has no anchor of its own')
        if (input.suggestion) throw new ArtifactHostError('invalid_input', 'A reply has no suggestion of its own')
        version = parent.version
        parentId = parent.id
      } else {
        if (input.version === undefined) throw new ArtifactHostError('invalid_input', 'version: Required')
        if (!store.getVersion(artifactId, input.version)) throw notFound(`Version ${input.version}`)
        version = input.version
      }
      if (comments.count(artifactId) >= maxComments)
        throw new ArtifactHostError('limit_reached', `This artifact reached ${maxComments} comments`)
      const comment: CommentRecord = {
        id: randomId(),
        artifactId,
        version,
        parentId,
        authorKind: author.kind,
        principalId: author.principalId,
        authorName: author.name,
        body: input.body,
        anchorJson: input.anchor && Object.keys(input.anchor).length ? JSON.stringify(input.anchor) : null,
        suggestionJson: input.suggestion ? JSON.stringify(input.suggestion) : null,
        status: 'open',
        createdAt: clock(),
      }
      comments.insert(comment)
      // The owner's and their agent's comments are not news to the owner.
      if (author.kind !== 'owner' && author.kind !== 'agent' && deps.record)
        deps.record(artifactId, 'comment_added', { name: author.name })
      else deps.onChange?.(artifactId)
      return toCommentView(comment)
    },

    setResolved(artifactId, commentId, resolved) {
      const comment = existing(artifactId, commentId)
      if (comment.parentId !== null) throw new ArtifactHostError('invalid_input', 'Only a thread can be resolved')
      if (typeof resolved !== 'boolean') throw new ArtifactHostError('invalid_input', 'resolved: Expected a boolean')
      comments.setStatus(comment.id, resolved ? 'resolved' : 'open')
      deps.onChange?.(artifactId)
    },

    markSuggestionApplied(artifactId, commentId, appliedVersion) {
      const comment = existing(artifactId, commentId)
      if (comment.parentId !== null) throw new ArtifactHostError('invalid_input', 'Only a thread has a suggestion')
      const suggestion = parseSuggestion(comment.suggestionJson)
      if (!suggestion) throw new ArtifactHostError('invalid_input', 'Comment has no token suggestion')
      if (!Number.isInteger(appliedVersion) || appliedVersion < 1 || !store.getVersion(artifactId, appliedVersion))
        throw notFound(`Version ${appliedVersion}`)
      const updated: TokenSuggestion = { ...suggestion, appliedVersion }
      const suggestionJson = JSON.stringify(updated)
      comments.setSuggestionAndStatus(comment.id, suggestionJson, 'resolved')
      deps.onChange?.(artifactId)
      return toCommentView({ ...comment, suggestionJson, status: 'resolved' })
    },

    remove(artifactId, commentId) {
      comments.softDelete(existing(artifactId, commentId).id, clock())
      deps.onChange?.(artifactId)
    },
  }
}
