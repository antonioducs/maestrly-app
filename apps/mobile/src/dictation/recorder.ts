import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio'
import { File } from 'expo-file-system'
import { useMemo, useRef } from 'react'
import type { AudioRecorderLike } from './server-engine'

/** Speech only: mono AAC at 16 kHz and 32 kbit/s, about 240 KB a minute, which the speech-to-text APIs take as is. */
const DICTATION_RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  web: { mimeType: 'audio/webm', bitsPerSecond: 32000 },
}
const METER_MS = 100
const SILENT_DB = -160

export const readRecording = (uri: string): Promise<string> => new File(uri).base64()

export function deleteRecording(uri: string): void {
  try {
    new File(uri).delete()
  } catch {
    // Already gone; the cache folder is cleared by the system anyway.
  }
}

/**
 * The phone's recorder for server dictation, through expo-audio. It meters the recording every 100 ms for the
 * listening indicator and keeps its loudest moment, which decides whether there was speech at all. A recorder that
 * never reports a level is taken to have heard something, so no recording is dropped for lack of metering.
 */
export function useDictationRecorder(): AudioRecorderLike {
  const recorder = useAudioRecorder(DICTATION_RECORDING)
  const meter = useRef<ReturnType<typeof setInterval> | null>(null)
  const peak = useRef<number | null>(null)
  return useMemo(() => {
    const stopMeter = () => {
      if (meter.current) clearInterval(meter.current)
      meter.current = null
    }
    // Gives the audio session back, so other apps play again at their volume.
    const release = () => setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    return {
      async requestPermission() {
        return (await requestRecordingPermissionsAsync()).granted
      },
      async start(onLevelDb) {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
        await recorder.prepareToRecordAsync()
        peak.current = null
        recorder.record()
        meter.current = setInterval(() => {
          const db = recorder.getStatus().metering
          if (typeof db !== 'number') return
          peak.current = Math.max(peak.current ?? SILENT_DB, db)
          onLevelDb(db)
        }, METER_MS)
      },
      async stop() {
        stopMeter()
        try {
          await recorder.stop()
        } finally {
          void release()
        }
        const uri = recorder.uri
        return uri ? { uri, peakDb: peak.current ?? 0 } : null
      },
      abort() {
        stopMeter()
        void recorder
          .stop()
          .catch(() => {})
          .finally(() => {
            void release()
            if (recorder.uri) deleteRecording(recorder.uri)
          })
      },
    }
  }, [recorder])
}
