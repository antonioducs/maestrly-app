import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformCredential, PlatformCredentialStore } from '../../src/main/platform/credential-store'
vi.mock('../../src/main/store', () => ({
  getAppSetting: () =>
    JSON.stringify([
      {
        id: 'connection',
        url: 'https://instance.test',
        name: 'Instance',
        instanceId: 'instance',
        desktopClientId: 'client',
      },
    ]),
  setAppSetting: vi.fn(),
}))
vi.mock('../../src/main/secure-store', () => ({
  secureGet: () => null,
  secureSet: () => false,
  secureRemove: vi.fn(),
  secureStorageMode: () => 'unavailable',
}))
import { PlatformConnectionService } from '../../src/main/platform/connection-service'
function fixture() {
  let value: PlatformCredential | null = {
    accessToken: 'old',
    refreshToken: 'refresh',
    clientId: 'client',
    expiresAt: 0,
    userId: 'owner',
  }
  const store = {
    get: () => value,
    set: vi.fn((_id: string, next: PlatformCredential) => {
      value = next
      return 'memory'
    }),
    remove: () => {
      value = null
    },
    mode: () => 'unavailable',
  }
  return { service: new PlatformConnectionService(store as unknown as PlatformCredentialStore), store }
}
afterEach(() => vi.unstubAllGlobals())
describe('desktop platform session renewal', () => {
  it('shares concurrent refreshes and persists rotated credentials', async () => {
    const { service, store } = fixture()
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }))
    )
    vi.stubGlobal('fetch', fetch)
    expect(
      await Promise.all([service.authenticatedToken('connection'), service.authenticatedToken('connection')])
    ).toEqual(['new', 'new'])
    expect(fetch).toHaveBeenCalledOnce()
    expect(store.get()).toMatchObject({ accessToken: 'new', refreshToken: 'rotated' })
    expect(await service.authenticatedToken('connection')).toBe('new')
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('does not restore a disconnected account when an in-flight refresh returns', async () => {
    const { service, store } = fixture()
    let resolve!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r
          })
      )
    )
    const pending = service.authenticatedToken('connection')
    service.disconnect('connection')
    resolve(new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 })))
    await expect(pending).rejects.toThrow(/account changed/)
    expect(store.set).not.toHaveBeenCalled()
    expect(store.get()).toBeNull()
  })
})
