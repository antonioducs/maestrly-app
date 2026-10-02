import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as store from '../../src/main/store'
import * as mcp from '../../src/main/chat/mcp'
import { mcpSettingsService as service } from '../../src/main/fleet/instance/settings/mcp'
import { freshDb, closeDb } from '../helpers/db'

const state = vi.hoisted(() => ({ available: true, write: true }))
vi.mock('../../src/main/secure-store', async () => {
  const db = await import('../../src/main/store')
  return {
    isSecureStorageAvailable: () => state.available,
    secureGet: (key: string) => (state.available ? db.getAppSetting('fixture.' + key) : null),
    secureSet: (key: string, value: string) => {
      if (!state.available || !state.write) return false
      db.setAppSetting('fixture.' + key, value)
      return true
    },
    secureRemove: (key: string) => {
      db.setAppSetting('fixture.' + key, '')
      return true
    },
  }
})
beforeEach(() => {
  freshDb()
  state.available = true
  state.write = true
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  closeDb()
})
const input = {
  name: 'Fixture',
  transport: 'http' as const,
  enabled: true,
  url: 'https://user:secret@example.test/mcp?token=secret',
  headers: { Authorization: 'secret', Other: 'keep' },
}

it('redacts all connection values and preserves omitted or empty secrets while merging chosen keys', async () => {
  const server = await service.createMcpServer(input)
  expect(JSON.stringify(server)).not.toMatch(/secret|user|token/)
  expect(server.headerKeys).toEqual(['Authorization', 'Other'])
  expect(server.hasUrl).toBe(true)
  const changed = await service.patchMcpServer({
    id: server.id,
    expectedRevision: server.revision,
    enabled: false,
    headers: { set: { Authorization: '', New: 'new' } },
  })
  expect(changed.enabled).toBe(false)
  expect(mcp.listMcpServers()[0]).toMatchObject({
    url: input.url,
    headers: { Authorization: 'secret', Other: 'keep', New: 'new' },
  })
  await service.patchMcpServer({
    id: server.id,
    expectedRevision: changed.revision,
    headers: { remove: ['Authorization'] },
  })
  expect(mcp.listMcpServers()[0].headers).toEqual({ Other: 'keep', New: 'new' })
})
it('preserves unrelated environment values and accepts explicit replacement arguments', async () => {
  const server = await service.createMcpServer({
    name: 'Process',
    transport: 'stdio',
    enabled: true,
    command: 'fixture-secret',
    args: ['secret'],
    env: { A: 'keep', B: 'old' },
  })
  expect(JSON.stringify(server)).not.toContain('secret')
  await service.patchMcpServer({
    id: server.id,
    expectedRevision: server.revision,
    replace: { args: [] },
    env: { set: { B: 'new' } },
  })
  expect(mcp.listMcpServers()[0]).toMatchObject({ args: [], env: { A: 'keep', B: 'new' } })
})
it('rejects missing servers and unavailable edits without destroying encrypted details', async () => {
  await expect(service.mcpServer({ id: 'missing' })).rejects.toMatchObject({ status: 404 })
  const server = await service.createMcpServer(input)
  const before = store.getAppSetting('fixture.chat.mcpServer.' + server.id)
  state.available = false
  await expect(
    service.patchMcpServer({ id: server.id, expectedRevision: server.revision, enabled: false })
  ).rejects.toMatchObject({ status: 409 })
  expect(store.getAppSetting('fixture.chat.mcpServer.' + server.id)).toBe(before)
  expect(await service.testMcpServer({ id: server.id })).toEqual({ code: 'unavailable', toolCount: 0 })
})
it('rolls back details and revision when the metadata write fails', async () => {
  const server = await service.createMcpServer(input)
  const write = store.setAppSetting
  vi.spyOn(store, 'setAppSetting').mockImplementation((key, value) => {
    if (key === 'chat.mcpServers') throw new Error('synthetic write failure')
    write(key, value)
  })
  await expect(
    service.patchMcpServer({
      id: server.id,
      expectedRevision: server.revision,
      replace: { url: 'https://changed.test' },
    })
  ).rejects.toThrow()
  expect(mcp.listMcpServers()[0].url).toBe(input.url)
  expect((await service.mcpServer({ id: server.id })).revision).toBe(server.revision)
})
it('fails closed on secure writes and does not change the old configuration', async () => {
  const server = await service.createMcpServer(input)
  state.write = false
  await expect(
    service.patchMcpServer({ id: server.id, expectedRevision: server.revision, enabled: false })
  ).rejects.toThrow()
  expect(mcp.listMcpServers()[0].enabled).toBe(true)
})
it('serializes concurrent mutations so the second stale revision conflicts', async () => {
  const server = await service.createMcpServer(input)
  const results = await Promise.allSettled([
    service.patchMcpServer({ id: server.id, expectedRevision: server.revision, name: 'First' }),
    service.patchMcpServer({ id: server.id, expectedRevision: server.revision, name: 'Second' }),
  ])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(mcp.listMcpServers()[0].name).toBe('First')
})
it('tests only tool discovery, closes separately, and sanitizes failures', async () => {
  const server = await service.createMcpServer(input)
  const connection = {
    listTools: vi.fn().mockResolvedValue([{ name: 'fixture' }]),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(mcp, 'connectMcpServer').mockResolvedValue(connection)
  expect(await service.testMcpServer({ id: server.id })).toEqual({ code: 'ok', toolCount: 1 })
  expect(connection.close).toHaveBeenCalledOnce()
  expect(connection.callTool).not.toHaveBeenCalled()
  connection.listTools.mockRejectedValue(new Error('raw-secret-stderr'))
  expect(await service.testMcpServer({ id: server.id })).toEqual({ code: 'connection-failed', toolCount: 0 })
  expect(connection.close).toHaveBeenCalledTimes(2)
})
it('times out stalled discovery and closes the connection', async () => {
  const server = await service.createMcpServer(input)
  vi.useFakeTimers()
  const connection = {
    listTools: vi.fn(() => new Promise<never>(() => {})),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(mcp, 'connectMcpServer').mockResolvedValue(connection)
  const pending = service.testMcpServer({ id: server.id })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await pending).toEqual({ code: 'timeout', toolCount: 0 })
  expect(connection.close).toHaveBeenCalledOnce()
})
it('closes connections that arrive after the test deadline', async () => {
  const server = await service.createMcpServer(input)
  vi.useFakeTimers()
  const connection = {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }
  let finish!: (value: typeof connection) => void
  vi.spyOn(mcp, 'connectMcpServer').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = service.testMcpServer({ id: server.id })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await pending).toEqual({ code: 'timeout', toolCount: 0 })
  finish(connection)
  await Promise.resolve()
  expect(connection.close).toHaveBeenCalledOnce()
  expect(connection.listTools).not.toHaveBeenCalled()
})

