import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startFakeProvider, type FakeProviderReply, type FakeProviderServer } from '../helpers/fake-provider'

const state = vi.hoisted(() => ({
  key: 'sk-qa-invalid-0000000000001111',
  baseURL: '',
  kind: 'openai',
  settings: new Map<string, string>(),
}))
vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: () => ({ id: 'custom', name: 'OpenAI custom', baseURL: state.baseURL }),
  getProviderKind: () => state.kind,
}))
vi.mock('../../src/main/chat/credentials', () => ({ getApiKey: () => state.key }))
vi.mock('../../src/main/store', () => ({
  getAppSetting: (name: string) => state.settings.get(name) ?? null,
  setAppSetting: (name: string, value: string) => void state.settings.set(name, value),
}))
import { currentApiKeyCheck, fetchModels, invalidateModels } from '../../src/main/chat/models'

/** What OpenAI answers for a wrong key: its message echoes a masked key, and the request carried the whole one. */
const OPENAI_401 = {
  error: {
    message:
      'Incorrect API key provided: sk-qa-in***********1111. You can find your API key at https://platform.openai.com/account/api-keys.',
    type: 'invalid_request_error',
    code: 'invalid_api_key',
  },
}

/** A synthetic key without a known prefix, so only the literal redaction can mask it. */
const ECHOED = 'qa-plain-0000000000000000'

let server: FakeProviderServer | undefined

async function serve(reply: FakeProviderReply): Promise<FakeProviderServer> {
  await server?.close()
  server = await startFakeProvider(reply)
  state.baseURL = server.baseURL
  return server
}

function persisted(): string {
  return [...state.settings.values()].join('\n')
}

beforeEach(() => {
  vi.spyOn(net, 'fetch').mockImplementation((input, init) => fetch(input as string, init))
  state.key = 'sk-qa-invalid-0000000000001111'
  state.kind = 'openai'
})

afterEach(async () => {
  invalidateModels()
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
})

describe('API key check from the model listing', () => {
  it.each([401, 403])('marks the key rejected on HTTP %i with the redacted provider message', async (status) => {
    await serve({ status, body: OPENAI_401 })
    expect(await fetchModels('custom', true)).toEqual([])
    const check = currentApiKeyCheck('custom')
    expect(check).toMatchObject({ outcome: 'rejected', status })
    expect(check?.detail).toContain('Incorrect API key provided')
    expect(check?.detail).not.toContain(state.key)
    expect(server!.requests[0].headers.authorization).toBe(`Bearer ${state.key}`)
    // Neither the stored check nor the model cache ever holds the key.
    expect(persisted()).not.toContain(state.key)
  })

  it('masks the key wherever the provider echoes it back', async () => {
    state.key = ECHOED
    await serve({ status: 401, body: { error: { message: `Key ${state.key} is not valid` } } })
    await fetchModels('custom', true)
    const check = currentApiKeyCheck('custom')
    expect(check?.outcome).toBe('rejected')
    expect(check?.detail).toBe('Key *** is not valid')
    expect(persisted()).not.toContain(state.key)
  })

  it('checks native Anthropic keys the same way', async () => {
    state.kind = 'anthropic'
    const provider = await serve({
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    })
    await fetchModels('custom', true)
    expect(provider.requests[0].headers['x-api-key']).toBe(state.key)
    expect(currentApiKeyCheck('custom')).toMatchObject({
      outcome: 'rejected',
      status: 401,
      detail: 'invalid x-api-key',
    })
  })

  it('accepts a key the listing answered', async () => {
    await serve({ status: 200, body: { data: [{ id: 'model-a' }] } })
    expect(await fetchModels('custom', true)).toEqual(['model-a'])
    expect(currentApiKeyCheck('custom')).toMatchObject({ outcome: 'accepted' })
  })

  it('leaves the key unverified when the provider has no /models or fails for another reason', async () => {
    await serve({ status: 404, body: '<html>Not Found</html>' })
    await fetchModels('custom', true)
    expect(currentApiKeyCheck('custom')).toEqual({ outcome: 'unverified', status: 404, checkedAt: expect.any(Number) })
    await serve({ status: 500, body: { error: { message: 'upstream down' } } })
    await fetchModels('custom', true)
    expect(currentApiKeyCheck('custom')).toMatchObject({ outcome: 'unverified', status: 500, detail: 'upstream down' })
  })

  it('leaves the key unverified when the provider cannot be reached', async () => {
    vi.mocked(net.fetch).mockRejectedValueOnce(new TypeError(`fetch failed for Bearer ${state.key}`))
    state.baseURL = 'http://127.0.0.1:9/v1'
    expect(await fetchModels('custom', true)).toEqual([])
    const check = currentApiKeyCheck('custom')
    expect(check?.outcome).toBe('unverified')
    expect(check?.status).toBeUndefined()
    expect(check?.detail).not.toContain(state.key)
  })

  it('binds the check to the key it ran with and forgets it when the provider changes', async () => {
    await serve({ status: 401, body: OPENAI_401 })
    await fetchModels('custom', true)
    expect(currentApiKeyCheck('custom')?.outcome).toBe('rejected')
    state.key = 'sk-qa-replaced-0000000000002222'
    expect(currentApiKeyCheck('custom')).toBeUndefined()
    state.key = 'sk-qa-invalid-0000000000001111'
    expect(currentApiKeyCheck('custom')?.outcome).toBe('rejected')
    invalidateModels('custom')
    expect(currentApiKeyCheck('custom')).toBeUndefined()
  })
})
