import { z } from 'zod'
import {
  type ArtifactSettings,
  DEFAULT_ARTIFACT_SETTINGS,
  MAX_ARTIFACT_NAME_CHARS,
  MAX_LINK_EXPIRY_DAYS,
} from '../../shared/artifacts'
import { getAppFlag, getAppSetting, setAppFlag, setAppSetting } from '../store'

const KEYS = {
  publishTo: 'artifacts.publishTo',
  hostEnabled: 'artifacts.hostEnabled',
  port: 'artifacts.port',
  quotaGb: 'artifacts.quotaGb',
  publicAddress: 'artifacts.publicAddress',
  ownerName: 'artifacts.ownerName',
  linkExpiryDays: 'artifacts.linkExpiryDays',
} as const

const NEVER = 'never'
const MAX_ADDRESS_CHARS = 300

const port = z.number().int().min(1024).max(65535)
const quotaGb = z.number().int().min(1).max(100)
const linkExpiryDays = z.number().int().min(1).max(MAX_LINK_EXPIRY_DAYS)
const ownerName = z
  .string()
  .trim()
  .max(MAX_ARTIFACT_NAME_CHARS)
  .regex(/^\P{Cc}*$/u, 'Use a single line of text')

/** Empty, or the origin other people reach the host at. Anything beyond the origin is refused, not dropped. */
const publicAddress = z
  .string()
  .trim()
  .max(MAX_ADDRESS_CHARS)
  .transform((value, ctx) => {
    if (value === '') return ''
    let url: URL | null = null
    try {
      url = new URL(value)
    } catch {
      // Reported below.
    }
    const isOrigin =
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    if (!url || !isOrigin) {
      ctx.addIssue({ code: 'custom', message: 'Use an address such as https://my-mac.example, without a path' })
      return z.NEVER
    }
    return url.origin
  })

export const artifactSettingsSchema = z
  .object({
    publishTo: z.enum(['local', 'server']).default('local'),
    hostEnabled: z.boolean(),
    port,
    quotaGb,
    publicAddress,
    ownerName,
    linkExpiryDays: linkExpiryDays.nullable(),
  })
  .strict()

function stored<T>(key: string, schema: z.ZodType<T>, fallback: T, read: (raw: string) => unknown = (raw) => raw): T {
  const raw = getAppSetting(key)
  if (raw === null) return fallback
  const parsed = schema.safeParse(read(raw))
  return parsed.success ? parsed.data : fallback
}

export function getArtifactSettings(): ArtifactSettings {
  return {
    publishTo: stored(KEYS.publishTo, z.enum(['local', 'server']), DEFAULT_ARTIFACT_SETTINGS.publishTo),
    hostEnabled: getAppFlag(KEYS.hostEnabled, DEFAULT_ARTIFACT_SETTINGS.hostEnabled),
    port: stored(KEYS.port, port, DEFAULT_ARTIFACT_SETTINGS.port, Number),
    quotaGb: stored(KEYS.quotaGb, quotaGb, DEFAULT_ARTIFACT_SETTINGS.quotaGb, Number),
    publicAddress: stored(KEYS.publicAddress, publicAddress, DEFAULT_ARTIFACT_SETTINGS.publicAddress),
    ownerName: stored(KEYS.ownerName, ownerName, DEFAULT_ARTIFACT_SETTINGS.ownerName),
    linkExpiryDays: stored(
      KEYS.linkExpiryDays,
      linkExpiryDays.nullable(),
      DEFAULT_ARTIFACT_SETTINGS.linkExpiryDays,
      (raw) => (raw === NEVER ? null : Number(raw))
    ),
  }
}

/** Validates the whole settings object before writing any of it; throws on invalid input. */
export function setArtifactSettings(input: unknown): ArtifactSettings {
  const settings = artifactSettingsSchema.parse(input)
  setAppSetting(KEYS.publishTo, settings.publishTo)
  setAppFlag(KEYS.hostEnabled, settings.hostEnabled)
  setAppSetting(KEYS.port, String(settings.port))
  setAppSetting(KEYS.quotaGb, String(settings.quotaGb))
  setAppSetting(KEYS.publicAddress, settings.publicAddress)
  setAppSetting(KEYS.ownerName, settings.ownerName)
  setAppSetting(KEYS.linkExpiryDays, settings.linkExpiryDays === null ? NEVER : String(settings.linkExpiryDays))
  return settings
}