it('preserves an empty URL editor and rejects invalid merged configuration without saving', async () => {
  const server = await service.createMcpServer(input)
  const changed = await service.patchMcpServer({
    id: server.id,
    expectedRevision: server.revision,
    replace: { url: '' },
  })
  expect(mcp.listMcpServers()[0].url).toBe(input.url)
  await expect(
    service.patchMcpServer({ id: server.id, expectedRevision: changed.revision, replace: { url: 'file:///secret' } })
  ).rejects.toMatchObject({ status: 400 })
  expect(mcp.listMcpServers()[0].url).toBe(input.url)
})

it('removes by ID with revision protection and invalidates the list', async () => {
  const server = await service.createMcpServer(input)
  const before = await service.mcpServers({})
  expect(await service.removeMcpServer({ id: server.id, expectedRevision: server.revision })).toEqual({ removed: true })
  const after = await service.mcpServers({})
  expect(after.servers).toEqual([])
  expect(after.revision).not.toBe(before.revision)
  expect(store.getAppSetting('fixture.chat.mcpServer.' + server.id)).toBe('')
})

it('invalidates remote and list revisions after local detail-only edits', async () => {
  const server = await service.createMcpServer(input)
  const before = await service.mcpServers({})
  mcp.updateMcpServer(server.id, { headers: { Authorization: 'local replacement' } }, { requireSecure: true })
  const after = await service.mcpServers({})
  expect(after.revision).not.toBe(before.revision)
  expect(after.servers[0].revision).not.toBe(server.revision)
  await expect(
    service.patchMcpServer({ id: server.id, expectedRevision: server.revision, enabled: false })
  ).rejects.toMatchObject({ status: 409 })
})

it('switches transports with fresh destination details and removes incompatible secrets', async () => {
  const server = await service.createMcpServer(input)
  expect(server.host).toBe('example.test')
  const process = await service.patchMcpServer({
    id: server.id,
    expectedRevision: server.revision,
    transport: 'stdio',
    replace: { command: 'fixture-command', args: ['private-argument'] },
    env: { set: { TOKEN: 'private-env', EMPTY: '' } },
  })
  expect(process.host).toBeNull()
  expect(process.hasUrl).toBe(false)
  expect(process.headerKeys).toEqual([])
  expect(mcp.listMcpServers()[0]).toMatchObject({
    transport: 'stdio',
    command: 'fixture-command',
    args: ['private-argument'],
    env: { TOKEN: 'private-env' },
  })
  expect(mcp.listMcpServers()[0].url).toBeUndefined()
  expect(mcp.listMcpServers()[0].headers).toBeUndefined()
  const http = await service.patchMcpServer({
    id: server.id,
    expectedRevision: process.revision,
    transport: 'http',
    replace: { url: 'https://user:private-password@next.test:8443/private-path?private-query=1' },
    headers: { set: { Authorization: 'private-header' } },
  })
  expect(http.host).toBe('next.test:8443')
  expect(http.hasCommand).toBe(false)
  expect(http.hasArgs).toBe(false)
  expect(http.envKeys).toEqual([])
  expect(mcp.listMcpServers()[0].headers).toEqual({ Authorization: 'private-header' })
  for (const key of ['command', 'args', 'env'] as const) expect(mcp.listMcpServers()[0][key]).toBeUndefined()
  expect(JSON.stringify([process, http])).not.toMatch(/private-|fixture-command|https:/)
})

