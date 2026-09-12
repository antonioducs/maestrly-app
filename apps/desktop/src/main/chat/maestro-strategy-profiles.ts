import { randomUUID } from 'node:crypto'
import {
  BUILTIN_MAESTRO_STRATEGY_PROFILE_PREFIX,
  GLOBAL_MAESTRO_STRATEGY_PROFILE_ID,
  MAESTRO_STRATEGY_PROFILE_VERSION,
  cloneMaestroConfig,
  type MaestroConfigV1,
  type MaestroOrchestratorProfileV1,
  type MaestroStrategy,
  type MaestroStrategyProfileCatalog,
  type MaestroStrategyProfileCatalogItem,
  type MaestroStrategyProfileInput,
  type MaestroStrategyProfileMutationResult,
  type MaestroStrategyProfileV1,
} from '../../shared/maestro'
import { getAppSetting, setAppSetting } from '../store'
import { getGlobalMaestroConfig, validateMaestroConfig } from './maestro-config'

export const MAESTRO_STRATEGY_PROFILES_SETTING_KEY = 'chat.maestro.strategy-profiles.v1'
export const MAESTRO_STRATEGY_PROFILE_LAST_USED_KEY = 'chat.maestro.strategy-profile.last-used.v1'

const STRATEGIES: MaestroStrategy[] = ['balanced', 'best-quality', 'fast', 'economy']
const BUILTIN_NAMES: Record<MaestroStrategy, string> = {
  balanced: 'Balanced',
  'best-quality': 'Best quality',
  fast: 'Fast',
  economy: 'Economy',
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
}

function cleanId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) ? value : ''
}

function orchestrator(value: unknown): MaestroOrchestratorProfileV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim().slice(0, 160) : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 240) : ''
  const reasoning =
    typeof raw.reasoning === 'string'
      ? raw.reasoning
          .trim()
          .toLowerCase()
          .slice(0, 24)
          .replace(/[^a-z0-9_-]/g, '') || 'off'
      : 'off'
  if (!providerId || !modelId) return null
  return { providerId, modelId, reasoning, fastMode: raw.fastMode === true }
}

function parseProfile(value: unknown): MaestroStrategyProfileV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = cleanId(raw.id)
  const name = cleanName(raw.name)
  const profile = orchestrator(raw.orchestrator)
  const parsed = validateMaestroConfig(raw.config)
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  if (raw.version !== MAESTRO_STRATEGY_PROFILE_VERSION || !id || !name || !profile || !parsed.ok) return null
  return {
    version: MAESTRO_STRATEGY_PROFILE_VERSION,
    id,
    name,
    config: cloneMaestroConfig(parsed.value.config),
    orchestrator: profile,
    createdAt,
    updatedAt,
  }
}

function readCustomProfiles(): MaestroStrategyProfileV1[] {
  const stored = getAppSetting(MAESTRO_STRATEGY_PROFILES_SETTING_KEY)
  if (!stored) return []
  try {
    const raw = JSON.parse(stored)
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw.map(parseProfile).filter((profile): profile is MaestroStrategyProfileV1 => {
      if (!profile || seen.has(profile.id)) return false
      seen.add(profile.id)
      return true
    })
  } catch {
    return []
  }
}

function writeCustomProfiles(profiles: MaestroStrategyProfileV1[]): void {
  setAppSetting(MAESTRO_STRATEGY_PROFILES_SETTING_KEY, JSON.stringify(profiles))
}

function builtins(
  config: MaestroConfigV1,
  globalOrchestrator: MaestroOrchestratorProfileV1 | null
): MaestroStrategyProfileCatalogItem[] {
  return STRATEGIES.map((strategy) => {
    const next = cloneMaestroConfig(config)
    next.strategy = strategy
    return {
      id: `${BUILTIN_MAESTRO_STRATEGY_PROFILE_PREFIX}${strategy}`,
      name: BUILTIN_NAMES[strategy],
      source: 'builtin',
      config: next,
      orchestrator: globalOrchestrator ? { ...globalOrchestrator } : null,
    }
  })
}

