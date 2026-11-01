import { isRealSubagentProfileEffort } from './subagent-profile-effort'
import { normalizeSubagentProfileKey, type SubagentProfileCandidate } from './subagent-profiles'
import {
  MAESTRO_CONFIG_VERSION,
  type MaestroConfigDiagnostic,
  type MaestroConfigPayload,
  type MaestroConfigV1,
  type MaestroResourceV1,
} from './maestro'

export type MaestroConfigSaveResult =
  | { ok: true; value: MaestroConfigPayload }
  | { ok: false; errors: MaestroConfigDiagnostic[] }

const diagnostic = (message: string, resourceId?: string): MaestroConfigDiagnostic => ({
  code: 'invalid-structure',
  message,
  severity: 'error',
  ...(resourceId ? { resourceId } : {}),
})

const STRATEGIES = ['balanced', 'best-quality', 'fast', 'economy'] as const

function parseCandidate(value: unknown, path: string, resourceId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: diagnostic(`${path} must be an object.`, resourceId) }
  }
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  const effort = typeof raw.effort === 'string' ? raw.effort.trim().toLowerCase() : ''
  if (!providerId || !modelId || !effort || (effort !== 'off' && !isRealSubagentProfileEffort(effort))) {
    return { error: diagnostic(`${path} requires providerId, modelId and a real effort.`, resourceId) }
  }
  if (raw.fastMode !== undefined && typeof raw.fastMode !== 'boolean') {
    return { error: diagnostic(`${path}.fastMode must be boolean.`, resourceId) }
  }
  const candidate: SubagentProfileCandidate = {
    providerId,
    modelId,
    effort,
    ...(raw.fastMode === true ? { fastMode: true } : {}),
  }
  return { value: candidate }
}

function parseResource(
  value: unknown,
  index: number
): { value?: MaestroResourceV1; errors: MaestroConfigDiagnostic[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: [diagnostic(`pool[${index}] must be an object.`)] }
  }
  const raw = value as Record<string, unknown>
  const id = normalizeSubagentProfileKey(typeof raw.id === 'string' ? raw.id : '')
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const errors: MaestroConfigDiagnostic[] = []
  if (!id) errors.push(diagnostic(`pool[${index}].id is required.`))
  if (!label) errors.push(diagnostic(`pool[${index}].label is required.`, id))
  if (typeof raw.enabled !== 'boolean') errors.push(diagnostic(`pool[${index}].enabled must be boolean.`, id))
  if (!description) errors.push(diagnostic(`pool[${index}].description is required.`, id))
  if (raw.capability !== 'worker' && raw.capability !== 'read-only') {
    errors.push(diagnostic(`pool[${index}].capability is invalid.`, id))
  }
  if (!Array.isArray(raw.specialties) || raw.specialties.some((item) => typeof item !== 'string')) {
    errors.push(diagnostic(`pool[${index}].specialties must be a string array.`, id))
  }
  const candidates: SubagentProfileCandidate[] = []
  if (!Array.isArray(raw.candidates)) errors.push(diagnostic(`pool[${index}].candidates must be an array.`, id))
  else {
    raw.candidates.forEach((candidate, candidateIndex) => {
      const parsed = parseCandidate(candidate, `pool[${index}].candidates[${candidateIndex}]`, id)
      if (parsed.error) errors.push(parsed.error)
      else candidates.push(parsed.value!)
    })
  }
  if (raw.agentName !== undefined && typeof raw.agentName !== 'string') {
    errors.push(diagnostic(`pool[${index}].agentName must be a string.`, id))
  }
  if (raw.instructions !== undefined && typeof raw.instructions !== 'string') {
    errors.push(diagnostic(`pool[${index}].instructions must be a string.`, id))
  }
  if (errors.length) return { errors }
  const specialties = [...new Set((raw.specialties as string[]).map(normalizeSubagentProfileKey).filter(Boolean))]
  return {
    value: {
      id,
      label,
      enabled: raw.enabled as boolean,
      description,
      capability: raw.capability as MaestroResourceV1['capability'],
      specialties,
      candidates,
      ...(typeof raw.agentName === 'string' && raw.agentName.trim() ? { agentName: raw.agentName.trim() } : {}),
      ...(typeof raw.instructions === 'string' && raw.instructions.trim()
        ? { instructions: raw.instructions.trim() }
        : {}),
    },
    errors: [],
  }
}

