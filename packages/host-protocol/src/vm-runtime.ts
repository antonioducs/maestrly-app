import { z } from 'zod'
import { id } from './common.js'
import { sessionCapacitySchema, sessionIdSchema, sessionProfileSchema } from './bot-sessions.js'
import { networkPolicySchema } from './bot-policy.js'
import { DESKTOP_CAPABILITIES, desktopGenerationSchema, desktopInputBatchSchema, inputSequenceSchema } from './desktop.js'

export const VM_RUNTIME_PROTOCOL = 'bot.vm.v1'
export const VM_ROUTE_CHUNK = 48 * 1024
export const VM_ROUTE_QUEUE_BYTES = 4 * 1024 * 1024
export const VM_ROUTE_LIMIT = 32
export const vmHelloSchema = z.strictObject({
  type: z.literal('vm.hello'), protocol: z.literal(VM_RUNTIME_PROTOCOL),
  version: z.string().min(1).max(60), bootId: sessionIdSchema, generation: z.number().int().positive(),
  nonce: sessionIdSchema,
})
export const vmWelcomeSchema = z.strictObject({
  type: z.literal('vm.welcome'), protocol: z.literal(VM_RUNTIME_PROTOCOL), nonce: sessionIdSchema,
  hostId: sessionIdSchema, hostGeneration: z.number().int().positive(),
})
const sessionIdentity = { sessionId: sessionIdSchema, generation: z.number().int().positive() }
const desktopScope = { ...sessionIdentity, epoch: z.number().int().positive() }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ type: z.literal('vm.request'), id, method: z.literal(method), params })
export const vmRequestSchema = z.discriminatedUnion('method', [
  request('vm.inspect', z.strictObject({})),
  request('session.create', z.strictObject({ sessionId: sessionIdSchema, botId: id, profile: sessionProfileSchema, idempotencyKey: id, adoptLegacy: z.boolean().default(false) })),
  request('session.inspect', z.strictObject({ sessionId: sessionIdSchema })),
  request('session.start', z.strictObject({ ...sessionIdentity, idempotencyKey: id })),
  request('session.stop', z.strictObject({ ...sessionIdentity, idempotencyKey: id })),
  request('session.lease', z.strictObject({ ...sessionIdentity, turnId: id, leaseMs: z.number().int().min(1000).max(30000) })),
  request('session.release', z.strictObject({ ...sessionIdentity, turnId: id })),
  // Desktop handoff. The Host allocates a strictly increasing control epoch; the guest
  // persists it with the hold so no restart can silently return control to the bot.
  request('desktop.inspect', z.strictObject(sessionIdentity)),
  request('desktop.hold', z.strictObject({ ...desktopScope, idempotencyKey: id, network: networkPolicySchema })),
  request('desktop.acquire', z.strictObject({ ...desktopScope, idempotencyKey: id })),
  request('desktop.lease', z.strictObject({ ...desktopScope, leaseMs: z.number().int().min(1000).max(30000) })),
  request('desktop.pause', z.strictObject(desktopScope)),
  request('desktop.input', z.strictObject({ ...desktopScope, desktopGeneration: desktopGenerationSchema, sequence: inputSequenceSchema, events: desktopInputBatchSchema })),
  request('desktop.release', z.strictObject({ ...desktopScope, idempotencyKey: id })),
  request('desktop.capture', z.strictObject({ ...desktopScope, observationId: z.string().uuid() })),
  request('desktop.resume', z.strictObject({ ...desktopScope, idempotencyKey: id })),
  request('desktop.policy', z.strictObject({ ...sessionIdentity, network: networkPolicySchema })),
  request('desktop.viewer.open', z.strictObject({ ...sessionIdentity, grantId: z.string().uuid() })),
  request('desktop.viewer.close', z.strictObject({ sessionId: sessionIdSchema, grantId: z.string().uuid() })),
])
export type VmRequest = z.infer<typeof vmRequestSchema>
export const vmDesktopInfoSchema = z.strictObject({
  sessionId: sessionIdSchema,
  mode: z.enum(['bot', 'acquiring', 'human', 'paused', 'resuming']),
  epoch: z.number().int().nonnegative(),
  desktopGeneration: desktopGenerationSchema.optional(),
  width: z.number().int().min(0).max(4096),
  height: z.number().int().min(0).max(4096),
  automation: z.enum(['running', 'stopped', 'unknown']),
  services: z.enum(['running', 'stopped', 'unknown']),
  viewers: z.number().int().nonnegative().max(16),
  capabilities: z.array(z.enum(DESKTOP_CAPABILITIES)).max(2),
})
export type VmDesktopInfo = z.infer<typeof vmDesktopInfoSchema>
export const vmDesktopCaptureSchema = z.strictObject({
  path: z.string().regex(/^\.maestrly\/screens\/[a-f0-9-]{36}\.png$/),
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(8 * 1024 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  desktopGeneration: desktopGenerationSchema,
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
})
export type VmDesktopCapture = z.infer<typeof vmDesktopCaptureSchema>
export const vmDesktopInputResultSchema = z.strictObject({ sequence: inputSequenceSchema, applied: z.number().int().nonnegative() })
export const vmDesktopViewerSchema = z.strictObject({
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  desktopGeneration: desktopGenerationSchema,
})
export type VmDesktopViewer = z.infer<typeof vmDesktopViewerSchema>
export const vmSessionInfoSchema = z.strictObject({
  id: sessionIdSchema, botId: id, profile: sessionProfileSchema,
  state: z.enum(['preparing', 'running', 'stopped', 'needs_attention']),
  generation: z.number().int().positive(), desiredState: z.enum(['running', 'stopped']),
})
export type VmSessionInfo = z.infer<typeof vmSessionInfoSchema>
export const vmInfoSchema = z.strictObject({
  capabilities: z.array(z.string().min(1).max(60)).max(32).default([]),
  capacity: sessionCapacitySchema.optional(), sessions: z.array(vmSessionInfoSchema).max(100),
  memoryMiB: z.number().int().positive(), cpus: z.number().int().positive(), freeDiskMiB: z.number().int().nonnegative(),
})
export const vmResponseSchema = z.strictObject({
  type: z.literal('vm.response'), id, result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(400) }).optional(),
}).refine(v => Number(Object.hasOwn(v, 'result')) + Number(!!v.error) === 1, 'One result or error required')
const route = { ...sessionIdentity, connectionId: sessionIdSchema }
export const routeFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('route.open'), ...route }),
  z.strictObject({ type: z.literal('route.ready'), ...route }),
  z.strictObject({ type: z.literal('route.data'), ...route, sequence: z.number().int().nonnegative(), data: z.string().min(4).max(VM_ROUTE_CHUNK * 4 / 3) }),
  z.strictObject({ type: z.literal('route.ack'), ...route, sequence: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('route.end'), ...route }),
  z.strictObject({ type: z.literal('route.close'), ...route }),
])
export type RouteFrame = z.infer<typeof routeFrameSchema>
