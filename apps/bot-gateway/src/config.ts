import { chmodSync, mkdirSync } from 'node:fs'
import { z } from 'zod'
import { FLEET_GATEWAY_ENV, FLEET_PORTS } from '@maestrly/bot-fleet-protocol'

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
  publicHost: z.string().min(1),
  publicPort: port,
  internalPort: port,
  internalUrl: z.url(),
  botImage: z.string().min(1),
  network: z.string().min(1),
  dockerSocket: z.string().min(1),
  botMemory: bytes,
  botShm: bytes,
  timezone: z.string().min(1),
  botSecurityOpt: z.array(z.string()),
})
export type GatewayConfig = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const security = env.MAESTRLY_GATEWAY_BOT_SECURITY_OPT ?? '[]'
  let botSecurityOpt: unknown
  try {
    botSecurityOpt = JSON.parse(security)
  } catch {
    throw new Error('Invalid MAESTRLY_GATEWAY_BOT_SECURITY_OPT')
  }
  const value = schema.parse({
    dataDir: env[FLEET_GATEWAY_ENV.dataDir] ?? '/data',
    publicHost: env[FLEET_GATEWAY_ENV.publicHost] ?? '127.0.0.1',
    publicPort: env[FLEET_GATEWAY_ENV.publicPort] ?? FLEET_PORTS.public,
    internalPort: env[FLEET_GATEWAY_ENV.internalPort] ?? FLEET_PORTS.internal,
    internalUrl: env[FLEET_GATEWAY_ENV.internalUrl] ?? 'http://maestrly-bot-gateway:7444',
    botImage: env[FLEET_GATEWAY_ENV.botImage] ?? 'maestrly/bot-instance:local',
    network: env[FLEET_GATEWAY_ENV.network] ?? 'maestrly-bots',
    dockerSocket: env[FLEET_GATEWAY_ENV.dockerSocket] ?? '/var/run/docker.sock',
    botMemory: env[FLEET_GATEWAY_ENV.botMemory] ?? '4g',
    botShm: env[FLEET_GATEWAY_ENV.botShm] ?? '1g',
    timezone: env[FLEET_GATEWAY_ENV.timezone] ?? 'UTC',
    botSecurityOpt,
  })
  mkdirSync(value.dataDir, { recursive: true, mode: 0o700 })
  chmodSync(value.dataDir, 0o700)
  return value
}