/** Strict, normalizing validator shared by the main process (persistence) and the renderer (draft revisions). */
export function validateMaestroConfig(value: unknown): MaestroConfigSaveResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [diagnostic('Maestro config must be an object.')] }
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== MAESTRO_CONFIG_VERSION) {
    return { ok: false, errors: [diagnostic('Unsupported Maestro config version.')] }
  }
  if (![...STRATEGIES, 'custom'].includes(String(raw.strategy))) {
    return { ok: false, errors: [diagnostic('Maestro strategy is invalid.')] }
  }
  const errors: MaestroConfigDiagnostic[] = []
  if (!Array.isArray(raw.pool) || raw.pool.length === 0) errors.push(diagnostic('Maestro pool must not be empty.'))
  const pool: MaestroResourceV1[] = []
  if (Array.isArray(raw.pool)) {
    raw.pool.forEach((resource, index) => {
      const parsed = parseResource(resource, index)
      errors.push(...parsed.errors)
      if (parsed.value) pool.push(parsed.value)
    })
  }
  const seen = new Set<string>()
  for (const resource of pool) {
    if (seen.has(resource.id)) errors.push(diagnostic(`Duplicate Maestro resource id “${resource.id}”.`, resource.id))
    seen.add(resource.id)
  }
  if (errors.length) return { ok: false, errors }
  const config: MaestroConfigV1 = {
    version: MAESTRO_CONFIG_VERSION,
    // Normalize older Custom configs to Balanced. Deliberately ignore all legacy score/policy fields,
    // but keep agents, instructions, and candidates intact.
    strategy: raw.strategy === 'custom' ? 'balanced' : (raw.strategy as MaestroConfigV1['strategy']),
    pool,
  }
  return { ok: true, value: { config, source: 'global', diagnostics: [], hasConversationOverride: false } }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * Coerces an editor draft into the V1 shape without requiring it to be complete: rows the user is still filling in
 * (empty provider, model or effort) and half-typed fields survive. Returns null when the value is not a draft.
 */
export function sanitizeMaestroDraftShape(value: unknown): MaestroConfigV1 | null {
  if (!isRecord(value)) return null
  if (value.version !== MAESTRO_CONFIG_VERSION || !Array.isArray(value.pool) || value.pool.length === 0) return null
  const strategy = STRATEGIES.includes(value.strategy as MaestroConfigV1['strategy'])
    ? (value.strategy as MaestroConfigV1['strategy'])
    : 'balanced'
  const pool: MaestroResourceV1[] = []
  for (const resource of value.pool) {
    if (!isRecord(resource)) return null
    pool.push({
      id: text(resource.id),
      label: text(resource.label),
      enabled: resource.enabled !== false,
      description: text(resource.description),
      capability: resource.capability === 'read-only' ? 'read-only' : 'worker',
      specialties: Array.isArray(resource.specialties)
        ? resource.specialties.filter((specialty): specialty is string => typeof specialty === 'string')
        : [],
      candidates: (Array.isArray(resource.candidates) ? resource.candidates : []).filter(isRecord).map((candidate) => ({
        providerId: text(candidate.providerId),
        modelId: text(candidate.modelId),
        effort: text(candidate.effort),
        ...(candidate.fastMode === true ? { fastMode: true } : {}),
      })),
      ...(typeof resource.agentName === 'string' ? { agentName: resource.agentName } : {}),
      ...(typeof resource.instructions === 'string' ? { instructions: resource.instructions } : {}),
    })
  }
  return { version: MAESTRO_CONFIG_VERSION, strategy, pool }
}

/** A candidate row the user added but has not finished choosing (no provider, model or effort yet). */
export function isIncompleteMaestroCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false
  return [value.providerId, value.modelId, value.effort].some(
    (field) => typeof field !== 'string' || field.trim().length === 0
  )
}
