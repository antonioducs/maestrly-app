import {autonomousProviderAllowed} from './autonomous'
import type { ChatModelMeta } from '../../shared/chat'
import type { SubagentProfileModelMetaResult } from '../../shared/subagent-profile-effort'
import type { SubagentProfileModelCatalogResult } from '../../shared/subagent-profiles'
import {
  getProvider,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  isGrokSubscriptionProvider,
  subscriptionAccountId,
} from './catalog'
import { hasApiKey } from './credentials'
import { getCodexSubscriptionManager, type CodexSubscriptionModel } from './codex-subscription/manager'
import { getGitHubCopilotSubscriptionManager } from './github-copilot/manager'
import { getClaudeSubscriptionManager } from './claude-agent-sdk/manager'
import { getGrokSubscriptionManager, type GrokSubscriptionModel } from './grok-subscription/manager'
import { grokReasoningMeta } from './grok-subscription/models'
import { catalogProviderForBaseURL, getProviderModelMetaWithStatus } from './model-meta'
import { fetchModelsWithStatus } from './models'
import { getHiddenChatModelsFor } from '../store'

export type SubagentProviderStatus = 'missing' | 'unsupported' | 'disconnected' | 'no-key' | 'available'

function visibleModelIds(providerId: string, models: string[]): string[] {
  const hidden = new Set(getHiddenChatModelsFor(providerId))
  return [...new Set(models.filter((model) => !hidden.has(model)))]
}

function codexModelMeta(model: CodexSubscriptionModel): ChatModelMeta {
  const efforts = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort).filter(Boolean)
  return {
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    reasoning: efforts.length > 0,
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    vision: model.inputModalities.includes('image'),
    chatCapable: model.inputModalities.includes('text'),
    fastModeCapability: model.serviceTiers.some((tier) => /^(?:priority|fast)$/i.test(tier.id)),
    nativeUltraMode: false,
    contextLimitEditable: false,
  }
}

async function authenticatedCodexModels(accountId: string | null): Promise<readonly CodexSubscriptionModel[] | null> {
  const manager = getCodexSubscriptionManager(accountId)
  const status = await manager.getStatus().catch(() => null)
  if (!status?.authenticated) return null
  return manager.listModels().catch(() => null)
}

type CopilotSubscriptionModel = Awaited<
  ReturnType<ReturnType<typeof getGitHubCopilotSubscriptionManager>['listModels']>
>[number]

function copilotModelMeta(model: CopilotSubscriptionModel): ChatModelMeta {
  const efforts = model.supportedReasoningEfforts ?? []
  return {
    ...(model.capabilities.limits.max_context_window_tokens
      ? { contextWindow: model.capabilities.limits.max_context_window_tokens }
      : {}),
    reasoning: model.capabilities.supports.reasoningEffort,
    ...(efforts.length ? { reasoningEfforts: [...efforts] } : {}),
    vision: model.capabilities.supports.vision,
    chatCapable: true,
    fastModeCapability: false,
    nativeUltraMode: false,
    contextLimitEditable: false,
  }
}

async function authenticatedCopilotModels(accountId: string | null): Promise<readonly CopilotSubscriptionModel[] | null> {
  const manager = getGitHubCopilotSubscriptionManager(accountId)
  const status = await manager.getStatus().catch(() => null)
  if (!status?.authenticated || !status.connected) return null
  return manager.listModels().catch(() => null)
}

type ClaudeSubscriptionModel = Awaited<
  ReturnType<ReturnType<typeof getClaudeSubscriptionManager>['listModels']>
>[number]

function claudeModelMeta(model: ClaudeSubscriptionModel, accountId: string | null): ChatModelMeta {
  const efforts = model.supportedEffortLevels ?? []
  const manager = getClaudeSubscriptionManager(accountId)
  const contextWindow =
    manager.getObservedModelContextWindow(model.value) ??
    (model.resolvedModel ? manager.getObservedModelContextWindow(model.resolvedModel) : undefined)
  return {
    ...(contextWindow ? { contextWindow } : {}),
    reasoning: model.supportsEffort === true || model.supportsAdaptiveThinking === true || efforts.length > 0,
    ...(efforts.length ? { reasoningEfforts: [...efforts] } : {}),
    vision: true,
    chatCapable: true,
    fastModeCapability: model.supportsFastMode === true,
    nativeUltraMode: false,
    contextLimitEditable: false,
  }
}

async function authenticatedClaudeModels(accountId: string | null): Promise<readonly ClaudeSubscriptionModel[] | null> {
  const manager = getClaudeSubscriptionManager(accountId)
  const status = await manager.status().catch(() => null)
  if (!status?.authenticated) return null
  return manager.listModels().catch(() => null)
}

function grokModelMeta(model: GrokSubscriptionModel): ChatModelMeta {
  return {
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...grokReasoningMeta(model.id),
    chatCapable: true,
    fastModeCapability: true,
    contextLimitEditable: false,
  }
}

