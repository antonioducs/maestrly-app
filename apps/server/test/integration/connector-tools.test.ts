import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  connectorPrincipalSchema,
  delegationCatalogRevision,
  delegationModelCatalogSchema,
  type ConnectorAction,
  type ConnectorPrincipal,
  type DelegationModelCatalog,
} from '@maestrly/protocol'
import { loadConfig } from '../../src/config.js'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { connectorToolCatalog } from '../../src/modules/connectors/tool-catalog.js'
import type { ConnectorTool } from '../../src/modules/connectors/mcp.js'
import { createConnectorConnection } from '../../src/modules/connectors/grants.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { runDelegationScheduler } from '../../src/modules/delegations/scheduler.js'
import { getDelegation } from '../../src/modules/delegations/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { integrationAvailable, runtimePool, runtimeUrl, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }

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
    efforts: ['medium', 'high'],
    fastMode: false,
    executionModes: ['standard'],
    delegationProfiles: [],
    harnessProfileId: null,
    harnessHash: null,
  },
  {
    selectionId: 'sel-astra',
    modelLabel: 'gpt-6-astra',
    accountLabel: 'OpenAI · work',
    efforts: ['low'],
    fastMode: true,
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

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: runtimeUrl!,
    MAESTRLY_WEB_ORIGIN: links.webOrigin,
    MAESTRLY_CANONICAL_URL: 'http://127.0.0.1:4310',
    LOG_LEVEL: 'silent',
  })
}

const signal = new AbortController().signal

async function fixture(pool: ReturnType<typeof runtimePool>, name: string, actions?: ConnectorAction[]) {
  const owner = `tools-owner-${randomUUID()}`
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const hidden = await createProject(pool, { organizationId, actorUserId: owner, name: `${name} (hidden)` })
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 2,
  })
  await inTenantTransaction(
    pool,
    { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } },
    (client) =>
      publishDelegationCatalog(client, { organizationId, runnerId: executor.runnerId, catalog: catalogFor(projectId) })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  const connection = await createConnectorConnection(
    pool,
    { organizationId, userId: owner },
    {
      clientId: `client-${randomUUID()}`,
      name: 'Grok Bot',
      cancelOnRevoke: true,
      grants: [
        {
          projectId,
          actions: actions ?? [
            'tasks:read',
            'tasks:write',
            'execution:control',
            'evidence:read',
            'inspect:read',
            'delivery:manage',
            'interactions:answer',
          ],
        },
      ],
    }
  )
  const principal: ConnectorPrincipal = connectorPrincipalSchema.parse({
    organizationId,
    connectionId: connection.id,
    clientId: connection.clientId,
    userId: owner,
    scopes: ['api:read', 'api:write'],
    grants: connection.grants,
    cancelOnRevoke: true,
    origin: { address: null, userAgent: null },
    clientLabel: 'Grok Bot',
  })
  const tools = new Map<string, ConnectorTool>(
    connectorToolCatalog(pool, config()).map((tool) => [tool.name, tool])
  )
  const call = (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`Unknown tool ${name}`)
    return tool.run(input, { principal, signal })
  }
  return {
    owner,
    organizationId,
    projectId,
    hiddenProjectId: hidden.project.id,
    executorId: executor.runnerId,
    boardId: board.board.id,
    scope: { organizationId, projectId, userId: owner },
    tools,
    call,
  }
}

const taskInput = (context: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) => ({
  boardId: context.boardId,
  title: 'Add the delegation panel',
  objective: 'Ship the panel behind the existing capability.',
  acceptanceCriteria: ['The panel lists stages'],
  executorId: context.executorId,
  workspaceKey: 'workspace-key',
  baseBranch: 'main',
  stages: [
    {
      type: 'implement',
      title: 'Implement',
      instructions: 'Write the panel.',
      dependsOn: [],
      requiredForCompletion: true,
      settings: { selectionId: 'sel-opus', reasoning: 'high' },
    },
  ],
  dependsOnTaskIds: [],
  ...overrides,
})

