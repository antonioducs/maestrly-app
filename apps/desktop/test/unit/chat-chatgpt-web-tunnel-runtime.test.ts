import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  get: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: h.spawn }
})
vi.mock('node:http', () => ({ default: { get: h.get }, get: h.get }))

import { createTunnelRuntime } from '../../src/main/chat/chatgpt-web/tunnel-runtime'

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly kill = vi.fn()

  constructor(readonly pid: number) {
    super()
  }
}

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

describe('ChatGPT Web tunnel runtime ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.spawn.mockReset()
    h.get.mockReset()
    let pid = 1000
    h.spawn.mockImplementation((_binary: string, args: string[]) => {
      const urlFile = args[args.indexOf('--health.url-file') + 1]
      writeFileSync(urlFile, 'http://127.0.0.1:1')
      return new FakeChild(pid++)
    })
    h.get.mockImplementation((_url: string, _options: unknown, callback: (response: EventEmitter) => void) => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number
        setEncoding: () => void
      }
      response.statusCode = 200
      response.setEncoding = () => undefined
      callback(response)
      response.emit('data', 'ready')
      response.emit('end')
      const request = new EventEmitter() as EventEmitter & { destroy: () => void }
      request.destroy = () => undefined
      return request
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the lease through transient backoff/restart and releases it once on explicit stop', async () => {
    const onStopped = vi.fn()
    const runtime = createTunnelRuntime({
      tunnelId: 'tunnel-test',
      apiKey: 'key-test',
      mcpServerUrl: 'http://127.0.0.1:3000',
      binaryPath: '/tmp/tunnel-client',
      onStopped,
    })

    await runtime.start()
    const first = h.spawn.mock.results[0].value as FakeChild
    first.emit('exit', 1, null)

    expect(runtime.isRunning()).toBe(true)
    expect(onStopped).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()

    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(runtime.getState()).toBe('ready')
    expect(onStopped).not.toHaveBeenCalled()

    const restarted = h.spawn.mock.results[1].value as FakeChild
    restarted.exitCode = 0
    await runtime.stop()
    await runtime.stop()
    expect(onStopped).toHaveBeenCalledTimes(1)
  })

  it('releases terminal ownership after restart exhaustion and does not leak into a subsequent start', async () => {
    const firstStopped = vi.fn()
    const first = createTunnelRuntime({
      tunnelId: 'tunnel-test',
      apiKey: 'key-test',
      mcpServerUrl: 'http://127.0.0.1:3000',
      binaryPath: '/tmp/tunnel-client',
      onStopped: firstStopped,
    })
    await first.start()

    for (let restart = 0; restart <= 5; restart++) {
      const child = h.spawn.mock.results[restart].value as FakeChild
      child.emit('exit', 1, null)
      if (restart < 5) {
        expect(first.isRunning()).toBe(true)
        await vi.advanceTimersByTimeAsync(1000 * 2 ** restart)
        await flushPromises()
        expect(first.getState()).toBe('ready')
      }
    }

    expect(first.getState()).toBe('error')
    expect(first.isRunning()).toBe(false)
    expect(firstStopped).toHaveBeenCalledTimes(1)

    await first.stop()
    expect(firstStopped).toHaveBeenCalledTimes(1)

    const secondStopped = vi.fn()
    const second = createTunnelRuntime({
      tunnelId: 'tunnel-test',
      apiKey: 'key-test',
      mcpServerUrl: 'http://127.0.0.1:3000',
      binaryPath: '/tmp/tunnel-client',
      onStopped: secondStopped,
    })
    await second.start()
    expect(firstStopped).toHaveBeenCalledTimes(1)
    expect(secondStopped).not.toHaveBeenCalled()

    const secondChild = h.spawn.mock.results[6].value as FakeChild
    secondChild.exitCode = 0
    await second.stop()
    expect(secondStopped).toHaveBeenCalledTimes(1)
  })
})
