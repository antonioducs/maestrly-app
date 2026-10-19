import type { FleetDictationTranscribeRequest, FleetDictationTranscribeResponse } from '@maestrly/bot-fleet-protocol'
import type { Recording, RecordingEngine } from './session'

/** The phone's recorder, behind what the server engine needs of it (see recorder.ts). */
export interface AudioRecorderLike {
  requestPermission(): Promise<boolean>
  /** `onLevelDb` hears the recording's level in dBFS, from about -160 (silence) to 0. */
  start(onLevelDb: (db: number) => void): Promise<void>
  stop(): Promise<Recording | null>
  abort(): void
}

/** The recording's level for the listening indicator: -60 dBFS and below is silent, 0 is as loud as it gets. */
export const levelFromDb = (db: number): number => Math.min(1, Math.max(0, (db + 60) / 60))

/**
 * Dictation through the bot server: the phone records AAC in M4A, and the server sends it to its speech-to-text
 * provider with its own key. A failure to reach the server is told like a failed transcription, so the person can
 * send the same recording again.
 */
export function serverRecordingEngine(deps: {
  recorder: AudioRecorderLike
  transcribe: (body: FleetDictationTranscribeRequest) => Promise<FleetDictationTranscribeResponse>
  readBase64: (uri: string) => Promise<string>
  deleteFile: (uri: string) => void
}): RecordingEngine {
  return {
    available: () => true,
    requestPermission: () => deps.recorder.requestPermission(),
    start: (onLevel) => deps.recorder.start((db) => onLevel(levelFromDb(db))),
    stop: () => deps.recorder.stop(),
    abort: () => deps.recorder.abort(),
    async transcribe(recording, language) {
      try {
        const audio = await deps.readBase64(recording.uri)
        return await deps.transcribe({ audio, mediaType: 'audio/mp4', language })
      } catch {
        return { error: 'unavailable' }
      }
    },
    discard(recording) {
      try {
        deps.deleteFile(recording.uri)
      } catch {
        // The system clears the cache folder the recordings are in.
      }
    },
  }
}
