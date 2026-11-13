import type { SpeechSegment } from './asr-audio'

export interface WhisperContextLike {
  transcribeData(
    audio: ArrayBuffer,
    options?: { language?: string; maxThreads?: number }
  ): { promise: Promise<{ result: string }> }
  release(): Promise<void>
}

export interface VadContextLike {
  detectSpeechData(audio: ArrayBuffer): Promise<SpeechSegment[]>
  release(): Promise<void>
}

export interface WhisperAddon {
  WhisperContext: new (o: { filePath: string; useGpu?: boolean; useFlashAttn?: boolean }) => WhisperContextLike
  WhisperVadContext: new (o: { filePath: string; useGpu?: boolean; nThreads?: number }) => VadContextLike
}
