import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  deleteConversation as deleteConversationRow,
  getConversation,
  getWorkspace,
  getDb,
  insertConversation,
} from '../../src/main/store'
import {
  createConversationDispatchService,
  listConversationDispatchWorkspaces,
  type ConversationDispatchServiceDeps,
} from '../../src/main/conversation-dispatch-service'
import {
  findConversationDispatch,
  getConversationDispatchByDestination,
} from '../../src/main/conversation-dispatch-store'
import type { ConversationDispatchGrant } from '../../src/main/chat/conversation-dispatch-authorization'
import type { ConversationDispatchSettings } from '../../src/shared/conversation-dispatch'
import type { ProjectConversation } from '../../src/shared/conversation'

const hoisted = vi.hoisted(() => ({ failReserve: false }))

vi.mock('../../src/main/conversation-dispatch-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/conversation-dispatch-store')>()
  return {
    ...original,
    reserveConversationDispatch: (...args: Parameters<typeof original.reserveConversationDispatch>) => {
      if (hoisted.failReserve) throw new Error('disk I/O error')
      return original.reserveConversationDispatch(...args)
    },
  }
})

const SETTINGS: ConversationDispatchSettings = {
  providerId: 'claude',
  modelId: 'opus',
  reasoning: 'high',
  fastMode: false,
}

let workspaceId: string
let source: ProjectConversation
let persistedSettings: Map<string, ConversationDispatchSettings>
let messages: Set<string>
let calls: string[]

function harness(overrides: Partial<ConversationDispatchServiceDeps> = {}) {
  const deps: ConversationDispatchServiceDeps = {
    getConversation: (id) => getConversation(id),
    resolveSettings: vi.fn(async (_source, requested) => ({
      ok: true as const,
      settings: { ...SETTINGS, ...requested } as ConversationDispatchSettings,
      inherited: requested.modelId ? [] : ['model'],
    })),
    resolveHead: vi.fn(async () => 'a'.repeat(40)),
    getWorkspace,
    resolveBranch: vi.fn(async () => 'b'.repeat(40)),
    validateBranch: vi.fn(async () => true),
    branchExists: vi.fn(async () => false),
    hasUncommittedChanges: vi.fn(async () => true),
    createShared: vi.fn(async (_sourceId, options) => {
      calls.push(`createShared:${options.id}`)
      return makeConversation(workspaceId, {
        id: options.id,
        name: options.name,
        cwd: source.cwd,
        branch: source.branch,
      })
    }),
    createIsolated: vi.fn(async (args) => {
      calls.push(`createIsolated:${args.branch}`)
      return makeConversation(args.workspaceId, { id: args.id, name: args.name, branch: args.branch })
    }),
    deleteConversation: vi.fn(async (id) => {
      calls.push(`delete:${id}`)
      deleteConversationRow(id)
    }),
    applySettings: vi.fn((id, settings) => {
      calls.push(`apply:${id}`)
      persistedSettings.set(id, settings)
    }),
    readSettings: (id) => persistedSettings.get(id) ?? null,
    startTurn: vi.fn(async ({ conversationId }) => {
      calls.push(`start:${conversationId}`)
      messages.add(conversationId)
      return { ok: true as const }
    }),
    hasPersistedMessages: (id) => messages.has(id),
    openConversation: vi.fn(),
    notifyChanged: vi.fn(),
    reportStartFailure: vi.fn(),
    isReserved: vi.fn(() => false),
    isMigrating: vi.fn(() => false),
    isWebManaged: vi.fn(() => false),
    text: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
    ...overrides,
  }
  return { deps, service: createConversationDispatchService(deps) }
}

function grant(maxConversations: number | null = null): ConversationDispatchGrant {
  return {
    conversationId: source.id,
    messageId: 'msg-1',
    originKey: 'message:msg-1',
    maxConversations,
    token: {},
    signal: new AbortController().signal,
  }
}

const task = (requestKey: string, extra: Record<string, unknown> = {}) => ({
  requestKey,
  title: `Card ${requestKey}`,
  prompt: `Implement ${requestKey} with tests.`,
  ...extra,
})

