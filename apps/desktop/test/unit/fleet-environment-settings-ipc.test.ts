import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { registerFleetEnvironmentSettingsIpc } from '../../src/main/fleet/client/environment-settings-ipc'
const revision = '550e8400-e29b-41d4-a716-446655440000'
function setup() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const mutations = new Set<string>()
  const reg: IpcRegistrar = {
    handle: (key, fn) => {
      handlers.set(key, (...args) => fn({} as never, ...args))
    },
    mhandle: (key, fn) => {
      mutations.add(key)
      handlers.set(key, (...args) => fn({} as never, ...args))
    },
    on: () => {},
    mon: () => {},
  }
  const environment = { id: 'empty-env', capabilities: ['environment-settings-v1'] }
  const fleet = {
    hasFeature: vi.fn(() => true),
    getSnapshot: () => ({ environments: [environment] }),
    call: vi.fn(async (): Promise<unknown> => ({ revision, imageGenEnabled: true })),
  }
  registerFleetEnvironmentSettingsIpc(reg, fleet)
  const call = (method: string, id: unknown, input: unknown = {}) =>
    handlers.get('fleet:settings:' + method)!(id, input)
  return { fleet, environment, call, mutations, handlers }
}
describe('environment settings IPC', () => {
  it('requires explicit valid environment target and both capability gates', async () => {
    const h = setup()
    await expect(h.call('preferences', '../escape')).rejects.toThrow()
    await expect(h.call('preferences', { botId: 'other' })).rejects.toThrow()
    await expect(h.call('preferences', 'unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    h.fleet.hasFeature.mockReturnValue(false)
    await expect(h.call('preferences', 'empty-env')).rejects.toMatchObject({ code: 'CONFLICT' })
    h.fleet.hasFeature.mockReturnValue(true)
    h.environment.capabilities = []
    await expect(h.call('preferences', 'empty-env')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.fleet.call).not.toHaveBeenCalled()
  })
  it('supports empty environments and validates raw responses', async () => {
    const h = setup()
    await expect(h.call('preferences', 'empty-env')).resolves.toEqual({ revision, imageGenEnabled: true })
    expect(h.fleet.call).toHaveBeenCalledWith('settingsPreferences', { params: { eid: 'empty-env' } })
    h.fleet.call.mockResolvedValue({ revision, imageGenEnabled: true, secret: 'must-not-cross' })
    await expect(h.call('preferences', 'empty-env')).rejects.toThrow()
  })
  it('guards mutations and rejects unknown fields before calling the gateway', async () => {
    const h = setup()
    expect(h.mutations.has('fleet:settings:setPreferences')).toBe(true)
    expect(h.handlers.has('fleet:settings:call')).toBe(false)
    await expect(h.call('setPreferences', 'empty-env', { imageGenEnabled: false })).rejects.toThrow()
    await expect(
      h.call('setPreferences', 'empty-env', { expectedRevision: revision, imageGenEnabled: false, arbitrary: true })
    ).rejects.toThrow()
    expect(h.fleet.call).not.toHaveBeenCalled()
  })
})
