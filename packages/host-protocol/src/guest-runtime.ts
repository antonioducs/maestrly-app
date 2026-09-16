import { delegatedCredentialSchema, accountCredentialRequestSchema, accountCredentialResponseSchema } from './delegated-auth.js'
import { z } from 'zod'
import { id } from './common.js'
import { networkPolicySchema } from './bot-policy.js'
import { collaborationRequestSchema, collaborationResponseSchema, teamTurnContextSchema } from './team-runtime.js'

// Private virtio-serial control channel between Host and the Linux runtime inside a VM.
// Frames are JSONL up to 256 KiB. File chunks are 48 KiB before base64. The Host
// associates a session with the VM whose channel it opened; a guest-supplied vmId
// never selects another VM.
export const GUEST_PROTOCOL = 'bot.runtime.v1'
export const CONTROL_PORT_NAME = 'org.maestrly.bot.control.0'
export const EGRESS_PORT_NAME = 'org.maestrly.bot.egress.0'
export const CONTROL_FRAME_MAX = 256 * 1024
export const FILE_CHUNK_BYTES = 48 * 1024
export const CONTROL_QUEUE_MAX = 64

export const guestHelloSchema = z.strictObject({
  type: z.literal('hello'),
  protocol: z.literal(GUEST_PROTOCOL),
  runtimeVersion: z.string().min(1).max(60),
  bootId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  nonce: z.string().min(16).max(128),
  capabilities: z.array(z.string().min(1).max(60)).max(32),
})
export const hostWelcomeSchema = z.strictObject({
  type: z.literal('welcome'),
  protocol: z.literal(GUEST_PROTOCOL),
  sessionId: id,
  nonce: z.string().min(16).max(128),
  hostGeneration: z.number().int().positive(),
})
export const runtimeCapabilitySchema = z.enum([
  'provider.codex',
  'tools.files',
  'tools.shell',
  'tools.system',
  'tools.browser',
  'tools.computer',
  'tools.memory',
  'network.proxy',
  'desktop.session',
  'teams.collaboration',
])

// Host → guest requests. Every method has its own params; there is no generic exec.
const snapshotSchema = z.strictObject({
  botId: id,
  conversationId: id,
  turnId: id,
  generation: z.number().int().positive(),
  permissionMode: z.enum(['ask', 'full-vm']),
  policyRevision: z.number().int().nonnegative(),
  network: networkPolicySchema,
  instructions: z.string().max(16_000),
  memory: z.array(z.strictObject({ id, content: z.string().max(8192) })).max(256),
  contextSummary: z.string().max(16_000).optional(),
  recentMessages: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().max(64 * 1024) }))
    .max(64),
  message: z.string().max(64 * 1024),
  attachments: z.array(z.string().min(1).max(512)).max(16),
  model: z.strictObject({ model: z.string().min(1).max(120), effort: z.string().max(20).optional() }).optional(),
  providerThreadId: z.string().max(200).optional(),
  leaseMs: z.number().int().positive(),
  limits: z.strictObject({
    activeMs: z.number().int().positive(),
    maxTools: z.number().int().positive(),
    maxLogBytes: z.number().int().positive(),
  }),
  /**
   * Present only for a turn that belongs to a team task, and only when the runtime
   * announced the team capability. An older guest keeps receiving the exact v1 shape.
   */
  team: teamTurnContextSchema.optional(),
})
export type TurnSnapshot = z.infer<typeof snapshotSchema>
const turnIdentity = z.strictObject({ turnId: id, generation: z.number().int().positive() })
const hostRequest = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ type: z.literal('request'), id, method: z.literal(method), params })
export const hostToGuestRequestSchema = z.discriminatedUnion('method', [
  hostRequest('runtime.inspect', z.strictObject({})),
  hostRequest('models.list', z.strictObject({})),
  hostRequest('auth.prepareDelegation', z.strictObject({})),
  hostRequest('auth.delegate', z.strictObject({ credential: delegatedCredentialSchema })),
  hostRequest('auth.exportLegacy', z.strictObject({})),
  hostRequest('auth.commitMigration', z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) })),
  hostRequest('auth.status', z.strictObject({})),
  hostRequest('auth.start', z.strictObject({ method: z.enum(['device', 'apiKey']), secretRef: id.optional() })),
  hostRequest('auth.cancel', z.strictObject({ loginId: z.string().min(1).max(128) })),
  hostRequest('auth.logout', z.strictObject({})),
  hostRequest('auth.secret', z.strictObject({ secretRef: id, apiKey: z.string().min(8).max(512) })),
  hostRequest('turn.start', snapshotSchema),
  hostRequest('turn.reconcile', turnIdentity),
  hostRequest('turn.cancel', turnIdentity),
  hostRequest('turn.lease', z.strictObject({ ...turnIdentity.shape, leaseMs: z.number().int().positive() })),
  hostRequest(
    'interaction.resolve',
    z.strictObject({
      ...turnIdentity.shape,
      actionId: id,
      decision: z.enum(['approve', 'deny', 'answer']),
      answer: z.string().max(8000).optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  hostRequest('policy.update', z.strictObject({ network: networkPolicySchema, permissionMode: z.enum(['ask', 'full-vm']) })),
  hostRequest('files.list', z.strictObject({ path: z.string().max(512).default('') })),
  hostRequest(
    'files.read',
    z.strictObject({ path: z.string().min(1).max(512), offset: z.number().int().nonnegative(), length: z.number().int().positive().max(FILE_CHUNK_BYTES) })
  ),
  hostRequest(
    'files.write',
    z.strictObject({
      transferId: id,
      path: z.string().min(1).max(512),
      offset: z.number().int().nonnegative(),
      dataBase64: z.string().max(Math.ceil((FILE_CHUNK_BYTES * 4) / 3) + 4),
      final: z.boolean(),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      overwrite: z.boolean().default(false),
    })
  ),
  hostRequest('files.abort', z.strictObject({ transferId: id })),
  hostRequest('files.stat', z.strictObject({ path: z.string().min(1).max(512) })),
])
export type HostToGuestRequest = z.infer<typeof hostToGuestRequestSchema>

export const guestEventSchema = z.strictObject({
  type: z.literal('event'),
  runtimeEventId: z.string().min(1).max(128),
  turnId: id.optional(),
  generation: z.number().int().positive().optional(),
  kind: z.enum([
    'turn.status',
    'assistant.delta',
    'assistant.message',
    'tool.started',
    'tool.finished',
    'approval.requested',
    'question.asked',
    'file.produced',
    'memory.proposed',
    'account.changed',
    'diagnostic',
  ]),
  summary: z.string().max(400),
  detail: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(20).max(40),
})
export type GuestEvent = z.infer<typeof guestEventSchema>
export const guestResponseSchema = z.strictObject({
  type: z.literal('response'),
  id,
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(2000) }).optional(),
})
export const hostAckSchema = z.strictObject({ type: z.literal('ack'), runtimeEventId: z.string().min(1).max(128) })
export const guestFrameSchema = z.discriminatedUnion('type', [guestHelloSchema, guestEventSchema, guestResponseSchema, accountCredentialRequestSchema, collaborationRequestSchema])
export const hostFrameSchema = z.discriminatedUnion('type', [hostWelcomeSchema, hostToGuestRequestSchema, hostAckSchema, accountCredentialResponseSchema, collaborationResponseSchema])
export type GuestFrame = z.infer<typeof guestFrameSchema>
export type HostFrame = z.infer<typeof hostFrameSchema>
