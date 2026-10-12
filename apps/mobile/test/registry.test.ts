import { describe, expect, it } from 'vitest'
import { memoryStores, ServerRegistry, type PairedServer } from '../src/servers/registry'

const server = (id: string, name = id): PairedServer => ({
  id,
  origin: `https://${name}.example.dev`,
  name,
  deviceName: 'iPhone',
  features: ['files'],
  pairedAt: '2026-10-12T12:00:00.000Z',
})

describe('paired servers', () => {
  it('keeps the token in the secret store and never in the list', async () => {
    const { secrets, kv } = memoryStores()
    const registry = new ServerRegistry(secrets, kv)
    await registry.add(server('a'), 'secret-token')
    expect(await registry.list()).toEqual([server('a')])
    expect(await registry.token('a')).toBe('secret-token')
    expect(await kv.get('servers')).not.toContain('secret-token')
    expect(await registry.activeId()).toBe('a')
  })

  it('writes the token first, so a failed list write leaves no server without one', async () => {
    const { secrets, kv } = memoryStores()
    const failing = { ...kv, set: async (key: string, value: string) => {
      if (key === 'servers') throw new Error('disk full')
      await kv.set(key, value)
    } }
    const registry = new ServerRegistry(secrets, failing)
    await expect(registry.add(server('a'), 'tok')).rejects.toThrow('disk full')
    expect(await registry.list()).toEqual([])
    expect(await secrets.get('server-token.a')).toBe('tok')
  })

  it('removes a server from the list before its token, and moves on to the next one', async () => {
    const { secrets, kv } = memoryStores()
    const registry = new ServerRegistry(secrets, kv)
    await registry.add(server('a'), 'ta')
    await registry.add(server('b'), 'tb')
    await registry.setActive('a')
    await registry.remove('a')
    expect((await registry.list()).map((item) => item.id)).toEqual(['b'])
    expect(await registry.token('a')).toBeNull()
    expect(await registry.activeId()).toBe('b')
    await registry.remove('b')
    expect(await registry.activeId()).toBeNull()
  })

  it('reads a damaged list as empty and updates features in place', async () => {
    const { secrets, kv } = memoryStores()
    await kv.set('servers', '{')
    const registry = new ServerRegistry(secrets, kv)
    expect(await registry.list()).toEqual([])
    await registry.add(server('a'), 'ta')
    await registry.updateFeatures('a', ['files', 'device-pairing'])
    expect((await registry.list())[0].features).toEqual(['files', 'device-pairing'])
  })
})
