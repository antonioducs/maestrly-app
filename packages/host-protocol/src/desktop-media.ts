import { z } from 'zod'
import { sessionIdSchema } from './bot-sessions.js'

// Private media lane for RFB bytes. It is separate from chat, files, egress and the
// administrative control lane: a congested framebuffer can never delay a lease renewal
// or a stop. Frames are binary with a fixed 20-byte header:
//   magic "MDV1" (4) | type (1) | reserved zero (3) | streamId u32 | sequence u32 | length u32
// Control payloads are small JSON objects; they never name hosts, ports or paths.
export const DESKTOP_PORT_NAME = 'org.maestrly.bot.desktop.0'
export const DESKTOP_MEDIA_PROTOCOL = 'bot.desktop.v1'
export const MEDIA_MAGIC = 0x4d445631 // "MDV1"
export const MEDIA_HEADER_BYTES = 20
export const MEDIA_PAYLOAD_MAX = 64 * 1024
export const MEDIA_CONTROL_PAYLOAD_MAX = 1024
export const MEDIA_INITIAL_CREDIT = 256 * 1024
export const MEDIA_QUEUE_MAX = 4 * 1024 * 1024
/** Streams accepted on one guest lane; the Host enforces the tighter product limits. */
export const MEDIA_LANE_STREAMS = 8
export const MEDIA_STREAMS_PER_HOST = 4
export const MEDIA_VIEWERS_PER_BOT = 2
/** A stream that cannot move bytes for this long is closed; a fresh viewer renegotiates. */
export const MEDIA_STALL_MS = 15_000
export const MEDIA_OPEN_TIMEOUT_MS = 10_000
export const MEDIA_FRAME = { hello: 1, welcome: 2, open: 3, accept: 4, data: 5, credit: 6, end: 7, close: 8 } as const
export type MediaFrameType = (typeof MEDIA_FRAME)[keyof typeof MEDIA_FRAME]

export const mediaHelloSchema = z.strictObject({
  protocol: z.literal(DESKTOP_MEDIA_PROTOCOL),
  bootId: z.string().uuid(),
  generation: z.number().int().positive(),
  nonce: z.string().uuid(),
})
export const mediaWelcomeSchema = z.strictObject({
  protocol: z.literal(DESKTOP_MEDIA_PROTOCOL),
  nonce: z.string().uuid(),
  hostId: z.string().uuid(),
  hostGeneration: z.number().int().positive(),
})
/** The grant is created first on the administrative lane; the guest never chooses a target. */
export const mediaOpenSchema = z.strictObject({
  sessionId: sessionIdSchema,
  generation: z.number().int().positive(),
  grantId: z.string().uuid(),
})
export const mediaCloseCodeSchema = z.string().regex(/^[A-Z_]{1,64}$/)

// desktop-stdio: one bounded JSON line authorizes the attach, then raw RFB bytes flow.
export const DESKTOP_ATTACH_LINE_MAX = 512
export const desktopAttachRequestSchema = z.strictObject({
  version: z.literal(1),
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
})
export const desktopAttachReplySchema = z.union([
  z.strictObject({ accepted: z.literal(true), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }),
  z.strictObject({ accepted: z.literal(false), code: mediaCloseCodeSchema }),
])
export type DesktopAttachReply = z.infer<typeof desktopAttachReplySchema>
