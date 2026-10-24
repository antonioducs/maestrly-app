import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpPipe, CdpPipeClosedError } from '../../src/main/fleet/instance/bot-browser/cdp-pipe'
import {
  BOT_CHROMIUM_ARGS,
  CHROMIUM_CLOSE_WAIT_MS,
  CHROMIUM_EXIT_WAIT_MS,
  CHROMIUM_RESTART_BUDGET,
  CHROMIUM_RESTART_DELAY_MS,
  CHROMIUM_START_TIMEOUT_MS,
  ChromiumSupervisor,
  type ChromiumProcess,
} from '../../src/main/fleet/instance/bot-browser/chromium-supervisor'

/** Both ends of a DevTools pipe: what the client writes, and a way to answer as the browser. */
function pipeEnds() {
  const commands = new PassThrough()
  const messages = new PassThrough()
  const written: Array<{ id: number; method: string; params: unknown; sessionId?: string }> = []
  let pending = ''
  commands.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let end: number
    while ((end = pending.indexOf('\0')) >= 0) {
      written.push(JSON.parse(pending.slice(0, end)))
      pending = pending.slice(end + 1)
    }
  })
  const reply = (message: unknown) => messages.write(`${JSON.stringify(message)}\0`)
  return { commands, messages, written, reply }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CdpPipe', () => {
  it('frames commands with NUL bytes and matches answers split across chunks', async () => {
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages)
    const version = pipe.send('Browser.getVersion')
    const title = pipe.send('Runtime.evaluate', { expression: 'document.title' }, 'session-1')
    await vi.waitFor(() => expect(ends.written).toHaveLength(2))
    expect(ends.written[1]).toEqual({
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' },
      sessionId: 'session-1',
    })
    const both = `${JSON.stringify({ id: 2, result: { value: 't' } })}\0${JSON.stringify({ id: 1, result: { product: 'Chrome' } })}\0`
    ends.messages.write(both.slice(0, 7))
    ends.messages.write(both.slice(7))
    await expect(title).resolves.toEqual({ value: 't' })
    await expect(version).resolves.toEqual({ product: 'Chrome' })
  })

  it('rejects a protocol error with its message and routes events with their session', async () => {
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages)
    const events: unknown[] = []
    pipe.onEvent((event) => events.push(event))
    const failing = pipe.send('Page.navigate', { url: 'x' })
    await vi.waitFor(() => expect(ends.written).toHaveLength(1))
    ends.reply({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } })
    ends.reply({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's' })
    ends.reply({ method: 'Target.targetCreated', params: {} })
    await expect(failing).rejects.toThrow('Cannot navigate to invalid URL')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events).toEqual([
      { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's' },
      { method: 'Target.targetCreated', params: {} },
    ])
  })

  it('fails a command that gets no answer by its deadline', async () => {
    vi.useFakeTimers()
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages, { commandTimeoutMs: 1_000 })
    const silent = pipe.send('Runtime.evaluate')
    const outcome = expect(silent).rejects.toThrow('got no answer')
    await vi.advanceTimersByTimeAsync(1_000)
    await outcome
  })

  it('fails pending and later commands once the browser closes its end', async () => {
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages)
    const closed = vi.fn()
    pipe.onClose(closed)
    const pending = pipe.send('Page.navigate')
    ends.messages.end()
    await expect(pending).rejects.toBeInstanceOf(CdpPipeClosedError)
    await expect(pipe.send('Browser.getVersion')).rejects.toBeInstanceOf(CdpPipeClosedError)
    expect(pipe.closed).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('closes with a last command, reading nothing the browser sends afterwards', async () => {
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages)
    const events = vi.fn()
    pipe.onEvent(events)
    const pending = pipe.send('Page.navigate')
    pipe.closeWith('Browser.close', 'it was stopped')
    await expect(pending).rejects.toThrow('it was stopped')
    await vi.waitFor(() =>
      expect(ends.written.map((message) => message.method)).toEqual(['Page.navigate', 'Browser.close'])
    )
    ends.reply({ method: 'Target.targetDestroyed', params: { targetId: 't1' } })
    ends.reply({ id: 2, result: {} })
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).not.toHaveBeenCalled()
    pipe.closeWith('Browser.close', 'again')
    await new Promise((resolve) => setImmediate(resolve))
    expect(ends.written).toHaveLength(2)
  })

  it('ends the connection when a message goes over its size limit', async () => {
    const ends = pipeEnds()
    const pipe = new CdpPipe(ends.commands, ends.messages, { maxMessageBytes: 64 })
    const pending = pipe.send('Page.captureScreenshot')
    ends.messages.write('x'.repeat(100))
    await expect(pending).rejects.toThrow('over 64 bytes')
  })
})

