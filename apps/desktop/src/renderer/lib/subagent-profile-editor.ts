import {
  DEFAULT_REASONING_EFFORTS,
  isChatProviderConnected,
  isChatSubscriptionProviderKind,
  type ChatProviderInfo,
} from '../../shared/chat'
import { isRealSubagentProfileEffort, type SubagentProfileModelMetaResult } from '../../shared/subagent-profile-effort'
import {
  isClaudeFableModelId,
  isClaudeSubscriptionProfileProvider,
  type SubagentProfileCandidate,
} from '../../shared/subagent-profiles'

export { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'

export interface SubagentProfileModelOption {
  id: string
  label: string
  hint?: string
  disabled?: boolean
}

export function subagentProfileModelOptions(
  providerId: string,
  models: string[],
  unavailableLabel: string,
  catalogAvailable: boolean
): SubagentProfileModelOption[] {
  const options = models.map((model) => ({ id: model, label: model }))
  if (!catalogAvailable || !isClaudeSubscriptionProfileProvider(providerId) || models.some(isClaudeFableModelId)) {
    return options
  }
  const fable = { id: 'fable', label: 'fable', hint: unavailableLabel, disabled: true }
  const defaultIndex = options.findIndex((option) => option.id === 'default')
  options.splice(defaultIndex >= 0 ? defaultIndex + 1 : 0, 0, fable)
  return options
}

export function subagentProfileProviders(providers: ChatProviderInfo[]): ChatProviderInfo[] {
  return providers.filter(
    (provider) => !isChatSubscriptionProviderKind(provider.kind) || isChatProviderConnected(provider)
  )
}

export function emptySubagentProfileCandidate(providerId = ''): SubagentProfileCandidate {
  return { providerId, modelId: '', effort: '' }
}

export function subagentProfileEffortIds(metadata: SubagentProfileModelMetaResult | null): string[] {
  if (metadata?.status !== 'available' || metadata.meta?.reasoning !== true) return []
  return metadata.meta.reasoningEfforts?.length
    ? metadata.meta.reasoningEfforts.filter((effort) => isRealSubagentProfileEffort(effort))
    : [...DEFAULT_REASONING_EFFORTS]
}

export function subagentProfileAllowsCustomEffort(metadata: SubagentProfileModelMetaResult | null): boolean {
  if (!metadata) return false
  return metadata.status === 'unavailable' || metadata.meta?.reasoning === undefined
}

export function changeSubagentProfileProvider(
  candidate: SubagentProfileCandidate,
  providerId: string
): SubagentProfileCandidate {
  return providerId === candidate.providerId ? candidate : { providerId, modelId: '', effort: '' }
}

export function changeSubagentProfileModel(
  candidate: SubagentProfileCandidate,
  modelId: string
): SubagentProfileCandidate {
  return modelId === candidate.modelId ? candidate : { providerId: candidate.providerId, modelId, effort: '' }
}

export function changeSubagentProfileFastMode(
  candidate: SubagentProfileCandidate,
  enabled: boolean
): SubagentProfileCandidate {
  if (enabled) return candidate.fastMode === true ? candidate : { ...candidate, fastMode: true }
  if (candidate.fastMode !== true) return candidate
  const next = { ...candidate }
  delete next.fastMode
  return next
}
