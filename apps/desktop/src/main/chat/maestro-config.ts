import { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'
import { normalizeSubagentProfileKey, type SubagentProfileCandidate } from '../../shared/subagent-profiles'
import {
  MAESTRO_CONFIG_VERSION,
  cloneMaestroConfig,
  createDefaultMaestroConfig,
  type MaestroConfigDiagnostic,
  type MaestroConfigPayload,
  type MaestroConfigV1,
  type MaestroResourceV1,
  type MaestroTurnSnapshotV1,
} from '../../shared/maestro'
import { getAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs, setAppSetting } from '../store'

export const MAESTRO_CONFIG_SETTING_KEY = 'chat.maestro.v1'

export type MaestroConfigSaveResult =
  | { ok: true; value: MaestroConfigPayload }
  | { ok: false; errors: MaestroConfigDiagnostic[] }

const diagnostic = (message: string, resourceId?: string): MaestroConfigDiagnostic => ({
  code: 'invalid-structure',
  message,
  severity: 'error',
  ...(resourceId ? { resourceId } : {}),
})

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

export function validateMaestroConfig(value: unknown): MaestroConfigSaveResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [diagnostic('Maestro config must be an object.')] }
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== MAESTRO_CONFIG_VERSION) {
    return { ok: false, errors: [diagnostic('Unsupported Maestro config version.')] }
  }
  if (!['balanced', 'best-quality', 'fast', 'economy', 'custom'].includes(String(raw.strategy))) {
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

function corruptPayload(message: string): MaestroConfigPayload {
  return {
    config: createDefaultMaestroConfig(),
    source: 'safe-default',
    diagnostics: [{ code: 'config-corrupt', message, severity: 'warning' }],
    hasConversationOverride: false,
  }
}

export function getGlobalMaestroConfig(): MaestroConfigPayload {
  const raw = getAppSetting(MAESTRO_CONFIG_SETTING_KEY)
  if (!raw) {
    return {
      config: createDefaultMaestroConfig(),
      source: 'safe-default',
      diagnostics: [],
      hasConversationOverride: false,
    }
  }
  try {
    const parsed = validateMaestroConfig(JSON.parse(raw))
    return parsed.ok ? parsed.value : corruptPayload(parsed.errors.map((item) => item.message).join(' '))
  } catch {
    return corruptPayload('Global Maestro configuration is corrupt and was replaced with the safe default.')
  }
}

export function setGlobalMaestroConfig(value: unknown): MaestroConfigSaveResult {
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  setAppSetting(MAESTRO_CONFIG_SETTING_KEY, JSON.stringify(parsed.value.config))
  return { ok: true, value: getGlobalMaestroConfig() }
}

export function getConversationMaestroConfig(conversationId: string): MaestroConfigPayload {
  const prefs = getConvUiPrefs(conversationId)
  const override = prefs.maestro?.config
  if (override === undefined) return getGlobalMaestroConfig()
  const parsed = validateMaestroConfig(override)
  if (!parsed.ok) {
    const global = getGlobalMaestroConfig()
    return {
      ...global,
      diagnostics: [
        ...global.diagnostics,
        {
          code: 'config-corrupt',
          message: `Conversation Maestro override is corrupt and was ignored. ${parsed.errors.map((item) => item.message).join(' ')}`,
          severity: 'warning',
        },
      ],
      hasConversationOverride: true,
    }
  }
  return {
    ...parsed.value,
    source: prefs.maestro?.projectScoped === true ? 'project' : 'conversation',
    hasConversationOverride: true,
  }
}

export function setConversationMaestroConfig(conversationId: string, value: unknown | null): MaestroConfigSaveResult {
  const conversation = getConversation(conversationId)
  if (conversation?.experience !== 'maestro') {
    return { ok: false, errors: [diagnostic('Maestro overrides require a Maestro conversation.')] }
  }
  const prefs = getConvUiPrefs(conversationId)
  if (value == null) {
    const next = { ...(prefs.maestro ?? {}) }
    delete next.config
    delete next.projectScoped
    patchConvUiPrefs(conversationId, { maestro: next })
    return { ok: true, value: getConversationMaestroConfig(conversationId) }
  }
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  patchConvUiPrefs(conversationId, {
    maestro: { ...(prefs.maestro ?? {}), config: parsed.value.config, projectScoped: false },
  })
  return { ok: true, value: getConversationMaestroConfig(conversationId) }
}

/** Host-only save path for cloud jobs. The marker makes physical agent resolution portable without changing V1. */
export function setProjectConversationMaestroConfig(
  conversationId: string,
  value: unknown
): MaestroConfigSaveResult {
  const conversation = getConversation(conversationId)
  if (conversation?.experience !== 'maestro') {
    return { ok: false, errors: [diagnostic('Shared Maestro configuration requires a Maestro conversation.')] }
  }
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  const prefs = getConvUiPrefs(conversationId)
  patchConvUiPrefs(conversationId, {
    maestro: { ...(prefs.maestro ?? {}), config: parsed.value.config, projectScoped: true },
  })
  return { ok: true, value: getConversationMaestroConfig(conversationId) }
}

export function freezeMaestroTurn(conversationId: string, frozenAt = Date.now()): MaestroTurnSnapshotV1 {
  const payload = getConversationMaestroConfig(conversationId)
  const config = cloneMaestroConfig(payload.config)
  return {
    version: MAESTRO_CONFIG_VERSION,
    strategy: config.strategy,
    pool: config.pool,
    source: payload.source,
    diagnostics: payload.diagnostics.map((item) => ({ ...item })),
    frozenAt,
  }
}
