import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import type { RunnerHost } from '../../src/main/fleet/client/runner-host'
import { registerRunnerIpc } from '../../src/main/fleet/client/runner-ipc'
import { fleetIpcRegistrar } from '../../src/main/fleet/client/scoped-ipc'
import type { FleetClientService } from '../../src/main/fleet/client/service'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const JOB = 'job_RunnerCoreTest0001'

function fakeHost(available = true) {
  const port = { wants: vi.fn(), connected: vi.fn(), disconnected: vi.fn(), handle: vi.fn(), unpaired: vi.fn() }
  return {
    available,
    forClient: vi.fn(() => port),
    port,
    config: vi.fn(() => ({ enabled: false, storageDir: '/data/runner' })),
    updateConfig: vi.fn(async (patch: unknown) => ({ patch })),
    status: vi.fn(async (options: unknown) => ({ options })),
    clearCaches: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => undefined),
    jobLog: vi.fn(async (_serverId: string, _jobId: string, offset: number | null) => ({ local: offset })),
    cancelBotJob: vi.fn(async (_client: unknown, botId: string, jobId: string) => ({ cancelled: jobId, botId })),
    botJobLog: vi.fn(async (_client: unknown, botId: string, jobId: string, offset: number | null) => ({
      remote: [botId, jobId, offset],
    })),
    access: vi.fn(async (_client: unknown, botId: string) => ({ view: botId })),
    link: vi.fn(async (_client: unknown, botId: string, name: unknown) => ({ linked: botId, name })),
    unlink: vi.fn(async (_client: unknown, botId: string) => ({ unlinked: botId })),
    removeOther: vi.fn(async (_client: unknown, botId: string, runnerId: unknown) => ({ removed: runnerId, botId })),
  }
}

function setup(host = fakeHost()) {
  const handlers = new Map<string, { fn: (...args: unknown[]) => unknown; mutation: boolean }>()
  const register = (mutation: boolean) => (channel: string, fn: (...args: unknown[]) => unknown) =>
    handlers.set(channel, { fn, mutation })
  const reg = { handle: register(false), mhandle: register(true), on: vi.fn(), mon: vi.fn() } as unknown as IpcRegistrar
  const client = { serverId: SERVER, runnerHost: null } as unknown as FleetClientService
  const other = { serverId: OTHER, runnerHost: null } as unknown as FleetClientService
  const scoped = fleetIpcRegistrar(reg, (serverId) => {
    if (serverId === SERVER) return client
    if (serverId === OTHER) return other
    throw new Error('FLEET_SERVER_UNKNOWN')
  })
  const setups: Array<(client: FleetClientService) => void> = []
  const chooseFolder = vi.fn(async (_event: unknown, _default: string | null) => '/picked')
  registerRunnerIpc(
    reg,
    scoped,
    {
      setupClients: (setup) => {
        setups.push(setup)
        setup(client)
      },
    },
    host as unknown as RunnerHost,
    { chooseFolder }
  )
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler.fn({}, ...args)
  }
  return { host, handlers, call, client, other, setups, chooseFolder }
}

