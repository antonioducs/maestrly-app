import { describe, expect, it, vi } from 'vitest'
import { registerConversationMigrationIpc } from '../../src/main/conversation-migration/ipc'
import { createTestRegistrar } from './ipc-registrar-test-utils'

function harness() {
  const listeners = new Set<(event: any) => void>()
  const service = {
    prepare: vi.fn(async () => undefined),
    execute: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    listRecoveries: vi.fn(() => []),
    onChanged: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  }
  const emitChanged = vi.fn()
  const registrar = createTestRegistrar()
  const dispose = registerConversationMigrationIpc(registrar.reg, {
    service: service as never,
    emitChanged,
  })
  return { ...registrar, service, emitChanged, listeners, dispose }
}

describe('conversation migration ipc', () => {
  it('registers guarded mutations separately from reads', () => {
    const { mhandles, handles } = harness()
    expect([...mhandles.keys()].sort()).toEqual([
      'conversation:migration-cancel',
      'conversation:migration-execute',
      'conversation:migration-prepare',
      'conversation:migration-resolve',
    ])
    expect([...handles.keys()]).toEqual(['conversation:migration-list-recoveries'])
  })

  it('validates strict payloads and never accepts renderer-supplied cwd/OID', async () => {
    const { mhandles, service } = harness()
    await expect(
      mhandles.get('conversation:migration-prepare')!({} as never, {
        conversationId: 'conversation',
        destinationBranch: 'feature/x',
      })
    ).resolves.toBeUndefined()
    expect(service.prepare).toHaveBeenCalledWith('conversation', 'feature/x')

    await expect(
      mhandles.get('conversation:migration-execute')!({} as never, {
        operationId: 'operation',
        selectedIgnoredPaths: [' leading.txt', 'trailing.txt '],
        confirmedSensitivePaths: [' leading.txt'],
      })
    ).resolves.toBeUndefined()
    expect(service.execute).toHaveBeenCalledWith('operation', [' leading.txt', 'trailing.txt '], [' leading.txt'])

    expect(() =>
      mhandles.get('conversation:migration-execute')!({} as never, {
        operationId: 'operation',
        selectedIgnoredPaths: [],
        confirmedSensitivePaths: [],
        destinationCwd: '/tmp/pwn',
        stashOid: 'attacker',
      })
    ).toThrow('Invalid payload')
    expect(service.execute).toHaveBeenCalledTimes(1)
  })

  it('forwards cancel/resolve and broadcasts progress until disposal', async () => {
    const { mhandles, handles, service, emitChanged, listeners, dispose } = harness()
    await mhandles.get('conversation:migration-cancel')!({} as never, { operationId: 'operation' })
    await mhandles.get('conversation:migration-resolve')!({} as never, {
      operationId: 'operation',
      action: 'rollback',
    })
    await handles.get('conversation:migration-list-recoveries')!({} as never)
    expect(service.cancel).toHaveBeenCalledWith('operation')
    expect(service.resolve).toHaveBeenCalledWith('operation', 'rollback')
    expect(service.listRecoveries).toHaveBeenCalledTimes(1)

    const event = {
      operationId: 'operation',
      phase: 'awaiting-validation',
      status: 'awaiting-validation',
      conversationId: 'conversation',
    }
    for (const listener of listeners) listener(event)
    expect(emitChanged).toHaveBeenCalledWith(event)
    dispose()
    for (const listener of listeners) listener({ ...event, phase: 'completed' })
    expect(emitChanged).toHaveBeenCalledTimes(1)
  })
})
