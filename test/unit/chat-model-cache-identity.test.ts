import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ key: 'test-api-key-one', persisted: '', writes: vi.fn() }))
vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: () => ({ id: 'provider', baseURL: 'https://example.test/v1' }),
  getProviderKind: () => 'openai',
}))
vi.mock('../../src/main/chat/credentials', () => ({ getApiKey: () => state.key }))
vi.mock('../../src/main/store', () => ({
  getAppSetting: () => null,
  setAppSetting: (_name: string, value: string) => {
    state.persisted = value
    state.writes(value)
  },
}))
import { fetchModels, invalidateModels } from '../../src/main/chat/models'

afterEach(() => {
  vi.restoreAllMocks()
  invalidateModels()
})

describe('model catalog credential fingerprints', () => {
  it('uses fingerprints only to invalidate cached model lists and never persists the API key', async () => {
    const fetch = vi
      .spyOn(net, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] })))
    expect(await fetchModels('provider')).toEqual(['model-a'])
    expect(state.persisted).not.toContain(state.key)
    const first = JSON.parse(state.persisted).provider.fp
    expect(first).toMatch(/^[a-f0-9]{16}$/)
    expect(await fetchModels('provider')).toEqual(['model-a'])
    expect(fetch).toHaveBeenCalledTimes(1)
    state.key = 'test-api-key-two'
    expect(await fetchModels('provider')).toEqual(['model-a'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(state.persisted).provider.fp).not.toBe(first)
    expect(state.persisted).not.toContain(state.key)
  })
})
