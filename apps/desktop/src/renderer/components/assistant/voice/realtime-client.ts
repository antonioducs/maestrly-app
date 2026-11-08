/**
 * The Realtime voice of the assistant window: a WebRTC call with OpenAI, set up through the main process (which holds
 * the key). Tap to talk: the microphone track is on only while the person talks, and the server's turn detection
 * ends it. Tool calls go to the main process, which hands the person's words to the assistant conversation.
 */
import { openMicStream } from '@/lib/mic-recorder'

export type RealtimeState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'idle'

export interface RealtimeClient {
  readonly startedAt: number
  /** Opens the microphone for the person's turn; interrupts the voice if it is talking. */
  listen(): void
  /** Closes the microphone; the server ends the turn on the silence. */
  stopListening(): void
  /** Stops the voice at once. */
  interrupt(): void
  close(): void
}

export class RealtimeStartError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** The session closes after two minutes without anyone talking. */
export const REALTIME_IDLE_CLOSE_MS = 120_000
/** After an interruption, audio still playing past this closes the call: the voice must stop. */
const INTERRUPT_GRACE_MS = 300
/** The person's words are transcribed after their turn; a tool call waits this long for them. */
const TRANSCRIPT_WAIT_MS = 4000

interface ServerEvent {
  type: string
  item_id?: string
  transcript?: string
  call_id?: string
  name?: string
  arguments?: string
  error?: { code?: string; message?: string }
}

export async function startRealtimeClient(opts: {
  deviceId?: string | null
  onState(state: RealtimeState): void
  onError(code: string): void
  onClosed(): void
}): Promise<RealtimeClient> {
  opts.onState('connecting')
  const stream = await openMicStream(opts.deviceId).catch(() => {
    throw new RealtimeStartError('mic')
  })
  const [track] = stream.getAudioTracks()
  if (!track) {
    for (const t of stream.getTracks()) t.stop()
    throw new RealtimeStartError('mic')
  }
  track.enabled = false
  const peer = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  peer.ontrack = (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
    void audio.play().catch(() => {})
  }
  peer.addTrack(track, stream)
  const channel = peer.createDataChannel('oai-events')

  let closed = false
  let state: RealtimeState = 'connecting'
  let speaking = false
  let tools = 0
  let lastActivity = Date.now()
  let interruptTimer: ReturnType<typeof setTimeout> | null = null
  const heard: string[] = []
  const transcribing = new Set<string>()
  const settled: Array<() => void> = []

  const set = (next: RealtimeState) => {
    if (closed || next === state) return
    state = next
    opts.onState(next)
  }
  const send = (event: Record<string, unknown>) => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(event))
  }
  const restingState = (): RealtimeState => (track.enabled ? 'listening' : tools > 0 ? 'thinking' : 'idle')
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

  const close = () => {
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
    window.api.assistantRealtimeStop()
    opts.onClosed()
  }

  const runTool = async (event: ServerEvent) => {
    tools++
    set('thinking')
    await transcriptsSettled()
    if (closed) return
    const name = event.name ?? ''
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
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output } })
    send({ type: 'response.create' })
    set(restingState())
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
        lastActivity = Date.now()
        set('listening')
        break
      case 'input_audio_buffer.speech_stopped':
        // The person's turn ended: the microphone waits for the next tap.
        track.enabled = false
        set('thinking')
        break
      case 'input_audio_buffer.committed':
        if (event.item_id) transcribing.add(event.item_id)
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) heard.push(event.transcript.trim())
        transcriptDone(event.item_id)
        break
      case 'conversation.item.input_audio_transcription.failed':
        transcriptDone(event.item_id)
        break
      case 'output_audio_buffer.started':
        speaking = true
        lastActivity = Date.now()
        set('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        speaking = false
        lastActivity = Date.now()
        if (interruptTimer) clearTimeout(interruptTimer)
        interruptTimer = null
        set(restingState())
        break
      case 'response.function_call_arguments.done':
        void runTool(event)
        break
      case 'error':
        opts.onError(event.error?.code ?? 'error')
        break
    }
  })
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed') {
      opts.onError('network')
      close()
    } else if (peer.connectionState === 'closed') close()
  })

  const idleTimer = setInterval(() => {
    if (!speaking && !tools && !track.enabled && Date.now() - lastActivity > REALTIME_IDLE_CLOSE_MS) close()
  }, 5000)

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const result = await window.api.assistantRealtimeStart(peer.localDescription?.sdp ?? offer.sdp ?? '')
    if (!result.ok) throw new RealtimeStartError(result.error)
    await peer.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
  } catch (error) {
    close()
    throw error instanceof RealtimeStartError ? error : new RealtimeStartError('network')
  }
  set('idle')

  const interrupt = () => {
    send({ type: 'response.cancel' })
    send({ type: 'output_audio_buffer.clear' })
    if (interruptTimer) clearTimeout(interruptTimer)
    interruptTimer = setTimeout(() => {
      if (speaking) close()
    }, INTERRUPT_GRACE_MS)
  }

  return {
    startedAt: Date.now(),
    listen() {
      if (closed) return
      if (speaking) interrupt()
      track.enabled = true
      lastActivity = Date.now()
      set('listening')
    },
    stopListening() {
      track.enabled = false
      set(restingState())
    },
    interrupt,
    close,
  }
}
