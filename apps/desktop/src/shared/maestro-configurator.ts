import type { ChatModelRef } from './chat'
import type { MaestroConfigDiagnostic, MaestroConfigV1, MaestroResourceV1 } from './maestro'
import type { SubagentProfileCandidate } from './subagent-profiles'

export const MAESTRO_CONFIGURATOR_THREAD_VERSION = 1 as const
export const MAESTRO_CONFIGURATOR_EVENT_CHANNEL = 'chat:maestro-configurator:event' as const

export interface MaestroConfiguratorProfile extends SubagentProfileCandidate {}

export interface MaestroConfiguratorCatalogModel {
  id: string
  reasoning: boolean
  reasoningEfforts: string[]
  fastModeCapability: boolean
  contextWindow?: number
}

export interface MaestroConfiguratorCatalogProvider {
  id: string
  name: string
  catalogStatus: 'available' | 'unavailable'
  models: MaestroConfiguratorCatalogModel[]
}

export interface MaestroConfiguratorCatalog {
  providers: MaestroConfiguratorCatalogProvider[]
  generatedAt: number
}

export type MaestroConfiguratorChange =
  | { kind: 'strategy'; before: MaestroConfigV1['strategy']; after: MaestroConfigV1['strategy'] }
  | { kind: 'resource-added'; resourceId: string; label: string }
  | { kind: 'resource-removed'; resourceId: string; label: string }
  | {
      kind: 'resource-field'
      resourceId: string
      label: string
      field: Exclude<keyof MaestroResourceV1, 'id' | 'candidates'>
      before: unknown
      after: unknown
    }
  | {
      kind: 'candidate-added'
      resourceId: string
      label: string
      index: number
      candidate: SubagentProfileCandidate
    }
  | {
      kind: 'candidate-removed'
      resourceId: string
      label: string
      index: number
      candidate: SubagentProfileCandidate
    }
  | {
      kind: 'candidate-replaced'
      resourceId: string
      label: string
      index: number
      before: SubagentProfileCandidate
      after: SubagentProfileCandidate
    }

export interface MaestroConfiguratorProposal {
  id: string
  baseHash: string
  summary: string
  config: MaestroConfigV1
  changes: MaestroConfiguratorChange[]
  diagnostics: MaestroConfigDiagnostic[]
  createdAt: number
}

export interface MaestroConfiguratorUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  runtimeEstimatedCostUsd?: number
}

export interface MaestroConfiguratorMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  model?: ChatModelRef
  usage?: MaestroConfiguratorUsage
  proposal?: MaestroConfiguratorProposal
}

export interface MaestroConfiguratorThread {
  version: typeof MAESTRO_CONFIGURATOR_THREAD_VERSION
  messages: MaestroConfiguratorMessage[]
}

export interface MaestroConfiguratorState {
  thread: MaestroConfiguratorThread
  profile: MaestroConfiguratorProfile | null
  catalog: MaestroConfiguratorCatalog
  activeTurnId: string | null
}

export interface MaestroConfiguratorSendInput {
  text: string
  draft: MaestroConfigV1
  baseHash: string
}

export type MaestroConfiguratorSendResult =
  | { ok: true; turnId: string; userMessage: MaestroConfiguratorMessage }
  | { ok: false; error: string }

export type MaestroConfiguratorEvent =
  | { kind: 'text-update'; turnId: string; update: { kind: 'append' | 'replace'; text: string } }
  | { kind: 'progress'; turnId: string; message: string }
  | { kind: 'completed'; turnId: string; message: MaestroConfiguratorMessage }
  | { kind: 'cancelled'; turnId: string }
  | { kind: 'error'; turnId: string; error: string }
  | { kind: 'reset' }

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

/** Stable renderer-safe revision; this is a stale-write guard, not a security primitive. */
export function hashMaestroConfig(config: MaestroConfigV1): string {
  const input = JSON.stringify(stableValue(config))
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `maestro-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))

const RESOURCE_FIELDS: Array<Exclude<keyof MaestroResourceV1, 'id' | 'candidates'>> = [
  'label',
  'enabled',
  'description',
  'capability',
  'specialties',
  'agentName',
  'instructions',
]

export function diffMaestroConfigs(before: MaestroConfigV1, after: MaestroConfigV1): MaestroConfiguratorChange[] {
  const changes: MaestroConfiguratorChange[] = []
  if (before.strategy !== after.strategy)
    changes.push({ kind: 'strategy', before: before.strategy, after: after.strategy })

  const beforeById = new Map(before.pool.map((resource) => [resource.id, resource]))
  const afterById = new Map(after.pool.map((resource) => [resource.id, resource]))
  for (const resource of before.pool) {
    if (!afterById.has(resource.id)) {
      changes.push({ kind: 'resource-removed', resourceId: resource.id, label: resource.label })
    }
  }
  for (const resource of after.pool) {
    const previous = beforeById.get(resource.id)
    if (!previous) {
      changes.push({ kind: 'resource-added', resourceId: resource.id, label: resource.label })
      continue
    }
    for (const field of RESOURCE_FIELDS) {
      if (same(previous[field], resource[field])) continue
      changes.push({
        kind: 'resource-field',
        resourceId: resource.id,
        label: resource.label,
        field,
        before: previous[field],
        after: resource[field],
      })
    }
    const shared = Math.min(previous.candidates.length, resource.candidates.length)
    for (let index = 0; index < shared; index++) {
      if (same(previous.candidates[index], resource.candidates[index])) continue
      changes.push({
        kind: 'candidate-replaced',
        resourceId: resource.id,
        label: resource.label,
        index,
        before: { ...previous.candidates[index] },
        after: { ...resource.candidates[index] },
      })
    }
    for (let index = shared; index < previous.candidates.length; index++) {
      changes.push({
        kind: 'candidate-removed',
        resourceId: resource.id,
        label: resource.label,
        index,
        candidate: { ...previous.candidates[index] },
      })
    }
    for (let index = shared; index < resource.candidates.length; index++) {
      changes.push({
        kind: 'candidate-added',
        resourceId: resource.id,
        label: resource.label,
        index,
        candidate: { ...resource.candidates[index] },
      })
    }
  }
  return changes
}