describe.skipIf(!integrationAvailable)('connector tools', () => {
  it('publishes a usable schema for every tool and never two tools with one name', async () => {
    const pool = runtimePool()
    try {
      const tools = connectorToolCatalog(pool, config())
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
      for (const tool of tools) {
        expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
        // An agent must not be able to smuggle an unknown field past validation.
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
        expect(tool.description.length, tool.name).toBeGreaterThan(40)
      }
      // Every tool that changes something defends against a repeated call: either it replays an
      // idempotency key, or it refuses to act on a version the caller has not read.
      for (const tool of tools) {
        if (tool.annotations.readOnlyHint) continue
        const properties = Object.keys(tool.inputSchema.properties as Record<string, unknown>)
        expect(
          properties.includes('idempotencyKey') || properties.includes('expectedVersion'),
          `${tool.name} accepts neither an idempotency key nor an expected version`
        ).toBe(true)
      }
    } finally {
      await pool.end()
    }
  })

  it('creates a task that actually starts and keeps the configuration it was given', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Tools create')
      const projects = (await context.call('maestrly_list_projects', {})) as {
        projects: Array<{ projectId: string }>
      }
      expect(projects.projects.map((project) => project.projectId)).toEqual([context.projectId])

      const executors = (await context.call('maestrly_list_executors', { projectId: context.projectId })) as {
        executors: Array<{ catalog: { models: Array<{ selectionId: string }> } }>
      }
      expect(executors.executors[0]!.catalog.models.map((model) => model.selectionId)).toEqual([
        'sel-opus',
        'sel-astra',
      ])

      const creation = {
        projectId: context.projectId,
        task: taskInput(context, { start: true }),
        idempotencyKey: randomUUID(),
      }
      const created = (await context.call('maestrly_create_task', creation)) as {
        task: { id: string; state: string; version: number }
        stages: Array<{ settings: unknown }>
      }
      // Asking for the task to start must actually start it, not leave a draft behind.
      expect(created.task.state).toBe('queued')
      expect(created.stages[0]!.settings).toMatchObject({ selectionId: 'sel-opus', reasoning: 'high' })

      // A retry with the same key replays the same task instead of delegating the work twice.
      const replayed = (await context.call('maestrly_create_task', creation)) as {
        task: { id: string }
        replayed: boolean
      }
      expect(replayed).toMatchObject({ replayed: true })
      expect(replayed.task.id).toBe(created.task.id)
      const listed = (await context.call('maestrly_list_tasks', { projectId: context.projectId })) as {
        items: unknown[]
      }
      expect(listed.items).toHaveLength(1)

      const read = (await context.call('maestrly_get_task', {
        projectId: context.projectId,
        taskId: created.task.id,
      })) as { task: { version: number }; links: { task: string } }
      expect(read.links.task).toContain(`delegation=${created.task.id}`)

      // An effort the selection does not offer is refused instead of being approximated.
      await expect(
        context.call('maestrly_configure_task', {
          projectId: context.projectId,
          taskId: created.task.id,
          expectedVersion: read.task.version,
          target: 'task_defaults',
          settingsPatch: { selectionId: 'sel-astra', reasoning: 'high' },
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow(/reasoning effort is unavailable/i)

      const configured = (await context.call('maestrly_configure_task', {
        projectId: context.projectId,
        taskId: created.task.id,
        expectedVersion: read.task.version,
        target: 'task_defaults',
        settingsPatch: { selectionId: 'sel-astra', reasoning: 'low' },
        idempotencyKey: randomUUID(),
      })) as { accepted: boolean; version: number; settingsRevision: number }
      expect(configured.accepted).toBe(true)

      // A stale version is refused, so a command never lands on a task that moved.
      await expect(
        context.call('maestrly_control_task', {
          projectId: context.projectId,
          taskId: created.task.id,
          expectedVersion: read.task.version,
          action: 'pause',
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow(/changed after it was loaded/i)

      const paused = (await context.call('maestrly_control_task', {
        projectId: context.projectId,
        taskId: created.task.id,
        expectedVersion: configured.version,
        action: 'pause',
        idempotencyKey: randomUUID(),
      })) as { state: string }
      expect(['pausing', 'paused']).toContain(paused.state)
    } finally {
      await pool.end()
    }
  })

  it('follows a task through events and reports a timeout instead of blocking', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Tools follow')
      const created = (await context.call('maestrly_create_task', {
        projectId: context.projectId,
        task: taskInput(context),
        idempotencyKey: randomUUID(),
      })) as { task: { id: string; version: number } }

      const first = (await context.call('maestrly_read_events', {
        projectId: context.projectId,
        taskId: created.task.id,
      })) as { events: Array<{ type: string; sequence: number }>; cursor: number }
      expect(first.events.map((event) => event.type)).toContain('task.created')
      expect(first.cursor).toBeGreaterThan(0)

      // Nothing new after the cursor: the wait reports a timeout with the state, it does not invent events.
      const waited = (await context.call('maestrly_wait_task', {
        projectId: context.projectId,
        taskId: created.task.id,
        cursor: first.cursor,
        timeoutSeconds: 1,
      })) as { events: unknown[]; timedOut: boolean; state: string; cursor: number }
      expect(waited).toMatchObject({ timedOut: true, state: 'draft', cursor: first.cursor })
      expect(waited.events).toEqual([])

      const evidence = (await context.call('maestrly_list_evidence', {
        projectId: context.projectId,
        taskId: created.task.id,
      })) as { artifacts: unknown[]; checks: unknown[] }
      expect(evidence).toMatchObject({ artifacts: [], checks: [] })

      const attempts = (await context.call('maestrly_read_attempts', {
        projectId: context.projectId,
        taskId: created.task.id,
      })) as { attempts: unknown[] }
      expect(attempts.attempts).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('answers a question a stage raised, and only for the person who owns the task', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Tools questions')
      const created = (await context.call('maestrly_create_task', {
        projectId: context.projectId,
        task: taskInput(context, { start: true }),
        idempotencyKey: randomUUID(),
      })) as { task: { id: string } }
      // Admitting the stage creates the chat session the question will live in.
      expect(await runDelegationScheduler(pool, { organizationId: context.organizationId })).toBe(1)

      const interactionId = randomUUID()
      await inTenantTransaction(
        pool,
        {
          organizationId: context.organizationId,
          projectId: context.projectId,
          actor: { type: 'human', userId: context.owner },
        },
        async (client) => {
          const turn = await client.query<{ id: string; session_id: string }>(
            `select t.id, t.session_id from chat_turns t
             join chat_sessions s on s.id = t.session_id
             where s.delegation_task_id=$1`,
            [created.task.id]
          )
          const row = turn.rows[0]!
          // A question can only be decided while the attempt still holds a live lease.
          await client.query(
            "update chat_turns set state='waiting_input', lease_id=gen_random_uuid(), lease_expires_at=now() + interval '5 minutes' where id=$1",
            [row.id]
          )
          await client.query(
            `insert into chat_interactions(id, organization_id, project_id, session_id, turn_id, version, payload)
             values ($1,$2,$3,$4,$5,1,$6)`,
            [
              interactionId,
              context.organizationId,
              context.projectId,
              row.session_id,
              row.id,
              {
                type: 'question',
                requestId: 'q-1',
                questions: [{ question: 'Which database should the migration target?', options: [] }],
              },
            ]
          )
        }
      )

      const pending = (await context.call('maestrly_list_questions', {
        projectId: context.projectId,
        taskId: created.task.id,
      })) as { questions: Array<{ interaction: { id: string; version: number } }> }
      expect(pending.questions.map((question) => question.interaction.id)).toEqual([interactionId])

      // A stale version cannot land an answer on a different question.
      await expect(
        context.call('maestrly_answer_question', {
          projectId: context.projectId,
          taskId: created.task.id,
          interactionId,
          expectedVersion: 2,
          decision: { type: 'question', answers: [['PostgreSQL']] },
        })
      ).rejects.toThrow(/changed/i)

      const answered = (await context.call('maestrly_answer_question', {
        projectId: context.projectId,
        taskId: created.task.id,
        interactionId,
        expectedVersion: 1,
        decision: { type: 'question', answers: [['PostgreSQL']] },
      })) as { interaction: { state: string } }
      expect(answered.interaction.state).toBe('decided')
      expect(
        ((await context.call('maestrly_list_questions', {
          projectId: context.projectId,
          taskId: created.task.id,
        })) as { questions: unknown[] }).questions
      ).toEqual([])
      const events = (await getDelegation(pool, context.scope, created.task.id, links)).task
      expect(events.id).toBe(created.task.id)
    } finally {
      await pool.end()
    }
  })

  it('refuses an action the connection was never granted and a project it cannot see', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Tools authorization', ['tasks:read'])
      await expect(
        context.call('maestrly_create_task', {
          projectId: context.projectId,
          task: taskInput(context),
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow(/not authorized for tasks:write/i)

      // A project outside the grant is refused even for an action the connection does hold elsewhere.
      await expect(
        context.call('maestrly_list_executors', { projectId: context.hiddenProjectId })
      ).rejects.toThrow(/not authorized/i)

      // Starting work needs its own authorization, even with tasks:write.
      const writer = await fixture(pool, 'Tools start authorization', ['tasks:read', 'tasks:write'])
      await expect(
        writer.call('maestrly_create_task', {
          projectId: writer.projectId,
          task: taskInput(writer, { start: true }),
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow(/execution:control/i)
      const drafted = (await writer.call('maestrly_create_task', {
        projectId: writer.projectId,
        task: taskInput(writer),
        idempotencyKey: randomUUID(),
      })) as { task: { state: string } }
      expect(drafted.task.state).toBe('draft')
    } finally {
      await pool.end()
    }
  })
})
