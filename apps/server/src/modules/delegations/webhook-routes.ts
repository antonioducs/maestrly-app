/**
 * Optional inbound GitHub webhook.
 *
 * It lives outside `/api/v1` because GitHub cannot send the Maestrly protocol header, and it verifies an HMAC
 * over the exact bytes received. The default follow-up path needs no webhook at all: the executor polls with
 * its own local credentials.
 */
import {
  delegationSourceEventSchema,
  type DelegationSourceEvent,
} from '@maestrly/protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import type { HumanIdentity } from '../auth/routes.js'
import { SecretVault, fingerprintOfSecret, parseSecretKeys } from '../connectors/secrets.js'
import { ingestForRepository, verifyGitHubSignature } from './github-events.js'
import { delegationFail } from './repository.js'

type Authenticate = (request: FastifyRequest, scopes?: readonly string[]) => Promise<HumanIdentity | null>

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024

/** Map a GitHub delivery to the normalized event this domain understands. */
export function normalizeGitHubDelivery(input: {
  deliveryId: string
  event: string
  body: Record<string, unknown>
}): { event: DelegationSourceEvent; repository: string; branch: string } | null {
  const repository = (input.body.repository as { full_name?: string } | undefined)?.full_name
  if (!repository) return null
  const pullRequest = input.body.pull_request as
    | { number?: number; head?: { ref?: string; sha?: string } }
    | undefined
  const checkSuite = input.body.check_suite as { head_sha?: string; head_branch?: string } | undefined
  const checkRun = input.body.check_run as
    | { head_sha?: string; check_suite?: { head_branch?: string } }
    | undefined
  const workflowRun = input.body.workflow_run as { head_sha?: string; head_branch?: string } | undefined
  const branch =
    pullRequest?.head?.ref ?? checkSuite?.head_branch ?? checkRun?.check_suite?.head_branch ?? workflowRun?.head_branch
  const headSha = pullRequest?.head?.sha ?? checkSuite?.head_sha ?? checkRun?.head_sha ?? workflowRun?.head_sha
  if (!branch) return null
  return {
    repository,
    branch,
    event: delegationSourceEventSchema.parse({
      source: 'github',
      externalId: input.deliveryId,
      type: input.event,
      pullRequestNumber: pullRequest?.number ?? null,
      headSha: headSha ?? null,
      // Only the identifying fields are kept; the raw third-party payload is not stored wholesale.
      payload: { repository, branch, action: typeof input.body.action === 'string' ? input.body.action : null },
      occurredAt: new Date().toISOString(),
    }),
  }
}