export function listMaestroStrategyProfiles(
  globalOrchestrator: MaestroOrchestratorProfileV1 | null
): MaestroStrategyProfileCatalog {
  const globalConfig = cloneMaestroConfig(getGlobalMaestroConfig().config)
  const custom: MaestroStrategyProfileCatalogItem[] = readCustomProfiles().map((profile) => ({
    ...profile,
    source: 'custom',
    config: cloneMaestroConfig(profile.config),
    orchestrator: { ...profile.orchestrator },
  }))
  const items: MaestroStrategyProfileCatalogItem[] = [
    {
      id: GLOBAL_MAESTRO_STRATEGY_PROFILE_ID,
      name: 'Global default',
      source: 'global',
      config: globalConfig,
      orchestrator: globalOrchestrator ? { ...globalOrchestrator } : null,
    },
    ...builtins(globalConfig, globalOrchestrator),
    ...custom,
  ]
  const storedLastUsed = getAppSetting(MAESTRO_STRATEGY_PROFILE_LAST_USED_KEY) ?? ''
  return {
    items,
    lastUsedId: items.some((item) => item.id === storedLastUsed) ? storedLastUsed : GLOBAL_MAESTRO_STRATEGY_PROFILE_ID,
  }
}

export function resolveMaestroStrategyProfile(
  id: string,
  globalOrchestrator: MaestroOrchestratorProfileV1 | null
): MaestroStrategyProfileCatalogItem | null {
  return listMaestroStrategyProfiles(globalOrchestrator).items.find((item) => item.id === id) ?? null
}

export function createMaestroStrategyProfile(
  input: MaestroStrategyProfileInput,
  globalOrchestrator: MaestroOrchestratorProfileV1 | null
): MaestroStrategyProfileMutationResult {
  const profiles = readCustomProfiles()
  const name = cleanName(input?.name)
  const profile = orchestrator(input?.orchestrator)
  const parsed = validateMaestroConfig(input?.config)
  if (!name) return { ok: false, error: 'maestro-strategy-profile-name-required' }
  if (profiles.some((item) => item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
    return { ok: false, error: 'maestro-strategy-profile-name-duplicate' }
  }
  if (!profile) return { ok: false, error: 'maestro-strategy-profile-orchestrator-invalid' }
  if (!parsed.ok) return { ok: false, error: 'maestro-strategy-profile-config-invalid' }
  const now = Date.now()
  const saved: MaestroStrategyProfileV1 = {
    version: MAESTRO_STRATEGY_PROFILE_VERSION,
    id: randomUUID(),
    name,
    config: cloneMaestroConfig(parsed.value.config),
    orchestrator: profile,
    createdAt: now,
    updatedAt: now,
  }
  writeCustomProfiles([...profiles, saved])
  return { ok: true, profile: saved, catalog: listMaestroStrategyProfiles(globalOrchestrator) }
}

export function updateMaestroStrategyProfile(
  id: string,
  input: MaestroStrategyProfileInput,
  globalOrchestrator: MaestroOrchestratorProfileV1 | null
): MaestroStrategyProfileMutationResult {
  const profiles = readCustomProfiles()
  const index = profiles.findIndex((profile) => profile.id === id)
  if (index < 0) return { ok: false, error: 'maestro-strategy-profile-not-found' }
  const name = cleanName(input?.name)
  const profile = orchestrator(input?.orchestrator)
  const parsed = validateMaestroConfig(input?.config)
  if (!name) return { ok: false, error: 'maestro-strategy-profile-name-required' }
  if (
    profiles.some((item) => item.id !== id && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
  ) {
    return { ok: false, error: 'maestro-strategy-profile-name-duplicate' }
  }
  if (!profile) return { ok: false, error: 'maestro-strategy-profile-orchestrator-invalid' }
  if (!parsed.ok) return { ok: false, error: 'maestro-strategy-profile-config-invalid' }
  const saved: MaestroStrategyProfileV1 = {
    ...profiles[index]!,
    name,
    config: cloneMaestroConfig(parsed.value.config),
    orchestrator: profile,
    updatedAt: Date.now(),
  }
  profiles[index] = saved
  writeCustomProfiles(profiles)
  return { ok: true, profile: saved, catalog: listMaestroStrategyProfiles(globalOrchestrator) }
}

export function deleteMaestroStrategyProfile(id: string): boolean {
  const profiles = readCustomProfiles()
  const next = profiles.filter((profile) => profile.id !== id)
  if (next.length === profiles.length) return false
  writeCustomProfiles(next)
  if (getAppSetting(MAESTRO_STRATEGY_PROFILE_LAST_USED_KEY) === id) {
    setAppSetting(MAESTRO_STRATEGY_PROFILE_LAST_USED_KEY, GLOBAL_MAESTRO_STRATEGY_PROFILE_ID)
  }
  return true
}

export function setLastUsedMaestroStrategyProfile(id: string): void {
  setAppSetting(MAESTRO_STRATEGY_PROFILE_LAST_USED_KEY, id)
}
