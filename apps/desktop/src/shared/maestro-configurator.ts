import type { ChatModelRef } from './chat'
import type {
  MaestroConfigDiagnostic,
  MaestroConfigV1,
  MaestroOrchestratorProfileV1,
  MaestroResourceV1,
  MaestroStrategyProfileCatalogItem,
} from './maestro'
import { isIncompleteMaestroCandidate, validateMaestroConfig } from './maestro-config-validation'
import type { SubagentProfileCandidate } from './subagent-profiles'

export const MAESTRO_CONFIGURATOR_THREAD_VERSION = 1 as const
export const MAESTRO_CONFIGURATOR_EVENT_CHANNEL = 'chat:maestro-configurator:event' as const
export const MAESTRO_CONFIGURATOR_MAX_IMAGES = 4
export const MAESTRO_CONFIGURATOR_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export interface MaestroConfiguratorProfile extends SubagentProfileCandidate {}

export interface MaestroConfiguratorCatalogModel {
  id: string
  reasoning: boolean
  reasoningEfforts: string[]
  fastModeCapability: boolean
  contextWindow?: number
  /** Omitted when the catalog does not say whether the model reads images. */
  vision?: boolean
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

/** An image the user attached to a configurator message; its pixels are read once, before the turn. */
export interface MaestroConfiguratorImageInput {
  name: string
  mediaType: string
  bytes: Uint8Array
}

/** What the thread keeps of an attached image: no bytes, only the transcription the assistant worked from. */
export interface MaestroConfiguratorImageRef {
  name: string
  mediaType: string
  byteSize: number
  description?: string
  descriptionModel?: string
}

/** Something the user did outside the assistant that it must know on its next turn. */
export type MaestroConfiguratorThreadEvent =
  /** `skipped` names the parts of the proposal the user left out; absent when it was applied whole. */
  | { kind: 'proposal-applied'; proposalId: string; skipped?: string[] }
  | { kind: 'proposal-dismissed'; proposalId: string }
  | { kind: 'draft-discarded'; profileName: string }
  | { kind: 'saved'; target: 'global' | 'custom' | 'new-custom'; profileName: string }
  | {
      kind: 'profile-selected'
      profileId: string
      profileName: string
      source: MaestroStrategyProfileCatalogItem['source']
    }

export interface MaestroConfiguratorMessage {
  id: string
  role: 'user' | 'assistant' | 'event'
  text: string
  createdAt: number
  model?: ChatModelRef
  usage?: MaestroConfiguratorUsage
  proposal?: MaestroConfiguratorProposal
  images?: MaestroConfiguratorImageRef[]
  event?: MaestroConfiguratorThreadEvent
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
  images?: MaestroConfiguratorImageInput[]
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
  /** A thread message was added or replaced outside a turn's completion (an event, a transcribed image). */
  | { kind: 'message'; message: MaestroConfiguratorMessage }
  | { kind: 'reset' }

/**
 * The Settings editor's working state, kept by the main process while the app runs so it survives the editor
 * unmounting (another tab, a reload) and so the assistant reads what the user sees right now.
 */
export interface MaestroSettingsDraftSession {
  profileId: string
  profileName: string
  /** Raw editor draft: may hold candidate rows the user has not finished. */
  draft: MaestroConfigV1
  orchestrator: MaestroOrchestratorProfileV1 | null
  /** Revision of the saved configuration the draft started from. */
  savedHash: string
}

export interface MaestroConfiguratorPreparedDraft {
  config: MaestroConfigV1
  baseHash: string
  /** Candidate rows left out because they are still being filled in, by position in the editor. */
  skippedCandidates: Array<{ resourceId: string; label: string; index: number }>
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

/**
 * The draft the assistant works on, identical in the renderer and the main process: normalized by the persistence
 * validator (so case or stray spaces never make the revisions disagree) and without the candidate rows the user is
 * still filling in, which would otherwise make the whole draft invalid.
 */
export function prepareMaestroConfiguratorDraft(
  value: unknown
): { ok: true; value: MaestroConfiguratorPreparedDraft } | { ok: false; errors: MaestroConfigDiagnostic[] } {
  const skippedCandidates: MaestroConfiguratorPreparedDraft['skippedCandidates'] = []
  let input = value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>
    if (Array.isArray(raw.pool)) {
      input = {
        ...raw,
        pool: raw.pool.map((resource) => {
          if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return resource
          const entry = resource as Record<string, unknown>
          if (!Array.isArray(entry.candidates)) return resource
          return {
            ...entry,
            candidates: entry.candidates.filter((candidate, index) => {
              if (!isIncompleteMaestroCandidate(candidate)) return true
              skippedCandidates.push({
                resourceId: typeof entry.id === 'string' ? entry.id : '',
                label: typeof entry.label === 'string' ? entry.label : '',
                index,
              })
              return false
            }),
          }
        }),
      }
    }
  }
  const parsed = validateMaestroConfig(input)
  if (!parsed.ok) return parsed
  const config = parsed.value.config
  return { ok: true, value: { config, baseHash: hashMaestroConfig(config), skippedCandidates } }
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

/**
 * One part of a proposal the user can take or leave on its own: the strategy, or everything it changes in one Pool
 * resource. Keys are stable across renderer and main (`strategy`, `resource:<id>`).
 */
export interface MaestroProposalUnit {
  key: string
  kind: 'strategy' | 'resource-added' | 'resource-removed' | 'resource-changed'
  resourceId?: string
  label: string
  changes: MaestroConfiguratorChange[]
}

export const MAESTRO_PROPOSAL_STRATEGY_UNIT = 'strategy'
export const maestroProposalResourceUnit = (resourceId: string) => `resource:${resourceId}`

const changeUnitKey = (change: MaestroConfiguratorChange) =>
  change.kind === 'strategy' ? MAESTRO_PROPOSAL_STRATEGY_UNIT : maestroProposalResourceUnit(change.resourceId)

/** The unit keys a proposal's recorded changes touch, in order. */
export function maestroProposalUnitKeys(changes: MaestroConfiguratorChange[]): string[] {
  return [...new Set(changes.map(changeUnitKey))]
}

/** Strategy first, then resources in the base order, then the ones the proposal adds. */
export function maestroProposalUnits(base: MaestroConfigV1, proposed: MaestroConfigV1): MaestroProposalUnit[] {
  const groups = new Map<string, MaestroConfiguratorChange[]>()
  for (const change of diffMaestroConfigs(base, proposed)) {
    const key = changeUnitKey(change)
    groups.set(key, [...(groups.get(key) ?? []), change])
  }
  const units: MaestroProposalUnit[] = []
  const strategy = groups.get(MAESTRO_PROPOSAL_STRATEGY_UNIT)
  if (strategy) units.push({ key: MAESTRO_PROPOSAL_STRATEGY_UNIT, kind: 'strategy', label: '', changes: strategy })
  const proposedById = new Map(proposed.pool.map((resource) => [resource.id, resource]))
  for (const resource of base.pool) {
    const key = maestroProposalResourceUnit(resource.id)
    const changes = groups.get(key)
    if (!changes) continue
    const next = proposedById.get(resource.id)
    units.push({
      key,
      kind: next ? 'resource-changed' : 'resource-removed',
      resourceId: resource.id,
      label: next?.label ?? resource.label,
      changes,
    })
  }
  const baseIds = new Set(base.pool.map((resource) => resource.id))
  for (const resource of proposed.pool) {
    if (baseIds.has(resource.id)) continue
    const key = maestroProposalResourceUnit(resource.id)
    units.push({
      key,
      kind: 'resource-added',
      resourceId: resource.id,
      label: resource.label,
      changes: groups.get(key) ?? [],
    })
  }
  return units
}

const cloneResource = (resource: MaestroResourceV1): MaestroResourceV1 => ({
  ...resource,
  specialties: [...resource.specialties],
  candidates: resource.candidates.map((candidate) => ({ ...candidate })),
})

/**
 * The draft after taking only the selected units of a proposal. `base` is the prepared form of `draft` the proposal
 * was made from: resources left out keep the editor's own version (unfinished candidate rows included), and taking
 * every unit yields the proposal exactly.
 */
export function applyMaestroProposalUnits({
  draft,
  base,
  proposed,
  selected,
}: {
  draft: MaestroConfigV1
  base: MaestroConfigV1
  proposed: MaestroConfigV1
  selected: ReadonlySet<string>
}): MaestroConfigV1 {
  const units = maestroProposalUnits(base, proposed)
  const taken = new Set(units.filter((unit) => selected.has(unit.key)).map((unit) => unit.key))
  if (units.length > 0 && taken.size === units.length) {
    return { ...proposed, pool: proposed.pool.map(cloneResource) }
  }
  // Validation keeps the order and count of the pool, so positions match; otherwise fall back to the prepared form.
  const own = draft.pool.length === base.pool.length ? draft.pool : base.pool
  const proposedById = new Map(proposed.pool.map((resource) => [resource.id, resource]))
  const pool: MaestroResourceV1[] = []
  const ids: string[] = []
  base.pool.forEach((resource, index) => {
    if (!taken.has(maestroProposalResourceUnit(resource.id))) {
      pool.push(cloneResource(own[index]!))
      ids.push(resource.id)
      return
    }
    const next = proposedById.get(resource.id)
    if (!next) return
    pool.push(cloneResource(next))
    ids.push(resource.id)
  })
  const baseIds = new Set(base.pool.map((resource) => resource.id))
  proposed.pool.forEach((resource, index) => {
    if (baseIds.has(resource.id) || !taken.has(maestroProposalResourceUnit(resource.id))) return
    const previous = proposed.pool
      .slice(0, index)
      .reverse()
      .find((candidate) => ids.includes(candidate.id))
    const at = previous ? ids.indexOf(previous.id) + 1 : 0
    pool.splice(at, 0, cloneResource(resource))
    ids.splice(at, 0, resource.id)
  })
  return {
    version: draft.version,
    strategy: taken.has(MAESTRO_PROPOSAL_STRATEGY_UNIT) ? proposed.strategy : draft.strategy,
    pool,
  }
}

export type MaestroProposalOutcome =
  | { status: 'pending' }
  /** A later proposal replaced it before the user decided. */
  | { status: 'superseded' }
  | { status: 'dismissed' }
  /** `draft` until a save; `discarded` when the unsaved draft holding it was thrown away. */
  | { status: 'applied'; skipped: string[]; state: 'draft' | 'saved' | 'discarded' }

/** What became of each proposal in a thread, read from the editor events recorded after it. */
export function maestroProposalOutcomes(messages: MaestroConfiguratorMessage[]): Map<string, MaestroProposalOutcome> {
  const outcomes = new Map<string, MaestroProposalOutcome>()
  const settle = (next: (outcome: MaestroProposalOutcome) => MaestroProposalOutcome) => {
    for (const [id, outcome] of outcomes) outcomes.set(id, next(outcome))
  }
  for (const message of messages) {
    if (message.proposal) {
      settle((outcome) => (outcome.status === 'pending' ? { status: 'superseded' } : outcome))
      outcomes.set(message.proposal.id, { status: 'pending' })
      continue
    }
    const event = message.event
    if (!event) continue
    if (event.kind === 'proposal-applied' && outcomes.has(event.proposalId)) {
      outcomes.set(event.proposalId, { status: 'applied', skipped: event.skipped ?? [], state: 'draft' })
    } else if (event.kind === 'proposal-dismissed' && outcomes.has(event.proposalId)) {
      outcomes.set(event.proposalId, { status: 'dismissed' })
    } else if (event.kind === 'saved') {
      settle((outcome) =>
        outcome.status === 'applied' && outcome.state === 'draft' ? { ...outcome, state: 'saved' } : outcome
      )
    } else if (event.kind === 'draft-discarded' || event.kind === 'profile-selected') {
      settle((outcome) =>
        outcome.status === 'applied' && outcome.state === 'draft' ? { ...outcome, state: 'discarded' } : outcome
      )
    }
  }
  return outcomes
}
