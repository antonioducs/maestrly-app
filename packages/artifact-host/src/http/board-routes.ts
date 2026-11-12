// A whiteboard as its viewers see it: the board when the canvas opens, what changed since, and what a person drew.
import { orderedElements, parseIncoming } from '@maestrly/whiteboard'
import { canEditBoard } from '../access.js'
import type { BoardChange, BoardService } from '../boards.js'
import { ArtifactHostError } from '../errors.js'
import { MAX_BOARD_WAITERS_PER_ARTIFACT } from '../limits.js'
import type { ArtifactStore } from '../store/artifact-store.js'
import { type ApiContext, apiNotFound, json } from './respond.js'

export interface BoardRouteDeps {
  store: ArtifactStore
  boards: BoardService
  /** How long a request for changes waits for one before it answers with none. */
  pollMs: number
}

export interface BoardRoutes {
  board(ctx: ApiContext): void
  changes(ctx: ApiContext): void
  push(ctx: ApiContext): void
}

const REVISION = /^[0-9]{1,15}$/

export function createBoardRoutes(deps: BoardRouteDeps): BoardRoutes {
  const { boards } = deps
  /** Only a whiteboard has a board, and only someone who may view it reads it. */
  const whiteboard = (ctx: ApiContext): boolean =>
    ctx.access !== null && deps.store.getArtifact(ctx.artifactId)?.kind === 'whiteboard'

  return {
    board(ctx) {
      if (!whiteboard(ctx)) return apiNotFound(ctx.res)
      const board = boards.board(ctx.artifactId)
      json(ctx.res, 200, {
        revision: board.revision,
        elements: orderedElements(board),
        canEdit: canEditBoard(ctx.sharing, ctx.access),
      })
    },

    // Long polling: answered at once when the board moved past `since`, otherwise at its next change or after
    // `pollMs` with nothing. Every poll is a new request, so a revoked viewer stops getting changes at the next one.
    changes(ctx) {
      if (!whiteboard(ctx)) return apiNotFound(ctx.res)
      const raw = ctx.query.get('since') ?? ''
      const since = REVISION.test(raw) ? Number(raw) : Number.NaN
      const current = boards.board(ctx.artifactId).revision
      if (!Number.isSafeInteger(since) || since > current) return json(ctx.res, 400, { error: 'invalid_revision' })
      if (since < current) return json(ctx.res, 200, boards.changesSince(ctx.artifactId, since))
      if (boards.waiting(ctx.artifactId) >= MAX_BOARD_WAITERS_PER_ARTIFACT)
        return json(ctx.res, 429, { error: 'too_many_watchers' })
      let settled = false
      const settle = (change: BoardChange | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stop()
        if (change && !ctx.res.destroyed && !ctx.res.writableEnded) json(ctx.res, 200, change)
      }
      const stop = boards.wait(ctx.artifactId, settle)
      const timer = setTimeout(
        () => settle({ revision: boards.board(ctx.artifactId).revision, elements: [] }),
        deps.pollMs
      )
      // The viewer left, or the connection was cut: nothing is waiting for the answer any more.
      ctx.res.once('close', () => settle(null))
    },

    push(ctx) {
      if (!whiteboard(ctx)) return apiNotFound(ctx.res)
      if (!canEditBoard(ctx.sharing, ctx.access)) return json(ctx.res, 403, { error: 'read_only' })
      const parsed = parseIncoming(ctx.body.elements)
      if (!parsed.ok)
        return parsed.reason === 'too_large'
          ? json(ctx.res, 413, { error: 'too_large' })
          : json(ctx.res, 400, { error: 'invalid_elements' })
      try {
        json(ctx.res, 200, boards.mergePerson(ctx.artifactId, parsed.elements, ctx.now))
      } catch (error) {
        if (!(error instanceof ArtifactHostError)) throw error
        if (error.code === 'limit_reached' || error.code === 'quota_exceeded')
          return json(ctx.res, 409, { error: 'board_full' })
        throw error
      }
    },
  }
}
