import { describe, expect, it, vi } from 'vitest'
import { registerArtifactsIpc } from '../../src/main/artifacts/ipc'
import type { ArtifactsService } from '../../src/main/artifacts/service'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup() {
  const guarded = new Map<string, Handler>()
  const unguarded: string[] = []
  const reg: IpcRegistrar = {
    handle: (channel) => void unguarded.push(channel),
    on: (channel) => void unguarded.push(channel),
    mon: (channel) => void unguarded.push(channel),
    mhandle: (channel, fn) => void guarded.set(channel, fn as Handler),
  }
  const service = {
    listAll: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    remove: vi.fn(async () => ({ removed: true, freedBytes: 0 })),
    thumbnail: vi.fn(async () => null),
    openExternal: vi.fn(async () => {}),
    openInConversation: vi.fn(async () => ({})),
    status: vi.fn(async () => ({ state: 'stopped', port: 4010 })),
    start: vi.fn(async () => ({ state: 'running', port: 4010 })),
    getSettings: vi.fn(() => ({ hostEnabled: true, port: 4010, quotaGb: 2 })),
    setSettings: vi.fn(async (input: unknown) => input),
  }
  registerArtifactsIpc(reg, { service: () => service as unknown as ArtifactsService })
  const call = (channel: string, ...args: unknown[]) => guarded.get(channel)!({}, ...args)
  return { guarded, unguarded, service, call }
}

const id = 'A'.repeat(22)

describe('artifacts IPC', () => {
  it('registers every channel behind the trusted-sender guard', () => {
    const { guarded, unguarded } = setup()
    expect([...guarded.keys()].sort()).toEqual([
      'artifacts:delete',
      'artifacts:detail',
      'artifacts:list',
      'artifacts:open-external',
      'artifacts:open-in-conversation',
      'artifacts:settings-get',
      'artifacts:settings-set',
      'artifacts:start',
      'artifacts:status',
      'artifacts:thumbnail',
    ])
    expect(unguarded).toEqual([])
  })

  it('validates identifiers before reaching the service', async () => {
    const { call, service } = setup()
    await expect(call('artifacts:delete', '../x')).rejects.toThrow()
    await expect(call('artifacts:detail', 42)).rejects.toThrow()
    await expect(call('artifacts:open-external', id, 0)).rejects.toThrow()
    await expect(call('artifacts:open-in-conversation', '', id)).rejects.toThrow()
    await expect(call('artifacts:thumbnail', 'nope')).rejects.toThrow()
    await expect(call('artifacts:thumbnail', id, 1.5)).rejects.toThrow()
    expect(service.remove).not.toHaveBeenCalled()
    expect(service.thumbnail).not.toHaveBeenCalled()
    expect(service.detail).not.toHaveBeenCalled()
    expect(service.openExternal).not.toHaveBeenCalled()
    expect(service.openInConversation).not.toHaveBeenCalled()

    await call('artifacts:delete', id)
    expect(service.remove).toHaveBeenCalledWith(id)
    await call('artifacts:thumbnail', id, 2)
    expect(service.thumbnail).toHaveBeenCalledWith(id, 2)
    await call('artifacts:open-in-conversation', 'conversation', id, 3)
    expect(service.openInConversation).toHaveBeenCalledWith('conversation', id, 3, {
      checkScope: false,
      activate: true,
    })
  })

  it('refuses invalid settings', async () => {
    const { call, service } = setup()
    await expect(call('artifacts:settings-set', { hostEnabled: true, port: 80, quotaGb: 2 })).rejects.toThrow()
    expect(service.setSettings).not.toHaveBeenCalled()
    await call('artifacts:settings-set', { hostEnabled: true, port: 5000, quotaGb: 2 })
    expect(service.setSettings).toHaveBeenCalledWith({ hostEnabled: true, port: 5000, quotaGb: 2 })
  })
})
