// A person's response to an artifact page: the page asks the viewer, and the viewer saves it here as that person.
import type { Access } from '../access.js'
import { ArtifactHostError } from '../errors.js'
import type { ResponseAuthor, ResponseService, ResponseView } from '../responses.js'
import type { ResponseSnapshot } from '../shell/contract.js'
import { type ApiContext, apiNotFound, json } from './respond.js'

/** The key of the owner's own response; people's responses are keyed by their ID. */
export const OWNER_RESPONDENT = 'owner'

export interface ResponseRouteDeps {
  responses: ResponseService
  /** The owner's display name, stored with the response the owner sends. */
  ownerName: string
}

export interface ResponseRoutes {
  mine(ctx: ApiContext): void
  save(ctx: ApiContext): void
}

export function createResponseRoutes(deps: ResponseRouteDeps): ResponseRoutes {
  const respondentOf = (access: Access): string => (access.kind === 'owner' ? OWNER_RESPONDENT : access.principal.id)

  const authorOf = (access: Access): ResponseAuthor =>
    access.kind === 'owner'
      ? { kind: 'owner', name: deps.ownerName, respondent: OWNER_RESPONDENT }
      : { kind: access.principal.kind, name: access.principal.name, respondent: access.principal.id }

  /** What the page learns about the response: its own data back, and no one's name or ID. */
  const snapshot = (response: ResponseView): ResponseSnapshot => ({
    data: response.data,
    version: response.version,
    updatedAt: response.updatedAt,
  })

  return {
    mine(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      const found = deps.responses.mine(ctx.artifactId, respondentOf(ctx.access))
      json(ctx.res, 200, { response: found ? snapshot(found) : null })
    },

    save(ctx) {
      const access = ctx.access
      if (!access) return apiNotFound(ctx.res)
      if (!ctx.sharing.responsesEnabled) return json(ctx.res, 403, { error: 'responses_closed' })
      if (access.kind === 'person' && !access.principal.name) return json(ctx.res, 409, { error: 'name_required' })
      try {
        // Only what a response takes; anything else in the body is ignored.
        const { response, created } = deps.responses.save(ctx.artifactId, authorOf(access), {
          version: ctx.body.version,
          data: ctx.body.data,
        } as { version: number; data: unknown })
        json(ctx.res, 200, { response: snapshot(response), created })
      } catch (error) {
        if (!(error instanceof ArtifactHostError)) throw error
        if (error.code === 'not_found') apiNotFound(ctx.res)
        else if (error.code === 'limit_reached') json(ctx.res, 409, { error: 'too_many_responses' })
        else if (error.code === 'invalid_input') json(ctx.res, 400, { error: 'invalid_response' })
        else throw error
      }
    },
  }
}
