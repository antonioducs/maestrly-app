import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  declareSwarmTasks,
  ensureSwarmTasks,
  listSwarm,
  maestroSwarmStatePart,
  onSwarmDispatchStarted,
  onSwarmWorkerResult,
  onSwarmWorkerTurnStarted,
  reconcileSwarmMerges,
  setMaestroSwarmListener,
  stopSwarm,
} from '../../src/main/chat/maestro-swarm'
import {
  MAESTRO_SWARM_HOST_PHASES,
  renderMaestroSwarmState,
  type MaestroSwarmPhase,
} from '../../src/shared/maestro-swarm'

let workspaceId: string
let orchId: string
let worker1: string
let worker2: string

beforeEach(() => {
  freshDb()
  setMaestroSwarmListener(null)
  workspaceId = makeWorkspace().id
  orchId = makeConversation(workspaceId, { name: 'Orchestrator' }).id
  worker1 = makeConversation(workspaceId, { name: 'Worker 1' }).id
  worker2 = makeConversation(workspaceId, { name: 'Worker 2' }).id
})

afterEach(() => {
  setMaestroSwarmListener(null)
  closeDb()
})

describe('maestro swarm state transitions', () => {
  it('creates a new task in queued phase with title and agent', () => {
    const res = declareSwarmTasks(orchId, [{ key: 'api', title: 'API pedidos', agent: 'neon', dependsOn: ['db'] }])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.tasks).toHaveLength(1)
    expect(res.tasks[0]).toMatchObject({
      orchestratorConversationId: orchId,
      key: 'api',
      title: 'API pedidos',
      resourceId: 'neon',
      dependsOn: ['db'],
      conversationId: null,
      branch: null,
      phase: 'queued',
      changesReason: null,
      reviewRound: 0,
      note: null,
      mergedCommit: null,
    })
  })

  it('requires title for a new task and keeps batch updates atomic', () => {
    const res = declareSwarmTasks(orchId, [{ key: 'valid', title: 'Valid task' }, { key: 'no-title' }])
    expect(res).toEqual({ ok: false, error: 'title is required for a new task' })
    expect(listSwarm(orchId)).toEqual([])
  })

  it('refuses host-owned phases such as merged via declareSwarmTasks', () => {
    expect(MAESTRO_SWARM_HOST_PHASES).toEqual(['implementing', 'delivered', 'merged', 'failed'])
    const res = declareSwarmTasks(orchId, [{ key: 'api', title: 'API', phase: 'merged' as unknown as 'queued' }])
    expect(res).toEqual({ ok: false, error: 'merged is set by the host' })
    expect(listSwarm(orchId)).toEqual([])
  })

  it('refuses changes phase without a valid reason', () => {
    declareSwarmTasks(orchId, [{ key: 'api', title: 'API' }])
    const res = declareSwarmTasks(orchId, [{ key: 'api', phase: 'changes' }])
    expect(res).toEqual({ ok: false, error: 'changes requires a reason (review or conflict)' })
    expect(listSwarm(orchId)[0].phase).toBe('queued')
  })

  it('increments reviewRound each time changes is entered and clears changesReason on leave', () => {
    declareSwarmTasks(orchId, [{ key: 'api', title: 'API' }])

    const first = declareSwarmTasks(orchId, [{ key: 'api', phase: 'changes', reason: 'review', note: 'Add tests' }])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.tasks[0]).toMatchObject({
      phase: 'changes',
      changesReason: 'review',
      reviewRound: 1,
      note: 'Add tests',
    })

    const reviewing = declareSwarmTasks(orchId, [{ key: 'api', phase: 'reviewing' }])
    expect(reviewing.ok).toBe(true)
    if (!reviewing.ok) return
    expect(reviewing.tasks[0]).toMatchObject({
      phase: 'reviewing',
      changesReason: null,
      reviewRound: 1,
    })

    const second = declareSwarmTasks(orchId, [{ key: 'api', phase: 'changes', reason: 'conflict' }])
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.tasks[0]).toMatchObject({
      phase: 'changes',
      changesReason: 'conflict',
      reviewRound: 2,
    })
  })

  it('ensureSwarmTasks creates missing queued tasks and updates resourceId on existing ones', () => {
    ensureSwarmTasks(orchId, [{ key: 'api', title: 'API', resourceId: 'neon' }])
    expect(listSwarm(orchId)[0]).toMatchObject({
      key: 'api',
      title: 'API',
      resourceId: 'neon',
      phase: 'queued',
    })

    ensureSwarmTasks(orchId, [{ key: 'api', title: 'Ignored new title', resourceId: 'atlas' }])
    expect(listSwarm(orchId)[0]).toMatchObject({
      key: 'api',
      title: 'API',
      resourceId: 'atlas',
      phase: 'queued',
    })
  })

  it('marks an existing task implementing with conversation and branch on dispatch started', () => {
    declareSwarmTasks(orchId, [{ key: 'api', title: 'API' }])

    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'unknown',
      conversationId: worker2,
      branch: 'feat/unknown',
      title: 'Unknown',
    })
    expect(listSwarm(orchId)).toHaveLength(1)

    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    expect(listSwarm(orchId)[0]).toMatchObject({
      key: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      phase: 'implementing',
    })
  })

  it('transitions worker result success to delivered and error to failed with note', () => {
    declareSwarmTasks(orchId, [
      { key: 'api', title: 'API' },
      { key: 'ui', title: 'UI' },
    ])
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'ui',
      conversationId: worker2,
      branch: 'feat/ui',
      title: 'UI',
    })

    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker1, status: 'success' })
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker2, status: 'error' })

    const tasks = listSwarm(orchId)
    expect(tasks.find((t) => t.key === 'api')).toMatchObject({ phase: 'delivered', note: null })
    expect(tasks.find((t) => t.key === 'ui')).toMatchObject({ phase: 'failed', note: 'error' })
  })

  it('moves task from changes back to implementing when worker turn starts', () => {
    declareSwarmTasks(orchId, [{ key: 'api', title: 'API' }])
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    declareSwarmTasks(orchId, [{ key: 'api', phase: 'changes', reason: 'review' }])

    onSwarmWorkerTurnStarted({ fromConversationId: orchId, toConversationId: worker1 })

    expect(listSwarm(orchId)[0]).toMatchObject({
      phase: 'implementing',
      changesReason: null,
      reviewRound: 1,
    })
  })

  it('reconciles merged branches when isAncestor is true and leaves task unchanged when null', async () => {
    declareSwarmTasks(orchId, [
      { key: 'api', title: 'API' },
      { key: 'ui', title: 'UI' },
    ])
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'ui',
      conversationId: worker2,
      branch: 'feat/ui',
      title: 'UI',
    })
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker1, status: 'success' })
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker2, status: 'success' })

    await reconcileSwarmMerges(orchId, {
      branchTip: async (branch) => (branch === 'feat/api' ? 'abc1234' : 'def5678'),
      isAncestor: async (commit) => (commit === 'abc1234' ? true : null),
    })

    const tasks = listSwarm(orchId)
    expect(tasks.find((t) => t.key === 'api')).toMatchObject({
      phase: 'merged',
      mergedCommit: 'abc1234',
    })
    expect(tasks.find((t) => t.key === 'ui')).toMatchObject({
      phase: 'delivered',
      mergedCommit: null,
    })

    // Merged task is immutable except note, and worker result does not change it
    expect(declareSwarmTasks(orchId, [{ key: 'api', phase: 'reviewing' }])).toEqual({
      ok: false,
      error: 'api is already merged',
    })
    const noteRes = declareSwarmTasks(orchId, [{ key: 'api', note: 'Merged cleanly' }])
    expect(noteRes.ok).toBe(true)
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker1, status: 'error' })
    expect(listSwarm(orchId).find((t) => t.key === 'api')).toMatchObject({
      phase: 'merged',
      note: 'Merged cleanly',
    })
  })

  it('stopSwarm marks implementing tasks blocked with note stopped and returns their conversation ids', () => {
    declareSwarmTasks(orchId, [
      { key: 'api', title: 'API' },
      { key: 'ui', title: 'UI' },
      { key: 'docs', title: 'Docs' },
    ])
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'ui',
      conversationId: worker2,
      branch: 'feat/ui',
      title: 'UI',
    })
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker2, status: 'success' })

    const stopped = stopSwarm(orchId)
    expect(stopped).toEqual({ workerConversationIds: [worker1] })

    const tasks = listSwarm(orchId)
    expect(tasks.find((t) => t.key === 'api')).toMatchObject({ phase: 'blocked', note: 'stopped' })
    expect(tasks.find((t) => t.key === 'ui')).toMatchObject({ phase: 'delivered' })
    expect(tasks.find((t) => t.key === 'docs')).toMatchObject({ phase: 'queued' })
  })

  it('calls the listener once per mutation and ignores listener errors', async () => {
    const calls: string[] = []
    setMaestroSwarmListener((id) => {
      calls.push(id)
      if (calls.length === 1) throw new Error('listener boom')
    })

    // 1: declareSwarmTasks (2 tasks in 1 call -> 1 notification, throwing listener does not break mutation)
    const declared = declareSwarmTasks(orchId, [
      { key: 'api', title: 'API' },
      { key: 'ui', title: 'UI' },
    ])
    expect(declared.ok).toBe(true)
    expect(calls).toEqual([orchId])

    // Invalid declare does not notify
    declareSwarmTasks(orchId, [{ key: 'bad' }])
    expect(calls).toHaveLength(1)

    // 2: ensureSwarmTasks
    ensureSwarmTasks(orchId, [{ key: 'docs', title: 'Docs', resourceId: 'neon' }])
    expect(calls).toHaveLength(2)

    // 3: onSwarmDispatchStarted
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 'api',
      conversationId: worker1,
      branch: 'feat/api',
      title: 'API',
    })
    expect(calls).toHaveLength(3)

    // 4: onSwarmWorkerResult
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker1, status: 'success' })
    expect(calls).toHaveLength(4)

    // 5: onSwarmWorkerTurnStarted
    onSwarmWorkerTurnStarted({ fromConversationId: orchId, toConversationId: worker1 })
    expect(calls).toHaveLength(5)

    // 6: stopSwarm
    stopSwarm(orchId)
    expect(calls).toHaveLength(6)

    // 7: reconcileSwarmMerges
    await reconcileSwarmMerges(orchId, {
      branchTip: async () => 'aaa111',
      isAncestor: async () => true,
    })
    expect(calls).toHaveLength(7)

    // Calling stopSwarm when nothing is implementing does not notify
    const listenerSpy = vi.fn()
    setMaestroSwarmListener(listenerSpy)
    stopSwarm(orchId)
    expect(listenerSpy).not.toHaveBeenCalled()
  })

  it('renders empty string for no tasks and formatted markdown table for tasks', () => {
    expect(renderMaestroSwarmState([])).toBe('')

    const rendered = renderMaestroSwarmState([
      {
        orchestratorConversationId: orchId,
        key: 'api',
        title: 'API pedidos',
        resourceId: 'neon',
        dependsOn: [],
        conversationId: null,
        branch: null,
        phase: 'queued',
        changesReason: null,
        reviewRound: 0,
        note: null,
        mergedCommit: null,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        orchestratorConversationId: orchId,
        key: 'ui',
        title: 'UI | checkout\nform',
        resourceId: null,
        dependsOn: ['api'],
        conversationId: worker1,
        branch: 'feat/ui',
        phase: 'changes' as MaestroSwarmPhase,
        changesReason: 'review',
        reviewRound: 2,
        note: 'Fix | layout\nnow',
        mergedCommit: null,
        createdAt: 2000,
        updatedAt: 2000,
      },
    ])

    expect(rendered).toContain('# Maestro swarm state')
    expect(rendered).toContain('| api | API pedidos | neon | - | - | queued | 0 | - |')
    expect(rendered).toContain(
      `| ui | UI \\| checkout form | - | ${worker1} | feat/ui | changes (review) | 2 | Fix \\| layout now |`
    )
    expect(
      rendered.endsWith(
        'Host-owned phases: implementing, delivered, merged, failed. Update the others with swarm_update.'
      )
    ).toBe(true)
  })

  it('builds a hidden markdown MessagePart only for Maestro conversations with swarm tasks', () => {
    const standardConv = makeConversation(workspaceId, { name: 'Standard', experience: 'standard' }).id
    const maestroConv = makeConversation(workspaceId, { name: 'Maestro', experience: 'maestro' }).id

    // Empty swarm on Maestro returns null.
    expect(maestroSwarmStatePart(maestroConv)).toBeNull()

    // Non-Maestro conversation returns null even if swarm rows exist.
    declareSwarmTasks(standardConv, [{ key: 'api', title: 'API' }])
    expect(maestroSwarmStatePart(standardConv)).toBeNull()

    // Maestro conversation with tasks returns hidden file part with rendered table.
    declareSwarmTasks(maestroConv, [{ key: 'api', title: 'API pedidos', agent: 'neon' }])
    const part = maestroSwarmStatePart(maestroConv)
    expect(part).not.toBeNull()
    expect(part).toMatchObject({
      type: 'file',
      name: 'maestro-swarm.md',
      mediaType: 'text/markdown',
      kind: 'text',
      hidden: true,
      data: renderMaestroSwarmState(listSwarm(maestroConv)),
    })
    if (part && part.type === 'file') {
      expect(typeof part.id).toBe('string')
      expect(part.id.length).toBeGreaterThan(0)
    }
  })
})
