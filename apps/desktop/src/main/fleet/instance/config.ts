import { FLEET_BOT_ENV, FLEET_PORTS, fleetBotIdSchema, fleetNameSchema } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'

const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a 32-byte base64url token')
  .refine(
    (token) => Buffer.from(token, 'base64url').toString('base64url') === token,
    'Expected a canonical 32-byte base64url token'
  )

const schema = z
  .object({
    mode: z.literal('1'),
    id: fleetBotIdSchema.optional(),
    name: fleetNameSchema.optional(),
    controlHost: z.string().min(1).default('0.0.0.0'),
    controlPort: z.coerce.number().int().min(0).max(65535).default(FLEET_PORTS.instanceControl),
    controlToken: tokenSchema,
    gatewayUrl: z.url().optional(),
    gatewayToken: tokenSchema.optional(),
  })
  .refine((value) => !value.gatewayUrl || !!value.gatewayToken, {
    path: ['gatewayToken'],
    message: 'Gateway token is required when gateway URL is configured',
  })

export type BotInstanceConfig = z.infer<typeof schema>
export const isBotMode = (env: NodeJS.ProcessEnv = process.env): boolean => env[FLEET_BOT_ENV.mode] === '1'

export function parseBotInstanceConfig(env: NodeJS.ProcessEnv = process.env): BotInstanceConfig | null {
  if (!isBotMode(env)) return null
  const result = schema.safeParse({
    mode: env[FLEET_BOT_ENV.mode],
    id: env[FLEET_BOT_ENV.id],
    name: env[FLEET_BOT_ENV.name],
    controlHost: env[FLEET_BOT_ENV.controlHost],
    controlPort: env[FLEET_BOT_ENV.controlPort],
    controlToken: env[FLEET_BOT_ENV.controlToken],
    gatewayUrl: env[FLEET_BOT_ENV.gatewayUrl],
    gatewayToken: env[FLEET_BOT_ENV.gatewayToken],
  })
  if (result.success) return result.data
  throw new Error(
    'Invalid bot instance environment: ' +
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  )
}
