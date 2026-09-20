import { createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import {
  connectorNotificationPayloadSchema,
  delegationCatalogRevision,
  delegationModelCatalogSchema,
  type DelegationModelCatalog,
} from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { createConnectorConnection } from '../../src/modules/connectors/grants.js'
import {
  deliverPendingNotifications,
  getNotificationEndpoint,
  setNotificationEndpoint,
  summarizeDelegationEvent,
} from '../../src/modules/connectors/notifications.js'
import { isPrivateAddress, resolveOutboundTarget } from '../../src/modules/connectors/outbound.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { appendDelegationEvent, loadTaskRow } from '../../src/modules/delegations/repository.js'
import { createDelegation } from '../../src/modules/delegations/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }
const secretKeys = `notify-key:${Buffer.alloc(32, 9).toString('base64')}`
const callbackSecret = 'a-callback-secret-that-is-long-enough'
const deliveryOptions = { webOrigin: links.webOrigin, secretKeys, allowPrivateHosts: true, timeoutMs: 4_000 }

const features = {
  checks: [],
  github: { available: false, login: null, issue: null },
  preview: { available: false, issue: null },
  maestro: true,
  subagents: false,
  browserInspect: false,
  browserInteract: false,
}

const models = [
  {
    selectionId: 'sel-opus',
    modelLabel: 'claude-opus-5',
    accountLabel: 'Claude · personal',
    efforts: ['high'],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
  },
]

function catalogFor(projectId: string): DelegationModelCatalog {
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: models as never, features, workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models,
    features,
    issues: [],
  })
}

interface Received {
  headers: http.IncomingHttpHeaders
  raw: Buffer
}

