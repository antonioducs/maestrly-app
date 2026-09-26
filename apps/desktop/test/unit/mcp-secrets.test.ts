import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../../src/main/store'
import {
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  listMcpServers,
  buildMcpTools,
  connectMcpServer,
} from '../../src/main/chat/mcp'
import { writeMcpCatalog } from '../../src/main/chat/mcp-catalog'
import { freshDb, closeDb } from '../helpers/db'

const secrets = vi.hoisted(() => ({ values: new Map<string, string>(), available: true, writable: true }))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => secrets.available,
  secureGet: (key: string) => (secrets.available ? (secrets.values.get(key) ?? null) : null),
  secureSet: (key: string, value: string) => {
    if (!secrets.available || !secrets.writable) return false
    secrets.values.set(key, value)
    return true
  },
  secureRemove: (key: string) => secrets.values.delete(key),
}))
const input = {
  name: 'Synthetic',
  transport: 'stdio' as const,
  command: 'synthetic-mcp',
  args: ['--key', 'secret-2'],
  env: { TOKEN: 'secret-1' },
}
beforeEach(() => {
  freshDb()
  secrets.values.clear()
  secrets.available = true
  secrets.writable = true
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})

describe('MCP connection secrets', () => {
  it('adds encrypted details without inline secrets', () => {
    const server = addMcpServer(input)
    const raw = store.getAppSetting('chat.mcpServers')!
    expect(raw).not.toContain('secret-1')
    expect(raw).not.toContain('secret-2')
    expect(secrets.values.has('chat.mcpServer.' + server.id)).toBe(true)
    expect(listMcpServers()[0]).toMatchObject(input)
  })
  it('updates encrypted details', () => {
    const server = addMcpServer(input)
    updateMcpServer(server.id, { env: { TOKEN: 'replacement' } })
    expect(listMcpServers()[0].env).toEqual({ TOKEN: 'replacement' })
    expect(store.getAppSetting('chat.mcpServers')).not.toContain('replacement')
  })
  it('removes the secret entry', () => {
    const server = addMcpServer(input)
    removeMcpServer(server.id)
    expect(secrets.values.size).toBe(0)
    expect(listMcpServers()).toEqual([])
  })
  it('migrates inline details exactly once', () => {
    const legacy = {
      id: 'mcp_1',
      name: 'A',
      transport: 'http',
      enabled: true,
      url: 'https://x.test/?key=s',
      headers: { Authorization: 'Bearer s' },
    }
    store.setAppSetting('chat.mcpServers', JSON.stringify([legacy]))
    expect(listMcpServers()).toEqual([legacy])
    expect(JSON.parse(store.getAppSetting('chat.mcpServers')!)).toEqual([
      { id: 'mcp_1', name: 'A', transport: 'http', enabled: true },
    ])
    const writes = vi.spyOn(store, 'setAppSetting')
    expect(listMcpServers()).toEqual([legacy])
    expect(writes).not.toHaveBeenCalled()
  })
  it('keeps legacy details when secure storage is unavailable', () => {
    secrets.available = false
    addMcpServer(input)
    expect(store.getAppSetting('chat.mcpServers')).toContain('secret-1')
    expect(listMcpServers()[0]).toMatchObject(input)
  })
  it('excludes unreadable details from tools', async () => {
    store.setAppSetting('chat.mcpServers', JSON.stringify([{ ...input, id: 'mcp_1', enabled: true }]))
    const server = listMcpServers()[0]
    writeMcpCatalog(server, [{ name: 'synthetic_tool', inputSchema: { type: 'object' } }])
    secrets.values.delete('chat.mcpServer.' + server.id)
    expect(listMcpServers()[0]).toMatchObject({ unavailable: true })
    await expect(connectMcpServer(listMcpServers()[0])).rejects.toThrow('unavailable')
    expect(listMcpServers()[0].url).toBeUndefined()
    expect(
      (await buildMcpTools({ mode: 'agent', gate: async () => {}, signal: new AbortController().signal })).tools
    ).toEqual({})
  })
  it('preserves unreadable secrets and never persists the runtime marker', () => {
    const server = addMcpServer(input)
    secrets.values.set('chat.mcpServer.' + server.id, 'invalid-json')
    updateMcpServer(server.id, { enabled: false })
    expect(secrets.values.get('chat.mcpServer.' + server.id)).toBe('invalid-json')
    expect(store.getAppSetting('chat.mcpServers')).not.toContain('unavailable')
  })
  it('recovers an unavailable server when connection details are configured again', () => {
    const server = addMcpServer(input)
    secrets.values.delete('chat.mcpServer.' + server.id)
    updateMcpServer(server.id, { command: 'replacement-mcp', env: { TOKEN: 'replacement' } })
    expect(listMcpServers()[0]).toMatchObject({ command: 'replacement-mcp', env: { TOKEN: 'replacement' } })
    expect(listMcpServers()[0].unavailable).toBeUndefined()
  })
  it('preserves encrypted details when another server is added without keyring access', () => {
    const server = addMcpServer(input)
    const encrypted = secrets.values.get('chat.mcpServer.' + server.id)
    secrets.available = false
    addMcpServer({ ...input, name: 'Second' })
    expect(listMcpServers()[0].unavailable).toBe(true)
    expect(secrets.values.get('chat.mcpServer.' + server.id)).toBe(encrypted)
    secrets.available = true
    expect(listMcpServers()[0]).toMatchObject(input)
  })
  it.each(['null', '[]', '"text"', 'invalid-json'])('marks invalid details %s unavailable', (raw) => {
    const server = addMcpServer(input)
    secrets.values.set('chat.mcpServer.' + server.id, raw)
    expect(listMcpServers()[0]).toMatchObject({ unavailable: true })
  })
  it('retains inline details on encryption failure', () => {
    secrets.writable = false
    addMcpServer(input)
    expect(listMcpServers()[0]).toMatchObject(input)
    expect(store.getAppSetting('chat.mcpServers')).toContain('secret-1')
  })
})
