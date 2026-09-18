import { z } from 'zod'
import { id, revision } from './common.js'
import { targetRefSchema } from './routines.js'
import {
  VOICE_LIMITS,
  VOICE_TRANSCRIPT_MAX,
  voiceClipSchema,
  voiceJobSchema,
  voiceMessageMetaSchema,
  voiceOperationSchema,
  voiceStatusSchema,
  voiceTransferSchema,
} from './voice.js'
import { botMessageSchema, botTurnSchema } from './bots.js'
import { teamMessageSchema, teamRunSchema } from './teams.js'

/**
 * Public voice methods. Audio only ever moves through the explicit chunked transfer below:
 * there is no URL, no path and no "import this file" shape anywhere in this contract, and
 * reading a clip back is always by clip identity with the target it belongs to.
 */
const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ ...envelope, method: z.literal(method), params })
const chunkBase64 = z.string().max(Math.ceil((VOICE_LIMITS.chunkBytes * 4) / 3) + 4)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const voiceRequests = [
  request('voice.status', z.strictObject({})),
  request(
    'voice.upload.begin',
    z.strictObject({
      target: targetRefSchema,
      /** Chosen by the application when the recording starts; retries reuse it. */
      clientClipId: id,
      sizeBytes: z.number().int().positive().max(VOICE_LIMITS.maxWavBytes),
      durationMs: z.number().int().positive().max(VOICE_LIMITS.maxDurationMs),
      sha256: digest,
    })
  ),
  request('voice.upload.status', z.strictObject({ transferId: id })),
  request('voice.upload.chunk', z.strictObject({ transferId: id, offset: z.number().int().nonnegative(), dataBase64: chunkBase64 })),
  request('voice.upload.finish', z.strictObject({ transferId: id })),
  request('voice.transcribe', z.strictObject({ clipId: id, idempotencyKey: id })),
  request('voice.job.inspect', z.strictObject({ jobId: id })),
  request('voice.job.cancel', z.strictObject({ jobId: id })),
  request('voice.clip.inspect', z.strictObject({ clipId: id })),
  request(
    'voice.clip.read',
    z.strictObject({ clipId: id, offset: z.number().int().nonnegative(), length: z.number().int().positive().max(VOICE_LIMITS.chunkBytes) })
  ),
  request('voice.clip.remove', z.strictObject({ clipId: id, idempotencyKey: id })),
  request(
    'voice.send',
    z.strictObject({
      clipId: id,
      /** Guards against sending text from a transcription that was replaced meanwhile. */
      transcriptRevision: revision,
      editedText: z.string().min(1).max(VOICE_TRANSCRIPT_MAX),
      clientMessageId: id,
    })
  ),
  request('voice.forMessages', z.strictObject({ target: targetRefSchema, messageIds: z.array(id).min(1).max(100) })),
  request('voice.operation.lookup', z.strictObject({ idempotencyKey: id })),
] as const
export const voiceRequestSchema = z.discriminatedUnion('method', [...voiceRequests])
export type VoiceRequest = z.infer<typeof voiceRequestSchema>
export type VoiceMethod = VoiceRequest['method']
export const voiceMethods = voiceRequests.map((schema) => schema.shape.method.value) as readonly VoiceMethod[]

export const voiceChunkSchema = z.strictObject({
  clipId: id,
  offset: z.number().int().nonnegative(),
  dataBase64: chunkBase64,
  done: z.boolean(),
  size: z.number().int().nonnegative(),
})
/** One receipt shape for both targets; exactly one of the two branches is present. */
export const voiceSendReceiptSchema = z.strictObject({
  clip: voiceClipSchema,
  bot: z.strictObject({ message: botMessageSchema, turn: botTurnSchema }).optional(),
  team: z.strictObject({ message: teamMessageSchema, run: teamRunSchema }).optional(),
  meta: voiceMessageMetaSchema,
})
export type VoiceSendReceipt = z.infer<typeof voiceSendReceiptSchema>

export const voiceResultSchemas = {
  'voice.status': voiceStatusSchema,
  'voice.upload.begin': voiceTransferSchema,
  'voice.upload.status': voiceTransferSchema,
  'voice.upload.chunk': voiceTransferSchema,
  'voice.upload.finish': voiceClipSchema,
  'voice.transcribe': voiceJobSchema,
  'voice.job.inspect': voiceJobSchema,
  'voice.job.cancel': voiceJobSchema,
  'voice.clip.inspect': voiceClipSchema,
  'voice.clip.read': voiceChunkSchema,
  'voice.clip.remove': voiceClipSchema,
  'voice.send': voiceSendReceiptSchema,
  'voice.forMessages': z.array(voiceMessageMetaSchema).max(100),
  'voice.operation.lookup': voiceOperationSchema.nullable(),
} satisfies Record<VoiceMethod, z.ZodType>
export type VoiceResult<M extends VoiceMethod> = z.infer<(typeof voiceResultSchemas)[M]>

export const VOICE_MUTATIONS: readonly VoiceMethod[] = [
  'voice.upload.begin',
  'voice.upload.chunk',
  'voice.upload.finish',
  'voice.transcribe',
  'voice.job.cancel',
  'voice.clip.remove',
  'voice.send',
]
