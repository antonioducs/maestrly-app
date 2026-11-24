import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { declareSwarmTasks, listSwarm, onSwarmDispatchStarted, onSwarmWorkerResult } from '../../src/main/chat/maestro-swarm'
import { registerMaestroSwarmIpc } from '../../src/main/chat/maestro-swarm-ipc'

describe('Maestro swarm IPC', () => {
  let workspaceId: string
  let orchId: string
  let worker1: string
  let worker2: string
  let worker3: string

  beforeEach(() => {
    freshDb()
    workspaceId = makeWorkspace().id
    orchId = makeConversation(workspaceId, { name: 'Orchestrator', experience: 'maestro' }).id
    worker1 = makeConversation(workspaceId, { name: 'Worker 1' }).id
    worker2 = makeConversation(workspaceId, { name: 'Worker 2' }).id
    worker3 = makeConversation(workspaceId, { name: 'Worker 3' }).id
  })

  afterEach(closeDb)

  it('returns swarm tasks for chat:maestro:swarm:get and validates conversationId', () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    registerMaestroSwarmIpc({ mhandle: (channel, handler) => handlers.set(channel, handler) })

    expect([...handlers.keys()].sort()).toEqual(['chat:maestro:swarm:get', 'chat:maestro:swarm:stop'])

    declareSwarmTasks(orchId, [
      { key: 'api', title: 'API', agent: 'neon' },
      { key: 'ui', title: 'UI', agent: 'amber' },
    ])

    const tasks = handlers.get('chat:maestro:swarm:get')!({}, orchId)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((task: { key: string }) => task.key)).toEqual(['api', 'ui'])

    expect(handlers.get('chat:maestro:swarm:get')!({}, '')).toEqual([])
    expect(handlers.get('chat:maestro:swarm:get')!({}, '   ')).toEqual([])
    expect(handlers.get('chat:maestro:swarm:get')!({}, null)).toEqual([])
  })

  it('stops the orchestrator and implementing workers via chat:maestro:swarm:stop', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const stopChat = vi.fn(async (id: string) => {
      if (id === worker2) throw new Error('already stopped')
    })
    registerMaestroSwarmIpc({ mhandle: (channel, handler) => handlers.set(channel, handler) }, { stopChat })

    declareSwarmTasks(orchId, [
      { key: 't1', title: 'Task 1' },
      { key: 't2', title: 'Task 2' },
      { key: 't3', title: 'Task 3' },
      { key: 't4', title: 'Task 4' },
    ])
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 't1',
      conversationId: worker1,
      branch: 'feat/t1',
      title: 'Task 1',
    })
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 't2',
      conversationId: worker2,
      branch: 'feat/t2',
      title: 'Task 2',
    })
    onSwarmDispatchStarted({
      orchestratorId: orchId,
      requestKey: 't3',
      conversationId: worker3,
      branch: 'feat/t3',
      title: 'Task 3',
    })
    // t3 is already delivered so it should not be stopped; t4 is still queued.
    onSwarmWorkerResult({ orchestratorId: orchId, workerConversationId: worker3, status: 'success' })

    const res = await handlers.get('chat:maestro:swarm:stop')!({}, orchId)
    expect(res).toEqual({ ok: true, stopped: 2 })

    expect(stopChat).toHaveBeenCalledTimes(3)
    expect(stopChat).toHaveBeenCalledWith(orchId)
    expect(stopChat).toHaveBeenCalledWith(worker1)
    expect(stopChat).toHaveBeenCalledWith(worker2)
    expect(stopChat).not.toHaveBeenCalledWith(worker3)

    const tasks = new Map(listSwarm(orchId).map((t) => [t.key, t]))
    expect(tasks.get('t1')).toMatchObject({ phase: 'blocked', note: 'stopped' })
    expect(tasks.get('t2')).toMatchObject({ phase: 'blocked', note: 'stopped' })
    expect(tasks.get('t3')?.phase).toBe('delivered')
    expect(tasks.get('t4')?.phase).toBe('queued')

    // Invalid conversationId is rejected without calling stopChat.
    stopChat.mockClear()
    const invalid = await handlers.get('chat:maestro:swarm:stop')!({}, '')
    expect(invalid).toEqual({ ok: false, stopped: 0, error: 'invalid-conversation' })
    expect(stopChat).not.toHaveBeenCalled()
  })
})
