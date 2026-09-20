import { delegationModelCatalogSchema } from '@maestrly/protocol'
import type { FastifyInstance } from 'fastify'
import type { DatabasePool } from '../../db/pool.js'
import { chatRunnerIdentity } from '../project-chat/runner-routes.js'
import { runnerTransaction } from '../project-chat/dispatch.js'
import { publishDelegationCatalog } from './model-catalog.js'

/** Machine endpoints for delegation stages. Authentication reuses the runner credential contract. */
export function registerDelegationRunnerRoutes(app: FastifyInstance, pool: DatabasePool): void {
  const root = '/api/v1/runners/delegations'
  const config = { rateLimit: { max: 1800, timeWindow: '1 minute' } }

  app.post(root + '/inventory', { config }, async (request) => {
    const identity = chatRunnerIdentity(request)
    const catalog = delegationModelCatalogSchema.parse(request.body)
    return runnerTransaction(pool, identity, async (client) => {
      await publishDelegationCatalog(client, {
        organizationId: identity.organizationId,
        runnerId: identity.runnerId,
        catalog,
      })
      return { ok: true }
    })
  })
}
