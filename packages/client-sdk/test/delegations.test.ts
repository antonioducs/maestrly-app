import { expect, it, vi } from 'vitest'
import { HttpTransport } from '../src/transport.js'
import { DelegationsApi, readDelegationEvents } from '../src/delegations.js'
import type { DelegationCreate } from '@maestrly/protocol'

const organizationId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const taskId = '33333333-3333-4333-8333-333333333333'

function transportFor(handler: (input: { url: string; init: RequestInit }) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    return new Response(JSON.stringify(handler(call)), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: new DelegationsApi(new HttpTransport({ baseUrl: 'https://fixture.test', fetch: fetchImpl })), calls }
}

const settings = {
  selectionId: 'sel-opus',
  reasoning: 'high',
  fastMode: false,
  executionMode: 'standard' as const,
  delegationProfiles: [],
}

const task = {
  id: taskId,
  organizationId,
  projectId,
  boardId: '44444444-4444-4444-8444-444444444444',
  cardId: '55555555-5555-4555-8555-555555555555',
  ownerUserId: 'owner',
  connectionId: null,
  title: 'Add the delegation panel',
  objective: 'Ship the panel',
  acceptanceCriteria: ['Panel renders'],
  executorId: '66666666-6666-4666-8666-666666666666',
  workspaceKey: 'workspace',
  baseBranch: 'main',
  repositoryBindingId: null,
  presetId: null,
  policy: {
    autonomy: {
      edit: true,
      runChecks: true,
      previewInteract: false,
      commit: false,
      push: false,
      openPullRequest: false,
      comment: false,
      merge: false,
    },
    limits: {
      maxActiveSeconds: 3600,
      watchWindowSeconds: 86400,
      maxFixAttempts: 3,
      maxParallelStages: 1,
      maxTokens: null,
      maxCostUsd: null,
    },
    completionTarget: 'patch_ready',
    requireReview: true,
    requiredCheckIds: [],
    moveCardOnCompletion: false,
  },
  state: 'queued',
  blocker: null,
  settingsRevision: 1,
  version: 2,
  eventSequence: 1,
  completedAt: null,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
}

const stage = {
  id: '77777777-7777-4777-8777-777777777777',
  type: 'implement',
  title: 'Implement',
  instructions: '',
  position: 0,
  dependsOn: [],
  settings,
  action: null,
  requiredForCompletion: true,
  state: 'pending',
  attempts: 0,
  settingsRevision: 1,
  version: 1,
}

const view = {
  task,
  stages: [stage],
  attempts: [],
  links: { task: 'https://web.test/?delegation=1', card: 'https://web.test/?card=1' },
}

it('sends the idempotency key on every mutation and validates the returned projection', async () => {
  const { api, calls } = transportFor(({ url }) => (url.endsWith('/commands') ? commandResult : view))
  const commandResult = {
    commandId: '88888888-8888-4888-8888-888888888888',
    taskId,
    accepted: true,
    version: 3,
    settingsRevision: 2,
    appliesFromStageId: stage.id,
    appliesFromAttempt: null,
    stageIds: [stage.id],
    state: 'queued',
    pendingInterrupt: false,
  }
  const input: DelegationCreate = {
    cardId: task.cardId,
    objective: 'Ship the panel',
    acceptanceCriteria: [],
    executorId: task.executorId,
    workspaceKey: 'workspace',
    baseBranch: 'main',
    stages: [{ type: 'implement', title: 'Implement', instructions: '', dependsOn: [], requiredForCompletion: true }],
    dependsOnTaskIds: [],
    start: false,
  }
  const created = await api.create(organizationId, projectId, input, 'create-key')
  expect(created.task.id).toBe(taskId)
  expect(calls[0]!.init.headers).toMatchObject({ 'idempotency-key': 'create-key' })

  const result = await api.command(
    organizationId,
    projectId,
    taskId,
    { type: 'configure', expectedVersion: 2, target: 'stage', stageId: stage.id, settingsPatch: { selectionId: 'sel-astra' }, apply: 'after_current' },
    'configure-key'
  )
  expect(result.settingsRevision).toBe(2)
  expect(calls[1]!.init.headers).toMatchObject({ 'idempotency-key': 'configure-key' })
})

it('reads the event page as JSON and rejects a projection that does not match the contract', async () => {
  const { api, calls } = transportFor(() => ({
    items: [{ id: 'e1', taskId, sequence: 1, type: 'task.created', data: {}, createdAt: '2026-09-20T00:00:00.000Z' }],
  }))
  const events = await api.events(organizationId, projectId, taskId, 0)
  expect(events[0]!.type).toBe('task.created')
  expect(calls[0]!.init.headers).toMatchObject({ accept: 'application/json' })

  const broken = transportFor(() => ({ items: [{ id: 'e1', taskId, sequence: 0, type: '', data: {}, createdAt: 'nope' }] }))
  await expect(broken.api.events(organizationId, projectId, taskId, 0)).rejects.toThrow()
})

it('streams delegation events across chunk boundaries and surfaces revoked access', async () => {
  const event = { id: 'e1', taskId, sequence: 1, type: 'stage.started', data: {}, createdAt: '2026-09-20T00:00:00.000Z' }
  const frame = new TextEncoder().encode(`id: 1\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame.slice(0, 12))
      controller.enqueue(frame.slice(12))
      controller.close()
    },
  })
  const collected = []
  for await (const value of readDelegationEvents(new Response(stream, { status: 200 }))) collected.push(value)
  expect(collected).toEqual([event])

  const revoked = new Response(
    new TextEncoder().encode('event: access_revoked\ndata: {}\n\n'),
    { status: 200 }
  )
  await expect(
    (async () => {
      for await (const value of readDelegationEvents(revoked)) void value
    })()
  ).rejects.toThrow(/access was removed/)
})

it('binds the global fetch receiver when no transport fetch is provided', async () => {
  vi.stubGlobal('fetch', function (this: unknown) {
    expect(this).toBe(globalThis)
    return Promise.resolve(new Response(JSON.stringify({ executors: [] })))
  })
  try {
    const api = new DelegationsApi(new HttpTransport({ baseUrl: 'https://fixture.test' }))
    expect(await api.catalog(organizationId, projectId)).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})
