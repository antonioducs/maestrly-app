import { describe, expect, it, vi } from 'vitest'
import { registerMaestroConfiguratorIpc } from '../../src/main/chat/maestro-configurator-ipc'

describe('Maestro configurator IPC', () => {
  it('registers the isolated surface and streams only to the invoking renderer', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const service = {
      state: vi.fn(async () => ({
        thread: { version: 1, messages: [] },
        profile: null,
        catalog: { providers: [], generatedAt: 1 },
        activeTurnId: null,
      })),
      setProfile: vi.fn(async (profile) => ({ ok: true as const, profile })),
      send: vi.fn(async (_input, emit) => {
        emit({ kind: 'progress', turnId: 'turn-1', message: 'working' })
        return {
          ok: true as const,
          turnId: 'turn-1',
          userMessage: { id: 'u1', role: 'user' as const, text: 'hi', createdAt: 1 },
        }
      }),
      cancel: vi.fn(() => true),
      reset: vi.fn((emit) => emit?.({ kind: 'reset' as const })),
      recordEvent: vi.fn((event: { kind: string }) =>
        event.kind === 'proposal-applied'
          ? { id: 'e1', role: 'event' as const, text: 'applied', createdAt: 2, event }
          : null
      ),
    }
    registerMaestroConfiguratorIpc({
      mhandle: (channel, handler) => handlers.set(channel, handler),
      service: service as never,
    })
    expect([...handlers.keys()].sort()).toEqual([
      'chat:maestro-configurator:cancel',
      'chat:maestro-configurator:record-event',
      'chat:maestro-configurator:reset',
      'chat:maestro-configurator:send',
      'chat:maestro-configurator:set-profile',
      'chat:maestro-configurator:state',
    ])
    const sender = { isDestroyed: () => false, send: vi.fn() }
    await handlers.get('chat:maestro-configurator:send')!({ sender }, { text: 'hi' })
    expect(sender.send).toHaveBeenCalledWith('chat:maestro-configurator:event', {
      kind: 'progress',
      turnId: 'turn-1',
      message: 'working',
    })
    await handlers.get('chat:maestro-configurator:reset')!({ sender })
    expect(sender.send).toHaveBeenLastCalledWith('chat:maestro-configurator:event', { kind: 'reset' })

    const applied = { kind: 'proposal-applied', proposalId: 'p1' }
    expect(await handlers.get('chat:maestro-configurator:record-event')!({ sender }, applied)).toEqual({ ok: true })
    expect(sender.send).toHaveBeenLastCalledWith('chat:maestro-configurator:event', {
      kind: 'message',
      message: expect.objectContaining({ id: 'e1', role: 'event', event: applied }),
    })
    sender.send.mockClear()
    // An event the thread does not record (nothing to inform yet) is not echoed to the renderer.
    expect(
      await handlers.get('chat:maestro-configurator:record-event')!({ sender }, { kind: 'draft-discarded' })
    ).toEqual({ ok: false })
    expect(sender.send).not.toHaveBeenCalled()
  })
})
