/**
 * Reads the assistant's sentences aloud, one after another: with the system's voices (free, on this computer) or
 * with OpenAI's, fetched through the main process while the previous sentence plays.
 */
import type { AssistantTtsError } from '../../../../shared/assistant'
import type { SupportedLocale } from '../../../../shared/locale'

export type SpeakerError = AssistantTtsError | 'no-voice' | 'playback'

export interface SpeakerOptions {
  engine: 'system' | 'openai'
  locale: SupportedLocale
  /** The system voice's name; null for the best one for the locale. */
  systemVoice: string | null
  speed: number
  /** Every sentence given was read. */
  onIdle(): void
  /** Reading stopped; the sentences left were dropped. */
  onError(error: SpeakerError): void
  /** A sentence starts playing, with how long it lasts (estimated for the system's voices). */
  onSentence?(text: string, durationMs: number): void
  /** The system voice reached the word at `charIndex` of the sentence playing. */
  onBoundary?(charIndex: number): void
}

export interface Speaker {
  speak(text: string): void
  /** Stops at once and drops what is left. */
  stop(): void
  dispose(): void
  /** How loud the voice plays now (RMS, 0–1); for the system's voices, an estimate from its words. */
  level(): number
}

/** About how long a system voice takes to say `text`: roughly 15 characters a second at normal speed. */
export function estimatedSpeechMs(text: string, speed: number): number {
  return Math.round((text.length / (15 * Math.max(0.25, speed))) * 1000)
}

/** The system voices that speak `locale`, the local ones first. */
export function systemVoicesFor(voices: readonly SpeechSynthesisVoice[], locale: SupportedLocale) {
  const language = locale.slice(0, 2).toLowerCase()
  return voices
    .filter((voice) => voice.lang.toLowerCase().replace('_', '-').startsWith(language))
    .sort((a, b) => Number(b.localService) - Number(a.localService))
}

export function pickSystemVoice(
  voices: readonly SpeechSynthesisVoice[],
  name: string | null,
  locale: SupportedLocale
): SpeechSynthesisVoice | null {
  if (name) {
    const named = voices.find((voice) => voice.name === name)
    if (named) return named
  }
  const fitting = systemVoicesFor(voices, locale)
  return fitting.find((voice) => voice.lang.replace('_', '-') === locale) ?? fitting[0] ?? null
}

function systemSpeaker(opts: SpeakerOptions): Speaker {
  const synth: SpeechSynthesis | undefined = typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis
  let queued = 0
  let generation = 0
  let playing = false
  let lastWordAt = 0
  const stop = () => {
    generation++
    queued = 0
    playing = false
    synth?.cancel()
  }
  return {
    speak(text) {
      if (!synth) {
        opts.onError('no-voice')
        return
      }
      const current = generation
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = opts.locale
      utterance.rate = opts.speed
      const voice = pickSystemVoice(synth.getVoices(), opts.systemVoice, opts.locale)
      if (voice) utterance.voice = voice
      utterance.onstart = () => {
        if (current !== generation) return
        playing = true
        lastWordAt = performance.now()
        opts.onSentence?.(text, estimatedSpeechMs(text, opts.speed))
      }
      utterance.onboundary = (event) => {
        if (current !== generation || event.name !== 'word') return
        lastWordAt = performance.now()
        opts.onBoundary?.(event.charIndex)
      }
      utterance.onend = () => {
        if (current !== generation) return
        queued = Math.max(0, queued - 1)
        if (!queued) {
          playing = false
          opts.onIdle()
        }
      }
      utterance.onerror = (event) => {
        if (current !== generation || event.error === 'interrupted' || event.error === 'canceled') return
        stop()
        opts.onError('no-voice')
      }
      queued++
      synth.speak(utterance)
    },
    stop,
    dispose: stop,
    level() {
      if (!playing) return 0
      // The system's audio is out of reach: each word gives a pulse that fades.
      return 0.04 + 0.12 * Math.max(0, 1 - (performance.now() - lastWordAt) / 260)
    },
  }
}

function rmsOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer)
  let sum = 0
  for (const value of buffer) sum += value * value
  return Math.sqrt(sum / buffer.length)
}

function openAiSpeaker(opts: SpeakerOptions): Speaker {
  const queue: Array<{ text: string; audio: Promise<Awaited<ReturnType<typeof window.api.assistantTts>>> | null }> = []
  let context: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  const samples = new Float32Array(512)
  let source: AudioBufferSourceNode | null = null
  let playing = false
  let generation = 0

  // The sentence playing and the next one are fetched; the rest wait.
  const fetchAhead = () => {
    for (const item of queue.slice(0, 2))
      item.audio ??= window.api.assistantTts(item.text).catch(() => ({ ok: false, error: 'network' }) as const)
  }
  const stop = () => {
    generation++
    queue.length = 0
    playing = false
    try {
      source?.stop()
    } catch {
      /* already ended */
    }
    source = null
    window.api.assistantTtsCancel()
  }
  const fail = (error: SpeakerError) => {
    stop()
    opts.onError(error)
  }
  const next = async (): Promise<void> => {
    const current = generation
    const item = queue[0]
    if (!item) {
      playing = false
      opts.onIdle()
      return
    }
    playing = true
    fetchAhead()
    const result = await item.audio!
    if (current !== generation) return
    if (!result.ok) {
      if (result.error !== 'cancelled') fail(result.error)
      return
    }
    try {
      context ??= new AudioContext()
      if (!analyser) {
        analyser = context.createAnalyser()
        analyser.fftSize = samples.length
        analyser.connect(context.destination)
      }
      const buffer = await context.decodeAudioData(result.audio.slice(0))
      if (current !== generation) return
      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(analyser)
      node.onended = () => {
        if (current !== generation) return
        source = null
        queue.shift()
        void next()
      }
      source = node
      node.start()
      opts.onSentence?.(item.text, Math.round(buffer.duration * 1000))
    } catch {
      if (current === generation) fail('playback')
    }
  }
  return {
    speak(text) {
      queue.push({ text, audio: null })
      if (playing) fetchAhead()
      else void next()
    },
    stop,
    dispose() {
      stop()
      void context?.close().catch(() => {})
      context = null
      analyser = null
    },
    level: () => (source && analyser ? rmsOf(analyser, samples) : 0),
  }
}

export function createSpeaker(opts: SpeakerOptions): Speaker {
  return opts.engine === 'openai' ? openAiSpeaker(opts) : systemSpeaker(opts)
}
