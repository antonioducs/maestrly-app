import type { TFunction } from 'i18next'
import type { ChatModelMeta } from '../../shared/chat'
import type { MaestroStrategyProfileCatalogItem } from '../../shared/maestro'
import type { SubagentProfileModelMetaResult } from '../../shared/subagent-profile-effort'

interface MaestroStrategySearchOption {
  id: string
  label: string
  hint?: string
  searchText?: string
  disabled?: boolean
}

export function mergeMaestroOrchestratorModelMeta(
  chatMeta: ChatModelMeta | null,
  executionMeta: SubagentProfileModelMetaResult
): ChatModelMeta | null {
  const execution = executionMeta.status === 'available' ? executionMeta.meta : null
  if (!chatMeta && !execution) return null
  return {
    ...(chatMeta ?? {}),
    reasoning: chatMeta?.reasoning === true || execution?.reasoning === true,
    reasoningEfforts: chatMeta?.reasoningEfforts?.length ? chatMeta.reasoningEfforts : execution?.reasoningEfforts,
    fastModeCapability: chatMeta?.fastModeCapability === true || execution?.fastModeCapability === true,
  }
}

export function maestroStrategyProfileLabel(item: MaestroStrategyProfileCatalogItem, t: TFunction): string {
  if (item.source === 'global') return t('maestro.strategyProfiles.global')
  if (item.source === 'builtin') return t(`maestro.strategies.${item.config.strategy}`)
  return item.name
}

export function maestroStrategyProfileSummary(item: MaestroStrategyProfileCatalogItem, t: TFunction): string {
  const strategy = t(`maestro.strategies.${item.config.strategy}`)
  const model = item.orchestrator?.modelId ?? t('maestro.strategyProfiles.noOrchestrator')
  const enabled = item.config.pool.filter((resource) => resource.enabled).length
  return t('maestro.strategyProfiles.summary', { strategy, model, count: enabled })
}

export function maestroStrategyProfileOptions(
  items: MaestroStrategyProfileCatalogItem[],
  t: TFunction
): MaestroStrategySearchOption[] {
  return items.map((item) => ({
    id: item.id,
    label: maestroStrategyProfileLabel(item, t),
    hint: maestroStrategyProfileSummary(item, t),
    disabled: !item.orchestrator,
    searchText: [
      item.config.strategy,
      item.orchestrator?.providerId,
      item.orchestrator?.modelId,
      item.orchestrator?.reasoning,
      ...item.config.pool.flatMap((resource) => [
        resource.id,
        resource.label,
        ...resource.specialties,
        ...resource.candidates.flatMap((candidate) => [candidate.providerId, candidate.modelId, candidate.effort]),
      ]),
    ]
      .filter(Boolean)
      .join(' '),
  }))
}
