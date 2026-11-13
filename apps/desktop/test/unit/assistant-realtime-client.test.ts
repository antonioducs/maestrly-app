import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mic = vi.hoisted(() => ({ openMicStream: vi.fn() }))
vi.mock('@/lib/mic-recorder', () => mic)

import {
  REALTIME_IDLE_CLOSE_MS,
  type RealtimeState,
  startRealtimeClient,
} from '../../src/renderer/components/assistant/voice/realtime-client'

/** The WebRTC side of the call; the test plays the server through its data channel. */
class FakePeer {
  static last: FakePeer
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  ontrack: ((event: unknown) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  readonly channel = {
    readyState: 'open',
    send: (data: string) => this.sent.push(JSON.parse(data)),
    close: vi.fn(),
    addEventListener: (_type: string, listener: (event: { data: string }) => void) => {
      this.onMessage = listener
    },
  }
  private onMessage: (event: { data: string }) => void = () => {}
  constructor() {
    FakePeer.last = this
  }
  addTrack = vi.fn()
  createDataChannel = () => this.channel
  createOffer = async () => ({ type: 'offer', sdp: 'v=0 offer' })
  setLocalDescription = async (offer: { sdp: string }) => {
    this.localDescription = offer
  }
  setRemoteDescription = vi.fn(async () => {})
  addEventListener = vi.fn()
  close = vi.fn()
  emit(event: Record<string, unknown>) {
    this.onMessage({ data: JSON.stringify(event) })
  }
}

class FakeAudio {
  autoplay = false
  srcObject: unknown = null
  play = async () => {}
}

function setup() {
  const track = { enabled: true, stop: vi.fn() }
  mic.openMicStream.mockResolvedValue({ getAudioTracks: () => [track], getTracks: () => [track] })
  const api = {
    assistantRealtimeStart: vi.fn(async () => ({ ok: true, answerSdp: 'v=0 answer', callId: 'rtc_1' })),
    assistantRealtimeStop: vi.fn(),
    assistantRealtimeTool: vi.fn(async () => '{"answer":"done"}'),
  }
  vi.stubGlobal('window', { api })
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('MediaStream', class {})
  const states: RealtimeState[] = []
  const onClosed = vi.fn()
  const started = startRealtimeClient({
    deviceId: 'mic-1',
    onState: (state) => states.push(state),
    onError: vi.fn(),
    onClosed,
  })
  const last = () => states[states.length - 1]
  return { track, api, states, last, onClosed, started }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the Realtime call, full duplex', () => {
  it('opens the microphone with echo cancellation and listens as soon as the call connects', async () => {
    const { track, states, started } = setup()
    await started
    expect(mic.openMicStream).toHaveBeenCalledWith('mic-1', expect.objectContaining({ echoCancellation: true }))
    expect(track.enabled).toBe(true)
    expect(states).toEqual(['connecting', 'listening'])
  })

  it('keeps the microphone open through the turns: the person talks, it answers, it listens again', async () => {
    const { track, states, started } = setup()
    await started
    const peer = FakePeer.last
    peer.emit({ type: 'input_audio_buffer.speech_started' })
    peer.emit({ type: 'input_audio_buffer.speech_stopped' })
    expect(track.enabled).toBe(true)
    peer.emit({ type: 'response.created' })
    peer.emit({ type: 'output_audio_buffer.started' })
    peer.emit({ type: 'response.done' })
    peer.emit({ type: 'output_audio_buffer.stopped' })
    expect(track.enabled).toBe(true)
    expect(states).toEqual(['connecting', 'listening', 'thinking', 'speaking', 'listening'])
    // A pause mid-sentence the server took for the end of the turn: the rest is still heard.
    peer.emit({ type: 'input_audio_buffer.speech_started' })
    expect(track.enabled).toBe(true)
  })

  it('lets the person talk over the voice: the server clears its audio and the call listens', async () => {
    const { last, started } = setup()
    await started
    const peer = FakePeer.last
    peer.emit({ type: 'response.created' })
    peer.emit({ type: 'output_audio_buffer.started' })
    expect(last()).toBe('speaking')
    peer.emit({ type: 'input_audio_buffer.speech_started' })
    expect(last()).toBe('listening')
    peer.emit({ type: 'output_audio_buffer.cleared' })
    peer.emit({ type: 'response.done' })
    expect(last()).toBe('listening')
    peer.emit({ type: 'input_audio_buffer.speech_stopped' })
    expect(last()).toBe('thinking')
  })

  it('mutes and unmutes the microphone without ending the call', async () => {
    const { track, last, started, onClosed } = setup()
    const client = await started
    client.setMuted(true)
    expect(client.muted).toBe(true)
    expect(track.enabled).toBe(false)
    expect(last()).toBe('muted')
    // A muted call still answers what it heard and plays it.
    FakePeer.last.emit({ type: 'output_audio_buffer.started' })
    expect(last()).toBe('speaking')
    FakePeer.last.emit({ type: 'output_audio_buffer.stopped' })
    expect(last()).toBe('muted')
    client.setMuted(false)
    expect(track.enabled).toBe(true)
    expect(last()).toBe('listening')
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('hands a tool call what the person said and answers the server with its output', async () => {
    const { api, last, started } = setup()
    await started
    const peer = FakePeer.last
    peer.emit({ type: 'input_audio_buffer.committed', item_id: 'item_1' })
    peer.emit({
      type: 'response.function_call_arguments.done',
      name: 'ask_assistant',
      call_id: 'call_1',
      arguments: '{}',
    })
    expect(last()).toBe('thinking')
    peer.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: ' abre o bot ',
    })
    await vi.waitFor(() => expect(peer.sent).toHaveLength(2))
    expect(api.assistantRealtimeTool).toHaveBeenCalledWith({
      name: 'ask_assistant',
      arguments: '{}',
      heard: ['abre o bot'],
    })
    expect(peer.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'call_1', output: '{"answer":"done"}' },
      },
      { type: 'response.create' },
    ])
    peer.emit({ type: 'response.done' })
    expect(last()).toBe('listening')
  })

  it('ends after two minutes without anyone talking, but not while the person talks', async () => {
    const { api, started, onClosed } = setup()
    await started
    FakePeer.last.emit({ type: 'input_audio_buffer.speech_started' })
    vi.advanceTimersByTime(REALTIME_IDLE_CLOSE_MS + 10_000)
    expect(onClosed).not.toHaveBeenCalled()
    FakePeer.last.emit({ type: 'input_audio_buffer.speech_stopped' })
    FakePeer.last.emit({ type: 'response.done' })
    vi.advanceTimersByTime(REALTIME_IDLE_CLOSE_MS + 10_000)
    expect(onClosed).toHaveBeenCalledOnce()
    expect(api.assistantRealtimeStop).toHaveBeenCalledOnce()
  })
})
