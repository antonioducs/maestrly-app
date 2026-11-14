/**
 * The Realtime voice of the assistant window: a WebRTC call with OpenAI, set up through the main process (which holds
 * the key). Full duplex: the microphone stays open for the whole call and the server's turn detection takes the
 * turns, so the person talks over the voice to interrupt it. Tool calls go to the main process, which hands the
 * person's words to the assistant conversation.
 */
import { openMicStream } from '@/lib/mic-recorder'

export type RealtimeState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted'

/** Why the call ended: the person hung up, nobody talked for two minutes, the connection failed, or the voice did not stop. */
export type RealtimeCloseReason = 'hangup' | 'idle' | 'network' | 'error'

/** What was said, as the server transcribes it: the person's turn once it ends, the voice's words as it says them. */
export interface RealtimeTranscript {
  who: 'you' | 'voice'
  id: string
  /** Everything heard of this turn so far. */
  text: string
  final: boolean
  /** When the person's turn ended (`you` only): a voice that started after it already answered it. */
  turnEndedAt?: number
}

/** A tool the voice calls: once when it starts, once with its output. */
export interface RealtimeToolEvent {
  callId: string
  name: string
  args: Record<string, unknown>
  done: boolean
  output?: string
}

export interface RealtimeLevels {
  /** The microphone's loudness (RMS, 0–1); 0 while muted. */
  input: number
  /** The voice's loudness as it plays. */
  output: number
}

export interface RealtimeClient {
  readonly startedAt: number
  readonly muted: boolean
  /** Mutes or unmutes the microphone; the call goes on. */
  setMuted(muted: boolean): void
  /** Stops the voice at once. */
  interrupt(): void
  /** Counts as someone talking: the two minutes of silence start over. */
  keepAlive(): void
  levels(): RealtimeLevels
  close(): void
}

export class RealtimeStartError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** The session closes after two minutes without anyone talking. */
export const REALTIME_IDLE_CLOSE_MS = 120_000
/** How long before that the window says the call is about to end. */
export const REALTIME_IDLE_WARN_MS = 15_000
/** After an interruption, audio still playing past this closes the call: the voice must stop. */
const INTERRUPT_GRACE_MS = 300
/** The person's words are transcribed after their turn; a tool call waits this long for them. */
const TRANSCRIPT_WAIT_MS = 4000
/** The voice plays through the speakers while the microphone is open: without echo cancellation it hears itself. */
const CALL_AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

interface ServerEvent {
  type: string
  item_id?: string
  transcript?: string
  delta?: string
  call_id?: string
  name?: string
  arguments?: string
  error?: { code?: string; message?: string }
}

