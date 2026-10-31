/**
 * The ordered model fallback list (app setting `chat.modelFallback.v1`). Reading never throws: corrupt or partial
 * values become a disabled or filtered list. Entries keep their own effort and Fast mode, never the primary's.
 */
import type { ChatModelFallbackCandidate, ChatModelFallbackConfigV1 } from '../../../shared/chat'
import { getAppSetting, setAppSetting } from '../../store'

export const MODEL_FALLBACK_CONFIG_KEY = 'chat.modelFallback.v1'
export const MAX_MODEL_FALLBACKS = 8
const MAX_ID_LENGTH = 256
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/i

export type { ChatModelFallbackCandidate, ChatModelFallbackConfigV1 }

export function emptyModelFallbackConfig(): ChatModelFallbackConfigV1 {
  return { version: 1, enabled: false, fallbacks: [] }
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= MAX_ID_LENGTH ? id : null
}

export function modelFallbackCandidateKey(
  candidate: Pick<ChatModelFallbackCandidate, 'providerId' | 'modelId'>
): string {
  return `${candidate.providerId}::${candidate.modelId}`
}

export function sanitizeModelFallbackCandidate(raw: unknown): ChatModelFallbackCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const providerId = cleanId(record.providerId)
  const modelId = cleanId(record.modelId)
  if (!providerId || !modelId) return null
  const reasoning =
    typeof record.reasoning === 'string' && EFFORT.test(record.reasoning.trim()) ? record.reasoning.trim() : undefined
  return {
    providerId,
    modelId,
    ...(reasoning ? { reasoning } : {}),
    ...(record.fastMode === true ? { fastMode: true } : {}),
  }
}

/** Never throws: anything that is not a valid v1 config becomes the empty (disabled) config. */
export function sanitizeModelFallbackConfig(raw: unknown): ChatModelFallbackConfigV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyModelFallbackConfig()
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.fallbacks)) return emptyModelFallbackConfig()
  const seen = new Set<string>()
  const fallbacks: ChatModelFallbackCandidate[] = []
  for (const item of record.fallbacks) {
    const candidate = sanitizeModelFallbackCandidate(item)
    if (!candidate) continue
    const key = modelFallbackCandidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    fallbacks.push(candidate)
    if (fallbacks.length >= MAX_MODEL_FALLBACKS) break
  }
  return { version: 1, enabled: record.enabled === true, fallbacks }
}

export function getModelFallbackConfig(): ChatModelFallbackConfigV1 {
  const raw = getAppSetting(MODEL_FALLBACK_CONFIG_KEY)
  if (!raw) return emptyModelFallbackConfig()
  try {
    return sanitizeModelFallbackConfig(JSON.parse(raw))
  } catch {
    return emptyModelFallbackConfig()
  }
}

export function setModelFallbackConfig(input: unknown): ChatModelFallbackConfigV1 {
  const config = sanitizeModelFallbackConfig(input)
  setAppSetting(MODEL_FALLBACK_CONFIG_KEY, JSON.stringify(config))
  return config
}

/** Drops a removed provider (or account) from the list. */
export function removeProviderFromModelFallback(providerId: string): void {
  const config = getModelFallbackConfig()
  const fallbacks = config.fallbacks.filter((candidate) => candidate.providerId !== providerId)
  if (fallbacks.length !== config.fallbacks.length) setModelFallbackConfig({ ...config, fallbacks })
}
