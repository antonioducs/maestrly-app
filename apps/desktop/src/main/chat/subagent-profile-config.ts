import { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'
import {
  SUBAGENT_PROFILE_RULES_VERSION,
  normalizeSubagentProfileKey,
  type ConversationSubagentProfileConfigPayload,
  type ConversationSubagentProfileSaveResult,
  type SubagentProfileCandidate,
  type SubagentProfileConfigPayload,
  type SubagentProfileDiagnostic,
  type SubagentProfileRulesV1,
  type SubagentProfileSaveResult,
} from '../../shared/subagent-profiles'
import { getAppSetting, getConvUiPrefs, patchConvUiPrefs, setAppSetting } from '../store'

export const SUBAGENT_PROFILES_SETTING_KEY = 'chat.subagentProfiles.v1'

function structuralError(message: string): SubagentProfileDiagnostic {
  return { code: 'invalid-structure', message, severity: 'error' }
}

function parseCandidate(
  value: unknown,
  path: string,
  allowLegacyPseudoEfforts: boolean
): { value?: SubagentProfileCandidate; errors: SubagentProfileDiagnostic[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { errors: [structuralError(`${path} must be an object.`)] }
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  const effort = typeof raw.effort === 'string' ? raw.effort.trim().toLowerCase() : ''
  if (!providerId || !modelId || !effort) {
    return { errors: [structuralError(`${path} requires providerId, modelId and effort.`)] }
  }
  if (!allowLegacyPseudoEfforts && !isRealSubagentProfileEffort(effort)) {
    return { errors: [structuralError(`${path}.effort must be a real model effort, not “${effort}”.`)] }
  }
  if (raw.fastMode !== undefined && typeof raw.fastMode !== 'boolean') {
    return { errors: [structuralError(`${path}.fastMode must be a boolean when provided.`)] }
  }
  return {
    value: { providerId, modelId, effort, ...(raw.fastMode === true ? { fastMode: true } : {}) },
    errors: [],
  }
}

function parseList(
  value: unknown,
  path: string,
  allowLegacyPseudoEfforts: boolean
): { value?: SubagentProfileCandidate[]; errors: SubagentProfileDiagnostic[] } {
  if (!Array.isArray(value) || value.length === 0)
    return { errors: [structuralError(`${path} must be a non-empty array.`)] }
  const errors: SubagentProfileDiagnostic[] = []
  const candidates: SubagentProfileCandidate[] = []
  value.forEach((candidate, index) => {
    const parsed = parseCandidate(candidate, `${path}[${index}]`, allowLegacyPseudoEfforts)
    errors.push(...parsed.errors)
    if (parsed.value) candidates.push(parsed.value)
  })
  return { value: errors.length ? undefined : candidates, errors }
}

function parseMap(
  value: unknown,
  path: string,
  allowLegacyPseudoEfforts: boolean
): { value?: Record<string, SubagentProfileCandidate[]>; errors: SubagentProfileDiagnostic[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { errors: [structuralError(`${path} must be an object.`)] }
  const result: Record<string, SubagentProfileCandidate[]> = {}
  const errors: SubagentProfileDiagnostic[] = []
  for (const [rawKey, rawList] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeSubagentProfileKey(rawKey)
    if (!key) {
      errors.push(structuralError(`${path} contains an empty key.`))
      continue
    }
    if (Object.hasOwn(result, key)) {
      errors.push(structuralError(`${path} contains multiple keys that normalize to “${key}”.`))
      continue
    }
    const parsed = parseList(rawList, `${path}.${rawKey}`, allowLegacyPseudoEfforts)
    errors.push(...parsed.errors)
    if (parsed.value) result[key] = parsed.value
  }
  return { value: errors.length ? undefined : result, errors }
}

export function validateSubagentProfileRules(
  value: unknown,
  options: { allowLegacyPseudoEfforts?: boolean } = {}
): SubagentProfileSaveResult {
  const allowLegacyPseudoEfforts = options.allowLegacyPseudoEfforts === true
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, errors: [structuralError('Rules must be an object.')] }
  const raw = value as Record<string, unknown>
  if (raw.version !== SUBAGENT_PROFILE_RULES_VERSION)
    return { ok: false, errors: [structuralError('Unsupported rules version.')] }
  const out: SubagentProfileRulesV1 = { version: SUBAGENT_PROFILE_RULES_VERSION }
  const errors: SubagentProfileDiagnostic[] = []
  if (raw.default !== undefined) {
    const parsed = parseList(raw.default, 'default', allowLegacyPseudoEfforts)
    errors.push(...parsed.errors)
    if (parsed.value) out.default = parsed.value
  }
  if (raw.byCategory !== undefined) {
    const parsed = parseMap(raw.byCategory, 'byCategory', allowLegacyPseudoEfforts)
    errors.push(...parsed.errors)
    if (parsed.value) out.byCategory = parsed.value
  }
  if (raw.byAgent !== undefined) {
    const parsed = parseMap(raw.byAgent, 'byAgent', allowLegacyPseudoEfforts)
    errors.push(...parsed.errors)
    if (parsed.value) out.byAgent = parsed.value
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { rules: out, diagnostics: [] } }
}

function corruptPayload(message: string): SubagentProfileConfigPayload {
  return { rules: null, diagnostics: [{ code: 'config-corrupt', message, severity: 'warning' }] }
}

export function getGlobalSubagentProfileRules(): SubagentProfileConfigPayload {
  const raw = getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)
  if (!raw) return { rules: null, diagnostics: [] }
  try {
    const parsed = validateSubagentProfileRules(JSON.parse(raw), { allowLegacyPseudoEfforts: true })
    return parsed.ok ? parsed.value : corruptPayload(parsed.errors.map((e) => e.message).join(' '))
  } catch {
    return corruptPayload('Global subagent profile configuration is corrupt and was ignored.')
  }
}

export function setGlobalSubagentProfileRules(value: unknown): SubagentProfileSaveResult {
  const parsed = validateSubagentProfileRules(value)
  if (!parsed.ok) return parsed
  setAppSetting(SUBAGENT_PROFILES_SETTING_KEY, JSON.stringify(parsed.value.rules))
  return parsed
}

export function getConversationSubagentProfileRules(conversationId: string): ConversationSubagentProfileConfigPayload {
  const chat = getConvUiPrefs(conversationId).chat
  const enabled = chat?.subagentProfilesEnabled !== false
  const subagentsEnabled = chat?.subagentsEnabled !== false
  const value = chat?.subagentProfiles
  if (value === undefined) return { rules: null, diagnostics: [], enabled, subagentsEnabled }
  const parsed = validateSubagentProfileRules(value, { allowLegacyPseudoEfforts: true })
  return parsed.ok
    ? { ...parsed.value, enabled, subagentsEnabled }
    : { ...corruptPayload(parsed.errors.map((e) => e.message).join(' ')), enabled, subagentsEnabled }
}

export function setConversationSubagentProfileRules(
  conversationId: string,
  value: unknown | null
): ConversationSubagentProfileSaveResult {
  const current = getConvUiPrefs(conversationId)
  const chat = { ...(current.chat ?? {}) }
  if (value == null) {
    delete chat.subagentProfiles
    patchConvUiPrefs(conversationId, { chat })
    return { ok: true, value: getConversationSubagentProfileRules(conversationId) }
  }
  const parsed = validateSubagentProfileRules(value)
  if (!parsed.ok) return parsed
  chat.subagentProfiles = parsed.value.rules ?? undefined
  patchConvUiPrefs(conversationId, { chat })
  return { ok: true, value: getConversationSubagentProfileRules(conversationId) }
}

export function setConversationSubagentProfilesEnabled(
  conversationId: string,
  enabled: boolean
): ConversationSubagentProfileSaveResult {
  const current = getConvUiPrefs(conversationId)
  const chat = { ...(current.chat ?? {}), subagentProfilesEnabled: enabled }
  patchConvUiPrefs(conversationId, { chat })
  return { ok: true, value: getConversationSubagentProfileRules(conversationId) }
}

export function setConversationSubagentsEnabled(
  conversationId: string,
  enabled: boolean
): ConversationSubagentProfileSaveResult {
  const current = getConvUiPrefs(conversationId)
  const chat = { ...(current.chat ?? {}), subagentsEnabled: enabled }
  patchConvUiPrefs(conversationId, { chat })
  return { ok: true, value: getConversationSubagentProfileRules(conversationId) }
}
