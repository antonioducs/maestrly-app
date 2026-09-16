import { z } from 'zod'
import { id, revision } from './common.js'
import { sessionIdSchema } from './bot-sessions.js'
import { isoDate } from './bots.js'

// Live desktop and human handoff. Viewing never authorizes control: every input is
// checked by the Host and again by the guest supervisor against lease, epoch and
// desktop generation. Public projections never carry sockets, PIDs, paths or tokens.
export const DESKTOP_LIVE_CAPABILITY = 'desktop.live.v1'
export const DESKTOP_HANDOFF_CAPABILITY = 'desktop.handoff.v1'
export const DESKTOP_CAPABILITIES = [DESKTOP_LIVE_CAPABILITY, DESKTOP_HANDOFF_CAPABILITY] as const
export const DESKTOP_LIMITS = {
  controlRenewMs: 3_000,
  controlLeaseMs: 12_000,
  viewerRenewMs: 3_000,
  viewerLeaseMs: 12_000,
  ticketMs: 30_000,
  inputBatchMax: 64,
  textMax: 4_096,
  eventsPerSecond: 256,
  moveHz: 60,
  viewersPerBot: 2,
  viewersPerHost: 4,
  transmitterIdleMs: 5_000,
  interruptMs: 10_000,
  wheelStepMax: 10,
  coordinateMax: 4_095,
} as const

export const desktopModeSchema = z.enum(['bot', 'acquiring', 'human', 'paused', 'resuming', 'blocked'])
export type DesktopMode = z.infer<typeof desktopModeSchema>
/** Modes in which the Host refuses to start, dispatch or retry any bot work. */
export const DESKTOP_HOLD_MODES: ReadonlySet<DesktopMode> = new Set(['acquiring', 'human', 'paused', 'resuming', 'blocked'])
export const DESKTOP_ERROR_CODES = [
  'DESKTOP_UPDATE_REQUIRED',
  'DESKTOP_UNAVAILABLE',
  'CONTROL_BUSY',
  'CONTROL_EXPIRED',
  'STALE_DESKTOP',
  'INPUT_SEQUENCE_INVALID',
  'HANDOFF_UNCERTAIN',
  'BOT_PAUSED_BY_USER',
] as const
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number]
const code = z.string().regex(/^[A-Z_]{1,64}$/)
const capabilityToken = z.string().regex(/^[a-f0-9]{64}$/)
export const desktopGenerationSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:._-]+$/)

export const desktopStateSchema = z.strictObject({
  botId: id,
  sessionId: sessionIdSchema,
  revision,
  controlEpoch: revision,
  mode: desktopModeSchema,
  desktopGeneration: desktopGenerationSchema.optional(),
  width: z.number().int().min(0).max(4096),
  height: z.number().int().min(0).max(4096),
  /** Present only while an interrupted task can still be continued. */
  interruptedTurnId: id.optional(),
  reasonCode: code.optional(),
  /** Whether some viewer currently holds control; never who. */
  controlled: z.boolean(),
  viewers: z.number().int().nonnegative().max(16),
  capabilities: z.array(z.enum(DESKTOP_CAPABILITIES)).max(2),
  available: z.boolean(),
  updatedAt: isoDate,
})
export type DesktopState = z.infer<typeof desktopStateSchema>

export const desktopOperationSchema = z.strictObject({
  id,
  botId: id,
  sessionId: sessionIdSchema,
  kind: z.enum(['acquire', 'return']),
  status: z.enum(['running', 'succeeded', 'failed']),
  phase: z.enum(['intent', 'interrupting', 'stopping', 'confirmed', 'releasing', 'capturing', 'resuming', 'continuing', 'completed', 'failed']),
  controlEpoch: revision,
  viewId: id.optional(),
  continueTask: z.boolean().optional(),
  interruptedTurnId: id.optional(),
  continuationTurnId: id.optional(),
  /** Stable code only; no free text crosses the sanitizer of the Host socket. */
  failureCode: code.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type DesktopOperation = z.infer<typeof desktopOperationSchema>

const coordinate = z.number().int().min(0).max(DESKTOP_LIMITS.coordinateMax)
const wheel = z.number().int().min(-DESKTOP_LIMITS.wheelStepMax).max(DESKTOP_LIMITS.wheelStepMax)
/** Printable text only: control characters would become unintended shortcuts on the guest. */
const typedText = z
  .string()
  .min(1)
  .max(DESKTOP_LIMITS.textMax)
  .refine((text) => !/[\u0000-\u001f\u007f-\u009f]/.test(text), 'Control characters are not text input')
export const desktopInputEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pointer'), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal('button'), button: z.enum(['left', 'middle', 'right']), down: z.boolean(), x: coordinate, y: coordinate }),
  z.strictObject({ kind: z.literal('wheel'), x: coordinate, y: coordinate, deltaX: wheel, deltaY: wheel }),
  z.strictObject({ kind: z.literal('key'), code: z.string().regex(/^[A-Za-z0-9]{1,40}$/), keysym: z.number().int().min(1).max(0x1ffffff), down: z.boolean() }),
  z.strictObject({ kind: z.literal('text'), text: typedText }),
  z.strictObject({ kind: z.literal('releaseAll') }),
])
export type DesktopInput = z.infer<typeof desktopInputEventSchema>
export const desktopInputBatchSchema = z
  .array(desktopInputEventSchema)
  .min(1)
  .max(DESKTOP_LIMITS.inputBatchMax)
  .refine(
    (events) => events.reduce((sum, event) => sum + (event.kind === 'text' ? event.text.length : 0), 0) <= DESKTOP_LIMITS.textMax,
    'Text per batch exceeds the limit'
  )
export const inputSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const desktopRequestParams = {
  inspect: z.strictObject({ botId: id }),
  open: z.strictObject({ botId: id, clientInstanceId: id }),
  close: z.strictObject({ viewId: id }),
  acquire: z.strictObject({ viewId: id, expectedRevision: revision, idempotencyKey: id }),
  operationGet: z.strictObject({ operationId: id }),
  operationLookup: z.strictObject({ idempotencyKey: id }),
  claimControl: z.strictObject({ viewId: id, operationId: id }),
  renew: z.strictObject({ viewId: id, controlEpoch: revision.optional(), controlCapability: capabilityToken.optional() }),
  input: z.strictObject({
    viewId: id,
    controlCapability: capabilityToken,
    controlEpoch: revision,
    desktopGeneration: desktopGenerationSchema,
    sequence: inputSequenceSchema,
    events: desktopInputBatchSchema,
  }),
  return: z.strictObject({
    botId: id,
    viewId: id.optional(),
    controlCapability: capabilityToken.optional(),
    expectedRevision: revision,
    idempotencyKey: id,
    continueTask: z.boolean(),
  }),
} as const
export const desktopOpenResultSchema = z.strictObject({
  viewId: id,
  mediaTicket: capabilityToken,
  ticketExpiresAt: isoDate,
  state: desktopStateSchema,
})
export const desktopClaimResultSchema = z.strictObject({
  controlCapability: capabilityToken,
  controlEpoch: revision,
  desktopGeneration: desktopGenerationSchema,
  leaseMs: z.number().int().positive(),
  renewMs: z.number().int().positive(),
  state: desktopStateSchema,
})
export const desktopRenewResultSchema = z.strictObject({ state: desktopStateSchema, controlling: z.boolean() })
export const desktopInputResultSchema = z.strictObject({ sequence: inputSequenceSchema, applied: z.number().int().nonnegative() })
export const desktopCloseResultSchema = z.strictObject({ closed: z.literal(true), state: desktopStateSchema.optional() })
