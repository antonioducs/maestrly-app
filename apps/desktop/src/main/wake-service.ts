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
}

export const WAKE_COOLDOWN_MS = 3000
export const WAKE_MIN_BURST_SAMPLES = 4000 // 0.25 s at 16 kHz
export const WAKE_MAX_BURST_SAMPLES = 40_000 // 2.5 s

const CRASH_WINDOW_MS = 60_000
const CRASH_BUDGET = 3

export function createWakeService(deps: WakeServiceDeps) {
  const now = deps.now ?? Date.now
  const pauses = new Set<WakePause>()
  let worker: WakeWorker | null = null
  let ready = false
  let wasWanted = false
  let error: 'mic' | 'worker' | null = null
  let exitTimes: number[] = []
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

  function stopWorker(): void {
    if (!worker) return
    const current = worker
    worker = null
    current.stop()
  }

  function handleExit(exited: { value: WakeWorker | null }): void {
    if (worker !== exited.value || !worker) return
    worker = null
    const t = now()
    exitTimes = exitTimes.filter((ts) => t - ts < CRASH_WINDOW_MS)
    exitTimes.push(t)
    if (exitTimes.length >= CRASH_BUDGET) {
      error = 'worker'
      stopWorker()
    }
    emitState()
  }

  async function runApply(): Promise<void> {
    const isWanted = wanted()
    if (isWanted && !wasWanted) {
      error = null
      exitTimes = []
    }
    wasWanted = isWanted

    if (isWanted && (await deps.modelReady())) {
      ready = true
      if (!worker && error !== 'worker' && wanted()) {
        const ref: { value: WakeWorker | null } = { value: null }
        const started = await deps.startWorker(() => handleExit(ref))
        ref.value = started
        if (started && wanted()) {
          worker = started
        } else {
          started?.stop()
        }
      }
    } else {
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
      console.log(`[wake] ${result.ms} ms score=${score.toFixed(2)} ${JSON.stringify(result.text)}`)
      if (matchesWakePhrase(result.text, phrase)) {
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
    stopWorker()
    emitState()
  }

  return { apply, burst, micFailed, setPause, state, status, stop }
}