/** A real receiver on loopback: the signature is verified over the bytes that actually arrived. */
async function receiver() {
  const received: Received[] = []
  let status = 200
  let location: string | null = null
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ headers: request.headers, raw: Buffer.concat(chunks) })
      response.statusCode = status
      if (location) response.setHeader('location', location)
      response.end('received')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/routine`,
    received,
    answerWith(next: number, redirectTo: string | null = null) {
      status = next
      location = redirectTo
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string) {
  const owner = `notify-owner-${crypto.randomUUID()}`
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const other = await createProject(pool, { organizationId, actorUserId: owner, name: `${name} (other)` })
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 1,
  })
  await inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } },
    (client) => publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog: catalogFor(projectId) })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  const scope = { organizationId, projectId, userId: owner }
  const view = await createDelegation(
    pool,
    scope,
    {
      boardId: board.board.id,
      title: name,
      objective: '',
      acceptanceCriteria: [],
      executorId: executor.runnerId,
      workspaceKey: 'workspace-key',
      baseBranch: 'main',
      stages: [
        {
          type: 'implement',
          title: 'Implement',
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-opus', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: false,
    },
    links
  )
  return { owner, organizationId, projectId, otherProjectId: other.project.id, scope, taskId: view.task.id }
}

/** Emit one delegation event as the domain would, inside the owner's tenant transaction. */
async function emit(
  pool: ReturnType<typeof runtimePool>,
  context: Awaited<ReturnType<typeof fixture>>,
  type: string,
  data: Record<string, unknown> = {}
) {
  return inTenantTransaction(
    pool,
    {
      organizationId: context.organizationId,
      projectId: context.projectId,
      actor: { type: 'human', userId: context.owner },
    },
    async (client) => {
      const task = await loadTaskRow(client, context.scope, context.taskId)
      return appendDelegationEvent(client, task, type, data)
    }
  )
}

function queued(pool: ReturnType<typeof runtimePool>, organizationId: string) {
  return inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'system', service: 'connector-notifier' } },
    async (client) => {
      const rows = await client.query(
        'select type, state, attempts, last_error, next_attempt_at from connector_notifications where organization_id=$1 order by created_at',
        [organizationId]
      )
      return rows.rows as Array<{
        type: string
        state: string
        attempts: number
        last_error: string | null
        next_attempt_at: Date
      }>
    }
  )
}

async function connect(
  pool: ReturnType<typeof runtimePool>,
  context: Awaited<ReturnType<typeof fixture>>,
  input: { url: string; projectIds?: string[] }
) {
  const connection = await createConnectorConnection(
    pool,
    { organizationId: context.organizationId, userId: context.owner },
    {
      clientId: `client-${crypto.randomUUID()}`,
      name: 'Routine',
      grants: (input.projectIds ?? [context.projectId]).map((projectId) => ({
        projectId,
        actions: ['tasks:read' as const],
      })),
      cancelOnRevoke: true,
    }
  )
  const endpoint = await setNotificationEndpoint(
    pool,
    { organizationId: context.organizationId, userId: context.owner, connectionId: connection.id },
    { url: input.url, secret: callbackSecret, enabled: true },
    { secretKeys, allowPrivateHosts: true }
  )
  return { connection, endpoint }
}

describe.skipIf(!integrationAvailable)('connector notifications', () => {
  const closers: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const close of closers) await close()
  })

  it('refuses a callback that points inside this network and never embeds a secret in a reply', async () => {
    const options = { allowPrivateHosts: false }
    await expect(resolveOutboundTarget('http://grok.example/hook', options)).rejects.toThrow(/HTTPS/)
    await expect(resolveOutboundTarget('https://user:pass@grok.example/hook', options)).rejects.toThrow(
      /credentials/
    )
    await expect(resolveOutboundTarget('https://127.0.0.1/hook', options)).rejects.toThrow(/inside this network/)
    await expect(resolveOutboundTarget('https://[::1]/hook', options)).rejects.toThrow(/inside this network/)
    await expect(resolveOutboundTarget('https://169.254.169.254/latest/meta-data', options)).rejects.toThrow(
      /inside this network/
    )
    // A name that resolves into private space is refused even though the name itself looks public.
    await expect(
      resolveOutboundTarget('https://internal.grok.example/hook', {
        allowPrivateHosts: false,
        lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      })
    ).rejects.toThrow(/inside this network/)
    expect(
      await resolveOutboundTarget('https://routines.grok.example/hook', {
        allowPrivateHosts: false,
        lookup: async () => [{ address: '203.0.114.9', family: 4 }],
      })
    ).toMatchObject({ address: '203.0.114.9', family: 4 })
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('not-an-address')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })

  it('queues only notable events, only for granted projects, and signs the exact bytes it sends', async () => {
    const pool = runtimePool()
    const hook = await receiver()
    closers.push(hook.close)
    try {
      const context = await fixture(pool, 'Notify delivery')
      await connect(pool, context, { url: hook.url })
      // A connection granted another project hears nothing about this one.
      const otherHook = await receiver()
      closers.push(otherHook.close)
      await connect(pool, context, { url: otherHook.url, projectIds: [context.otherProjectId] })

      await emit(pool, context, 'stage.started', { stageId: 'ignored' })
      const event = await emit(pool, context, 'task.completed', { completionTarget: 'pr_ready' })
      expect((await queued(pool, context.organizationId)).map((row) => row.type)).toEqual(['task.completed'])

      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(1)
      expect(hook.received).toHaveLength(1)
      expect(otherHook.received).toHaveLength(0)

      const delivery = hook.received[0]!
      const signature = String(delivery.headers['x-maestrly-signature'])
      const [timestamp, digest] = signature.split(',')
      const expected = createHmac('sha256', callbackSecret)
        .update(`${timestamp!.slice(2)}.`)
        .update(delivery.raw)
        .digest('hex')
      expect(digest).toBe(`v1=${expected}`)
      expect(delivery.headers['x-maestrly-event']).toBe('task.completed')
      expect(delivery.headers['x-maestrly-event-id']).toBe(event.id)

      const payload = connectorNotificationPayloadSchema.parse(JSON.parse(delivery.raw.toString('utf8')))
      expect(payload).toMatchObject({
        version: 1,
        eventId: event.id,
        taskId: context.taskId,
        type: 'task.completed',
        state: 'draft',
      })
      expect(payload.url).toContain(`delegation=${context.taskId}`)
      expect(payload.summary).toContain('pr_ready')

      // At-least-once, not at-least-twice: a second pass has nothing left to send.
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(0)
      expect(hook.received).toHaveLength(1)
      expect((await queued(pool, context.organizationId))[0]!.state).toBe('delivered')
    } finally {
      await pool.end()
    }
  })

  it('retries a failed callback later and never follows a redirect', async () => {
    const pool = runtimePool()
    const hook = await receiver()
    closers.push(hook.close)
    try {
      const context = await fixture(pool, 'Notify retry')
      await connect(pool, context, { url: hook.url })
      hook.answerWith(500)
      await emit(pool, context, 'task.needs_attention', {
        missing: [{ reason: 'review_missing', detail: 'No review has been recorded.' }],
      })
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(0)
      const afterFailure = (await queued(pool, context.organizationId))[0]!
      expect(afterFailure.state).toBe('pending')
      expect(afterFailure.attempts).toBe(1)
      expect(afterFailure.last_error).toContain('HTTP 500')
      // The retry is scheduled, not immediate.
      expect(afterFailure.next_attempt_at.getTime()).toBeGreaterThan(Date.now())
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(0)
      expect(hook.received).toHaveLength(1)

      // A redirect is a failure: the request is never chased to another host.
      hook.answerWith(302, 'https://elsewhere.example/hook')
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'connector-notifier' } },
        (client) =>
          client.query("update connector_notifications set next_attempt_at = now() - interval '1 second'")
      )
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(0)
      expect((await queued(pool, context.organizationId))[0]!.last_error).toContain('HTTP 302')

      hook.answerWith(204)
      await inTenantTransaction(
        pool,
        { organizationId: context.organizationId, actor: { type: 'system', service: 'connector-notifier' } },
        (client) =>
          client.query("update connector_notifications set next_attempt_at = now() - interval '1 second'")
      )
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(1)
      expect((await queued(pool, context.organizationId))[0]!.state).toBe('delivered')
    } finally {
      await pool.end()
    }
  })

  it('stops and reports a receiver that says the endpoint is gone', async () => {
    const pool = runtimePool()
    const hook = await receiver()
    closers.push(hook.close)
    try {
      const context = await fixture(pool, 'Notify gone')
      const { connection } = await connect(pool, context, { url: hook.url })
      hook.answerWith(410)
      await emit(pool, context, 'task.watching')
      expect(await deliverPendingNotifications(pool, { ...deliveryOptions, organizationId: context.organizationId })).toBe(0)
      expect((await queued(pool, context.organizationId))[0]!.state).toBe('failed')
      const endpoint = await getNotificationEndpoint(pool, {
        organizationId: context.organizationId,
        userId: context.owner,
        connectionId: connection.id,
      })
      expect(endpoint?.enabled).toBe(false)
      expect(endpoint?.lastStatus).toContain('410')
      // A disabled endpoint stops collecting work instead of queueing forever.
      await emit(pool, context, 'task.completed', { completionTarget: 'patch_ready' })
      expect(await queued(pool, context.organizationId)).toHaveLength(1)
      // The stored secret is never returned; only its fingerprint is.
      expect(JSON.stringify(endpoint)).not.toContain(callbackSecret)
    } finally {
      await pool.end()
    }
  })

  it('summarizes an event in one sentence a person can read', () => {
    expect(summarizeDelegationEvent('task.needs_attention', { missing: [{ detail: 'No review has been recorded.' }] })).toBe(
      'The task needs a decision: No review has been recorded.'
    )
    expect(summarizeDelegationEvent('review.recorded', { verdict: 'changes_requested' })).toContain(
      'changes_requested'
    )
    expect(summarizeDelegationEvent('delivery.settled', { mode: 'ready_pr', pullRequest: 12 })).toContain('#12')
    expect(summarizeDelegationEvent('unknown.event', {})).toBe('unknown.event')
  })
})