export function registerDelegationWebhookRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: ServerConfig,
  authenticate: Authenticate
): void {
  const vault = new SecretVault(parseSecretKeys(config.secretKeys))
  const root = '/api/v1/organizations/:organizationId/projects/:projectId'

  app.put(root + '/delegation-webhook', async (request) => {
    const human = await authenticate(request, ['api:write'])
    if (!human) delegationFail('Authentication required.', 401)
    const params = z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() }).parse(request.params)
    const body = z
      .object({
        repository: z.string().trim().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Use the owner/repo form.'),
        secret: z.string().min(16).max(500),
        enabled: z.boolean().default(true),
      })
      .strict()
      .parse(request.body)
    if (!vault.available)
      delegationFail('Configure MAESTRLY_SECRET_KEYS before storing a webhook secret.', 503)
    const sealed = vault.seal(body.secret)
    return inTenantTransaction(
      pool,
      { ...params, actor: { type: 'human', userId: human.userId } },
      async (client) => {
        await authorizeProject(client, params.organizationId, params.projectId, human.userId, 'automation:manage')
        await client.query(
          `insert into delegation_webhook_bindings(
             organization_id, project_id, repository, secret_cipher, secret_nonce, secret_fingerprint, key_id,
             enabled, created_by_user_id
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (organization_id, project_id, repository) do update set
             secret_cipher=excluded.secret_cipher, secret_nonce=excluded.secret_nonce,
             secret_fingerprint=excluded.secret_fingerprint, key_id=excluded.key_id, enabled=excluded.enabled,
             updated_at=now()`,
          [
            params.organizationId,
            params.projectId,
            body.repository,
            sealed.cipher,
            sealed.nonce,
            sealed.fingerprint,
            sealed.keyId,
            body.enabled,
            human.userId,
          ]
        )
        // The secret itself is never returned; the fingerprint confirms which one is stored.
        return {
          repository: body.repository,
          enabled: body.enabled,
          secretFingerprint: fingerprintOfSecret(body.secret),
          keyId: sealed.keyId,
          url: `${config.canonicalUrl}/webhooks/github/${params.organizationId}`,
        }
      }
    )
  })

  app.post(
    '/webhooks/github/:organizationId',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      bodyLimit: MAX_WEBHOOK_BYTES,
      // The signature covers the exact bytes GitHub sent, so the raw body is captured before parsing.
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of payload) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
          size += buffer.byteLength
          if (size > MAX_WEBHOOK_BYTES) throw Object.assign(new Error('Webhook payload too large.'), { statusCode: 413 })
          chunks.push(buffer)
        }
        const raw = Buffer.concat(chunks)
        ;(request as FastifyRequest & { rawWebhookBody?: Buffer }).rawWebhookBody = raw
        const { Readable } = await import('node:stream')
        return Readable.from(raw)
      },
    },
    async (request, reply) => {
      const params = z.object({ organizationId: z.string().uuid() }).parse(request.params)
      const raw = (request as FastifyRequest & { rawWebhookBody?: Buffer }).rawWebhookBody
      if (!raw) return reply.status(400).send({ error: 'missing_body' })
      const deliveryId = request.headers['x-github-delivery']
      const eventName = request.headers['x-github-event']
      const signature = request.headers['x-hub-signature-256']
      if (typeof deliveryId !== 'string' || typeof eventName !== 'string')
        return reply.status(400).send({ error: 'missing_delivery_headers' })
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      } catch {
        return reply.status(400).send({ error: 'invalid_json' })
      }
      const normalized = normalizeGitHubDelivery({
        deliveryId,
        event: eventName,
        body: parsed,
      })
      if (!normalized) return reply.status(202).send({ accepted: false, reason: 'unsupported_event' })
      if (!vault.available) return reply.status(503).send({ error: 'secret_key_unavailable' })

      const binding = await inTenantTransaction(
        pool,
        { organizationId: params.organizationId, actor: { type: 'system', service: 'delegation-scheduler' } },
        async (client) => {
          const rows = await client.query<{
            secret_cipher: Buffer
            secret_nonce: Buffer
            key_id: string
          }>(
            'select secret_cipher, secret_nonce, key_id from delegation_webhook_bindings where organization_id=$1 and repository=$2 and enabled',
            [params.organizationId, normalized.repository]
          )
          return rows.rows[0] ?? null
        }
      )
      if (!binding) return reply.status(404).send({ error: 'repository_not_bound' })
      const secret = vault.open({
        cipher: binding.secret_cipher,
        nonce: binding.secret_nonce,
        keyId: binding.key_id,
      })
      if (!verifyGitHubSignature({ rawBody: raw, signature: typeof signature === 'string' ? signature : undefined, secret }))
        return reply.status(401).send({ error: 'invalid_signature' })
      try {
        const result = await ingestForRepository(pool, {
          organizationId: params.organizationId,
          repository: normalized.repository,
          branch: normalized.branch,
          event: normalized.event,
        })
        // Accepting a delivery only means it was recorded; the reaction is decided by the watcher.
        return reply.status(202).send({ accepted: true, eventId: result.eventId, state: result.state })
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 500
        if (statusCode === 404) return reply.status(202).send({ accepted: false, reason: 'no_task_following_branch' })
        throw error
      }
    }
  )
}
