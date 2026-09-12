import type { SoundVoice } from '../../shared/sound'
import type { SoundPlayAck, SoundPlayRequest, SoundPlaybackFailure } from '../../shared/sound-playback'

export interface SoundPlayerApi {
  onSoundPlay: (cb: (request: SoundPlayRequest) => void) => () => void
  setSoundRendererReady: () => void
  ackSoundPlay: (ack: SoundPlayAck) => void
}

export interface AudioContextLike {
  state: string
  destination: unknown
  resume: () => Promise<void>
  decodeAudioData: (data: ArrayBuffer) => Promise<unknown>
  createBufferSource: () => {
    buffer: unknown
    connect: (node: unknown) => unknown
    start: () => void
  }
  createGain: () => {
    gain: { value: number }
    connect: (node: unknown) => unknown
  }
  close: () => Promise<void>
}

export type AudioContextConstructor = new () => AudioContextLike

export interface SoundPlayer {
  dispose: () => Promise<void>
}

function requestBytes(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function clampVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
}

function runtimeGlobals(): { api: SoundPlayerApi; AudioContext: AudioContextConstructor } {
  return globalThis as unknown as { api: SoundPlayerApi; AudioContext: AudioContextConstructor }
}

export function createSoundPlayer(
  api: SoundPlayerApi,
  AudioContextCtor: AudioContextConstructor = runtimeGlobals().AudioContext,
  now: () => number = Date.now
): SoundPlayer {
  let context: AudioContextLike | null
  try {
    context = new AudioContextCtor()
  } catch {
    return { dispose: async () => {} }
  }

  let disposed = false
  const decoded = new Map<SoundVoice, Promise<unknown>>()

  const fail = (requestId: string, reason: SoundPlaybackFailure): void => {
    api.ackSoundPlay({ requestId, status: 'failed', reason })
  }

  const play = async (request: SoundPlayRequest): Promise<void> => {
    if (disposed || !context) return
    if (now() >= request.expiresAt) {
      fail(request.requestId, 'timeout')
      return
    }
    try {
      if (context.state === 'suspended') await context.resume()
      if (context.state !== 'running') {
        fail(request.requestId, 'context-suspended')
        return
      }
    } catch {
      fail(request.requestId, 'context-suspended')
      return
    }

    let buffer: unknown
    try {
      let pending = decoded.get(request.voice)
      if (!pending) {
        pending = context.decodeAudioData(requestBytes(request.data))
        decoded.set(request.voice, pending)
        pending.catch(() => decoded.delete(request.voice))
      }
      buffer = await pending
    } catch {
      fail(request.requestId, 'decode-failed')
      return
    }

    if (now() >= request.expiresAt) {
      fail(request.requestId, 'timeout')
      return
    }

    try {
      const source = context.createBufferSource()
      const gain = context.createGain()
      source.buffer = buffer
      gain.gain.value = clampVolume(request.volume)
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
      api.ackSoundPlay({ requestId: request.requestId, status: 'started' })
    } catch {
      fail(request.requestId, 'start-failed')
    }
  }

  const unsubscribe = api.onSoundPlay((request) => void play(request))
  api.setSoundRendererReady()

  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      decoded.clear()
      if (context && context.state !== 'closed') await context.close().catch(() => {})
      context = null
    },
  }
}

let player: SoundPlayer | null = null

export function initSoundPlayer(): SoundPlayer {
  player ??= createSoundPlayer(runtimeGlobals().api)
  return player
}
