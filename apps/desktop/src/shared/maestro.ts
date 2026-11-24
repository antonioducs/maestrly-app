import type { SubagentProfileCandidate } from './subagent-profiles'

export const MAESTRO_CONFIG_VERSION = 2 as const
export const MAESTRO_STRATEGY_PROFILE_VERSION = 1 as const
export const GLOBAL_MAESTRO_STRATEGY_PROFILE_ID = 'global' as const
export const BUILTIN_MAESTRO_STRATEGY_PROFILE_PREFIX = 'builtin:' as const

export type MaestroStrategy = 'balanced' | 'best-quality' | 'fast' | 'economy'
export type MaestroResourceMode = 'agent' | 'design' | 'ask'

export interface MaestroResourceV1 {
  id: string
  label: string
  enabled: boolean
  description: string
  mode: MaestroResourceMode
  specialties: string[]
  /** Ordered concrete candidates. Empty means inherit the frozen orchestrator profile as the final candidate. */
  candidates: SubagentProfileCandidate[]
  /** Optional extra instructions for this resource. */
  instructions?: string
}

export interface MaestroConfigV1 {
  version: typeof MAESTRO_CONFIG_VERSION
  strategy: MaestroStrategy
  pool: MaestroResourceV1[]
}

export interface MaestroConfigDiagnostic {
  code: 'config-corrupt' | 'invalid-structure' | 'resource-unavailable'
  message: string
  severity: 'warning' | 'error'
  resourceId?: string
}

export interface MaestroConfigPayload {
  config: MaestroConfigV1
  source: 'global' | 'conversation' | 'project' | 'safe-default'
  diagnostics: MaestroConfigDiagnostic[]
  hasConversationOverride: boolean
}

export interface MaestroOrchestratorProfileV1 {
  providerId: string
  modelId: string
  reasoning: string
  fastMode: boolean
}

export interface MaestroStrategyProfileV1 {
  version: typeof MAESTRO_STRATEGY_PROFILE_VERSION
  id: string
  name: string
  config: MaestroConfigV1
  orchestrator: MaestroOrchestratorProfileV1
  createdAt: number
  updatedAt: number
}

export interface MaestroStrategyProfileCatalogItem {
  id: string
  name: string
  source: 'global' | 'builtin' | 'custom'
  config: MaestroConfigV1

  orchestrator: MaestroOrchestratorProfileV1 | null
  createdAt?: number
  updatedAt?: number
}

export interface MaestroStrategyProfileCatalog {
  items: MaestroStrategyProfileCatalogItem[]
  lastUsedId: string
}

export interface MaestroStrategyProfileInput {
  name: string
  config: MaestroConfigV1
  orchestrator: MaestroOrchestratorProfileV1
}

export type MaestroStrategyProfileMutationResult =
  | { ok: true; profile: MaestroStrategyProfileV1; catalog: MaestroStrategyProfileCatalog }
  | { ok: false; error: string }

export interface MaestroTurnSnapshotV1 {
  version: typeof MAESTRO_CONFIG_VERSION
  strategy: MaestroStrategy
  pool: MaestroResourceV1[]
  source: MaestroConfigPayload['source']
  diagnostics: MaestroConfigDiagnostic[]
  frozenAt: number
}

const defaultPool = (): MaestroResourceV1[] => [
  {
    id: 'explorer',
    label: 'Explorer',
    enabled: true,
    description: 'Fast, read-only repository exploration and context gathering.',
    mode: 'ask',
    specialties: ['exploration', 'general'],
    candidates: [],
  },
  {
    id: 'frontend',
    label: 'Frontend',
    enabled: true,
    description: 'UI, renderer, accessibility and client-side implementation.',
    mode: 'agent',
    specialties: ['frontend', 'design', 'implementation'],
    candidates: [],
  },
  {
    id: 'backend',
    label: 'Backend',
    enabled: true,
    description: 'Services, persistence, APIs and backend implementation.',
    mode: 'agent',
    specialties: ['backend', 'infra', 'data', 'implementation'],
    candidates: [],
  },
  {
    id: 'tester',
    label: 'Tests',
    enabled: true,
    description: 'Runs focused validation, tests, lint, typecheck and build checks.',
    mode: 'agent',
    specialties: ['test', 'fullstack', 'general'],
    candidates: [],
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    enabled: true,
    description: 'Independent, read-only review of delegated changes and findings.',
    mode: 'ask',
    specialties: ['review', 'fullstack', 'general'],
    candidates: [],
  },
  {
    id: 'generalist',
    label: 'Generalist',
    enabled: true,
    description: 'General-purpose implementation, fixes and cross-cutting work.',
    mode: 'agent',
    specialties: ['general', 'fullstack', 'fix', 'implementation'],
    candidates: [],
  },
]

export function createDefaultMaestroConfig(): MaestroConfigV1 {
  return {
    version: MAESTRO_CONFIG_VERSION,
    strategy: 'balanced',
    pool: defaultPool(),
  }
}

export function cloneMaestroConfig(config: MaestroConfigV1): MaestroConfigV1 {
  return {
    ...config,
    pool: config.pool.map((resource) => ({
      ...resource,
      specialties: [...resource.specialties],
      candidates: resource.candidates.map((candidate) => ({ ...candidate })),
    })),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isMaestroConfigV1(value: unknown): value is MaestroConfigV1 {
  const raw = record(value)
  if (
    raw?.version !== MAESTRO_CONFIG_VERSION ||
    !['balanced', 'best-quality', 'fast', 'economy'].includes(String(raw.strategy)) ||
    !Array.isArray(raw.pool) ||
    raw.pool.length === 0
  ) {
    return false
  }
  return raw.pool.every((item) => {
    const resource = record(item)
    if (
      !resource ||
      typeof resource.id !== 'string' ||
      !resource.id.trim() ||
      typeof resource.label !== 'string' ||
      !resource.label.trim() ||
      typeof resource.enabled !== 'boolean' ||
      typeof resource.description !== 'string' ||
      !resource.description.trim() ||
      !['agent', 'design', 'ask'].includes(String(resource.mode)) ||
      !Array.isArray(resource.specialties) ||
      resource.specialties.some((specialty) => typeof specialty !== 'string') ||
      !Array.isArray(resource.candidates) ||
      (resource.instructions !== undefined && typeof resource.instructions !== 'string')
    ) {
      return false
    }
    return resource.candidates.every((item) => {
      const candidate = record(item)
      return Boolean(
        candidate &&
          typeof candidate.providerId === 'string' &&
          candidate.providerId.trim() &&
          typeof candidate.modelId === 'string' &&
          candidate.modelId.trim() &&
          typeof candidate.effort === 'string' &&
          candidate.effort.trim() &&
          (candidate.fastMode === undefined || typeof candidate.fastMode === 'boolean')
      )
    })
  })
}
