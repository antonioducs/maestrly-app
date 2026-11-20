import { z } from 'zod'
import { isReplaced } from '../access.js'
import type { ArtifactAdmin } from '../admin.js'
import { buildTokenEdits, DesignActionError, type DesignService, formatTokenSummary } from '../design.js'
import { ArtifactHostError } from '../errors.js'
import { MAX_DESIGN_TOKENS, MAX_SUMMARY_CHARS } from '../limits.js'
import {
  type DesignResponse,
  isValidThemeSelector,
  isValidTokenName,
  isValidTokenValue,
  type ViewerVersion,
} from '../shell/contract.js'
import type { RateLimiter } from './rate-limit.js'
import { type ApiContext, apiForbidden, apiNotFound, apiVersionReplaced, json } from './respond.js'

export interface DesignRouteDeps {
  design: DesignService
  admin: ArtifactAdmin
  limiter: RateLimiter
}

export interface DesignRoutes {
  get(ctx: ApiContext): Promise<void>
  saveTokens(ctx: ApiContext): Promise<void>
}

const VERSION_PARAM = /^[1-9]\d{0,5}$/

export const tokenChangeInputSchema = z
  .object({
    name: z.string().refine(isValidTokenName),
    theme: z
      .string()
      .refine(isValidThemeSelector)
      .nullable()
      .optional()
      .transform((v) => v ?? undefined),
    value: z.string().refine(isValidTokenValue),
  })
  .strict()

const saveTokensBodySchema = z
  .object({
    baseVersion: z.number().int().min(1),
    changes: z.array(tokenChangeInputSchema).min(1).max(MAX_DESIGN_TOKENS),
    summary: z.string().trim().max(MAX_SUMMARY_CHARS).optional(),
  })
  .strict()

export function createDesignRoutes(deps: DesignRouteDeps): DesignRoutes {
  const { design, admin, limiter } = deps

  return {
    async get(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      const versionQuery = ctx.query.get('version')
      let version = ctx.currentVersion
      if (versionQuery !== null) {
        if (!VERSION_PARAM.test(versionQuery)) return json(ctx.res, 400, { error: 'invalid_version' })
        version = Number(versionQuery)
      }
      if (isReplaced(ctx.sharing, ctx.access, version, ctx.currentVersion)) return apiVersionReplaced(ctx.res)
      const detail = await admin.get(ctx.artifactId)
      if (!detail?.versions.some((v) => v.number === version)) return apiNotFound(ctx.res)

      const loaded = await design.getDesign(ctx.artifactId, version)
      const response: DesignResponse = { design: loaded }
      json(ctx.res, 200, response)
    },

    async saveTokens(ctx) {
      if (!ctx.access) return apiNotFound(ctx.res)
      if (ctx.access.kind !== 'owner') return apiForbidden(ctx.res)
      if (!limiter.allow('tokenSave', ctx.artifactId)) return json(ctx.res, 429, { error: 'rate_limited' })

      const parsedBody = saveTokensBodySchema.safeParse(ctx.body)
      if (!parsedBody.success) return json(ctx.res, 400, { error: 'invalid_tokens' })
      const { baseVersion, changes, summary } = parsedBody.data

      if (baseVersion !== ctx.currentVersion) {
        return json(ctx.res, 409, { error: 'version_conflict', currentVersion: ctx.currentVersion })
      }

      const loaded = await design.loadEditable(ctx.artifactId, baseVersion)
      if (!loaded) return json(ctx.res, 409, { error: 'no_design_contract' })

      let built: ReturnType<typeof buildTokenEdits>
      try {
        built = buildTokenEdits(loaded.design.tokenFile, loaded.source, loaded.parsed, changes)
      } catch (error) {
        if (error instanceof DesignActionError) {
          const status = error.code === 'no_changes' ? 400 : error.code === 'no_design_contract' ? 409 : 400
          return json(ctx.res, status, { error: error.code })
        }
        throw error
      }

      const versionSummary = summary && summary.length > 0 ? summary : formatTokenSummary(built.appliedChanges)
      try {
        const updated = await admin.update({
          id: ctx.artifactId,
          baseVersion,
          summary: versionSummary,
          createdBy: 'owner',
          change: { kind: 'edits', edits: built.edits },
        })
        const info = updated.versions.find((v) => v.number === updated.currentVersion)!
        const viewerVersion: ViewerVersion = {
          number: info.number,
          createdAt: info.createdAt,
          summary: info.summary,
        }
        const nextDesign = await design.getDesign(ctx.artifactId, updated.currentVersion)
        json(ctx.res, 201, { version: viewerVersion, design: nextDesign })
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
  }
}
