import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real manager, recycle scheduler and bot runtimes; only the app-server handshake, the runtime a new connection
// selects and the update events are stubbed.
const mocks = vi.hoisted(() => ({
  listeners: new Set<(id: 'codex-runtime' | 'claude-code-runtime') => void>(),
  selectedCodex: '',
}))

vi.mock('../../src/main/runtime-assets/app-service', () => ({
  onRuntimeUpdateChanged: (listener: (id: 'codex-runtime' | 'claude-code-runtime') => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  },
  acquireRuntimeAssetLease: async () => null,
  readyRuntimeAsset: async () => {
    throw new Error('not used by bots')
  },
}))
vi.mock('../../src/main/chat/codex-subscription/bot-runtime', () => ({
  isManagedCodexPath: () => false,
  resolveBotCodexRuntime: async () => ({
    executablePath: mocks.selectedCodex,
    source: 'managed',
    version: path.basename(path.dirname(path.dirname(mocks.selectedCodex))),
    target: {
      platform: process.platform,
      arch: process.arch,
      targetTriple: 'fixture-target',
      optionalPackage: '@openai/codex-fixture',
      executableName: 'codex',
    },
  }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/runtime-selection', () => ({
  botClaudeRuntime: () => ({ refresh: async () => false }),
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  notifyClaudeRuntimeChanged: () => {},
}))

import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { app } from 'electron'
import {
  CodexAppServerClient,
  CodexSubscriptionManager,
  getCodexSubscriptionManager,
  listCodexSubscriptionManagers,
  type CodexAppServerConnectOptions,
} from '../../src/main/chat/codex-subscription'
import { RUNTIME_RECYCLE_INTERVAL_MS } from '../../src/main/fleet/instance/runtime-recycle'
import { startBotRuntimes } from '../../src/main/runtime-assets/bot-runtimes'

const OLD_CODEX = '/managed/codex-runtime/versions/0.159.0/bin/codex'
const NEW_CODEX = '/managed/codex-runtime/versions/0.160.0/bin/codex'

const idle = { turn: { state: 'idle' }, queue: [], pending: [], compaction: null } as unknown as FleetInstanceStatus
const working = { ...idle, turn: { state: 'running' } } as unknown as FleetInstanceStatus

interface FakeClient {
  state: 'ready' | 'closed'
  failure: null
  stderr: string
  onNotification: () => () => void
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  close: () => Promise<void>
}

function fakeClient(): FakeClient {
  let exit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    exit = resolve
  })
  const client: FakeClient = {
    state: 'ready',
    failure: null,
    stderr: '',
    onNotification: () => () => {},
    waitForExit: () => exited,
    close: vi.fn(async () => {
      client.state = 'closed'
      exit({ code: 0, signal: null })
    }),
  }
  return client
}

/** The first handshake waits for `release`; every connection's executable is recorded. */
function pausedHandshake() {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const clients: FakeClient[] = []
  const connect = vi
    .spyOn(CodexAppServerClient, 'connect')
    .mockImplementation(async (_options: CodexAppServerConnectOptions) => {
      if (connect.mock.calls.length === 1) await released
      const client = fakeClient()
      clients.push(client)
      return client as unknown as CodexAppServerClient
    })
  const executables = () => connect.mock.calls.map(([options]) => options.binaryPath)
  releases.push(release)
  return { release, clients, connect, executables }
}

/** Released after each test, so a failed test does not leave dispose waiting on a handshake. */
const releases: (() => void)[] = []

function emit(id: 'codex-runtime' | 'claude-code-runtime') {
  for (const listener of mocks.listeners) listener(id)
}

let userDataPath: string
let stop: () => void = () => {}

beforeEach(async () => {
  userDataPath = await mkdtemp(path.join(tmpdir(), 'maestrly-bot-runtimes-codex-'))
  vi.spyOn(app, 'getPath').mockReturnValue(userDataPath)
  vi.stubEnv('MAESTRLY_BOT_MODE', '1')
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  mocks.listeners.clear()
  mocks.selectedCodex = OLD_CODEX
})

afterEach(async () => {
  stop()
  vi.useRealTimers()
  for (const release of releases.splice(0)) release()
  await Promise.all(listCodexSubscriptionManagers().map((manager) => manager.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(userDataPath, { recursive: true, force: true })
})

describe('startBotRuntimes with a Codex connection being established', () => {
  it('moves a connection whose handshake started on the old runtime once the bot is idle', async () => {
    const handshake = pausedHandshake()
    let busy = true
    const botStatuses = vi.fn(async () => [busy ? working : idle])
    stop = startBotRuntimes({ botStatuses })
    const manager = getCodexSubscriptionManager('connectingbusy')

    // A turn opens the connection: the old executable is selected, then the handshake takes a while.
    const turn = manager.getClient()
    await vi.waitFor(() => expect(handshake.connect).toHaveBeenCalledTimes(1))
    expect(handshake.executables()).toEqual([OLD_CODEX])
    expect(manager.connecting).toBe(true)
    expect(manager.connectedRuntimePath).toBeNull()

    // The update activates now; no other update event follows the handshake.
    mocks.selectedCodex = NEW_CODEX
    emit('codex-runtime')
    await vi.waitFor(() => expect(botStatuses).toHaveBeenCalled())
    handshake.release()
    const old = await turn
    expect(manager.connectedRuntimePath).toBe(OLD_CODEX)

    // The turn still runs: its connection stays.
    await vi.advanceTimersByTimeAsync(RUNTIME_RECYCLE_INTERVAL_MS)
    expect(old.state).toBe('ready')

    busy = false
    await vi.advanceTimersByTimeAsync(RUNTIME_RECYCLE_INTERVAL_MS)
    await vi.waitFor(() => expect(old.state).toBe('closed'))
    expect(manager.connectedRuntimePath).toBeNull()

    await manager.getClient()
    expect(handshake.executables()).toEqual([OLD_CODEX, NEW_CODEX])
    expect(manager.connectedRuntimePath).toBe(NEW_CODEX)
  })

  it('keeps the recycle pending when the bots are idle while the handshake still runs', async () => {
    const handshake = pausedHandshake()
    const connecting = vi.spyOn(CodexSubscriptionManager.prototype, 'connecting', 'get')
    const onRuntimesChanged = vi.fn()
    stop = startBotRuntimes({ botStatuses: async () => [idle], onRuntimesChanged })
    const manager = getCodexSubscriptionManager('connectingidle')

    const turn = manager.getClient()
    await vi.waitFor(() => expect(handshake.connect).toHaveBeenCalledTimes(1))
    mocks.selectedCodex = NEW_CODEX
    emit('codex-runtime')
    onRuntimesChanged.mockClear()
    // Read once to request the recycle, once by the recycle that runs at once and finds it still connecting.
    const reads = () => connecting.mock.contexts.filter((context) => context === manager).length
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(onRuntimesChanged).not.toHaveBeenCalled()

    handshake.release()
    const old = await turn
    expect(manager.connectedRuntimePath).toBe(OLD_CODEX)

    await vi.advanceTimersByTimeAsync(RUNTIME_RECYCLE_INTERVAL_MS)
    await vi.waitFor(() => expect(old.state).toBe('closed'))
    expect(onRuntimesChanged).toHaveBeenCalledTimes(1)

    await manager.getClient()
    expect(handshake.executables()).toEqual([OLD_CODEX, NEW_CODEX])
  })
})
