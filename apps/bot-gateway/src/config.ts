import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  FLEET_BOT_EGRESS_MODES,
  FLEET_BOT_RUNTIME_UPDATE_MODES,
  FLEET_GATEWAY_ENV,
  FLEET_PORTS,
  isValidTimeZone,
} from '@maestrly/bot-fleet-protocol'

const bytes = z
  .string()
  .regex(/^\d+(?:[kmg])?$/i)
  .transform((value) => {
    const match = /^(\d+)([kmg])?$/i.exec(value)!
    return Number(match[1]) * ({ k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() as 'k' | 'm' | 'g'] ?? 1)
  })
const port = z.coerce.number().int().min(1).max(65535)
const schema = z.object({
  dataDir: z.string().min(1),
  displayName: z.string().trim().max(64).nullable(),
  publicHost: z.string().min(1),
  publicPort: port,
  internalPort: port,
  artifactsHost: z.enum(['127.0.0.1', '0.0.0.0']),
  artifactsPort: port,
  internalUrl: z.url(),
  botImage: z.string().min(1),
  network: z.string().min(1),
  dockerSocket: z.string().min(1),
  botMemory: bytes,
  botEgress: z.enum(FLEET_BOT_EGRESS_MODES),
  /** Whether bots update Claude Code and Codex on their own. */
  botRuntimeUpdates: z.enum(FLEET_BOT_RUNTIME_UPDATE_MODES),
  botShm: bytes,
  timezone: z.string().min(1).refine(isValidTimeZone, 'Invalid time zone'),
  botSecurityOpt: z.array(z.string()),
})
export type GatewayConfig = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const security = env.MAESTRLY_GATEWAY_BOT_SECURITY_OPT ?? '[]'
  let botSecurityOpt: unknown
  try {
    if (security === 'auto') {
      const profile: unknown = JSON.parse(
        readFileSync(env.MAESTRLY_GATEWAY_BOT_SECCOMP_PROFILE ?? '/etc/maestrly-bot/seccomp-bot.json', 'utf8')
      )
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid seccomp profile')
      botSecurityOpt = ['seccomp=' + JSON.stringify(profile)]
    } else botSecurityOpt = JSON.parse(security)
  } catch {
    throw new Error('Invalid MAESTRLY_GATEWAY_BOT_SECURITY_OPT or seccomp profile')
  }
  const value = schema.parse({
    dataDir: env[FLEET_GATEWAY_ENV.dataDir] ?? '/data',
    displayName: env[FLEET_GATEWAY_ENV.displayName]?.trim() || null,
    publicHost: env[FLEET_GATEWAY_ENV.publicHost] ?? '127.0.0.1',
    publicPort: env[FLEET_GATEWAY_ENV.publicPort] ?? FLEET_PORTS.public,
    internalPort: env[FLEET_GATEWAY_ENV.internalPort] ?? FLEET_PORTS.internal,
    artifactsHost: env[FLEET_GATEWAY_ENV.artifactsHost] ?? '127.0.0.1',
    artifactsPort: env[FLEET_GATEWAY_ENV.artifactsPort] ?? FLEET_PORTS.artifacts,
    internalUrl: env[FLEET_GATEWAY_ENV.internalUrl] ?? 'http://maestrly-bot-gateway:7444',
    botImage: env[FLEET_GATEWAY_ENV.botImage] ?? 'maestrly/bot-instance:local',
    network: env[FLEET_GATEWAY_ENV.network] ?? 'maestrly-bots',
    dockerSocket: env[FLEET_GATEWAY_ENV.dockerSocket] ?? '/var/run/docker.sock',
    botMemory: env[FLEET_GATEWAY_ENV.botMemory] ?? '4g',
    botEgress: env[FLEET_GATEWAY_ENV.botEgress] ?? 'open',
    botRuntimeUpdates: env[FLEET_GATEWAY_ENV.botRuntimeUpdates] || 'auto',
    botShm: env[FLEET_GATEWAY_ENV.botShm] ?? '1g',
    timezone: env[FLEET_GATEWAY_ENV.timezone] ?? 'UTC',
    botSecurityOpt,
  })
  mkdirSync(value.dataDir, { recursive: true, mode: 0o700 })
  chmodSync(value.dataDir, 0o700)
  return value
}