/** A browser process that answers its commands, closes on `Browser.close` and exits when told to. */
function fakeProcess(options: { answers?: boolean; ignoresClose?: boolean; ignoresTerm?: boolean } = {}) {
  const ends = pipeEnds()
  let exit!: (code: number | null) => void
  const exited = new Promise<number | null>((resolve) => (exit = resolve))
  const signals: string[] = []
  const commands: string[] = []
  const process: ChromiumProcess = {
    pid: 4242,
    commands: ends.commands,
    messages: ends.messages,
    exited,
    kill: (signal) => {
      signals.push(signal)
      if (signal === 'SIGKILL' || !options.ignoresTerm) {
        ends.messages.end()
        exit(null)
      }
    },
    stderrTail: () => 'chromium: some error',
  }
  if (options.answers !== false) {
    ends.commands.on('data', () => {
      for (const message of ends.written.splice(0)) {
        commands.push(message.method)
        if (message.method === 'Browser.close' && !options.ignoresClose) {
          // Chromium closes its tabs on the way out: these must not reach a stopping supervisor's listeners.
          ends.reply({ method: 'Target.targetDestroyed', params: { targetId: 'tab-1' } })
          ends.messages.end()
          exit(0)
          continue
        }
        ends.reply({ id: message.id, result: {} })
      }
    })
  }
  return {
    process,
    signals,
    commands,
    crash: (code: number | null = 139) => {
      ends.messages.end()
      exit(code)
    },
  }
}

function supervisor(
  processes: Array<ReturnType<typeof fakeProcess>>,
  onStarted = vi.fn(async () => {}),
  startTimeoutMs?: number
) {
  const spawn = vi.fn(() => {
    const next = processes.shift()
    if (!next) throw new Error('no more processes')
    return next.process
  })
  const onExited = vi.fn()
  const log = vi.fn()
  let now = 0
  const instance = new ChromiumSupervisor(
    { spawn, now: () => now, setTimeout, clearTimeout, log },
    { botId: 'bot-1', env: () => ({ DISPLAY: ':3' }), onStarted, onExited, ...(startTimeoutMs ? { startTimeoutMs } : {}) }
  )
  return { instance, spawn, onExited, log, advance: (ms: number) => (now += ms) }
}