function parseArgs(json: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(json ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Loudness meters for the call's two streams; none where Web Audio is missing. */
function createMeters(input: MediaStream) {
  if (typeof AudioContext === 'undefined') return null
  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    return null
  }
  const analyser = () => {
    const node = context.createAnalyser()
    node.fftSize = 512
    return node
  }
  const buffer = new Float32Array(512)
  const rms = (node: AnalyserNode | null) => {
    if (!node) return 0
    node.getFloatTimeDomainData(buffer)
    let sum = 0
    for (const value of buffer) sum += value * value
    return Math.sqrt(sum / buffer.length)
  }
  const mic = analyser()
  context.createMediaStreamSource(input).connect(mic)
  let voice: AnalyserNode | null = null
  return {
    attachOutput(stream: MediaStream) {
      if (voice || !stream.getAudioTracks().length) return
      voice = analyser()
      // Only measured: the audio element plays it.
      context.createMediaStreamSource(stream).connect(voice)
    },
    read: (): RealtimeLevels => ({ input: rms(mic), output: rms(voice) }),
    close: () => void context.close().catch(() => {}),
  }
}

export async function startRealtimeClient(opts: {
  deviceId?: string | null
  onState(state: RealtimeState): void
  onError(code: string): void
  onClosed(reason: RealtimeCloseReason): void
  onTranscript?(transcript: RealtimeTranscript): void
  onTool?(event: RealtimeToolEvent): void
  /** The server hears the person (between the start and the end of their speech). */
  onPersonSpeaking?(speaking: boolean): void
  /** When the call will close for silence, from 15 s before; null once someone talks again. */
  onIdleWarning?(closesAt: number | null): void
}): Promise<RealtimeClient> {
  opts.onState('connecting')
  const stream = await openMicStream(opts.deviceId, CALL_AUDIO).catch(() => {
    throw new RealtimeStartError('mic')
  })
  const [track] = stream.getAudioTracks()
  if (!track) {
    for (const t of stream.getTracks()) t.stop()
    throw new RealtimeStartError('mic')
  }
  const peer = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  const meters = createMeters(stream)
  peer.ontrack = (event) => {
    const remote = event.streams[0] ?? new MediaStream([event.track])
    audio.srcObject = remote
    void audio.play().catch(() => {})
    meters?.attachOutput(remote)
  }
  peer.addTrack(track, stream)
  const channel = peer.createDataChannel('oai-events')

  let closed = false
  let connected = false
  let state: RealtimeState = 'connecting'
  let muted = false
  /** The server hears the person talking (between speech_started and speech_stopped). */
  let personSpeaking = false
  /** A response is on its way: from the end of the person's turn, or its creation, until it is done. */
  let responding = false
  let speaking = false
  let tools = 0
  let lastActivity = Date.now()
  let idleWarning: number | null = null
  let speechStoppedAt = 0
  let interruptTimer: ReturnType<typeof setTimeout> | null = null
  const heard: string[] = []
  const transcribing = new Set<string>()
  const settled: Array<() => void> = []
  /** The transcripts still coming in, by item. */
  const partial = new Map<string, string>()

  const current = (): RealtimeState => {
    if (personSpeaking && !muted) return 'listening'
    if (speaking) return 'speaking'
    if (muted) return 'muted'
    return tools > 0 || responding ? 'thinking' : 'listening'
  }
  const refresh = () => {
    if (closed || !connected) return
    const next = current()
    if (next === state) return
    state = next
    opts.onState(next)
  }
  const send = (event: Record<string, unknown>) => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(event))
  }
  const transcriptDone = (itemId: string | undefined) => {
    if (itemId) transcribing.delete(itemId)
    if (!transcribing.size) for (const resolve of settled.splice(0)) resolve()
  }
  const transcriptsSettled = () =>
    transcribing.size
      ? new Promise<void>((resolve) => {
          settled.push(resolve)
          setTimeout(resolve, TRANSCRIPT_WAIT_MS)
        })
      : Promise.resolve()

  const close = (reason: RealtimeCloseReason) => {
    if (closed) return
    closed = true
    clearInterval(idleTimer)
    if (interruptTimer) clearTimeout(interruptTimer)
    for (const resolve of settled.splice(0)) resolve()
    try {
      channel.close()
    } catch {
      /* already closed */
    }
    peer.close()
    for (const t of stream.getTracks()) t.stop()
    audio.srcObject = null
    meters?.close()
    window.api.assistantRealtimeStop()
    opts.onClosed(reason)
  }

  const checkIdle = () => {
    if (closed || !connected) return
    const busy = speaking || tools > 0 || personSpeaking
    const closesAt = lastActivity + REALTIME_IDLE_CLOSE_MS
    if (!busy && Date.now() >= closesAt) return close('idle')
    const warning = !busy && closesAt - Date.now() <= REALTIME_IDLE_WARN_MS ? closesAt : null
    if (warning === idleWarning) return
    idleWarning = warning
    opts.onIdleWarning?.(warning)
  }

  const transcript = (who: 'you' | 'voice', event: ServerEvent, final: boolean) => {
    const id = event.item_id ?? ''
    const text = final ? (event.transcript ?? partial.get(id) ?? '') : (partial.get(id) ?? '') + (event.delta ?? '')
    if (final) partial.delete(id)
    else partial.set(id, text)
    if (!text.trim()) return
    opts.onTranscript?.({
      who,
      id,
      text: text.trim(),
      final,
      ...(who === 'you' ? { turnEndedAt: speechStoppedAt } : {}),
    })
  }

  const runTool = async (event: ServerEvent) => {
    tools++
    refresh()
    const name = event.name ?? ''
    const callId = event.call_id ?? ''
    const args = parseArgs(event.arguments)
    opts.onTool?.({ callId, name, args, done: false })
    await transcriptsSettled()
    if (closed) return
    // A request or an answer consumes what the person said; the overview leaves it for the next one.
    const words = name === 'maestrly_overview' ? [...heard] : heard.splice(0)
    let output: string
    try {
      output = await window.api.assistantRealtimeTool({ name, arguments: event.arguments ?? '{}', heard: words })
    } catch (error) {
      output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
    tools--
    if (closed) return
    lastActivity = Date.now()
    opts.onTool?.({ callId, name, args, done: true, output })
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output } })
    send({ type: 'response.create' })
    refresh()
    checkIdle()
  }

  channel.addEventListener('message', ({ data }) => {
    let event: ServerEvent
    try {
      event = JSON.parse(String(data))
    } catch {
      return
    }
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        // Talking over the voice interrupts it: the server cancels the response and clears its audio.
        personSpeaking = true
        lastActivity = Date.now()
        opts.onPersonSpeaking?.(true)
        break
      case 'input_audio_buffer.speech_stopped':
        // The person's turn ended; the server answers it.
        personSpeaking = false
        responding = true
        lastActivity = Date.now()
        speechStoppedAt = lastActivity
        opts.onPersonSpeaking?.(false)
        break
      case 'input_audio_buffer.committed':
        if (event.item_id) transcribing.add(event.item_id)
        break
      case 'conversation.item.input_audio_transcription.delta':
        transcript('you', event, false)
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) heard.push(event.transcript.trim())
        transcript('you', event, true)
        transcriptDone(event.item_id)
        break
      case 'conversation.item.input_audio_transcription.failed':
        partial.delete(event.item_id ?? '')
        transcriptDone(event.item_id)
        break
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        transcript('voice', event, false)
        break
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        transcript('voice', event, true)
        break
      case 'response.created':
        responding = true
        break
      case 'response.done':
        responding = false
        lastActivity = Date.now()
        break
      case 'output_audio_buffer.started':
        speaking = true
        lastActivity = Date.now()
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        speaking = false
        lastActivity = Date.now()
        if (interruptTimer) clearTimeout(interruptTimer)
        interruptTimer = null
        break
      case 'response.function_call_arguments.done':
        void runTool(event)
        break
      case 'error':
        responding = false
        opts.onError(event.error?.code ?? 'error')
        break
    }
    refresh()
    checkIdle()
  })
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed') {
      opts.onError('network')
      close('network')
    } else if (peer.connectionState === 'closed') close('network')
  })

  // Every second, so the warning counts down and the call closes on time.
  const idleTimer = setInterval(checkIdle, 1000)

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const result = await window.api.assistantRealtimeStart(peer.localDescription?.sdp ?? offer.sdp ?? '')
    if (!result.ok) throw new RealtimeStartError(result.error)
    await peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
  } catch (error) {
    close('network')
    throw error instanceof RealtimeStartError ? error : new RealtimeStartError('network')
  }
  connected = true
  lastActivity = Date.now()
  refresh()

  const interrupt = () => {
    send({ type: 'response.cancel' })
    send({ type: 'output_audio_buffer.clear' })
    if (interruptTimer) clearTimeout(interruptTimer)
    interruptTimer = setTimeout(() => {
      if (speaking) close('error')
    }, INTERRUPT_GRACE_MS)
  }

  return {
    startedAt: Date.now(),
    get muted() {
      return muted
    },
    setMuted(next) {
      if (closed || next === muted) return
      muted = next
      // A muted track sends silence: the server's turn detection ends any turn in progress.
      track.enabled = !next
      lastActivity = Date.now()
      refresh()
      checkIdle()
    },
    interrupt,
    keepAlive() {
      lastActivity = Date.now()
      checkIdle()
    },
    levels() {
      const levels = meters?.read() ?? { input: 0, output: 0 }
      return muted ? { ...levels, input: 0 } : levels
    },
    close: () => close('hangup'),
  }
}
