import { z } from 'zod'

/** What the owner's computers send each other, and what this one keeps about them. */
export const peerDeviceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const os = z.enum(['mac', 'win', 'linux'])
const b64u = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(4096)
const pem = z.string().min(1).max(8192)
const address = z.string().min(1).max(255)
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/)
const name = z.string().min(1).max(128)

export const peerHelloSchema = z.object({
  deviceId: peerDeviceIdSchema,
  name,
  os,
  appVersion: z.string().max(64),
  fingerprint,
  pairing: z.boolean(),
})
export const peerPairingRequestSchema = z
  .object({ deviceId: peerDeviceIdSchema, name, os, appVersion: z.string().max(64), certificate: pem })
  .strict()
export const peerPairingStartedSchema = z.object({ pairingId: z.string().uuid(), expiresAt: z.number() })
export const peerExchangeRequestSchema = z.object({ x: b64u }).strict()
export const peerExchangeResponseSchema = z.object({ y: b64u, confirm: b64u })
export const peerConfirmRequestSchema = z.object({ confirm: b64u, sealed: b64u }).strict()
export const peerConfirmResponseSchema = z.object({ sealed: b64u })
export const peerAbortRequestSchema = z.object({ reason: z.enum(['mismatch', 'cancelled']) }).strict()
export const peerGrantSchema = z
  .object({
    token: z.string().min(32).max(256),
    port: z.number().int().min(1).max(65535).nullable(),
    addresses: z.array(address).max(8),
  })
  .strict()
export const peerRecordSchema = z.object({
  deviceId: peerDeviceIdSchema,
  name,
  os,
  certPem: pem,
  fingerprint,
  port: z.number().int().min(1).max(65535),
  addresses: z.array(address).max(8),
  tint: z.string().max(32).nullable(),
  pairedAt: z.number(),
  lastSeenAt: z.number().nullable(),
  issuedTokenHash: fingerprint,
})
export type PeerRecord = z.infer<typeof peerRecordSchema>
