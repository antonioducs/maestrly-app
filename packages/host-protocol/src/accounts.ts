import { z } from 'zod'
import { id, revision } from './common.js'
import { authStatusSchema, isoDate, modelCatalogEntrySchema } from './bots.js'

/** Public account metadata. Credential material never belongs in this projection. */
export const accountSchema = z.strictObject({
  id,
  authorityHostId: z.string().uuid(),
  name: z.string().min(1).max(80),
  provider: z.literal('codex'),
  role: z.enum(['authority', 'linked']),
  status: authStatusSchema,
  available: z.boolean(),
  issue: z.string().max(400).optional(),
  isDefault: z.boolean(),
  revision,
  createdAt: isoDate,
  updatedAt: isoDate,
})
export type SharedAccount = z.infer<typeof accountSchema>
export const accountImpactSchema = z.strictObject({
  bots: z.array(z.strictObject({ botId: id, name: z.string().max(80), hostId: z.string().uuid(), active: z.boolean() })).max(1000),
  activeLeases: z.number().int().nonnegative(),
})
// A peer key can request credentials only for grants issued to this exact Host identity.
export const accountPeerIdentitySchema = z.strictObject({
  hostId: z.string().uuid(),
  publicKey: z.string().min(50).max(256),
  certificate: z.string().min(100).max(8192).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
})
export type AccountPeerIdentity = z.infer<typeof accountPeerIdentitySchema>
export const accountGrantSchema = z.strictObject({
  id: z.string().uuid(),
  account: accountSchema,
  authority: accountPeerIdentitySchema,
  peerHostId: z.string().uuid(),
  expiresAt: isoDate,
})
export type AccountGrant = z.infer<typeof accountGrantSchema>
const request = <M extends string, S extends z.ZodType>(method: M, params: S) =>
  z.strictObject({ version: z.literal(1), id, method: z.literal(method), params })
const byAccount = z.strictObject({ accountId: id })
export const accountRequests = [
  request('account.list', z.strictObject({})),
  request('account.create', z.strictObject({ idempotencyKey: id, name: z.string().min(1).max(80).default('Minha conta') })),
  request('account.inspect', byAccount),
  request('account.models', byAccount),
  request('account.impact', byAccount),
  request('account.default', byAccount),
  request('account.start', byAccount),
  request('account.cancel', byAccount),
  request('account.logout', byAccount),
  request('account.setApiKey', z.strictObject({ accountId: id, apiKey: z.string().min(8).max(512) })),
  request('account.migrate', z.strictObject({ botId: id, idempotencyKey: id })),
  request('account.peer.identity', z.strictObject({})),
  request('account.peer.grant', z.strictObject({ accountId: id, peer: accountPeerIdentitySchema, idempotencyKey: id,
    expiresAt: isoDate })),
  request('account.peer.link', z.strictObject({ grant: accountGrantSchema, endpoint: z.string().url().max(512) })),
  request('account.peer.revoke', z.strictObject({ grantId: z.string().uuid() })),
] as const
export const accountResultSchemas = {
  'account.list': z.array(accountSchema).max(100),
  'account.create': accountSchema,
  'account.inspect': accountSchema,
  'account.models': z.array(modelCatalogEntrySchema).max(100),
  'account.impact': accountImpactSchema,
  'account.default': accountSchema,
  'account.start': accountSchema,
  'account.cancel': accountSchema,
  'account.logout': accountSchema,
  'account.setApiKey': accountSchema,
  'account.migrate': accountSchema,
  'account.peer.identity': accountPeerIdentitySchema,
  'account.peer.grant': accountGrantSchema,
  'account.peer.link': accountSchema,
  'account.peer.revoke': z.strictObject({ revoked: z.literal(true) }),
}