it.each(['http', 'stdio'] as const)('requires an explicit destination for a switch from %s', async (transport) => {
  const server = await service.createMcpServer({
    ...input,
    transport,
    command: 'obsolete-command',
    args: ['obsolete'],
    env: { TOKEN: 'obsolete' },
  })
  const before = mcp.listMcpServers()[0]
  const destination = transport === 'http' ? 'stdio' : 'http'
  for (const replace of [undefined, destination === 'http' ? { url: '' } : { command: '' }]) {
    await expect(
      service.patchMcpServer({
        id: server.id,
        expectedRevision: server.revision,
        transport: destination,
        replace,
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' })
    expect(mcp.listMcpServers()[0]).toEqual(before)
    expect((await service.mcpServer({ id: server.id })).revision).toBe(server.revision)
  }
})

it('preserves omitted stdio details through empty edits and removes only explicitly chosen env keys', async () => {
  let server = await service.createMcpServer({
    name: 'Process',
    transport: 'stdio',
    enabled: true,
    command: 'fixture-command',
    args: ['fixture-argument'],
    env: { A: 'keep', B: 'remove' },
  })
  const before = mcp.listMcpServers()[0]
  for (const fields of [{}, { transport: 'stdio' as const, replace: { command: '' }, env: { set: { A: '' } } }]) {
    server = await service.patchMcpServer({ id: server.id, expectedRevision: server.revision, ...fields })
    expect(mcp.listMcpServers()[0]).toEqual(before)
  }
  await service.patchMcpServer({ id: server.id, expectedRevision: server.revision, env: { remove: ['B'] } })
  expect(mcp.listMcpServers()[0]).toMatchObject({ command: before.command, args: before.args, env: { A: 'keep' } })
})

it('does not persist a transport switch when secure storage rejects the write', async () => {
  const server = await service.createMcpServer(input)
  const before = mcp.listMcpServers()[0]
  const encrypted = store.getAppSetting('fixture.chat.mcpServer.' + server.id)
  state.write = false
  await expect(
    service.patchMcpServer({
      id: server.id,
      expectedRevision: server.revision,
      transport: 'stdio',
      replace: { command: 'fixture-command' },
    })
  ).rejects.toThrow()
  expect(mcp.listMcpServers()[0]).toEqual(before)
  expect(store.getAppSetting('fixture.chat.mcpServer.' + server.id)).toBe(encrypted)
  expect((await service.mcpServer({ id: server.id })).revision).toBe(server.revision)
})

it('initiates cleanup without hanging the test when close never settles', async () => {
  const server = await service.createMcpServer(input)
  const connection = {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
    close: vi.fn(() => new Promise<void>(() => {})),
  }
  vi.spyOn(mcp, 'connectMcpServer').mockResolvedValue(connection)
  expect(await service.testMcpServer({ id: server.id })).toEqual({ code: 'ok', toolCount: 0 })
  expect(connection.close).toHaveBeenCalledOnce()
})

it('shares concurrent diagnostics of one revision and bounds active connections across servers', async () => {
  const first = await service.createMcpServer(input)
  let finish!: () => void
  const pendingTools = new Promise<[]>((resolve) => {
    finish = () => resolve([])
  })
  const connection = { listTools: vi.fn(() => pendingTools), callTool: vi.fn(), close: vi.fn(async () => {}) }
  const connect = vi.spyOn(mcp, 'connectMcpServer').mockResolvedValue(connection)
  const calls = Array.from({ length: 12 }, () => service.testMcpServer({ id: first.id }))
  const other = []
  for (let index = 0; index < 4; index++)
    other.push(await service.createMcpServer({ ...input, name: 'Other ' + index }))
  const more = other.map((item) => service.testMcpServer({ id: item.id }))
  const settlements = Promise.allSettled([...calls, ...more])
  const opened = connect.mock.calls.length
  finish()
  const results = await settlements
  expect(opened).toBe(4)
  expect(results.slice(0, 12).every((result) => result.status === 'fulfilled')).toBe(true)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(connection.close).toHaveBeenCalledTimes(4)
})

it('keeps unrelated server revisions and encrypted details unchanged when a server is added', async () => {
  const first = await service.createMcpServer(input)
  const stored = store.getAppSetting('fixture.chat.mcpServer.' + first.id)
  const writes = vi.spyOn(store, 'setAppSetting')
  await service.createMcpServer({ ...input, name: 'Another server' })
  expect((await service.mcpServer({ id: first.id })).revision).toBe(first.revision)
  expect(store.getAppSetting('fixture.chat.mcpServer.' + first.id)).toBe(stored)
  expect(writes.mock.calls.some(([key]) => key === 'fixture.chat.mcpServer.' + first.id)).toBe(false)
  await expect(
    service.patchMcpServer({ id: first.id, expectedRevision: first.revision, enabled: false })
  ).resolves.toMatchObject({ enabled: false })
})
