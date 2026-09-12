import type { SoundPlayRequest } from '../../src/shared/sound-playback'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSoundPlayer,
  type AudioContextConstructor,
  type SoundPlayerApi,
} from '../../src/renderer/lib/sound-player'

function setup(options: { state?: string; resumeFails?: boolean; decodeFails?: boolean; startFails?: boolean } = {}) {
  let listener: ((request: SoundPlayRequest) => void) | null = null
  const unsubscribe = vi.fn()
  const api: SoundPlayerApi = {
    onSoundPlay: vi.fn((cb) => {
      listener = cb
      return unsubscribe
    }),
    setSoundRendererReady: vi.fn(),
    ackSoundPlay: vi.fn(),
  }
  const source = {
    buffer: null,
    connect: vi.fn(),
    start: options.startFails ? vi.fn(() => { throw new Error('start') }) : vi.fn(),
  }
  const gain = { gain: { value: 0 }, connect: vi.fn() }
  const context = {
    state: options.state ?? 'running',
    destination: {},
    resume: options.resumeFails
      ? vi.fn().mockRejectedValue(new Error('resume'))
      : vi.fn(async function (this: { state: string }) { this.state = 'running' }),
    decodeAudioData: options.decodeFails
      ? vi.fn().mockRejectedValue(new Error('decode'))
      : vi.fn().mockResolvedValue({ duration: 0.1 }),
    createBufferSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const Ctor = vi.fn(function () { return context }) as unknown as AudioContextConstructor
  let now = 1000
  const player = createSoundPlayer(api, Ctor, () => now)
  const emit = (request: Partial<SoundPlayRequest> = {}) => {
    listener?.({ requestId: 'r1', voice: 'glass', volume: 0.5, expiresAt: 2000, data: new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer, ...request })
  }
  return { api, context, source, gain, player, emit, unsubscribe, setNow: (value: number) => (now = value) }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.restoreAllMocks())

describe('renderer sound player', () => {
  it('registers once, declares readiness, and acknowledges started after start', async () => {
    const { api, source, gain, emit } = setup()
    expect(api.setSoundRendererReady).toHaveBeenCalledTimes(1)
    emit()
    await flush()
    expect(source.start).toHaveBeenCalledTimes(1)
    expect(gain.gain.value).toBe(0.5)
    expect(api.ackSoundPlay).toHaveBeenCalledWith({ requestId: 'r1', status: 'started' })
  })

  it('resumes a suspended context and caches decoding per voice even under concurrency', async () => {
    const { context, emit } = setup({ state: 'suspended' })
    emit({ requestId: 'r1' })
    emit({ requestId: 'r2' })
    await flush()
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1)
  })

  it('normalizes ArrayBuffer and Uint8Array and clamps gain', async () => {
    const { context, gain, emit } = setup()
    const backing = new Uint8Array([0, 1, 2, 3, 4])
    emit({ volume: 2, data: backing.subarray(1, 4) as unknown as ArrayBuffer })
    await flush()
    expect(new Uint8Array(context.decodeAudioData.mock.calls[0]![0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
    expect(gain.gain.value).toBe(1)
  })

  it.each([
    [{ state: 'suspended' as const, resumeFails: true }, 'context-suspended'],
    [{ decodeFails: true }, 'decode-failed'],
    [{ startFails: true }, 'start-failed'],
  ])('acknowledges failed on a pre-start failure (%s)', async (options, reason) => {
    const { api, emit } = setup(options)
    emit()
    await flush()
    expect(api.ackSoundPlay).toHaveBeenCalledWith({ requestId: 'r1', status: 'failed', reason })
  })

  it('decoding completed after the deadline does not start WAV playback after fallback', async () => {
    let resolveDecode!: (value: unknown) => void
    const { api, context, source, emit, setNow } = setup()
    context.decodeAudioData.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDecode = resolve }),
    )
    emit()
    await Promise.resolve()
    setNow(2000)
    resolveDecode({ duration: 0.1 })
    await flush()
    expect(source.start).not.toHaveBeenCalled()
    expect(api.ackSoundPlay).toHaveBeenCalledWith({ requestId: 'r1', status: 'failed', reason: 'timeout' })
  })

  it('cleanup removes the listener, closes the context, and is idempotent', async () => {
    const { context, player, emit, unsubscribe } = setup()
    emit()
    await flush()
    await player.dispose()
    await player.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })
})
