import type { SoundVoice } from './sound'

export type SoundPlaybackFailure =
  | 'asset-missing'
  | 'asset-read-failed'
  | 'renderer-unavailable'
  | 'context-suspended'
  | 'decode-failed'
  | 'start-failed'
  | 'timeout'

export interface SoundPlayRequest {
  requestId: string
  voice: SoundVoice
  volume: number

  expiresAt: number
  data: ArrayBuffer
}

export type SoundPlayAck =
  | { requestId: string; status: 'started' }
  | { requestId: string; status: 'failed'; reason: SoundPlaybackFailure }
