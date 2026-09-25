import { randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { buildProviderOptions } from '../../shared/chat'
import { getConversation } from '../store'
import {
  getProvider,
  getProviderKind,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isCursorSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  isGrokSubscriptionProvider,
  subscriptionAccountId,
} from './catalog'
import { getCursorSubscriptionManager } from './cursor-subscription/manager'
import { summarizeWithCursorRuntime } from './cursor-subscription/portable-summarizer'
import { hasApiKey } from './credentials'
import { getGitHubCopilotSubscriptionManager } from './github-copilot/manager'
import { getGrokSubscriptionManager } from './grok-subscription/manager'
import { catalogProviderForBaseURL, getProviderModelMeta } from './model-meta'
import {
  isolatedSummaryAttemptUsage as extractIsolatedSummaryAttemptUsage,
  mergeIsolatedSummaryUsage as mergeIsolatedSummaryAttemptUsage,
  summarizeWithClaudeRuntime,
  summarizeWithCodexRuntime,
  summarizeWithGitHubCopilotRuntime,
} from './portable-summarizer'
import { resolveLanguageModel } from './provider'
import { recordModelCallUsage, type DiagnosticUsage } from './usage-diagnostics'

export type OneShotSelection = {
  providerId: string
  modelId: string
  effort?: string
  fastMode?: boolean
}

export type OneShotUsage = { input: number; output: number; cacheRead: number; cacheCreate: number }

function oneShotUsage(usage: DiagnosticUsage | undefined): OneShotUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheCreate: usage?.cacheCreate ?? 0,
  }
}

