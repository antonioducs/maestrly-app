import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { createDefaultMaestroConfig } from '../../src/shared/maestro'
import { registerMaestroIpc } from '../../src/main/chat/maestro-ipc'

describe('Maestro strategy profile IPC', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('registers catalog and CRUD using the global profile supplied by the runtime', () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const orchestrator = { providerId: 'p', modelId: 'm', reasoning: 'high', fastMode: true }
    registerMaestroIpc(
      { mhandle: (channel, handler) => handlers.set(channel, handler) },
      { getGlobalOrchestratorProfile: () => orchestrator }
    )

    expect([...handlers.keys()].sort()).toEqual(
      expect.arrayContaining([
        'chat:maestro:strategy-profiles:list',
        'chat:maestro:strategy-profiles:create',
        'chat:maestro:strategy-profiles:update',
        'chat:maestro:strategy-profiles:delete',
      ])
    )
    expect(handlers.get('chat:maestro:strategy-profiles:list')!({}).items).toHaveLength(5)
    const input = { name: 'Premium', config: createDefaultMaestroConfig(), orchestrator }
    const created = handlers.get('chat:maestro:strategy-profiles:create')!({}, input)
    expect(created).toMatchObject({ ok: true, profile: { name: 'Premium' } })
    const id = created.profile.id
    expect(
      handlers.get('chat:maestro:strategy-profiles:update')!({}, id, { ...input, name: 'Premium 2' })
    ).toMatchObject({ ok: true, profile: { id, name: 'Premium 2' } })
    expect(handlers.get('chat:maestro:strategy-profiles:delete')!({}, id)).toMatchObject({ ok: true })
  })
})
