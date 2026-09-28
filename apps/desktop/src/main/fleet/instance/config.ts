import { FLEET_BOT_ENV, FLEET_PORTS, fleetEnvironmentIdSchema } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'

const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a 32-byte base64url token')
  .refine(
    (token) => Buffer.from(token, 'base64url').toString('base64url') === token,
    'Expected a canonical 32-byte base64url token'
  )

/**
 * The container environment of an environment instance: its id, its control server and the gateway URL. Bots are not
 * configured here: the gateway installs each one through the control API, with its profile, slot and gateway token.
 */
const schema = z.object({
  mode: z.literal('1'),
  environmentId: fleetEnvironmentIdSchema.optional(),
  controlHost: z.string().min(1).default('0.0.0.0'),
  controlPort: z.coerce.number().int().min(0).max(65535).default(FLEET_PORTS.instanceControl),
  controlToken: tokenSchema,
  gatewayUrl: z.url().optional(),
})

export type EnvironmentInstanceConfig = z.infer<typeof schema>
/** The control server only needs the control token; kept under its former name for the instance server. */
export type BotInstanceConfig = EnvironmentInstanceConfig
export const isBotMode = (env: NodeJS.ProcessEnv = process.env): boolean => env[FLEET_BOT_ENV.mode] === '1'

export function parseBotInstanceConfig(env: NodeJS.ProcessEnv = process.env): EnvironmentInstanceConfig | null {
  if (!isBotMode(env)) return null
  const result = schema.safeParse({
    mode: env[FLEET_BOT_ENV.mode],
    environmentId: env[FLEET_BOT_ENV.environmentId] || undefined,
    controlHost: env[FLEET_BOT_ENV.controlHost],
    controlPort: env[FLEET_BOT_ENV.controlPort],
    controlToken: env[FLEET_BOT_ENV.controlToken],
    gatewayUrl: env[FLEET_BOT_ENV.gatewayUrl] || undefined,
  })
  if (result.success) return result.data
  throw new Error(
    'Invalid bot instance environment: ' +
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  )
}
