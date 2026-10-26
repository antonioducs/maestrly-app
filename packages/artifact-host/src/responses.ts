import { z } from 'zod'
import { ArtifactHostError } from './errors.js'
import { isArtifactId, randomId } from './ids.js'
import { MAX_RESPONSES_PER_ARTIFACT, RESPONSES_PAGE_SIZE } from './limits.js'
import { parseInput } from './schemas.js'
import type { ActivityRecorder } from './sharing-admin.js'
import { isResponseData, type ResponseData } from './shell/contract.js'
import type { ArtifactStore } from './store/artifact-store.js'
import type { ResponseAuthorKind, ResponseRecord, ResponseStore } from './store/response-store.js'

export type { ResponseData } from './shell/contract.js'
export type { ResponseAuthorKind } from './store/response-store.js'

export interface ResponseView {
  id: string
  /** The version it was last sent from. */
  version: number
  /** Owner, invited and approved people are verified; a guest's name is whatever they typed. */
  author: { kind: ResponseAuthorKind; name: string; verified: boolean }
  data: ResponseData
  /** When the person first sent it, and when they last changed it. */
  createdAt: number
  updatedAt: number
}

/** Who sends a response, and the key that makes it theirs: a person's ID, or `owner`. */
export interface ResponseAuthor {
  kind: ResponseAuthorKind
  name: string
  respondent: string
}

export interface ResponseListInput {
  cursor?: string
  limit?: number
}

export const responseDataSchema = z.custom<ResponseData>(isResponseData, 'Expected a JSON object of at most 32 KiB')

const saveInput = z.object({ version: z.number().int().min(1), data: responseDataSchema }).strict()

const listInput = z
  .object({
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,14}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(RESPONSES_PAGE_SIZE).optional(),
  })
  .strict()

export const toResponseView = (record: ResponseRecord): ResponseView => ({
  id: record.id,
  version: record.version,
  author: { kind: record.authorKind, name: record.authorName, verified: record.authorKind !== 'guest' },
  data: JSON.parse(record.dataJson) as ResponseData,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

export interface ResponseService {
  list(artifactId: string, input?: ResponseListInput): { responses: ResponseView[]; nextCursor: string | null }
  /** The respondent's response, when they sent one. */
  mine(artifactId: string, respondent: string): ResponseView | null
  /** Saves the author's response from a version of the artifact, replacing the one they sent before. */
  save(
    artifactId: string,
    author: ResponseAuthor,
    input: { version: number; data: unknown }
  ): { response: ResponseView; created: boolean }
  remove(artifactId: string, responseId: string): void
}

export interface ResponseServiceDeps {
  store: ArtifactStore
  responses: ResponseStore
  clock: () => number
  maxResponses?: number
  onChange?: (artifactId: string) => void
  /** Tells the owner about the first response of each person. */
  record?: ActivityRecorder
}

const notFound = (what: string) => new ArtifactHostError('not_found', `${what} not found`)

/** The rules of responses, the same for the owner and visitors; who may send one is decided by the callers. */
export function createResponseService(deps: ResponseServiceDeps): ResponseService {
  const { store, responses, clock } = deps
  const maxResponses = deps.maxResponses ?? MAX_RESPONSES_PER_ARTIFACT

  function artifact(id: string): void {
    if (!isArtifactId(id) || !store.getArtifact(id)) throw notFound('Artifact')
  }

  return {
    list(artifactId, raw = {}) {
      artifact(artifactId)
      const input = parseInput(listInput, raw)
      const limit = input.limit ?? RESPONSES_PAGE_SIZE
      // One more than asked for tells whether there is another page.
      const rows = responses.list(artifactId, {
        after: input.cursor === undefined ? undefined : Number(input.cursor),
        limit: limit + 1,
      })
      const page = rows.slice(0, limit)
      return {
        responses: page.map((row) => toResponseView(row.response)),
        nextCursor: rows.length > limit ? String(page[page.length - 1]!.position) : null,
      }
    },

    mine(artifactId, respondent) {
      const found = responses.findByRespondent(artifactId, respondent)
      return found ? toResponseView(found) : null
    },

    save(artifactId, author, raw) {
      artifact(artifactId)
      const input = parseInput(saveInput, raw)
      if (!store.getVersion(artifactId, input.version)) throw notFound(`Version ${input.version}`)
      const now = clock()
      const dataJson = JSON.stringify(input.data)
      const existing = responses.findByRespondent(artifactId, author.respondent)
      if (existing) {
        responses.update(existing.id, {
          authorKind: author.kind,
          authorName: author.name,
          version: input.version,
          dataJson,
          updatedAt: now,
        })
        deps.onChange?.(artifactId)
        return { response: toResponseView(responses.get(existing.id)!), created: false }
      }
      if (responses.count(artifactId) >= maxResponses)
        throw new ArtifactHostError('limit_reached', `This artifact reached ${maxResponses} responses`)
      const record: ResponseRecord = {
        id: randomId(),
        artifactId,
        respondent: author.respondent,
        authorKind: author.kind,
        authorName: author.name,
        version: input.version,
        dataJson,
        createdAt: now,
        updatedAt: now,
      }
      responses.insert(record)
      // A new response is news to the owner; an edited one, or the owner's own, is not.
      if (author.kind !== 'owner' && deps.record) deps.record(artifactId, 'response_submitted', { name: author.name })
      else deps.onChange?.(artifactId)
      return { response: toResponseView(record), created: true }
    },

    remove(artifactId, responseId) {
      artifact(artifactId)
      const found = typeof responseId === 'string' ? responses.get(responseId) : null
      if (!found || found.artifactId !== artifactId) throw notFound('Response')
      responses.remove(found.id)
      deps.onChange?.(artifactId)
    },
  }
}
