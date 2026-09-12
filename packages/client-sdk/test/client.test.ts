import { describe, expect, it, vi } from 'vitest'
import { MaestrlyClient, MaestrlyApiError } from '../src/index.js'

describe('MaestrlyClient', () => {
  it('uses the configured instance and authentication mechanism', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer scoped')
      return Response.json({
        instanceId: 'local', name: 'Local', canonicalUrl: 'http://127.0.0.1:4310', apiVersion: 'v1',
        protocolVersions: ['1.0'], authentication: { localAccounts: true, publicSignup: false, deviceAuthorization: true },
      })
    })
    const client = new MaestrlyClient({
      baseUrl: 'http://127.0.0.1:4310', fetch: fetchMock as typeof fetch,
      authentication: { headers: () => ({ authorization: 'Bearer scoped' }) },
    })
    await expect(client.metadata()).resolves.toMatchObject({ instanceId: 'local' })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4310/api/v1/meta', expect.anything())
  })

  it('rejects incompatible instances without affecting local callers', async () => {
    const client = new MaestrlyClient({
      baseUrl: 'https://instance.example',
      fetch: vi.fn(async () => Response.json({
        instanceId: 'future', name: 'Future', canonicalUrl: 'https://instance.example', apiVersion: 'v1',
        protocolVersions: ['9.0'], authentication: { localAccounts: true, publicSignup: false, deviceAuthorization: true },
      })) as typeof fetch,
    })
    await expect(client.metadata()).rejects.toBeInstanceOf(MaestrlyApiError)
  })

  it('sends idempotency keys on writes', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('write-1')
      return Response.json({
        id: 'card', organizationId: 'org', projectId: 'project', boardId: 'board', columnId: 'column', parentCardId: null,
        title: 'Card', description: '', acceptanceCriteria: [], priority: 'none', labels: [], assigneeUserIds: [],
        position: 0, version: 1, archivedAt: null, createdAt: '2026-09-07T01:00:00.000Z', updatedAt: '2026-09-07T01:00:00.000Z',
      })
    })
    const client = new MaestrlyClient({ baseUrl: 'https://instance.example', fetch: fetchMock as typeof fetch })
    await client.createCard('org', 'board', { title: 'Card' }, 'write-1')
  })
})