describe('runner IPC', () => {
  it('gives each server’s client the runner before it starts, and not where there is no runner', () => {
    const { host, client, other, setups } = setup()
    // A server paired later gets it too.
    for (const setup of setups) setup(other)
    expect(host.forClient).toHaveBeenCalledTimes(2)
    expect(client.runnerHost).toBe(host.port)
    expect(other.runnerHost).toBe(host.port)

    const bot = setup(fakeHost(false))
    expect(bot.host.forClient).not.toHaveBeenCalled()
    expect(bot.client.runnerHost).toBeNull()
  })

  it('reads and changes the settings, validating in the host', async () => {
    const { call, host, handlers } = setup()
    expect(call('runner:settings:get')).toEqual({ enabled: false, storageDir: '/data/runner' })
    await expect(call('runner:settings:set', { slots: 2 })).resolves.toEqual({ patch: { slots: 2 } })
    expect(host.updateConfig).toHaveBeenCalledExactlyOnceWith({ slots: 2 })
    // Changes go through the guarded registrar.
    expect(handlers.get('runner:settings:set')?.mutation).toBe(true)
    expect(handlers.get('runner:settings:get')?.mutation).toBe(false)
  })

  it('answers the status, asking Docker again only when the screen says so', async () => {
    const { call, host } = setup()
    await call('runner:status')
    await call('runner:status', { recheckDocker: true })
    await call('runner:status', { recheckDocker: 'yes' })
    expect(host.status.mock.calls).toEqual([
      [{ recheckDocker: false }],
      [{ recheckDocker: true }],
      [{ recheckDocker: false }],
    ])
  })

  it('clears the caches of every bot, or of the one named, and refuses anything else', async () => {
    const { call, host, handlers } = setup()
    await call('runner:clearCaches')
    await call('runner:clearCaches', null)
    await call('runner:clearCaches', { serverId: SERVER, botId: 'scout' })
    expect(host.clearCaches.mock.calls).toEqual([[undefined], [undefined], [{ serverId: SERVER, botId: 'scout' }]])
    expect(() => call('runner:clearCaches', { serverId: SERVER })).toThrow()
    expect(() => call('runner:clearCaches', { serverId: SERVER, botId: 'scout', extra: 1 })).toThrow()
    expect(() => call('runner:clearCaches', '../..')).toThrow()
    expect(handlers.get('runner:clearCaches')?.mutation).toBe(true)
  })

  it('cancels a job by its server and id', async () => {
    const { call, host } = setup()
    await call('runner:cancelJob', { serverId: SERVER, jobId: JOB })
    expect(host.cancelJob).toHaveBeenCalledExactlyOnceWith(SERVER, JOB)
    expect(() => call('runner:cancelJob', { serverId: SERVER })).toThrow()
    expect(() => call('runner:cancelJob', JOB)).toThrow()
  })

  it('reads a log of this computer from the offset or the end, and refuses what is not a job or an offset', async () => {
    const { call, host, handlers } = setup()
    await expect(call('runner:jobLog', { serverId: SERVER, jobId: JOB, offset: null })).resolves.toEqual({
      local: null,
    })
    await call('runner:jobLog', { serverId: SERVER, jobId: JOB, offset: 1_024 })
    expect(host.jobLog.mock.calls).toEqual([
      [SERVER, JOB, null],
      [SERVER, JOB, 1_024],
    ])
    for (const input of [
      { serverId: SERVER, jobId: JOB },
      { serverId: SERVER, jobId: JOB, offset: -1 },
      { serverId: SERVER, jobId: JOB, offset: 1.5 },
      { serverId: SERVER, jobId: JOB, offset: Number.MAX_SAFE_INTEGER + 2 },
      { serverId: SERVER, jobId: JOB, offset: '5' },
      { serverId: SERVER, jobId: '../../etc/passwd', offset: null },
      { serverId: SERVER, jobId: JOB, offset: null, extra: 1 },
      JOB,
    ])
      expect(() => call('runner:jobLog', input)).toThrow()
    expect(host.jobLog).toHaveBeenCalledTimes(2)
    // Reading changes nothing.
    expect(handlers.get('runner:jobLog')?.mutation).toBe(false)
  })

  it('asks for the storage folder over the folder now chosen', async () => {
    const { call, chooseFolder } = setup()
    await expect(call('runner:chooseStorageDir')).resolves.toBe('/picked')
    expect(chooseFolder).toHaveBeenCalledWith(expect.anything(), '/data/runner')
  })

  it('reaches the server a call names and validates the bot, the name and the runner', async () => {
    const { call, host, client, other } = setup()
    await expect(call('fleet:runnerAccess:get', SERVER, 'scout')).resolves.toEqual({ view: 'scout' })
    expect(host.access).toHaveBeenCalledWith(client, 'scout')
    await call('fleet:runnerAccess:link', OTHER, 'scout', 'Studio')
    expect(host.link).toHaveBeenCalledWith(other, 'scout', 'Studio')
    await call('fleet:runnerAccess:unlink', SERVER, 'scout')
    expect(host.unlink).toHaveBeenCalledWith(client, 'scout')
    await call('fleet:runnerAccess:removeOther', SERVER, 'scout', 'rnr_BBBBBBBBBBBBBBBB0002')
    expect(host.removeOther).toHaveBeenCalledWith(client, 'scout', 'rnr_BBBBBBBBBBBBBBBB0002')
    expect(() => call('fleet:runnerAccess:get', 'cccccccc-0000-4000-8000-000000000003', 'scout')).toThrow(
      'FLEET_SERVER_UNKNOWN'
    )
    expect(() => call('fleet:runnerAccess:get', SERVER, '')).toThrow()
    expect(() => call('fleet:runnerAccess:unlink', SERVER, { id: 'scout' })).toThrow()
  })

  it('cancels and reads the jobs of a bot on the server a call names, validating the bot, the job and the offset', async () => {
    const { call, host, client, other } = setup()
    await expect(call('fleet:runnerAccess:cancelJob', SERVER, 'scout', JOB)).resolves.toEqual({
      cancelled: JOB,
      botId: 'scout',
    })
    expect(host.cancelBotJob).toHaveBeenCalledExactlyOnceWith(client, 'scout', JOB)
    await expect(call('fleet:runnerAccess:jobLog', OTHER, 'scout', JOB, null)).resolves.toEqual({
      remote: ['scout', JOB, null],
    })
    await call('fleet:runnerAccess:jobLog', SERVER, 'scout', JOB, 2_048)
    expect(host.botJobLog.mock.calls).toEqual([
      [other, 'scout', JOB, null],
      [client, 'scout', JOB, 2_048],
    ])
    expect(() => call('fleet:runnerAccess:cancelJob', SERVER, '', JOB)).toThrow()
    expect(() => call('fleet:runnerAccess:cancelJob', SERVER, 'scout', 'job_short')).toThrow()
    expect(() => call('fleet:runnerAccess:cancelJob', SERVER, 'scout', { jobId: JOB })).toThrow()
    expect(() => call('fleet:runnerAccess:cancelJob', 'cccccccc-0000-4000-8000-000000000003', 'scout', JOB)).toThrow(
      'FLEET_SERVER_UNKNOWN'
    )
    expect(() => call('fleet:runnerAccess:jobLog', SERVER, 'scout', 'nope', null)).toThrow()
    expect(() => call('fleet:runnerAccess:jobLog', SERVER, 'scout', JOB, -1)).toThrow()
    expect(() => call('fleet:runnerAccess:jobLog', SERVER, 'scout', JOB, 1.5)).toThrow()
    expect(() => call('fleet:runnerAccess:jobLog', SERVER, 'scout', JOB)).toThrow()
    expect(host.cancelBotJob).toHaveBeenCalledTimes(1)
    expect(host.botJobLog).toHaveBeenCalledTimes(2)
  })

  it('treats the changes of a bot’s runners as mutations', () => {
    const { handlers } = setup()
    for (const channel of ['link', 'unlink', 'removeOther', 'cancelJob'])
      expect(handlers.get(`fleet:runnerAccess:${channel}`)?.mutation).toBe(true)
    expect(handlers.get('fleet:runnerAccess:get')?.mutation).toBe(false)
    expect(handlers.get('fleet:runnerAccess:jobLog')?.mutation).toBe(false)
  })
})
