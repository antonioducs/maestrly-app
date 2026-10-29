import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
  docker: vi.fn(),
  holdAwake: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({
  getAppFlag: (key: string, fallback: boolean) => (state.values.has(key) ? state.values.get(key) === '1' : fallback),
  setAppFlag: (key: string, value: boolean) => void state.values.set(key, value ? '1' : '0'),
  getAppSetting: (key: string) => state.values.get(key) ?? null,
  setAppSetting: (key: string, value: string) => void state.values.set(key, value),
}))
vi.mock('../../src/main/power-manager', () => ({ holdAwake: state.holdAwake }))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: (channel: string, payload?: unknown) => state.broadcasts.push({ channel, payload }),
}))
vi.mock('../../src/main/fleet/installer/runner', () => ({ LocalRunner: class {} }))
vi.mock('../../src/main/fleet/installer/docker-host', () => ({
  DockerHost: class {
    status = state.docker
  },
}))

import { createAppRunnerHost } from '../../src/main/fleet/client/runner-app'
import { RUNNER_SETTING_KEYS } from '../../src/main/fleet/client/runner-settings'
import type { RunnerHostClient } from '../../src/main/fleet/client/runner-host'
import { FLEET_RUNNERS_FEATURE } from '@maestrly/bot-fleet-protocol'

beforeEach(() => {
  state.values.clear()
  state.broadcasts.length = 0
  state.docker.mockReset()
  delete process.env.MAESTRLY_BOT_MODE
})
afterEach(() => {
  delete process.env.MAESTRLY_BOT_MODE
  vi.useRealTimers()
})

describe('the runner of the app', () => {
  it('exists in the app and not in a bot container', () => {
    expect(createAppRunnerHost().available).toBe(true)
    process.env.MAESTRLY_BOT_MODE = '1'
    const bot = createAppRunnerHost()
    expect(bot.available).toBe(false)
    expect(bot.enabled()).toBe(false)
  })

  it('keeps its settings in the app database and announces a change to the windows', async () => {
    const host = createAppRunnerHost({ platform: 'linux' })
    expect(host.config()).toMatchObject({ enabled: false, executor: 'native', slots: 1 })
    await host.updateConfig({ slots: 3 })
    expect(state.values.get(RUNNER_SETTING_KEYS.slots)).toBe('3')
    expect(host.config().slots).toBe(3)
    expect(state.broadcasts).toEqual([{ channel: 'runner:changed', payload: undefined }])
  })

  it('tells the windows which bot’s runners changed', () => {
    const host = createAppRunnerHost()
    const client = {
      serverId: 'aaaaaaaa-0000-4000-8000-000000000001',
      hasFeature: (feature: string) => feature === FLEET_RUNNERS_FEATURE,
    } as unknown as RunnerHostClient
    host
      .forClient(client)
      .handle({ type: 'runner_link.updated', at: '2026-10-29T10:00:00.000Z', botId: 'scout', links: [] })
    expect(state.broadcasts).toEqual([
      { channel: 'fleet:runner-access', payload: { serverId: client.serverId, botId: 'scout' } },
    ])
  })

  it('asks Docker as the installer does, counting a missing Compose as ready, since jobs need only the engine', async () => {
    state.values.set(RUNNER_SETTING_KEYS.executor, 'container')
    const host = createAppRunnerHost({ platform: 'linux' })
    state.docker.mockResolvedValueOnce({
      state: 'no-compose',
      engine: 'Docker Desktop',
      version: '27.0.0',
      memoryBytes: 1,
    })
    expect((await host.status({ recheckDocker: true })).docker).toEqual({
      state: 'ready',
      engine: 'Docker Desktop',
      version: '27.0.0',
    })
    state.docker.mockResolvedValueOnce({ state: 'missing', engine: null, version: null, memoryBytes: null })
    expect((await host.status({ recheckDocker: true })).docker).toEqual({
      state: 'missing',
      engine: null,
      version: null,
    })
    // Native never asks.
    state.docker.mockClear()
    await host.updateConfig({ executor: 'native' })
    expect((await host.status()).docker).toBeNull()
    expect(state.docker).not.toHaveBeenCalled()
  })

  it('counts a Docker that does not answer as not running', async () => {
    vi.useFakeTimers()
    state.values.set(RUNNER_SETTING_KEYS.executor, 'container')
    const host = createAppRunnerHost({ platform: 'linux' })
    state.docker.mockReturnValue(new Promise(() => undefined))
    const asking = host.status({ recheckDocker: true })
    await vi.advanceTimersByTimeAsync(16_000)
    expect((await asking).docker).toEqual({ state: 'stopped', engine: null, version: null })
  })
})