beforeEach(() => {
  freshDb()
  hoisted.failReserve = false
  workspaceId = makeWorkspace().id
  source = makeConversation(workspaceId, { name: 'Analysis', branch: 'feat/analysis' })
  persistedSettings = new Map([[source.id, { providerId: 'codex', modelId: 'gpt', reasoning: 'low', fastMode: true }]])
  messages = new Set()
  calls = []
})

afterEach(() => closeDb())

describe('conversation dispatch service', () => {
  it('creates isolated worktrees from one pinned commit, applies settings before starting, and keeps the source', async () => {
    const { deps, service } = harness()
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('PROJ-1'), task('PROJ-2', { settings: { reasoning: 'max' } })] },
      assertCurrent: () => undefined,
    })

    expect(result.ok).toBe(true)
    expect(result.items.map((item) => item.status)).toEqual(['started', 'started'])
    expect(result.notes?.[0]).toMatch(/uncommitted changes/)
    const isolated = vi.mocked(deps.createIsolated).mock.calls.map(([args]) => args)
    expect(isolated.map((args) => args.baseRevision)).toEqual(['a'.repeat(40), 'a'.repeat(40)])
    expect(isolated[0].branch).toMatch(/^task\/card-proj-1-[0-9a-f]{8}$/)
    expect(deps.resolveHead).toHaveBeenCalledTimes(1)
    for (const item of result.items) {
      const id = item.conversationId!
      expect(calls.indexOf(`apply:${id}`)).toBeLessThan(calls.indexOf(`start:${id}`))
    }
    expect(result.items[1].settings?.reasoning).toBe('max')
    expect(persistedSettings.get(source.id)).toEqual({
      providerId: 'codex',
      modelId: 'gpt',
      reasoning: 'low',
      fastMode: true,
    })
    expect(vi.mocked(deps.startTurn).mock.calls[0][0]).toMatchObject({ visible: true, sourceConversationId: source.id })
    expect(deps.openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.items[0].conversationId }),
      false
    )
  })

  it('lists registered unavailable repositories without substituting another checkout', async () => {
    const other = makeWorkspace({ name: 'Unavailable repository', path: '/missing/dispatch-test-repository' })
    const options = await listConversationDispatchWorkspaces()
    expect(options).toHaveLength(2)
    expect(options.find((option) => option.workspaceId === other.id)).toEqual({
      workspaceId: other.id,
      name: other.name,
      path: other.path,
      defaultBranch: 'main',
      branches: [],
    })
  })

  it('rolls back a successfully created isolated destination when cancelled before start', async () => {
    const controller = new AbortController()
    const { deps, service } = harness({
      createIsolated: vi.fn(async (args) => {
        const conversation = makeConversation(args.workspaceId, { id: args.id, branch: args.branch })
        controller.abort()
        return conversation
      }),
    })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { target: { workspaceId, branch: 'cancelled' }, tasks: [task('A')] },
      signal: controller.signal,
      assertCurrent: () => undefined,
    })
    expect(result.items[0].error).toMatch(/cancelled/)
    expect(deps.deleteConversation).toHaveBeenCalledWith(expect.any(String), { preserveWorktree: false })
    expect(deps.startTurn).not.toHaveBeenCalled()
    expect(findConversationDispatch(source.id, 'message:msg-1', 'A')?.phase).toBe('discarded')
  })

  it('requires a workspace for standalone sources and routes an explicit target', async () => {
    const standalone = {
      ...source,
      id: 'standalone-source',
      scope: 'standalone' as const,
      workspaceId: null,
      branch: null,
      mode: null,
      experience: 'standard' as const,
      isMulti: 0 as const,
      repos: undefined,
    }
    insertConversation(standalone)
    const { deps, service } = harness()
    const standaloneGrant = { ...grant(), conversationId: standalone.id }
    const missing = await service.dispatchBatch({
      grant: standaloneGrant,
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/explicit workspaceId/) })
    const result = await service.dispatchBatch({
      grant: standaloneGrant,
      batch: { target: { workspaceId }, tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({ status: 'started', workspaceId, baseRevision: 'b'.repeat(40) })
    expect(deps.resolveBranch).toHaveBeenCalledWith(getWorkspace(workspaceId)!.path, 'main')
    expect(deps.resolveHead).not.toHaveBeenCalled()
  })

  it('merges batch targets and routes to the selected project with exact branch names and pinned bases', async () => {
    const other = makeWorkspace({ defaultBranch: 'develop' })
    const { deps, service } = harness()
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: {
        target: { workspaceId: other.id, baseBranch: 'release' },
        tasks: [
          task('A', { target: { branch: 'Feature/Exact.Name' } }),
          task('B', { target: { baseBranch: 'develop' } }),
        ],
      },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({
      workspaceId: other.id,
      branch: 'Feature/Exact.Name',
      baseRevision: 'b'.repeat(40),
      status: 'started',
    })
    expect(getConversation(result.items[0].conversationId!)?.workspaceId).toBe(other.id)
    expect(deps.resolveBranch).toHaveBeenNthCalledWith(1, other.path, 'release')
    expect(deps.resolveBranch).toHaveBeenNthCalledWith(2, other.path, 'develop')
    expect(deps.resolveHead).not.toHaveBeenCalled()
  })

  it('uses the project workspace for branch-only targets', async () => {
    const { deps, service } = harness()
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A', { target: { branch: 'exact' } })] },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({ workspaceId, branch: 'exact', status: 'started' })
    expect(deps.resolveBranch).toHaveBeenCalledWith(getWorkspace(workspaceId)!.path, 'main')
  })

  it.each([
    'missing-workspace',
    'missing-base',
    'invalid-branch',
    'existing-branch',
    'duplicate-branch',
    'shared-target',
  ])('prevalidates all destinations before allocation: %s', async (failure) => {
    const { deps, service } = harness()
    if (failure === 'missing-base') vi.mocked(deps.resolveBranch).mockResolvedValue(null)
    if (failure === 'invalid-branch') vi.mocked(deps.validateBranch).mockResolvedValue(false)
    if (failure === 'existing-branch') vi.mocked(deps.branchExists).mockResolvedValue(true)
    const target = { workspaceId: failure === 'missing-workspace' ? 'missing' : workspaceId, branch: 'exact' }
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: {
        tasks: [
          task('A', failure === 'duplicate-branch' ? { target } : {}),
          task('B', { target, ...(failure === 'shared-target' ? { placement: 'shared' } : {}) }),
        ],
      },
      assertCurrent: () => undefined,
    })
    expect(result.ok).toBe(false)
    expect(deps.createIsolated).not.toHaveBeenCalled()
    expect(deps.createShared).not.toHaveBeenCalled()
    expect(deps.deleteConversation).not.toHaveBeenCalled()
  })

  it('replays pinned targets after refs disappear and rejects changed targets before allocating other tasks', async () => {
    const { deps, service } = harness()
    const batch = { target: { workspaceId, baseBranch: 'main', branch: 'exact' }, tasks: [task('A')] }
    const first = await service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined })
    vi.mocked(deps.resolveHead).mockResolvedValue(null)
    vi.mocked(deps.resolveBranch).mockResolvedValue(null)
    vi.mocked(deps.branchExists).mockResolvedValue(true)
    const replay = await service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined })
    expect(replay.items[0]).toMatchObject({
      conversationId: first.items[0].conversationId,
      replayed: true,
      status: 'started',
      baseRevision: 'b'.repeat(40),
    })
    expect(deps.resolveBranch).toHaveBeenCalledTimes(1)
    const conflict = await service.dispatchBatch({
      grant: grant(),
      batch: {
        tasks: [task('B', { placement: 'shared' }), task('A', { target: { ...batch.target, branch: 'changed' } })],
      },
      assertCurrent: () => undefined,
    })
    expect(conflict.items[0].error).toMatch(/different content/)
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
    expect(deps.createShared).not.toHaveBeenCalled()
  })

  it('replays legacy implicit targets without resolving source HEAD again', async () => {
    const { deps, service } = harness()
    const batch = { tasks: [task('A')] }
    await service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined })
    vi.mocked(deps.resolveHead).mockResolvedValue(null)
    const replay = await service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined })
    expect(replay.items[0]).toMatchObject({ replayed: true, status: 'started' })
    expect(deps.resolveHead).toHaveBeenCalledTimes(1)
  })

  it('shares the source checkout on request and rolls back without removing it', async () => {
    const { deps, service } = harness({
      startTurn: vi.fn(async () => ({ ok: true as const })),
      readSettings: () => null,
    })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('PROJ-3')], placement: 'shared' },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({ status: 'failed' })
    expect(result.items[0].error).toMatch(/did not keep the selected model settings/)
    expect(deps.createShared).toHaveBeenCalledTimes(1)
    expect(deps.deleteConversation).toHaveBeenCalledWith(expect.any(String), { preserveWorktree: true })
    expect(deps.startTurn).not.toHaveBeenCalled()
    expect(findConversationDispatch(source.id, 'message:msg-1', 'PROJ-3')?.phase).toBe('discarded')
  })

  it('reports partial failure and cleans only the failed allocation', async () => {
    const { deps, service } = harness()
    vi.mocked(deps.createIsolated).mockImplementationOnce(async (args) => {
      calls.push(`createIsolated:${args.branch}`)
      return makeConversation(args.workspaceId, { id: args.id, name: args.name, branch: args.branch })
    })
    vi.mocked(deps.createIsolated).mockImplementationOnce(async () => {
      throw new Error('worktree add failed')
    })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A'), task('B'), task('C')] },
      assertCurrent: () => undefined,
    })
    expect(result.items.map((item) => item.status)).toEqual(['started', 'failed', 'started'])
    expect(result.items[1].error).toMatch(/worktree add failed/)
    expect(deps.deleteConversation).not.toHaveBeenCalled()
    expect(findConversationDispatch(source.id, 'message:msg-1', 'B')?.phase).toBe('recovery')
  })

  it('stops between items when the authorizing turn ends', async () => {
    const { deps, service } = harness()
    let checks = 0
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A'), task('B')] },
      assertCurrent: () => {
        checks += 1
        // Item A is checked before allocation and again before it becomes prepared; item B never starts.
        if (checks > 4) throw new Error('The turn that authorized this request is no longer active.')
      },
    })
    expect(result.items[0].status).toBe('started')
    expect(result.items[1]).toMatchObject({ status: 'skipped', error: expect.stringMatching(/no longer active/) })
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
  })

  it('deduplicates simultaneous identical requests and replays later ones', async () => {
    const { deps, service } = harness()
    const batch = { tasks: [task('PROJ-9')] }
    const [first, second] = await Promise.all([
      service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined }),
      service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined }),
    ])
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
    expect(deps.startTurn).toHaveBeenCalledTimes(1)
    expect(first.items[0].conversationId).toBe(second.items[0].conversationId)
    expect([first.items[0].replayed, second.items[0].replayed]).toContain(true)

    const replay = await service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined })
    expect(replay.items[0]).toMatchObject({ status: 'started', replayed: true })
    expect(deps.startTurn).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent retries and preserves an uncertain failed allocation for recovery', async () => {
    const { deps, service } = harness()
    vi.mocked(deps.createIsolated).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('transient worktree failure')
    })
    const batch = { tasks: [task('PROJ-7')] }
    const results = await Promise.all(
      [1, 2, 3].map(() => service.dispatchBatch({ grant: grant(), batch, assertCurrent: () => undefined }))
    )
    const statuses = results.map((result) => result.items[0].status)
    expect(statuses).toEqual(['failed', 'failed', 'failed'])
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
    expect(deps.deleteConversation).not.toHaveBeenCalled()
    expect(deps.startTurn).not.toHaveBeenCalled()
    expect(findConversationDispatch(source.id, 'message:msg-1', 'PROJ-7')?.phase).toBe('recovery')
  })

  it('refuses to widen a request key with different content on retry', async () => {
    const { deps, service } = harness()
    await service.dispatchBatch({ grant: grant(), batch: { tasks: [task('K')] }, assertCurrent: () => undefined })
    const changed = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('K', { prompt: 'Also delete the production database.' })] },
      assertCurrent: () => undefined,
    })
    expect(changed.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/different content/) })
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
  })

  it('enforces the stated count and validates every item before allocating', async () => {
    const { deps, service } = harness()
    const tooMany = await service.dispatchBatch({
      grant: grant(1),
      batch: { tasks: [task('A'), task('B')] },
      assertCurrent: () => undefined,
    })
    expect(tooMany).toMatchObject({ ok: false, items: [] })
    expect(tooMany.error).toMatch(/asked for 1 conversation/)

    vi.mocked(deps.resolveSettings).mockImplementation(async (_s, requested) =>
      requested.fastMode
        ? { ok: false, error: 'fast-mode-unsupported', message: 'Fast mode is not available for opus.' }
        : { ok: true, settings: SETTINGS, inherited: [] }
    )
    const invalid = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A'), task('B', { settings: { fastMode: true } })] },
      assertCurrent: () => undefined,
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.items).toEqual([expect.objectContaining({ requestKey: 'B', status: 'failed' })])
    expect(deps.createIsolated).not.toHaveBeenCalled()
  })

  it('keeps a destination whose start failed visible and retries the same conversation', async () => {
    const { deps, service } = harness()
    vi.mocked(deps.startTurn).mockResolvedValueOnce({ ok: false, error: 'no-key' })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    const conversationId = result.items[0].conversationId!
    expect(result.items[0]).toMatchObject({ status: 'start-failed', error: 'no-key' })
    expect(deps.reportStartFailure).toHaveBeenCalledWith(conversationId, 'no-key')
    expect(service.status(conversationId)).toMatchObject({ phase: 'start-failed', error: 'no-key' })

    await expect(service.retryStart(conversationId)).resolves.toEqual({ ok: true })
    expect(vi.mocked(deps.startTurn).mock.calls.map(([input]) => input.conversationId)).toEqual([
      conversationId,
      conversationId,
    ])
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
    expect(service.status(conversationId)?.phase).toBe('started')
  })

  it('does not recreate a destination the person deleted', async () => {
    const { deps, service } = harness()
    const first = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    deleteConversationRow(first.items[0].conversationId!)
    const retry = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(retry.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/deleted/) })
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
  })

  it('keeps a record for manual recovery when cleanup of a failed allocation fails', async () => {
    const { deps, service } = harness({
      createIsolated: vi.fn(async () => {
        throw new Error('worktree add failed halfway')
      }),
    })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({ status: 'failed' })
    expect(findConversationDispatch(source.id, 'message:msg-1', 'A')).toMatchObject({
      phase: 'recovery',
      error: expect.stringMatching(/ownership is uncertain/),
    })
    const retry = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(retry.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/ownership is uncertain/) })
    expect(deps.createIsolated).toHaveBeenCalledTimes(1)
  })

  it('reports a persistence failure without allocating anything', async () => {
    const { deps, service } = harness()
    hoisted.failReserve = true
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(result.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Could not record/) })
    expect(deps.createIsolated).not.toHaveBeenCalled()
  })

  it('honours source restrictions before creating anything', async () => {
    const { deps, service } = harness({ isWebManaged: vi.fn(() => true) })
    const result = await service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')] },
      assertCurrent: () => undefined,
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Kanban web chat/) })
    const reserved = harness({ isReserved: vi.fn(() => true) })
    const shared = await reserved.service.dispatchBatch({
      grant: grant(),
      batch: { tasks: [task('A')], placement: 'shared' },
      assertCurrent: () => undefined,
    })
    expect(shared).toMatchObject({ ok: false, error: expect.stringMatching(/review loop/) })
    expect(deps.createIsolated).not.toHaveBeenCalled()
  })

  it('prepares, discards and re-prepares a plan handoff without starting it', async () => {
    const { deps, service } = harness()
    const input = {
      sourceConversationId: source.id,
      originKey: 'plan:1:abc',
      requestKey: 'plan',
      kind: 'plan' as const,
      title: 'Checkout plan',
      prompt: '## Edited plan',
      placement: 'shared' as const,
      settings: SETTINGS,
    }
    const prepared = await service.prepare(input)
    expect(prepared.conversation.name).toBe('Analysis · Checkout plan')
    expect(deps.startTurn).not.toHaveBeenCalled()
    await service.discard(prepared.record.dispatchId)
    expect(deps.deleteConversation).toHaveBeenCalledWith(prepared.conversation.id, { preserveWorktree: true })
    expect(findConversationDispatch(source.id, 'plan:1:abc', 'plan')?.phase).toBe('discarded')

    const again = await service.prepare(input)
    expect(again.record.dispatchId).toBe(prepared.record.dispatchId)
    expect(again.conversation.id).not.toBe(prepared.conversation.id)
    const started = await service.start(again.record.dispatchId, { focus: true })
    expect(started.status).toBe('started')
    const seed = vi.mocked(deps.startTurn).mock.calls[0][0]
    expect(seed).toMatchObject({ visible: false, conversationId: again.conversation.id })
    expect(seed.prompt).toContain('## Edited plan')
    expect(deps.openConversation).toHaveBeenCalledWith(expect.objectContaining({ id: again.conversation.id }), true)
  })

  it('reconciles records left by a crash from durable state and never starts twice', async () => {
    const { service } = harness({ startTurn: vi.fn(async () => ({ ok: true as const })) })
    const pending = await service.prepare({
      sourceConversationId: source.id,
      originKey: 'message:crash',
      requestKey: 'started-before-crash',
      kind: 'task',
      title: 'A',
      prompt: 'Do A',
      placement: 'shared',
      settings: SETTINGS,
    })
    const unsent = await service.prepare({
      sourceConversationId: source.id,
      originKey: 'message:crash',
      requestKey: 'never-sent',
      kind: 'task',
      title: 'B',
      prompt: 'Do B',
      placement: 'shared',
      settings: SETTINGS,
    })
    getDb()
      .prepare("UPDATE conversation_dispatches SET phase='starting' WHERE dispatch_id IN (?, ?)")
      .run(pending.record.dispatchId, unsent.record.dispatchId)
    messages.add(pending.conversation.id)
    getDb()
      .prepare(
        `INSERT INTO conversation_dispatches (dispatch_id, source_conversation_id, origin_key, request_key, kind,
          fingerprint, title, prompt, placement, settings_json, workspace_id, conversation_id, conversation_name,
          branch, base_revision, phase, created_at, updated_at)
         VALUES ('crashed-worktree', ?, 'message:crash', 'wt', 'task', 'f', 'W', 'Do W', 'worktree', '{}', ?,
          'not-created', 'W', 'task/w-1', 'abc1234', 'allocating', 0, 0)`
      )
      .run(source.id, workspaceId)

    restartDb()
    const { deps: after, service: restarted } = harness()
    await restarted.reconcile()
    expect(getConversationDispatchByDestination(pending.conversation.id)?.phase).toBe('started')
    expect(getConversationDispatchByDestination(unsent.conversation.id)).toMatchObject({
      phase: 'start-failed',
      error: 'interrupted-during-start',
    })
    expect(getConversationDispatchByDestination('not-created')).toMatchObject({ phase: 'recovery' })
    await restarted.start(pending.record.dispatchId)
    expect(after.startTurn).not.toHaveBeenCalled()
    await expect(restarted.retryStart(unsent.conversation.id)).resolves.toEqual({ ok: true })
    expect(after.startTurn).toHaveBeenCalledTimes(1)
  })
})
