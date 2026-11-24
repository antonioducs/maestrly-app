import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { deleteConversation } from '../../src/main/store'
import {
  deleteMaestroSwarmTasks,
  findMaestroSwarmTaskByConversation,
  getMaestroSwarmTask,
  listMaestroSwarmTasks,
  upsertMaestroSwarmTask,
} from '../../src/main/store/maestro-swarm'
import type { MaestroSwarmTask } from '../../src/shared/maestro-swarm'

let workspaceId: string
let orchA: string
let orchB: string

function makeTask(overrides: Partial<MaestroSwarmTask> = {}): MaestroSwarmTask {
  return {
    orchestratorConversationId: orchA,
    key: 'api',
    title: 'API endpoints',
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
    ...overrides,
  }
}

beforeEach(() => {
  freshDb()
  workspaceId = makeWorkspace().id
  orchA = makeConversation(workspaceId, { name: 'Orch A' }).id
  orchB = makeConversation(workspaceId, { name: 'Orch B' }).id
})

afterEach(() => {
  closeDb()
})

describe('maestro swarm store', () => {
  it('creates and reads tasks in creation order', () => {
    upsertMaestroSwarmTask(makeTask({ key: 'second', title: 'Second', createdAt: 2000, updatedAt: 2000 }))
    upsertMaestroSwarmTask(
      makeTask({ key: 'first', title: 'First', dependsOn: ['setup'], createdAt: 1000, updatedAt: 1000 })
    )

    const single = getMaestroSwarmTask(orchA, 'first')
    expect(single).toEqual(
      makeTask({ key: 'first', title: 'First', dependsOn: ['setup'], createdAt: 1000, updatedAt: 1000 })
    )
    expect(getMaestroSwarmTask(orchA, 'missing')).toBeNull()

    const listed = listMaestroSwarmTasks(orchA)
    expect(listed.map((t) => t.key)).toEqual(['first', 'second'])

    restartDb()
    expect(listMaestroSwarmTasks(orchA).map((t) => t.key)).toEqual(['first', 'second'])
  })

  it('updates an existing task while preserving createdAt', () => {
    upsertMaestroSwarmTask(makeTask({ key: 'api', createdAt: 1000, updatedAt: 1000 }))
    upsertMaestroSwarmTask(
      makeTask({
        key: 'api',
        title: 'API v2',
        resourceId: 'atlas',
        dependsOn: ['schema'],
        conversationId: 'worker-1',
        branch: 'feat/api',
        phase: 'changes',
        changesReason: 'review',
        reviewRound: 1,
        note: 'Fix validation',
        mergedCommit: null,
        createdAt: 9999,
        updatedAt: 2500,
      })
    )

    const updated = getMaestroSwarmTask(orchA, 'api')
    expect(updated).toEqual({
      orchestratorConversationId: orchA,
      key: 'api',
      title: 'API v2',
      resourceId: 'atlas',
      dependsOn: ['schema'],
      conversationId: 'worker-1',
      branch: 'feat/api',
      phase: 'changes',
      changesReason: 'review',
      reviewRound: 1,
      note: 'Fix validation',
      mergedCommit: null,
      createdAt: 1000,
      updatedAt: 2500,
    })
  })

  it('looks up tasks by worker conversation id', () => {
    upsertMaestroSwarmTask(
      makeTask({
        orchestratorConversationId: orchA,
        key: 'api',
        conversationId: 'worker-1',
        branch: 'feat/api',
        phase: 'implementing',
      })
    )
    upsertMaestroSwarmTask(
      makeTask({
        orchestratorConversationId: orchB,
        key: 'ui',
        conversationId: 'worker-2',
        branch: 'feat/ui',
        phase: 'implementing',
      })
    )

    expect(findMaestroSwarmTaskByConversation('worker-1')?.key).toBe('api')
    expect(findMaestroSwarmTaskByConversation('worker-1', orchA)?.key).toBe('api')
    expect(findMaestroSwarmTaskByConversation('worker-1', orchB)).toBeNull()
    expect(findMaestroSwarmTaskByConversation('unknown')).toBeNull()
  })

  it('deletes swarm rows explicitly and cascades when the orchestrator conversation is deleted', () => {
    upsertMaestroSwarmTask(makeTask({ orchestratorConversationId: orchA, key: 'a1' }))
    upsertMaestroSwarmTask(makeTask({ orchestratorConversationId: orchA, key: 'a2' }))
    upsertMaestroSwarmTask(makeTask({ orchestratorConversationId: orchB, key: 'b1' }))

    deleteConversation(orchA)
    expect(listMaestroSwarmTasks(orchA)).toEqual([])
    expect(listMaestroSwarmTasks(orchB).map((t) => t.key)).toEqual(['b1'])

    deleteMaestroSwarmTasks(orchB)
    expect(listMaestroSwarmTasks(orchB)).toEqual([])
  })
})