describe('ChromiumSupervisor', () => {
  it('starts once for concurrent callers, with the pipe flags, and is running only once prepared', async () => {
    const one = fakeProcess()
    let prepared!: () => void
    const onStarted = vi.fn(() => new Promise<void>((resolve) => (prepared = resolve)))
    const { instance, spawn } = supervisor([one], onStarted)
    const first = instance.ensure()
    const second = instance.ensure()
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalled())
    expect(instance.isRunning).toBe(false)
    // A caller arriving while the tabs are restored waits for them too.
    const third = instance.ensure()
    prepared()
    const pipes = await Promise.all([first, second, third])
    expect(new Set(pipes).size).toBe(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith([...BOT_CHROMIUM_ARGS], { DISPLAY: ':3' })
    expect(BOT_CHROMIUM_ARGS).toContain('--remote-debugging-pipe')
    expect(BOT_CHROMIUM_ARGS).toContain('--disable-blink-features=AutomationControlled')
    expect(BOT_CHROMIUM_ARGS.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false)
    expect(instance.isRunning).toBe(true)
  })

  it('restarts a crashed browser after a moment, within its budget', async () => {
    vi.useFakeTimers()
    const processes = Array.from({ length: CHROMIUM_RESTART_BUDGET + 2 }, () => fakeProcess())
    const crashes = [...processes]
    const { instance, spawn, onExited } = supervisor(processes)
    await instance.ensure()
    for (let crash = 0; crash < CHROMIUM_RESTART_BUDGET; crash++) {
      crashes[crash].crash()
      await vi.advanceTimersByTimeAsync(CHROMIUM_RESTART_DELAY_MS)
      expect(spawn).toHaveBeenCalledTimes(crash + 2)
    }
    expect(onExited).toHaveBeenLastCalledWith({ code: 139, restarting: true })
    // One more crash within the minute: it stays stopped until it is needed again.
    crashes[CHROMIUM_RESTART_BUDGET].crash()
    await vi.advanceTimersByTimeAsync(CHROMIUM_RESTART_DELAY_MS * 5)
    expect(spawn).toHaveBeenCalledTimes(CHROMIUM_RESTART_BUDGET + 1)
    expect(onExited).toHaveBeenLastCalledWith({ code: 139, restarting: false })
    await instance.ensure()
    expect(spawn).toHaveBeenCalledTimes(CHROMIUM_RESTART_BUDGET + 2)
  })

  it('leaves a browser the person closed stopped until it is needed', async () => {
    vi.useFakeTimers()
    const one = fakeProcess()
    const { instance, spawn, onExited } = supervisor([one, fakeProcess()])
    await instance.ensure()
    one.crash(0)
    await vi.advanceTimersByTimeAsync(CHROMIUM_RESTART_DELAY_MS * 3)
    expect(onExited).toHaveBeenCalledWith({ code: 0, restarting: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(instance.isRunning).toBe(false)
  })

  it('stops by asking the browser to close, so it writes its cookies, without signalling it', async () => {
    const one = fakeProcess()
    const { instance, spawn, onExited } = supervisor([one])
    const pipe = await instance.ensure()
    const events = vi.fn()
    pipe.onEvent(events)
    await instance.stop()
    expect(one.commands.at(-1)).toBe('Browser.close')
    expect(one.signals).toEqual([])
    expect(events).not.toHaveBeenCalled()
    expect(onExited).toHaveBeenCalledWith({ code: 0, restarting: false })
    expect(instance.isRunning).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('ends a browser that does not close when asked with SIGTERM, then SIGKILL, and never restarts it', async () => {
    vi.useFakeTimers()
    const stubborn = fakeProcess({ ignoresClose: true, ignoresTerm: true })
    const { instance, spawn, onExited, log } = supervisor([stubborn])
    await instance.ensure()
    const stopped = instance.stop()
    await vi.advanceTimersByTimeAsync(CHROMIUM_CLOSE_WAIT_MS - 1)
    expect(stubborn.commands).toContain('Browser.close')
    expect(stubborn.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(stubborn.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(CHROMIUM_EXIT_WAIT_MS)
    await stopped
    expect(stubborn.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not close when asked'))
    expect(onExited).toHaveBeenCalledWith({ code: null, restarting: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CHROMIUM_RESTART_DELAY_MS * 3)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('kills a browser that does not answer and reports why it did not start', async () => {
    vi.useFakeTimers()
    const silent = fakeProcess({ answers: false })
    const { instance, log } = supervisor([silent])
    const start = instance.ensure()
    const outcome = expect(start).rejects.toThrow('got no answer')
    await vi.advanceTimersByTimeAsync(CHROMIUM_START_TIMEOUT_MS)
    await outcome
    expect(silent.signals).toContain('SIGTERM')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chromium: some error'))
  })

  it('gives a browser the start timeout it was configured with', async () => {
    vi.useFakeTimers()
    const silent = fakeProcess({ answers: false })
    const { instance } = supervisor([silent], undefined, CHROMIUM_START_TIMEOUT_MS * 3)
    const start = instance.ensure()
    const outcome = expect(start).rejects.toThrow(`within ${CHROMIUM_START_TIMEOUT_MS * 3} ms`)
    await vi.advanceTimersByTimeAsync(CHROMIUM_START_TIMEOUT_MS * 2)
    expect(silent.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(CHROMIUM_START_TIMEOUT_MS)
    await outcome
    expect(silent.signals).toContain('SIGTERM')
  })

  it('refuses to start without a display, and after disposal', async () => {
    const none = new ChromiumSupervisor(
      { spawn: vi.fn(), now: () => 0, setTimeout, clearTimeout, log: vi.fn() },
      { botId: 'bot-1', env: () => null, onStarted: async () => {}, onExited: () => {} }
    )
    await expect(none.ensure()).rejects.toThrow('no display')
    const { instance } = supervisor([fakeProcess()])
    await instance.ensure()
    await instance.dispose()
    await expect(instance.ensure()).rejects.toThrow('stopped for good')
  })
})
