import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().max(65_535).default(4310),
  DATABASE_URL: z.string().min(1).default('postgres://maestrly_runtime:maestrly_dev_only@127.0.0.1:5432/maestrly'),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  MAESTRLY_CANONICAL_URL: z.string().url().default('http://127.0.0.1:4310'),
  MAESTRLY_WEB_ORIGIN: z.string().url().default('http://127.0.0.1:4173'),
  MAESTRLY_INSTANCE_ID: z.string().min(1).max(191).default('local-development'),
  MAESTRLY_INSTANCE_NAME: z.string().min(1).max(160).default('Local Maestrly'),
  BETTER_AUTH_SECRET: z.string().min(32).default('development-only-secret-change-before-team-use'),
  MAESTRLY_PUBLIC_SIGNUP: z.enum(['true', 'false']).default('false'),
  MAESTRLY_TEST_AUTH: z.enum(['true', 'false']).default('false'),
  MAESTRLY_BOOTSTRAP_MODE: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAESTRLY_STORAGE_DIR: z.string().min(1).default('.maestrly-data'),
})

export interface ServerConfig {
  environment: 'development' | 'test' | 'production'
  host: string
  port: number
  databaseUrl: string
  migrationDatabaseUrl?: string
  canonicalUrl: string
  webOrigin: string
  instanceId: string
  instanceName: string
  authSecret: string
  publicSignup: boolean
  allowTestAuth: boolean
  bootstrapMode: boolean
  logLevel: string
  storageDirectory: string
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const value = environmentSchema.parse(environment)
  if (value.NODE_ENV === 'production') {
    if (!value.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required in production')
    if (value.BETTER_AUTH_SECRET.includes('development-only')) throw new Error('BETTER_AUTH_SECRET must be replaced in production')
    const canonical = new URL(value.MAESTRLY_CANONICAL_URL)
    const loopback = canonical.hostname === '127.0.0.1' || canonical.hostname === 'localhost' || canonical.hostname === '::1'
    if (canonical.protocol !== 'https:' && !loopback) throw new Error('MAESTRLY_CANONICAL_URL must use HTTPS outside loopback')
    if (value.MAESTRLY_TEST_AUTH === 'true') throw new Error('MAESTRLY_TEST_AUTH cannot be enabled in production')
  }
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    migrationDatabaseUrl: value.MIGRATION_DATABASE_URL,
    canonicalUrl: value.MAESTRLY_CANONICAL_URL.replace(/\/$/, ''),
    webOrigin: value.MAESTRLY_WEB_ORIGIN.replace(/\/$/, ''),
    instanceId: value.MAESTRLY_INSTANCE_ID,
    instanceName: value.MAESTRLY_INSTANCE_NAME,
    authSecret: value.BETTER_AUTH_SECRET,
    publicSignup: value.MAESTRLY_PUBLIC_SIGNUP === 'true',
    allowTestAuth: value.MAESTRLY_TEST_AUTH === 'true',
    bootstrapMode: value.MAESTRLY_BOOTSTRAP_MODE === 'true',
    logLevel: value.LOG_LEVEL,
    storageDirectory: value.MAESTRLY_STORAGE_DIR,
  }
}
