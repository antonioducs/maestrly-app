import { z } from 'zod'
import { id, revision, errorSchema } from './common.js'
import { isoDate } from './bots.js'
import { targetRefSchema } from './routines.js'

/**
 * Voice messages. Audio is captured on the person's own computer and transcribed on the
 * Host they chose, in a separate worker process — never inside a bot's VM and never by a
 * third-party service. Only the text the person confirms is sent to the AI provider.
 *
 * Nothing in this contract carries a filesystem path, a URL, a model file, a device name or
 * the audio bytes themselves outside the explicit chunked transfer.
 */
export const VOICE_HOST_CAPABILITY = 'voice.messages.v1'
export const VOICE_TRANSCRIPT_MAX = 16_000

/** Canonical audio the Host accepts: nothing else is decoded, probed or converted server-side. */
export const VOICE_AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
} as const

export const VOICE_LIMITS = {
  maxDurationMs: 5 * 60_000,
  /** Largest compressed recording the application may hold locally before converting. */
  maxCompressedBytes: 20 * 1024 * 1024,
  /** 44 byte RIFF header + 5 min × 16 000 × 2 bytes. */
  maxWavBytes: 9_600_044,
  chunkBytes: 48 * 1024,
  /** Transcription jobs waiting behind the single active one. */
  queueMax: 8,
  jobTimeoutMs: 10 * 60_000,
  /** The worker exits after this much idle time; the model is not resident forever. */
  workerIdleMs: 120_000,
  /** Abandoned drafts, uploads and jobs expire; they are not kept "just in case". */
  draftTtlMs: 24 * 60 * 60_000,
  clipTtlDays: 30,
  quotaBytes: 1024 * 1024 * 1024,
  transferTtlMs: 30 * 60_000,
  maxInferenceThreads: 2,
} as const

export const voiceClipStateSchema = z.enum(['uploading', 'stored', 'expired', 'removed'])
export type VoiceClipState = z.infer<typeof voiceClipStateSchema>

/** One recording kept on the Host. `bytes` is the verified canonical WAV size. */
export const voiceClipSchema = z.strictObject({
  id,
  target: targetRefSchema,
  state: voiceClipStateSchema,
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sampleRate: z.literal(VOICE_AUDIO.sampleRate),
  channels: z.literal(VOICE_AUDIO.channels),
  /** Set once the clip is attached to a message; a loose clip expires with the draft TTL. */
  messageId: id.optional(),
  expiresAt: isoDate,
  createdAt: isoDate,
  updatedAt: isoDate,
  revision,
})
export type VoiceClip = z.infer<typeof voiceClipSchema>

export const voiceTransferSchema = z.strictObject({
  transferId: id,
  clipId: id,
  target: targetRefSchema,
  size: z.number().int().positive().max(VOICE_LIMITS.maxWavBytes),
  offset: z.number().int().nonnegative(),
  chunkBytes: z.literal(VOICE_LIMITS.chunkBytes),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  done: z.boolean(),
  expiresAt: isoDate,
})
export type VoiceTransfer = z.infer<typeof voiceTransferSchema>

export const voiceJobStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type VoiceJobState = z.infer<typeof voiceJobStateSchema>

/** Stable reasons a transcription did not produce usable text. */
export const voiceFailureCodeSchema = z.enum([
  'ASR_UNAVAILABLE',
  'ASR_MODEL_MISSING',
  'ASR_TIMEOUT',
  'ASR_CRASHED',
  'ASR_QUEUE_FULL',
  'ASR_CANCELLED',
  'ASR_NO_SPEECH',
])
export type VoiceFailureCode = z.infer<typeof voiceFailureCodeSchema>

export const voiceJobSchema = z.strictObject({
  id,
  clipId: id,
  target: targetRefSchema,
  state: voiceJobStateSchema,
  /** Fenced against a late answer from a worker that was already replaced. */
  generation: z.number().int().positive(),
  queuePosition: z.number().int().nonnegative().default(0),
  /** Exactly what the model produced, before any edit by the person. */
  transcript: z.string().max(VOICE_TRANSCRIPT_MAX).optional(),
  /** Bumped every time the Host writes a new transcript for this clip. */
  transcriptRevision: revision.default(0),
  language: z.string().max(16).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  failureCode: voiceFailureCodeSchema.optional(),
  error: errorSchema.optional(),
  startedAt: isoDate.optional(),
  finishedAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  revision,
})
export type VoiceJob = z.infer<typeof voiceJobSchema>

/**
 * Sidecar that links an existing conversation message to its recording and transcript.
 * Removing the audio never removes the message; the text stays, clearly marked.
 */
export const voiceMessageMetaSchema = z.strictObject({
  messageId: id,
  clipId: id,
  target: targetRefSchema,
  durationMs: z.number().int().nonnegative(),
  /** The machine transcript, kept apart from what the person actually sent. */
  transcript: z.string().max(VOICE_TRANSCRIPT_MAX),
  edited: z.boolean(),
  audioAvailable: z.boolean(),
  expiresAt: isoDate,
  createdAt: isoDate,
})
export type VoiceMessageMeta = z.infer<typeof voiceMessageMetaSchema>

export const voiceStatusSchema = z.strictObject({
  /** Whether this Host has a verified ASR bundle installed at all. */
  available: z.boolean(),
  state: z.enum(['ready', 'missing', 'installing', 'incompatible']),
  modelId: z.string().max(80).optional(),
  reason: z.string().max(400).optional(),
  /** Bytes a first activation would have to fetch, so the app can say so up front. */
  downloadBytes: z.number().int().nonnegative().optional(),
  queueDepth: z.number().int().nonnegative().default(0),
  activeJobId: id.optional(),
  quotaBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  limits: z.strictObject({
    maxDurationMs: z.literal(VOICE_LIMITS.maxDurationMs),
    maxWavBytes: z.literal(VOICE_LIMITS.maxWavBytes),
    sampleRate: z.literal(VOICE_AUDIO.sampleRate),
    channels: z.literal(VOICE_AUDIO.channels),
  }),
})
export type VoiceStatus = z.infer<typeof voiceStatusSchema>

export const voiceOperationSchema = z.strictObject({
  id,
  kind: z.enum(['voice.send', 'voice.clip.remove']),
  clipId: id.optional(),
  messageId: id.optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  detail: z.record(z.string(), z.unknown()).optional(),
  error: errorSchema.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type VoiceOperation = z.infer<typeof voiceOperationSchema>

export const VOICE_ERROR_CODES = [
  'VOICE_UNAVAILABLE',
  'VOICE_CLIP_NOT_FOUND',
  'VOICE_CLIP_EXPIRED',
  'VOICE_TRANSCRIPT_REQUIRED',
  'VOICE_TRANSCRIPT_STALE',
  'VOICE_FORMAT_INVALID',
  'VOICE_QUOTA_EXCEEDED',
  'VOICE_TRANSFER_CONFLICT',
  'VOICE_JOB_NOT_READY',
] as const
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number]
