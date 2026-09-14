import { z } from 'zod'
import { id } from './common.js'

/** Private channel only. Never journal, emit as an event, or return to the UI. */
export const delegatedCredentialSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('chatgptAuthTokens'), accessToken: z.string().min(1).max(24 * 1024),
    chatgptAccountId: z.string().min(1).max(200), chatgptPlanType: z.string().max(60).nullable().optional() }),
  z.strictObject({ type: z.literal('apiKey'), apiKey: z.string().min(8).max(512) }),
])
export type DelegatedCredential = z.infer<typeof delegatedCredentialSchema>
export const accountCredentialRequestSchema = z.strictObject({
  type: z.literal('account.request'), id, forceRefresh: z.boolean(), credentialHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})
export const accountCredentialResponseSchema = z.strictObject({
  type: z.literal('account.response'), id,
  credential: delegatedCredentialSchema.optional(),
  error: z.strictObject({ code: z.enum(['ACCOUNT_UNAVAILABLE', 'ACCOUNT_REQUIRED', 'ACCOUNT_REVOKED']) }).optional(),
})
/** Only the previous bot's own auth file can be transferred for an explicit account migration. */
export const legacyCredentialSchema = z.strictObject({
  auth_mode: z.enum(['chatgpt', 'apikey']).optional(),
  OPENAI_API_KEY: z.string().min(8).max(512).nullable().optional(),
  tokens: z.strictObject({
    id_token: z.string().min(1).max(24 * 1024), access_token: z.string().min(1).max(24 * 1024),
    refresh_token: z.string().min(1).max(24 * 1024), account_id: z.string().min(1).max(200).nullable().optional(),
  }).nullable().optional(),
  last_refresh: z.string().max(80).nullable().optional(),
}).refine(value => !!value.OPENAI_API_KEY || !!value.tokens, 'No account credentials')
export type LegacyCredential = z.infer<typeof legacyCredentialSchema>
