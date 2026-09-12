import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { SoundVoice } from '../../shared/sound'
import type { SoundPlayAck, SoundPlaybackFailure } from '../../shared/sound-playback'
import { isSoundVoice, readSoundAsset, validSoundVolume } from './assets'
import { playNativeSound } from './native-player'

const PLAYBACK_TIMEOUT_MS = 1500
// Renderer playback cannot start after PLAYBACK_TIMEOUT_MS; this grace only lets its acknowledgment cross
// IPC before fallback.
const ACK_GRACE_MS = 250
const WARN_RATE_LIMIT_MS = 60_000

interface PendingPlayback {
  voice: SoundVoice
  volume: number
  timer: ReturnType<typeof setTimeout>
}

export interface SoundServiceDeps {
  readAsset: typeof readSoundAsset
  playFallback: typeof playNativeSound
  makeRequestId: () => string
  now: () => number
  warn: (message: string) => void
  timeoutMs: number
  warnRateLimitMs: number
}

const defaultDeps: SoundServiceDeps = {
  readAsset: readSoundAsset,
  playFallback: playNativeSound,
  makeRequestId: randomUUID,
  now: Date.now,
  warn: console.warn,
  timeoutMs: PLAYBACK_TIMEOUT_MS,
  warnRateLimitMs: WARN_RATE_LIMIT_MS,
}

export class SoundService {
  private target: WebContents | null = null
  private rendererReady = false
  private readonly pending = new Map<string, PendingPlayback>()
  private readonly warnedAt = new Map<SoundPlaybackFailure, number>()

  constructor(private readonly deps: SoundServiceDeps = defaultDeps) {}

  setTarget(target: WebContents | null): void {
    if (this.target === target) return
    this.clearPending(true, 'renderer-unavailable')
    this.target = target && !target.isDestroyed() ? target : null
    this.rendererReady = false
  }

  getTarget(): WebContents | null {
    return this.target && !this.target.isDestroyed() ? this.target : null
  }

  setRendererReady(sender: WebContents): void {
    if (sender === this.getTarget()) this.rendererReady = true
  }

  invalidateRenderer(sender?: WebContents): void {
    if (sender && sender !== this.target) return
    this.rendererReady = false
    this.clearPending(true, 'renderer-unavailable')
  }

  play(voice: SoundVoice, volume = 1): void {
    if (!isSoundVoice(voice)) return
    const validVolume = validSoundVolume(volume)
    if (validVolume === null || validVolume <= 0) return

    const target = this.getTarget()
    if (!target || !this.rendererReady) {
      this.fallback(voice, validVolume, 'renderer-unavailable')
      return
    }

    const asset = this.deps.readAsset(voice)
    if (!asset.ok) {
      this.fallback(voice, validVolume, asset.reason)
      return
    }

    const requestId = this.deps.makeRequestId()
    const expiresAt = this.deps.now() + this.deps.timeoutMs
    const data = asset.data.buffer.slice(
      asset.data.byteOffset,
      asset.data.byteOffset + asset.data.byteLength
    ) as ArrayBuffer
    const timer = setTimeout(() => {
      const pending = this.takePending(requestId)
      if (pending) this.fallback(pending.voice, pending.volume, 'timeout')
    }, this.deps.timeoutMs + ACK_GRACE_MS)
    timer.unref?.()
    this.pending.set(requestId, { voice, volume: validVolume, timer })

    try {
      target.send('sound:play', { requestId, voice, volume: validVolume, expiresAt, data })
    } catch {
      const pending = this.takePending(requestId)
      if (pending) this.fallback(pending.voice, pending.volume, 'renderer-unavailable')
    }
  }

  acknowledge(sender: WebContents, ack: SoundPlayAck): void {
    if (sender !== this.getTarget()) return
    const pending = this.takePending(ack.requestId)
    if (!pending || ack.status === 'started') return
    this.fallback(pending.voice, pending.volume, ack.reason)
  }

  private takePending(requestId: string): PendingPlayback | null {
    const pending = this.pending.get(requestId)
    if (!pending) return null
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    return pending
  }

  private clearPending(fallback: boolean, reason: SoundPlaybackFailure = 'renderer-unavailable'): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId)
      if (fallback && pending) this.fallback(pending.voice, pending.volume, reason)
    }
  }

  private fallback(voice: SoundVoice, volume: number, reason: SoundPlaybackFailure): void {
    const now = this.deps.now()
    const last = this.warnedAt.get(reason)
    if (last === undefined || now - last >= this.deps.warnRateLimitMs) {
      this.warnedAt.set(reason, now)
      this.deps.warn(`[sound] primary playback failed (${reason}); attempting native fallback`)
    }
    try {
      this.deps.playFallback(voice, volume)
    } catch {
      /* Fallback playback is also best-effort. */
    }
  }
}

export const soundService = new SoundService()

/** Synchronous best-effort facade consumed by platform.ts. */
export function playManagedSound(voice: SoundVoice, volume = 1): void {
  soundService.play(voice, volume)
}