export async function runOneShotText(args: {
  selection: OneShotSelection
  system: string
  prompt: string
  signal: AbortSignal
  conversationId: string
  cwd: string
  agent: string
}): Promise<{ text: string; usage: OneShotUsage }> {
  const { selection, system, prompt, signal, conversationId, cwd, agent } = args
  const { providerId, modelId, effort, fastMode } = selection
  const accountId = subscriptionAccountId(providerId)
  const record = (
    runtime:
      | 'byok-ai-sdk'
      | 'codex-subscription'
      | 'github-copilot-subscription'
      | 'claude-subscription'
      | 'cursor-subscription',
    usage: DiagnosticUsage | undefined,
    details: { providerId?: string; modelId?: string; attempt?: number } = {}
  ): void => {
    if (usage && (usage.totalInput || usage.output)) {
      recordModelCallUsage({
        runtime,
        providerId: details.providerId ?? providerId,
        modelId: details.modelId ?? modelId,
        conversationId,
        agent,
        ...(details.attempt != null ? { attempt: details.attempt } : {}),
        usage,
      })
    }
  }

  if (isCodexSubscriptionProvider(providerId)) {
    const { runCodexEphemeralWithFailover } = await import('./subscription-failover')
    const result = await runCodexEphemeralWithFailover({
      logicalProviderId: providerId,
      modelId,
      ...(effort ? { reasoningEffort: effort } : {}),
      signal,
      scope: 'helper',
      conversationId,
      extractAttemptUsage: extractIsolatedSummaryAttemptUsage,
      mergeAttemptUsage: mergeIsolatedSummaryAttemptUsage,
      onAttemptUsage: ({ target, attempt, usage }) =>
        record('codex-subscription', usage, {
          providerId: target.providerId,
          modelId: target.runtimeModelId,
          attempt,
        }),
      operation: async (target, operationSignal) =>
        summarizeWithCodexRuntime({
          conversationScope: getConversation(conversationId)?.scope,
          client: target.client,
          cwd,
          modelId: target.runtimeModelId,
          system,
          prompt,
          signal: operationSignal,
          conversationId,
          accountId: target.accountId ?? accountId ?? null,
          ...(target.reasoningEffort ? { effort: target.reasoningEffort } : effort ? { effort } : {}),
          ...(target.serviceTier !== undefined ? { serviceTier: target.serviceTier } : {}),
        }),
    })
    return { text: result.text, usage: oneShotUsage(result.usage) }
  }

  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const manager = getGitHubCopilotSubscriptionManager(accountId)
    const status = await manager.getStatus().catch(() => null)
    if (!status?.authenticated || !status.connected) throw new Error('One-shot provider is not connected.')
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) throw new Error('One-shot provider is not authenticated.')
    const result = await summarizeWithGitHubCopilotRuntime({
      manager,
      accountIdentity: identity,
      // Ephemeral store-free session; ID is only for cleanup and must not touch the real conversation.
      conversationId: `one-shot:${randomUUID()}`,
      cwd,
      modelId,
      system,
      prompt,
      signal,
      ...(effort ? { effort } : {}),
    })
    record('github-copilot-subscription', result.usage)
    return { text: result.text, usage: oneShotUsage(result.usage) }
  }

  if (isClaudeSubscriptionProvider(providerId)) {
    const { runClaudeEphemeralWithFailover } = await import('./subscription-failover/claude-ephemeral')
    const result = await runClaudeEphemeralWithFailover({
      logicalProviderId: providerId,
      modelId,
      reasoningEffort: effort,
      fastMode,
      signal,
      conversationId,
      extractAttemptUsage: extractIsolatedSummaryAttemptUsage,
      mergeAttemptUsage: mergeIsolatedSummaryAttemptUsage,
      onAttemptUsage: ({ target, attempt, usage }) =>
        record('claude-subscription', usage, {
          providerId: target.providerId,
          modelId: target.runtimeModelId,
          attempt,
        }),
      operation: (target, operationSignal) =>
        summarizeWithClaudeRuntime({
          manager: target.manager,
          accountIdentity: target.accountIdentity,
          cwd,
          modelId: target.runtimeModelId,
          system,
          prompt,
          signal: operationSignal,
          effort: target.reasoningEffort,
          fastMode: target.fastMode,
        }),
    })
    return { text: result.text, usage: oneShotUsage(result.usage) }
  }

  if (isCursorSubscriptionProvider(providerId)) {
    const manager = getCursorSubscriptionManager(accountId)
    const status = await manager.getStatus(true).catch(() => null)
    if (!status?.authenticated) throw new Error('One-shot provider is not authenticated.')
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) throw new Error('One-shot provider is not authenticated.')
    const result = await summarizeWithCursorRuntime({
      manager,
      accountIdentity: identity,
      cwd,
      modelId,
      system,
      prompt,
      signal,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    record('cursor-subscription', result.usage)
    return { text: result.text, usage: oneShotUsage(result.usage) }
  }

  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown one-shot provider: ${providerId}`)
  if (isGrokSubscriptionProvider(providerId)) {
    const status = await getGrokSubscriptionManager(accountId)
      .getStatus()
      .catch(() => null)
    if (!status?.authenticated) throw new Error('One-shot provider is not authenticated.')
  } else if (!hasApiKey(providerId)) {
    throw new Error('One-shot provider has no API key.')
  }
  const meta = await getProviderModelMeta(modelId, catalogProviderForBaseURL(provider.baseURL)).catch(() => null)
  const providerOptions = buildProviderOptions(getProviderKind(provider), effort, meta)
  const result = await generateText({
    model: resolveLanguageModel(providerId, modelId),
    system,
    prompt,
    abortSignal: signal,
    ...(providerOptions ? { providerOptions } : {}),
  })
  // Keep usage normalization independent of the conversation runner.
  const rawUsage = result.totalUsage as
    | { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown }
    | undefined
  const count = (value: unknown): number => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
  }
  const totalInput = count(rawUsage?.inputTokens)
  const cacheRead = Math.min(totalInput, count(rawUsage?.cachedInputTokens))
  const usage = {
    input: totalInput - cacheRead,
    output: count(rawUsage?.outputTokens),
    cacheRead,
    cacheCreate: 0,
  }
  record('byok-ai-sdk', { ...usage, totalInput })
  return { text: result.text ?? '', usage }
}