async function authenticatedGrokModels(accountId: string | null): Promise<readonly GrokSubscriptionModel[] | null> {
  const manager = getGrokSubscriptionManager(accountId)
  const status = await manager.getStatus().catch(() => null)
  if (!status?.authenticated) return null
  return manager.listModels().catch(() => null)
}

export async function subagentProviderStatus(providerId: string): Promise<SubagentProviderStatus> {
  if (!autonomousProviderAllowed(providerId)) return 'unsupported'
  if (!getProvider(providerId)) return 'missing'
  const accountId = subscriptionAccountId(providerId)
  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const status = await getGitHubCopilotSubscriptionManager(accountId)
      .getStatus()
      .catch(() => null)
    return status?.authenticated && status.connected ? 'available' : 'disconnected'
  }
  if (isCodexSubscriptionProvider(providerId)) {
    const status = await getCodexSubscriptionManager(accountId)
      .getStatus()
      .catch(() => null)
    return status?.authenticated ? 'available' : 'disconnected'
  }
  if (isClaudeSubscriptionProvider(providerId)) {
    const status = await getClaudeSubscriptionManager(accountId)
      .status()
      .catch(() => null)
    return status?.authenticated ? 'available' : 'disconnected'
  }
  if (isGrokSubscriptionProvider(providerId)) {
    const status = await getGrokSubscriptionManager(accountId)
      .getStatus()
      .catch(() => null)
    return status?.authenticated ? 'available' : 'disconnected'
  }
  return hasApiKey(providerId) ? 'available' : 'no-key'
}

export async function subagentModelCatalog(providerId: string): Promise<SubagentProfileModelCatalogResult> {
  const accountId = subscriptionAccountId(providerId)
  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const models = await authenticatedCopilotModels(accountId)
    return models
      ? {
          status: 'available',
          models: visibleModelIds(
            providerId,
            models.filter((model) => model.policy?.state !== 'disabled').map((model) => model.id)
          ),
        }
      : { status: 'unavailable', models: [] }
  }
  if (isCodexSubscriptionProvider(providerId)) {
    const models = await authenticatedCodexModels(accountId)
    return models
      ? {
          status: 'available',
          models: visibleModelIds(
            providerId,
            models.filter((model) => !model.hidden && model.inputModalities.includes('text')).map((model) => model.id)
          ),
        }
      : { status: 'unavailable', models: [] }
  }
  if (isClaudeSubscriptionProvider(providerId)) {
    const models = await authenticatedClaudeModels(accountId)
    return models
      ? {
          status: 'available',
          models: visibleModelIds(providerId, models.map((model) => model.value)),
        }
      : { status: 'unavailable', models: [] }
  }
  if (isGrokSubscriptionProvider(providerId)) {
    const models = await authenticatedGrokModels(accountId)
    return models
      ? { status: 'available', models: visibleModelIds(providerId, models.map((model) => model.id)) }
      : { status: 'unavailable', models: [] }
  }
  const result = await fetchModelsWithStatus(providerId)
  return result.status === 'available'
    ? { ...result, models: visibleModelIds(providerId, result.models) }
    : result
}

/** Metadata from the same effective catalog used to start the child Codex thread. */
export async function subagentModelMeta(providerId: string, modelId: string): Promise<SubagentProfileModelMetaResult> {
  const accountId = subscriptionAccountId(providerId)
  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const models = await authenticatedCopilotModels(accountId)
    const model = models?.find((entry) => entry.id === modelId)
    return model ? { status: 'available', meta: copilotModelMeta(model) } : { status: 'unavailable', meta: null }
  }
  if (isCodexSubscriptionProvider(providerId)) {
    const models = await authenticatedCodexModels(accountId)
    const model = models?.find((entry) => entry.id === modelId || entry.model === modelId)
    return model ? { status: 'available', meta: codexModelMeta(model) } : { status: 'unavailable', meta: null }
  }
  if (isClaudeSubscriptionProvider(providerId)) {
    const models = await authenticatedClaudeModels(accountId)
    const model = models?.find((entry) => entry.value === modelId || entry.resolvedModel === modelId)
    return model
      ? { status: 'available', meta: claudeModelMeta(model, accountId) }
      : { status: 'unavailable', meta: null }
  }
  if (isGrokSubscriptionProvider(providerId)) {
    const models = await authenticatedGrokModels(accountId)
    const model = models?.find((entry) => entry.id === modelId)
    return model ? { status: 'available', meta: grokModelMeta(model) } : { status: 'unavailable', meta: null }
  }
  const provider = getProvider(providerId)
  const catalogProviderId = provider ? catalogProviderForBaseURL(provider.baseURL) : null
  return getProviderModelMetaWithStatus(modelId, catalogProviderId)
}
