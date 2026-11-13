import { describe, expect, it, vi } from 'vitest'
import { assistantSettingsSchema, type AssistantSettings } from '../../src/shared/assistant'
import { createWakeService, WAKE_RESTART_DELAY_MS, type WakeServiceDeps } from '../../src/main/wake-service'
import type { WakeWorker } from '../../src/main/wake-worker-host'

function harness(opts: {
  enabled?: boolean
  wakeWord?: boolean
  wakePhrase?: string | null
  locale?: string
  supported?: boolean
  modelReady?: boolean
  transcript?: string
  exitDuringStart?: boolean
} = {}) {
  let settings: AssistantSettings = assistantSettingsSchema.parse({
    enabled: opts.enabled ?? true,
    voice: { wakeWord: opts.wakeWord ?? false, wakePhrase: opts.wakePhrase ?? null },
  })
  let nowMs = 10_000
  const supported = opts.supported ?? true
  let ready = opts.modelReady ?? true
  let locale = opts.locale ?? 'pt-BR'
  let transcript = opts.transcript ?? 'Oi, Maestro.'
  let exitDuringStart = opts.exitDuringStart ?? false
  const exitCallbacks: Array<() => void> = []
  const workers: Array<{ detect: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  const onWake = vi.fn()
  const sendState = vi.fn()
  let timerSeq = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const id = ++timerSeq
    timers.set(id, { fn, at: nowMs + ms })
    return {
      cancel: () => {
        timers.delete(id)
      },
    }
  })
  const startWorker = vi.fn(async (onExit: () => void): Promise<WakeWorker | null> => {
    const w = {
      detect: vi.fn(async () => ({ text: transcript, silent: false, ms: 80 })),
      stop: vi.fn(),
    }
    workers.push(w)
    exitCallbacks.push(onExit)
    if (exitDuringStart) {
      exitDuringStart = false
      onExit()
    }
    return w
  })
  const deps: WakeServiceDeps = {
    settings: () => settings,
    locale: () => locale,
    supported: () => supported,
    modelReady: async () => ready,
    startWorker,
    onWake,
    sendState,
    now: () => nowMs,
    setTimer,
  }
  const service = createWakeService(deps)
  return {
    service,
    deps,
    startWorker,
    onWake,
    sendState,
    workers,
    setTimer,
    pendingTimers: () => timers.size,
    exitLast: () => exitCallbacks.at(-1)?.(),
    advance: (ms: number) => {
      nowMs += ms
    },
    tick: async (ms: number) => {
      nowMs += ms
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.at <= nowMs) {
          timers.delete(id)
          entry.fn()
        }
      }
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
    setSettings: (patch: { enabled?: boolean; wakeWord?: boolean; wakePhrase?: string | null }) => {
      settings = assistantSettingsSchema.parse({
        ...settings,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        voice: {
          ...settings.voice,
          ...(patch.wakeWord !== undefined ? { wakeWord: patch.wakeWord } : {}),
          ...(patch.wakePhrase !== undefined ? { wakePhrase: patch.wakePhrase } : {}),
        },
      })
    },
    setModelReady: (v: boolean) => {
      ready = v
    },
    setTranscript: (t: string) => {
      transcript = t
    },
    setLocale: (l: string) => {
      locale = l
    },
  }
}

const burstOf = (samples = 16_000) => new Float32Array(samples)

