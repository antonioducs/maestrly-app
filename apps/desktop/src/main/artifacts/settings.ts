import { z } from 'zod'
import { type ArtifactSettings, DEFAULT_ARTIFACT_SETTINGS } from '../../shared/artifacts'
import { getAppFlag, getAppSetting, setAppFlag, setAppSetting } from '../store'

const KEYS = {
  hostEnabled: 'artifacts.hostEnabled',
  port: 'artifacts.port',
  quotaGb: 'artifacts.quotaGb',
} as const

const port = z.number().int().min(1024).max(65535)
const quotaGb = z.number().int().min(1).max(100)

export const artifactSettingsSchema = z.object({ hostEnabled: z.boolean(), port, quotaGb }).strict()

function storedNumber(key: string, schema: z.ZodNumber, fallback: number): number {
  const raw = getAppSetting(key)
  if (raw === null) return fallback
  const parsed = schema.safeParse(Number(raw))
  return parsed.success ? parsed.data : fallback
}

export function getArtifactSettings(): ArtifactSettings {
  return {
    hostEnabled: getAppFlag(KEYS.hostEnabled, DEFAULT_ARTIFACT_SETTINGS.hostEnabled),
    port: storedNumber(KEYS.port, port, DEFAULT_ARTIFACT_SETTINGS.port),
    quotaGb: storedNumber(KEYS.quotaGb, quotaGb, DEFAULT_ARTIFACT_SETTINGS.quotaGb),
  }
}

/** Validates the whole settings object before writing any of it; throws on invalid input. */
export function setArtifactSettings(input: unknown): ArtifactSettings {
  const settings = artifactSettingsSchema.parse(input)
  setAppFlag(KEYS.hostEnabled, settings.hostEnabled)
  setAppSetting(KEYS.port, String(settings.port))
  setAppSetting(KEYS.quotaGb, String(settings.quotaGb))
  return settings
}
