import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as store from '../../src/main/store'
import { addMcpServer, listMcpServers, removeMcpServer, upsertMcpServerByName } from '../../src/main/chat/mcp'
import { freshDb, closeDb } from '../helpers/db'

const state = vi.hoisted(() => ({ remove: true }))
vi.mock('../../src/main/secure-store', async () => {
  const db = await import('../../src/main/store')
  return {
    isSecureStorageAvailable: () => true,
    secureGet: (key: string) => db.getAppSetting('fixture.' + key),
    secureSet: (key: string, value: string) => {
      db.setAppSetting('fixture.' + key, value)
      return true
    },
    secureRemove: (key: string) => {
      if (!state.remove) return false
      db.setAppSetting('fixture.' + key, '')
      return true
    },
  }
})
beforeEach(() => {
  freshDb()
  state.remove = true
})
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})
const input = { name: 'Synthetic', transport: 'http' as const, enabled: true, url: 'https://example.test' }
function failListWrite() {
  const write = store.setAppSetting
  vi.spyOn(store, 'setAppSetting').mockImplementation((key, value) => {
    if (key === 'chat.mcpServers') throw new Error('List write failed')
    write(key, value)
  })
}
it('rolls back encrypted details when the identity list write fails', () => {
  const server = addMcpServer(input)
  const before = listMcpServers()
  const details = store.getAppSetting('fixture.chat.mcpServer.' + server.id)
  failListWrite()
  expect(() => upsertMcpServerByName({ name: input.name, transport: 'stdio', enabled: true, command: 'node' })).toThrow(
    'List write failed'
  )
  expect(listMcpServers()).toEqual(before)
  expect(store.getAppSetting('fixture.chat.mcpServer.' + server.id)).toBe(details)
})
it('rolls back migration when the identity list write fails', () => {
  const legacy = { ...input, id: 'mcp_fixture' }
  const raw = JSON.stringify([legacy])
  store.setAppSetting('chat.mcpServers', raw)
  failListWrite()
  expect(() => listMcpServers()).toThrow('List write failed')
  expect(store.getAppSetting('chat.mcpServers')).toBe(raw)
  expect(store.getAppSetting('fixture.chat.mcpServer.mcp_fixture')).toBeNull()
})
it('keeps the server and details when secure removal fails', () => {
  addMcpServer(input)
  const before = listMcpServers()
  state.remove = false
  expect(() => removeMcpServer(before[0].id)).toThrow()
  expect(listMcpServers()).toEqual(before)
})