describe('wake word service', () => {
  it('stays stopped when off', async () => {
    const h = harness({ wakeWord: false })
    await h.service.apply()
    expect(h.startWorker).not.toHaveBeenCalled()
    expect(h.service.state()).toEqual({ listening: false })
  })

  it('starts the worker once and emits listening state once when on and ready', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    await h.service.apply()
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    expect(h.sendState).toHaveBeenCalledTimes(1)
    expect(h.sendState).toHaveBeenCalledWith({ listening: true })
    expect(h.service.state()).toEqual({ listening: true })
  })

  it('does not start when the model is missing', async () => {
    const h = harness({ wakeWord: true, modelReady: false })
    await h.service.apply()
    expect(h.startWorker).not.toHaveBeenCalled()
    expect(h.service.state()).toEqual({ listening: false })
  })

  it('wakes once on the default phrase for the locale', async () => {
    const h = harness({ wakeWord: true, wakePhrase: null, locale: 'pt-BR', transcript: 'Oi, Maestro.' })
    await h.service.apply()
    await h.service.burst(burstOf())
    expect(h.workers[0].detect).toHaveBeenCalledWith(expect.any(Float32Array), 'pt')
    expect(h.onWake).toHaveBeenCalledTimes(1)
  })

  it('enforces cooldown between triggers', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    await h.service.burst(burstOf())
    h.advance(1000)
    await h.service.burst(burstOf())
    expect(h.onWake).toHaveBeenCalledTimes(1)
    h.advance(2100)
    await h.service.burst(burstOf())
    expect(h.onWake).toHaveBeenCalledTimes(2)
  })

  it('matches a custom phrase instead of the default', async () => {
    const h = harness({ wakeWord: true, wakePhrase: 'Olá Jarvis', transcript: 'Oi Maestro' })
    await h.service.apply()
    await h.service.burst(burstOf())
    expect(h.onWake).not.toHaveBeenCalled()
    h.setTranscript('Olá, Jarvis')
    await h.service.burst(burstOf())
    expect(h.onWake).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed or out-of-range bursts without calling detect', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    await h.service.burst(new Float32Array(100))
    await h.service.burst(new Float32Array(50_000))
    await h.service.burst([1, 2, 3])
    expect(h.workers[0].detect).not.toHaveBeenCalled()
  })

  it('pauses on lock/suspend and resumes when cleared', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    h.service.setPause('locked', true)
    expect(h.service.state()).toEqual({ listening: false })
    expect(h.sendState).toHaveBeenLastCalledWith({ listening: false })
    await h.service.burst(burstOf())
    expect(h.workers[0].detect).not.toHaveBeenCalled()

    h.service.setPause('locked', false)
    expect(h.service.state()).toEqual({ listening: true })
    expect(h.sendState).toHaveBeenLastCalledWith({ listening: true })
    await h.service.burst(burstOf())
    expect(h.workers[0].detect).toHaveBeenCalledTimes(1)
  })

  it('restarts the worker automatically after an unexpected exit', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    expect(h.startWorker).toHaveBeenCalledTimes(1)

    h.exitLast()
    expect(h.service.state()).toEqual({ listening: false })
    expect(h.sendState).toHaveBeenLastCalledWith({ listening: false })
    expect(h.pendingTimers()).toBe(1)

    await h.tick(WAKE_RESTART_DELAY_MS)
    expect(h.startWorker).toHaveBeenCalledTimes(2)
    expect(h.service.state()).toEqual({ listening: true })
    expect(h.sendState).toHaveBeenLastCalledWith({ listening: true })
  })

  it('stops after three exits within 60 s and resets when toggled off and on', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    h.exitLast()
    await h.tick(10_000)
    h.exitLast()
    await h.tick(10_000)
    h.exitLast()

    expect(h.startWorker).toHaveBeenCalledTimes(3)
    expect(h.pendingTimers()).toBe(0)
    expect(h.service.status()).toEqual({ listening: false, error: 'worker' })
    await h.service.apply()
    expect(h.startWorker).toHaveBeenCalledTimes(3)

    h.setSettings({ wakeWord: false })
    await h.service.apply()
    h.setSettings({ wakeWord: true })
    await h.service.apply()
    expect(h.startWorker).toHaveBeenCalledTimes(4)
    expect(h.service.status()).toEqual({ listening: true, error: null })
  })

  it('cancels a pending restart when stopped', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    h.exitLast()
    expect(h.pendingTimers()).toBe(1)

    h.service.stop()
    expect(h.pendingTimers()).toBe(0)
    await h.tick(WAKE_RESTART_DELAY_MS)
    expect(h.startWorker).toHaveBeenCalledTimes(1)
  })

  it('discards a worker that exits during startup and restarts it after the delay', async () => {
    const h = harness({ wakeWord: true, exitDuringStart: true })
    await h.service.apply()
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    expect(h.workers[0].stop).toHaveBeenCalledTimes(1)
    expect(h.service.state()).toEqual({ listening: false })
    expect(h.pendingTimers()).toBe(1)

    await h.tick(WAKE_RESTART_DELAY_MS)
    expect(h.startWorker).toHaveBeenCalledTimes(2)
    expect(h.service.state()).toEqual({ listening: true })
  })

  it('records mic failure in status', async () => {
    const h = harness({ wakeWord: true })
    await h.service.apply()
    h.service.micFailed()
    expect(h.service.status()).toEqual({ listening: true, error: 'mic' })
  })

  it('stops the worker when the assistant is disabled', async () => {
    const h = harness({ wakeWord: true, enabled: true })
    await h.service.apply()
    h.setSettings({ enabled: false })
    await h.service.apply()
    expect(h.workers[0].stop).toHaveBeenCalledTimes(1)
    expect(h.service.state()).toEqual({ listening: false })
  })
})
