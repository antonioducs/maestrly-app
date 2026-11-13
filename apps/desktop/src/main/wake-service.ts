import type { AssistantSettings } from '../shared/assistant'
import { defaultWakePhrase, matchesWakePhrase, wakeScore } from '../shared/wake-phrase'
import type { WakeWorker } from './wake-worker-host'

export type WakePause = 'locked' | 'suspended'
export interface WakeState {
  listening: boolean
}
export interface WakeStatus extends WakeState {
  error: 'mic' | 'worker' | null
}

export interface WakeServiceDeps {
  settings(): AssistantSettings
  locale(): string
  supported(): boolean
  modelReady(): Promise<boolean>
  startWorker(onExit: () => void): Promise<WakeWorker | null>
  /** The phrase was heard: play the sound and open the assistant listening. */
  onWake(): void
  sendState(state: WakeState): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  logTranscripts?: boolean
}

export const WAKE_COOLDOWN_MS = 3000
export const WAKE_RESTART_DELAY_MS = 1000
export const WAKE_MIN_BURST_SAMPLES = 4000 // 0.25 s at 16 kHz
export const WAKE_MAX_BURST_SAMPLES = 40_000 // 2.5 s

const CRASH_WINDOW_MS = 60_000
const CRASH_BUDGET = 3

export function createWakeService(deps: WakeServiceDeps) {
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(id) }
    })
  const pauses = new Set<WakePause>()
  let worker: WakeWorker | null = null
  let ready = false
  let wasWanted = false
  let error: 'mic' | 'worker' | null = null
  let exitTimes: number[] = []
  let restartTimer: { cancel(): void } | null = null
  let lastSentListening: boolean | null = null
  let inFlight = false
  let cooldownUntil = 0
  let applyChain: Promise<void> = Promise.resolve()

  function wanted(): boolean {
    const s = deps.settings()
    return s.enabled && s.voice.wakeWord && deps.supported()
  }

  function isListening(): boolean {
    return wanted() && ready && worker !== null && pauses.size === 0 && error !== 'worker'
  }

  function emitState(): void {
    const listening = isListening()
    if (listening === lastSentListening) return
    lastSentListening = listening
    deps.sendState({ listening })
  }

  function clearRestart(): void {
    restartTimer?.cancel()
    restartTimer = null
  }

  function scheduleRestart(): void {
    if (restartTimer || error === 'worker' || !wanted()) return
    restartTimer = setTimer(() => {
      restartTimer = null
      void apply()
    }, WAKE_RESTART_DELAY_MS)
  }

  function stopWorker(): void {
    if (!worker) return
    const current = worker
    worker = null
    current.stop()
  }

  function recordExit(): void {
    const t = now()
    exitTimes = exitTimes.filter((ts) => t - ts < CRASH_WINDOW_MS)
    exitTimes.push(t)
    if (exitTimes.length >= CRASH_BUDGET) {
      error = 'worker'
      clearRestart()
      stopWorker()
    } else {
      scheduleRestart()
    }
    emitState()
  }

  function handleExit(exited: { value: WakeWorker | null; exited: boolean }): void {
    if (exited.value === null) {
      // Exited before startWorker resolved; runApply will discard the worker and count the exit.
      exited.exited = true
      return
    }
    if (worker !== exited.value || !worker) return
    worker = null
    recordExit()
  }

  async function runApply(): Promise<void> {
    const isWanted = wanted()
    if (isWanted && !wasWanted) {
      error = null
      exitTimes = []
      clearRestart()
    }
    wasWanted = isWanted

    if (isWanted && (await deps.modelReady())) {
      ready = true
      if (!worker && error !== 'worker' && wanted()) {
        const ref: { value: WakeWorker | null; exited: boolean } = { value: null, exited: false }
        const started = await deps.startWorker(() => handleExit(ref))
        if (ref.exited) {
          started?.stop()
          if (wanted()) recordExit()
        } else if (started && wanted()) {
          ref.value = started
          worker = started
          clearRestart()
        } else {
          started?.stop()
        }
      }
    } else {
      clearRestart()
      ready = false
      stopWorker()
    }
    emitState()
  }

  function apply(): Promise<void> {
    applyChain = applyChain.then(runApply, runApply)
    return applyChain
  }

  async function burst(audio: unknown): Promise<void> {
    if (!(audio instanceof Float32Array)) return
    if (audio.length < WAKE_MIN_BURST_SAMPLES || audio.length > WAKE_MAX_BURST_SAMPLES) return
    if (inFlight || now() < cooldownUntil) return
    if (!worker && wanted() && ready && pauses.size === 0 && error !== 'worker') {
      await apply()
    }
    if (!isListening() || !worker) return
    if (error === 'mic') error = null
    inFlight = true
    try {
      const locale = deps.locale()
      const language: 'pt' | 'en' = locale.startsWith('pt') ? 'pt' : 'en'
      const phrase = deps.settings().voice.wakePhrase ?? defaultWakePhrase(locale)
      const result = await worker.detect(audio, language)
      if (!result) return
      const score = wakeScore(result.text, phrase)
      const matched = matchesWakePhrase(result.text, phrase)
      const parts = [`[wake] ${result.ms} ms score=${score.toFixed(2)}`]
      if (matched) parts.push('match')
      if (deps.logTranscripts) parts.push(JSON.stringify(result.text))
      console.log(parts.join(' '))
      if (matched) {
        cooldownUntil = now() + WAKE_COOLDOWN_MS
        deps.onWake()
      }
    } finally {
      inFlight = false
    }
  }

  function micFailed(): void {
    error = 'mic'
  }

  function setPause(reason: WakePause, paused: boolean): void {
    if (paused) pauses.add(reason)
    else pauses.delete(reason)
    emitState()
  }

  function state(): WakeState {
    return { listening: isListening() }
  }

  function status(): WakeStatus {
    return { listening: isListening(), error }
  }

  function stop(): void {
    clearRestart()
    stopWorker()
    emitState()
  }

  return { apply, burst, micFailed, setPause, state, status, stop }
}
