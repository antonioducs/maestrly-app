/**
 * BYOK chat service in main: registers `chat:*` IPC channels, orchestrates the runner per conversation,
 * forwards permission broker events to the renderer, and maintains conversation status (working/ready).
 *
 * Streaming by ID (like `pty:data:<id>`): turn events on `chat:delta:<convId>`, permissions on
 * `chat:permission:<convId>`. API keys NEVER cross into the renderer (only presence + mode).
 */
import type { IpcMainInvokeEvent, IpcMainEvent, WebContents } from 'electron'
import { app, shell, systemPreferences } from 'electron'
import { ensureRuntimeAsset } from '../runtime-assets/app-service'
import {
  addProvider,
  addSubscriptionAccount,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  getProvider,
  getProviderKind,
  getSubscriptionAccount,
  isChatGptWebEnabled,
  isChatGptWebProvider,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  isGrokSubscriptionProvider,
  isManagedProvider,
  isSubscriptionProvider,
  listAvailableChatProviders,
  setChatGptWebEnabled,
  PROVIDER_PRESETS,
  removeProvider,
  removeSubscriptionAccount,
  renameSubscriptionAccount,
  subscriptionAccountId,
  subscriptionProviderIdFor,
  updateProvider,
} from './catalog'
import {
  freezeFailoverChain,
  CodexEphemeralAttemptTimeoutError,
  getSubscriptionFailoverRouter,
  listFailoverRoutes,
  listCodexEphemeralAttempts,
  removeAccountFromFailoverConfig,
  resetCodexRateLimitBinding,
  resolveCodexRuntimeTarget,
  runCodexEphemeralWithFailover,
  setCodexEphemeralAttemptOwner,
  setFailoverRoute,
  SUPPORTED_FAILOVER_KINDS,
  type CodexRuntimeTarget,
} from './subscription-failover'
import { resolveClaudeRuntimeTarget, type ClaudeRuntimeTarget } from './subscription-failover/claude-adapter'
import { listClaudeAttempts, setClaudeAttemptOwner } from './subscription-failover/claude-attempts'
import { runClaudeEphemeralWithFailover } from './subscription-failover/claude-ephemeral'
import { recordModelCallUsage } from './usage-diagnostics'
import { apiKeyStorageMode, clearApiKey, hasApiKey, setApiKey } from './credentials'
import { fetchModels, fetchModelWindow, invalidateModels } from './models'
import { getContextLimit, setContextLimit, resolveContextWindow } from './context-limits'
import {
  addMcpServer,
  disposeMcpRuntime,
  listMcpServers,
  removeMcpServer,
  updateMcpServer,
  type McpServer,
} from './mcp'
import {
  invalidateProvider,
  resolveLanguageModel,
  resolveChatModel,
  resolveChatHarnessMetadata,
  ChatConfigError,
} from './provider'
import { isOpenAIHarnessActive } from './harness'
import {
  PermissionBroker,
  AUTO_RULESET,
  BYOK_DEFAULT_RULESET,
  YOLO_RULESET,
  type PermissionRequest,
  type Ruleset,
} from './permission'
import { applyFastModeServiceTier, normalizeAiUsage, runChat, type NormalizedAiUsage } from './runner'
import * as chatGptWeb from './chatgpt-web/manager'
import { getChecksConfig, listChecks as listChatGptWebChecks, setChecksConfig } from './chatgpt-web/checks'
import {
  deleteAllManagedCodexThreads,
  deleteCodexThreadForConversation,
  deleteManagedCodexThread,
  getCodexSubscriptionManager,
  listCodexSubscriptionManagers,
  getCodexThreadBinding,
  retryManagedCodexThreadCleanup,
  runCodexSubscriptionChat,
  type CodexActiveTurnControlPort,
  type CodexSubscriptionStatus,
} from './codex-subscription'
import { resolveCodexContextWindow } from './codex-subscription/context-window'
import {
  deleteAllManagedGitHubCopilotSessions,
  deleteGitHubCopilotSessionForConversation,
  getGitHubCopilotSessionBinding,
  getGitHubCopilotSubscriptionManager,
  listGitHubCopilotSubscriptionManagers,
  githubCopilotErrorMessage,
  retryManagedGitHubCopilotSessionCleanup,
  runGitHubCopilotChat,
  type GitHubCopilotAccountIdentity,
  type GitHubCopilotSubscriptionStatus,
} from './github-copilot'
import { GITHUB_COPILOT_SERIALIZABLE_EFFORTS } from './github-copilot/runner'
import {
  claudeSubscriptionErrorMessage,
  deleteAllManagedClaudeSessions,
  deleteClaudeSessionForConversation,
  getClaudeSessionBinding,
  getClaudeSubscriptionManager,
  listClaudeSubscriptionManagers,
  inspectClaudeSessionCompatibility,
  retryManagedClaudeSessionCleanup,
  runClaudeChat,
  type ClaudeSubscriptionAccountIdentity,
  type ClaudeSubscriptionStatus,
} from './claude-agent-sdk'
import {
  disposeGrokSubscriptionManager,
  getGrokSubscriptionManager,
  listGrokSubscriptionManagers,
  grokSubscriptionErrorMessage,
  type GrokAccountIdentity,
  type GrokLoginMethod,
  type GrokSubscriptionStatus,
} from './grok-subscription'
import { grokReasoningMeta } from './grok-subscription/models'
import { finalTurnCompletion } from './turn-status'
import { QuestionBroker } from './question-broker'
import { activeChatContext, renderTranscript } from './message'
import {
  getCompanionConversationContext,
  getCompanionConversationRevision,
  readCompanionConversation,
  searchCompanionConversation,
} from './chatgpt-web/conversation-context'
import { buildAgentMentionParts, type StructuredAgentMentionDraft } from '../../shared/chat-agent-mentions'
import { listEffectiveAgents } from './virtual-subagents'
import {
  chatHistoryStats,
  clearChatMessages,
  deleteChatMessagesFrom,
  findAttachmentImagePart,
  findGeneratedImagePart,
  getChatMessage,
  hasChatToolImageOwner,
  getMessageSeq,
  lastConversationContextMessage,
  listConversationContextMessages,
  listExecutionContextMessages,
  listPublicChatMessagesPage,
  reconcileInterruptedExecutionMessages,
  searchChatMessages,
  toPublicChatHistoryStats,
  upsertChatMessage,
  type StoredChatHistoryStats,
} from './chat-store'
import { readGeneratedImage } from './generated-images'
import {
  decodeLegacyAttachmentData,
  deleteAttachmentImages,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
  readAttachmentImage,
  saveAttachmentImage,
  preserveResendAttachments,
} from './attachment-artifacts'
import { clearEphemeralToolImages, getEphemeralToolImage, getEphemeralToolImageCacheSnapshot } from './tool-output'
import { onSubagentSessionChanged } from './subagent-session'
import {
  findSubagentSession,
  getSubagentSession,
  getSubagentTranscriptPage,
  listSubagentSessions,
  markInterruptedSubagentSessions,
} from './subagent-session-store'
import {
  cancelTurnDelegations,
  markDelegationObserved,
  unobservedTurnDelegations,
  waitForTurnDelegationsTerminal,
} from './maestro-delegation-registry'
import { releaseTurnDelegationRuntimes } from './subagent-resume'
import { registerPerformanceCache } from '../performance/metrics'
import { imageGenEnabledFor, IMAGE_GEN_FLAG } from './image-gen'
import { supportsChatToolImages } from './tool-capabilities'
import {
  getAppFlag,
  getAppSetting,
  getConversation,
  getConvUiPrefs,
  getHiddenChatModels,
  getLocale,
  listAllConversations,
  patchConvUiPrefs,
  setAppFlag,
  setAppSetting,
  setHiddenChatModels,
  touchConversation,
  transaction,
  updateConversationExperience,
  updateConversationStatus,
} from '../store'
import { incompleteMigrationForConversation } from '../conversation-migration/store'
import path from 'node:path'
import type fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import type { ModelInfo as GitHubCopilotModelInfo } from '@github/copilot-sdk'
import type { ModelInfo as ClaudeModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { OPENAI_GPT6_ASTRA_MANIFEST, resolveModelHarnessProfile } from './model-harness-profile'
import { searchFiles } from './file-search'
import { listUserPrompts, addUserPrompt, updateUserPrompt, removeUserPrompt, listProjectCommands } from './commands'
import {
  createSkill,
  parseSkillInvocation,
  readSkillBody,
  removeSkillDir,
  renderSkillContext,
  writeSkillFromPrompt,
  type ChatSkillScope,
} from './skills'
import {
  createSkillGroup,
  conversationCwd,
  effectiveSkills,
  findEffectiveSkill,
  listSkillGroups,
  listSkillInfos,
  listSkillsState,
  readSkillDetail,
  removeSkillGroup,
  resetConversationSkillOverrides,
  setConversationSkillSelection,
  setConversationSkillOverride,
  setSkillEnabledGlobal,
  updateSkillGroup,
} from './skill-state'
import { forgetInstalledSkill, installSkillFromSlug, searchSkillLibrary } from './skills-registry'
import { buildProjectContext } from './project-context'
import { releasePlanRevision, stagePlan, getPending as getPendingPlan } from '../plan-broker'
import {
  catalogProviderForBaseURL,
  filterChatModels,
  filterChatModelsSnapshot,
  getClaudeHarnessModelMeta,
  getModelMeta,
  getProviderModelMeta,
} from './model-meta'
import { transcribe } from '../asr-service'
import { findMentions, type MentionMatch } from '../../shared/chat-mentions'
import {
  applyChatEvent,
  buildProviderOptions,
  buildProviderOptionsForSentEffort,
  contextOccupancy,
  CUT_FINISH_REASONS,
  DEFAULT_REASONING_EFFORTS,
  hasUsagePricing,
  isChatSubscriptionProviderKind,
  isPortableExecutionProviderId,
  isMaestrlyUltraEffort,
  resolveFrozenSentEffort,
  resolveUltraEffort,
} from '../../shared/chat'
import { responseDurationMs } from '../../shared/response-duration'
import type {
  ChatAttachmentInput,
  ChatConfig,
  ChatConvTools,
  ChatGptWebStatus,
  ChatMessage,
  ChatModelMeta,
  ChatModelRef,
  ChatPermissionEvent,
  ChatProviderKind,
  ChatRuntimeState,
  ChatStreamEvent,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionProviderKind,
  ChatSkillSelection,
  CodexSubscriptionAuthStatus,
  ChatExecutionScope,
  FrozenChatSelection,
  InternalTurnHandle,
  InternalTurnOutcome,
  MessagePart,
  ReviewLoopInfo,
  ReviewLoopRole,
  ReviewLoopSource,
  ReviewLoopTurnPolicy,
  StartPairedReviewLoopInput,
  SubagentSessionSummary,
} from '../../shared/chat'
import type { ConversationStatus } from '../store'
import {
  resolveChatBehavior,
  type ChatBehavior,
  type MaestroToStandardResult,
  type StandardToMaestroResult,
} from '../../shared/conversation-experience'
import type { ChatMode } from '../../shared/chat'
import { isChatMode, normalizeChatMode } from '../../shared/chat-mode'
import type { MaestroOrchestratorProfileV1 } from '../../shared/maestro'
import { tFor } from '../i18n'
import { getMainWebContents } from '../window-ipc'
import { registerSubagentProfileIpc } from './subagent-profile-ipc'
import { registerMaestroIpc } from './maestro-ipc'
import { registerMaestroConfiguratorIpc } from './maestro-configurator-ipc'
import { maestroConfiguratorService } from './maestro-configurator'
import { freezeMaestroTurn } from './maestro-config'
import { createMaestroLiveRunPort, maestroLiveState, type MaestroLiveRunPort } from './maestro-live'
import {
  clearMaestroLiveRunsForConversation,
  getActiveMaestroLiveRun,
  reconcileInterruptedMaestroLiveRuns,
} from './maestro-live-store'
import { canReplayOpenAIInferenceState, getOpenAIInferenceState } from './openai/inference-store'
import { canonicalCwd, tryAcquireCwdActivity, tryAcquireLongCwdLease } from '../cwd-activity-coordinator'
import {
  createConversationReviewLoopCoordinator,
  type ConversationReviewLoopCoordinator,
} from './review-loop/conversation-driver'
import { lookupReviewLoopByConversation, releaseReviewLoop, reserveReviewLoop } from './review-loop/registry'
import type { ReviewerToolRuntime } from './tools/util'
import {
  estimateNativeSeedContextTokens,
  estimatePortableContextTokens,
  estimatePortablePartsTokens,
  estimateTextTokens,
  portableContextReserveTokens,
  preflightContextLoad,
  summarizePortableTranscript,
} from './portable-context'
import { chatDiag } from './diag-log'
import { invalidateUnifiedUsageCache } from '../usage/usage-service'
import { registerSubscriptionUsageIpc } from './subscription-usage-ipc'
import {
  summarizeWithClaudeRuntime,
  summarizeWithCodexRuntime,
  summarizeWithGitHubCopilotRuntime,
  type IsolatedSummaryResult,
} from './portable-summarizer'
import * as portableSummarizer from './portable-summarizer'
import {
  describeConversationImages,
  getImageInterpreter,
  hasImagesToDescribe,
  setImageInterpreter,
} from './image-interpreter'
import { recordIpcSend } from '../performance/metrics'
import { FABLE_51_PROFILE_FLAG } from './fable/profile'
import { OPUS_5_PROFILE_FLAG } from './opus/profile'
import { resolveClaudeBehaviorProfile, type ClaudeBehaviorProfile } from './behavior-profile'
import { compileClaudeCompactionSystem } from './behavior-prompt'

type SafeSend = (channel: string, payload: unknown) => void

async function ensurePackagedProviderAsset(
  id: 'codex-runtime' | 'github-copilot-runtime',
  signal?: AbortSignal
): Promise<void> {
  if (app.isPackaged) await ensureRuntimeAsset(id, signal)
}

const extractIsolatedSummaryAttemptUsage = (value: unknown): NormalizedAiUsage | undefined => {
  try {
    return portableSummarizer.isolatedSummaryAttemptUsage?.(value)
  } catch {
    return undefined
  }
}

const mergeIsolatedSummaryAttemptUsage = (
  result: IsolatedSummaryResult,
  failedAttemptUsage: NormalizedAiUsage
): IsolatedSummaryResult => {
  try {
    const merge = portableSummarizer.mergeIsolatedSummaryUsage
    if (merge) return merge(result, failedAttemptUsage)
  } catch {
    // Older test doubles may not expose the optional helper exports.
  }
  return {
    ...result,
    usage: {
      input: (result.usage?.input ?? 0) + failedAttemptUsage.input,
      output: (result.usage?.output ?? 0) + failedAttemptUsage.output,
      cacheRead: (result.usage?.cacheRead ?? 0) + failedAttemptUsage.cacheRead,
      cacheCreate: (result.usage?.cacheCreate ?? 0) + failedAttemptUsage.cacheCreate,
      totalInput: (result.usage?.totalInput ?? 0) + failedAttemptUsage.totalInput,
    },
  }
}

/**
 * Fallback guards for transports that returned before async workers settled must attach their usage to the
 * original parent message exactly once. The caller invokes this only for previously-unobserved sessions and
 * marks them observed immediately afterwards, so retries cannot double-account.
 */
function accountGuardedDelegationUsage(
  conversationId: string,
  parentMessageId: string,
  sessions: readonly SubagentSessionSummary[]
): void {
  const measured = sessions.filter((session) => session.usage && session.profile?.effective)
  if (!measured.length) return
  const message = getChatMessage(conversationId, parentMessageId)
  if (!message) return
  const previous = message.usage
  const perModel = new Map(
    (previous?.subagentUsage ?? []).map((entry) => [`${entry.providerId}\0${entry.modelId}`, { ...entry }])
  )
  let subInput = previous?.subInput ?? 0
  let subOutput = previous?.subOutput ?? 0
  let subCachedInput = previous?.subCachedInput ?? 0
  let subCacheCreate = previous?.subCacheCreate ?? 0
  for (const session of measured) {
    const usage = session.usage!
    const effective = session.profile!.effective!
    subInput += usage.input
    subOutput += usage.output
    subCachedInput += usage.cacheRead
    subCacheCreate += usage.cacheCreate
    const key = `${effective.providerId}\0${effective.modelId}`
    const current = perModel.get(key) ?? {
      providerId: effective.providerId,
      modelId: effective.modelId,
      input: 0,
      output: 0,
    }
    current.input += usage.input
    current.output += usage.output
    current.cachedInput = (current.cachedInput ?? 0) + usage.cacheRead
    current.cacheCreate = (current.cacheCreate ?? 0) + usage.cacheCreate
    if (session.runtimeEstimatedCostUsd != null) {
      current.runtimeEstimatedCostUsd = (current.runtimeEstimatedCostUsd ?? 0) + session.runtimeEstimatedCostUsd
    } else {
      current.catalogInput = (current.catalogInput ?? 0) + usage.input
      current.catalogOutput = (current.catalogOutput ?? 0) + usage.output
      current.catalogCacheRead = (current.catalogCacheRead ?? 0) + usage.cacheRead
      current.catalogCacheCreate = (current.catalogCacheCreate ?? 0) + usage.cacheCreate
    }
    perModel.set(key, current)
  }
  upsertChatMessage({
    ...message,
    usage: {
      ...(previous ?? {}),
      usageVersion: 2,
      input: previous?.input ?? 0,
      output: previous?.output ?? 0,
      subInput,
      subOutput,
      subCachedInput,
      subCacheCreate,
      subagentUsage: [...perModel.values()],
    },
  })
}

/**
 * Live chat stream subscriptions. The runtime stays in MAIN without requiring a mounted ChatView;
 * only currently subscribed (WebContents, conversationId) pairs receive IPC. Counts are per pair,
 * since one renderer may have multiple consumers of a conversation (including stream and permissions).
 */
const chatSubscribersByConversation = new Map<string, Map<WebContents, number>>()
const chatSubscriptionsByWebContents = new Map<WebContents, Map<string, number>>()
const chatSubscriptionCleanup = new Map<WebContents, () => void>()

function clearChatSubscriptions(wc: WebContents): void {
  const subscriptions = chatSubscriptionsByWebContents.get(wc)
  if (!subscriptions) return

  for (const conversationId of subscriptions.keys()) {
    const subscribers = chatSubscribersByConversation.get(conversationId)
    subscribers?.delete(wc)
    if (subscribers?.size === 0) chatSubscribersByConversation.delete(conversationId)
  }
  chatSubscriptionsByWebContents.delete(wc)
  chatSubscriptionCleanup.get(wc)?.()
  chatSubscriptionCleanup.delete(wc)
}

/** Registers a stream consumer; each call requires a matching unsubscribe. */
export function subscribeChatStream(wc: WebContents, conversationId: string): void {
  if (!conversationId || wc.isDestroyed()) return

  let subscriptions = chatSubscriptionsByWebContents.get(wc)
  if (!subscriptions) {
    subscriptions = new Map()
    chatSubscriptionsByWebContents.set(wc, subscriptions)
    if (typeof wc.once === 'function') {
      const onDestroyed = () => clearChatSubscriptions(wc)
      wc.once('destroyed', onDestroyed)
      chatSubscriptionCleanup.set(wc, () => wc.removeListener?.('destroyed', onDestroyed))
    }
  }

  subscriptions.set(conversationId, (subscriptions.get(conversationId) ?? 0) + 1)
  let subscribers = chatSubscribersByConversation.get(conversationId)
  if (!subscribers) {
    subscribers = new Map()
    chatSubscribersByConversation.set(conversationId, subscribers)
  }
  subscribers.set(wc, (subscribers.get(wc) ?? 0) + 1)
}

/** Removes only one subscription for this renderer and conversation. */
export function unsubscribeChatStream(wc: WebContents, conversationId: string): void {
  const subscriptions = chatSubscriptionsByWebContents.get(wc)
  const count = subscriptions?.get(conversationId)
  if (!subscriptions || !count) return

  if (count === 1) subscriptions.delete(conversationId)
  else subscriptions.set(conversationId, count - 1)

  const subscribers = chatSubscribersByConversation.get(conversationId)
  if (subscribers) {
    if (subscribers.get(wc) === 1) subscribers.delete(wc)
    else subscribers.set(wc, (subscribers.get(wc) ?? 1) - 1)
    if (subscribers.size === 0) chatSubscribersByConversation.delete(conversationId)
  }

  if (subscriptions.size === 0) {
    chatSubscriptionsByWebContents.delete(wc)
    chatSubscriptionCleanup.get(wc)?.()
    chatSubscriptionCleanup.delete(wc)
  }
}

function hasChatSubscriber(wc: WebContents, conversationId: string): boolean {
  return (chatSubscribersByConversation.get(conversationId)?.get(wc) ?? 0) > 0
}

function chatConversationIdFromChannel(channel: string): string | null {
  if (channel.startsWith('chat:delta:')) return channel.slice('chat:delta:'.length)
  if (channel.startsWith('chat:permission:')) return channel.slice('chat:permission:'.length)
  return null
}

/** Sends render-only events to current consumers and counts only actual sends. */
function sendChatEvent(wc: WebContents, channel: string, payload: unknown): void {
  const conversationId = chatConversationIdFromChannel(channel)
  if (conversationId !== null && !hasChatSubscriber(wc, conversationId)) return
  if (wc.isDestroyed()) {
    if (conversationId !== null) clearChatSubscriptions(wc)
    return
  }
  try {
    wc.send(channel, payload)
    recordIpcSend()
  } catch {
    // WebContents may be destroyed between the check and send.
    clearChatSubscriptions(wc)
  }
}

interface ActiveRun {
  controller: AbortController
  send: SafeSend
  /** Assistant message ID for the current turn (captured at message-start). */
  messageId: string
  /** LOGICAL conversation selection (compat / patchConv / messages). */
  providerId: string
  /** Physical account in use (failover); absent = unresolved / same as logical. */
  effectiveProviderId?: string
  /** Reference count of physical accounts with active work in this run (root + children). */
  activeSubscriptionProviders: Map<string, number>
  /** ChatGPT identity generation captured at admission; account changes revoke persistence. */
  codexAccountEpoch?: number
  /** Official thread created/resumed in this run; exists before the persisted binding. */
  codexThreadId?: string
  /** Physical provider owning this run's Codex thread. */
  codexThreadProviderId?: string
  /** Physical accountId owning the thread (null = default account). */
  codexThreadAccountId?: string | null
  /** Teardown/new account revokes the running thread, including ephemeral threads. */
  allowCodexThreadLifecycle: boolean
  /** Teardown/new account revokes the runner's right to resurrect a binding on late completion. */
  allowCodexPersistence: boolean
  /** GitHub/Copilot identity captured at admission; token changes revoke the session. */
  githubCopilotIdentity?: GitHubCopilotAccountIdentity
  githubCopilotSessionId?: string
  allowGitHubCopilotPersistence: boolean
  /** Claude identity captured at admission; account changes/logout revoke the native session. */
  claudeIdentity?: ClaudeSubscriptionAccountIdentity
  claudeSessionId?: string
  claudeSessionProviderId?: string
  claudeSessionAccountId?: string | null
  allowClaudePersistence: boolean
  /** Grok identity captured at admission; account changes/logout abort the turn (generic runner). */
  grokIdentity?: GrokAccountIdentity
  done: Promise<void>
  settleDone: () => void
  /** Structured terminal outcome (internal automated turn API, e.g. review loop). Resolves ONCE. */
  outcome: Promise<InternalTurnOutcome>
  settleOutcome: (outcome: InternalTurnOutcome) => void
  /** Host-owned inbox for the Maestro turn; absent in Standard/review-loop. */
  maestroLive?: MaestroLiveRunPort
  activeHarnessProfile: import('../../shared/chat').ChatActiveHarnessProfile | null
  midTurnSteering: boolean
  liveReasoningUpdate: boolean
  codexTurnControl?: CodexActiveTurnControlPort
  acceptedSteeringMessageIds: Set<string>
}

interface PendingConversationOperation {
  token: symbol
  /** LOGICAL selection (conversation). */
  providerId: string | null
  /** Admitted/resolved physical account; logout/reset target it, not just the logical account. */
  effectiveProviderId?: string
  controller: AbortController
  done: Promise<void>
  settleDone: () => void
}

function acquireActiveProvider(run: ActiveRun, providerId: string): void {
  const current = run.activeSubscriptionProviders.get(providerId) ?? 0
  run.activeSubscriptionProviders.set(providerId, current + 1)
}

function releaseActiveProvider(run: ActiveRun, providerId: string): void {
  const current = run.activeSubscriptionProviders.get(providerId) ?? 0
  if (current <= 1) run.activeSubscriptionProviders.delete(providerId)
  else run.activeSubscriptionProviders.set(providerId, current - 1)
}

function runUsesPhysicalProvider(run: ActiveRun, providerId: string): boolean {
  return (
    (run.activeSubscriptionProviders.get(providerId) ?? 0) > 0 ||
    run.effectiveProviderId === providerId ||
    run.codexThreadProviderId === providerId ||
    run.claudeSessionProviderId === providerId
  )
}

function physicalAccountId(run: ActiveRun): string | null {
  // undefined = not yet known; null = physical default account (do not fall back to the logical provider).
  if (run.claudeSessionAccountId !== undefined) return run.claudeSessionAccountId
  if (run.codexThreadAccountId !== undefined) return run.codexThreadAccountId
  if (run.effectiveProviderId) return subscriptionAccountId(run.effectiveProviderId)
  return subscriptionAccountId(run.providerId)
}

function pendingPhysicalProviderId(operation: PendingConversationOperation): string | null {
  return operation.effectiveProviderId ?? operation.providerId
}

const CODEX_EPHEMERAL_TEARDOWN_TIMEOUT_MS = 1_000

function abortPendingCodexHelperOperations(
  providerId: string,
  excludeOperations: ReadonlySet<PendingConversationOperation> = new Set()
): PendingConversationOperation[] {
  const aborted = new Set<PendingConversationOperation>()
  for (const attempt of listCodexEphemeralAttempts()) {
    if (attempt.providerId !== providerId) continue
    const operation = attempt.conversationId ? pendingConversationOperations.get(attempt.conversationId) : undefined
    if (operation && excludeOperations.has(operation)) continue
    attempt.abort(new Error('Codex account changed'))
    if (operation) aborted.add(operation)
  }
  return [...aborted]
}

function abortAllCodexEphemeralAttempts(
  excludeOperations: ReadonlySet<PendingConversationOperation> = new Set()
): void {
  for (const attempt of listCodexEphemeralAttempts()) {
    const operation = attempt.conversationId ? pendingConversationOperations.get(attempt.conversationId) : undefined
    if (operation && excludeOperations.has(operation)) continue
    attempt.abort(new Error('Chat service is shutting down'))
  }
}

async function waitForCodexEphemeralAttempts(
  providerId: string,
  additionalDone: readonly Promise<void>[] = []
): Promise<void> {
  await waitForEphemeralAttempts(
    () => [
      ...listCodexEphemeralAttempts().filter((attempt) => attempt.providerId === providerId),
      ...additionalDone.map((done) => ({ done })),
    ],
    `provider ${providerId}`
  )
}

async function waitForAllCodexEphemeralAttemptsBestEffort(
  additionalDone: readonly Promise<void>[] = []
): Promise<void> {
  try {
    await waitForEphemeralAttempts(
      () => [...listCodexEphemeralAttempts(), ...additionalDone.map((done) => ({ done }))],
      'all providers'
    )
  } catch (error) {
    console.warn('[chat] continuing shutdown with Codex ephemeral attempts still in flight:', error)
  }
}

async function waitForEphemeralAttempts(
  snapshot: () => readonly (object & { done: Promise<void> })[],
  scope: string
): Promise<void> {
  const deadline = Date.now() + CODEX_EPHEMERAL_TEARDOWN_TIMEOUT_MS
  while (true) {
    const attempts = snapshot()
    if (attempts.length === 0) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const error = new CodexEphemeralAttemptTimeoutError(scope)
      console.warn(`[chat] ${error.message}`)
      throw error
    }
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining)
    })
    const settled = Promise.allSettled(attempts.map((attempt) => attempt.done)).then(() => true as const)
    const finished = await Promise.race([settled, timedOut])
    if (timer) clearTimeout(timer)
    if (!finished) {
      const error = new CodexEphemeralAttemptTimeoutError(scope)
      console.warn(`[chat] ${error.message}`)
      throw error
    }
  }
}

export interface ChatIpcDeps {
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
  mon: (channel: string, fn: (event: IpcMainEvent, ...args: any[]) => void) => void
  emitStatus: (conversationId: string, status: ConversationStatus, opts?: { silent?: boolean }) => void
  /** Dedicated Companion alert: must bypass the status/lifecycle state machine. */
  notifyChatGptWebTurnCompleted?: (conversationId: string) => void
}

const active = new Map<string, ActiveRun>()
const pendingConversationOperations = new Map<string, PendingConversationOperation>()

// Ephemeral Codex helpers may run inside a non-Codex ActiveRun (imagegen/interpreter/compact) or before one
// exists. The failover module keeps the independent attempt registry; this bridge adds the same physical
// provider refcount to an admitted conversation run exactly once for the lifetime of each attempt.
setCodexEphemeralAttemptOwner((attempt) => {
  if (!attempt.conversationId) return
  const run = active.get(attempt.conversationId)
  if (!run) return
  acquireActiveProvider(run, attempt.providerId)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseActiveProvider(run, attempt.providerId)
  }
})

setClaudeAttemptOwner((attempt) => {
  if (claudePhysicalIdentityIsChanging(attempt.providerId)) {
    const error = new Error('Claude account changed')
    attempt.abort(error)
    throw error
  }
  // Manual/preflight compaction has a reservation but no ActiveRun yet.
  const operation = attempt.conversationId ? pendingConversationOperations.get(attempt.conversationId) : undefined
  if (operation && attempt.scope === 'helper') operation.effectiveProviderId = attempt.providerId
  const run = attempt.conversationId ? active.get(attempt.conversationId) : undefined
  if (!run) return
  acquireActiveProvider(run, attempt.providerId)
  return () => {
    releaseActiveProvider(run, attempt.providerId)
    // Between physical attempts there is no root session owner. Keeping A here
    // would let logout of an already-retired A cancel B's preflight/helper work.
    if (attempt.scope === 'root' && run.effectiveProviderId === attempt.providerId) {
      run.effectiveProviderId = undefined
      if (run.claudeSessionProviderId === attempt.providerId) {
        run.claudeSessionProviderId = undefined
        run.claudeSessionAccountId = undefined
        run.claudeSessionId = undefined
      }
    }
  }
})

let broker: PermissionBroker | null = null
let questionBroker: QuestionBroker | null = null
let chatDisposePromise: Promise<void> | null = null

/**
 * Internal review-loop turns (executionId → record): handle cancellation must abort the
 * run EVEN before admission (cancelRequested), independently of `active` (prevents races).
 */
interface InternalTurnEntry {
  run: ActiveRun | null
  cancelRequested: boolean
  cancel: () => void
  resolveHandle: (handle: InternalTurnHandle) => void
}
const internalTurns = new Map<string, InternalTurnEntry>()

const CHAT_DEFAULT_PROVIDER_KEY = 'chat.defaultProvider'
const CHAT_DEFAULT_MODEL_KEY = 'chat.defaultModel'
const CHAT_DEFAULT_REASONING_KEY = 'chat.defaultReasoning'
const CHAT_DEFAULT_FAST_MODE_KEY = 'chat.defaultFastMode'
const CODEX_ACCOUNT_FINGERPRINT_KEY = 'chat.codexSubscription.accountFingerprint'
const AUTO_COMPACT_RATIO = 0.9
let codexLoginPending = false
let codexIdentityTransitionPending = false
let codexLoginGeneration = 0
let codexConfigRefreshPromise: Promise<void> | null = null
let codexAccountUpdatedUnsubscribe: (() => void) | null = null
let codexExternalAccountRefreshPromise: Promise<void> | null = null
let codexAccountUpdateEpoch = 0
let lastCodexAccountFingerprint: string | null = null
let codexIdentityReconciledThisProcess = false
let codexIdentityReconciliation: {
  fingerprint: string
  accountEpoch: number
  admittedOperations: Set<PendingConversationOperation>
  promise: Promise<void>
} | null = null
let githubCopilotLoginPending = false
let githubCopilotAuthGeneration = 0
let githubCopilotConfigRefreshPromise: Promise<void> | null = null
let githubCopilotAuthUpdatedUnsubscribe: (() => void) | null = null
let githubCopilotIdentityTransitionPromise: Promise<void> | null = null
const claudeSlotTransitions = new Set<string>()
let claudeLoginPending = false
let claudeAuthGeneration = 0
let claudeConfigRefreshPromise: Promise<void> | null = null
let claudeIdentityTransitionPromise: Promise<void> | null = null
let lastClaudeAccountFingerprint: string | null = null
let claudeAuthenticationRequiredUnsubscribe: (() => void) | null = null
let grokLoginPending = false
let grokAuthGeneration = 0
let grokConfigRefreshPromise: Promise<void> | null = null
let grokAuthUpdatedUnsubscribe: (() => void) | null = null
let grokIdentityTransitionPromise: Promise<void> | null = null

export interface ChatRunnerCapabilityChange {
  /** Removes the persisted snapshot before refresh at explicit identity/configuration boundaries. */
  resetCachedCatalog: boolean
}

const chatRunnerCapabilityListeners = new Set<(change: ChatRunnerCapabilityChange) => void>()

export function subscribeChatRunnerCapabilityChanges(
  listener: (change: ChatRunnerCapabilityChange) => void
): () => void {
  chatRunnerCapabilityListeners.add(listener)
  return () => chatRunnerCapabilityListeners.delete(listener)
}

function notifyChatRunnerCapabilityChanges(resetCachedCatalog: boolean): void {
  for (const listener of chatRunnerCapabilityListeners) {
    try {
      listener({ resetCachedCatalog })
    } catch {
      // A catalog consumer must not break chat authentication/configuration transitions.
    }
  }
}

function authChangeResetsRunnerCatalog(status: ChatSubscriptionAuthStatus | CodexSubscriptionAuthStatus): boolean {
  return status.state === 'signed-out' || status.state === 'signing-in'
}

const GITHUB_COPILOT_PROVISIONAL_AUTH_STATUS: ChatSubscriptionAuthStatus = {
  state: 'signed-out',
  authenticated: false,
}

const CODEX_PROVISIONAL_AUTH_STATUS: CodexSubscriptionAuthStatus = {
  state: 'signed-out',
  authenticated: false,
}

const CLAUDE_PROVISIONAL_AUTH_STATUS: ChatSubscriptionAuthStatus = {
  state: 'signed-out',
  authenticated: false,
}

const GROK_PROVISIONAL_AUTH_STATUS: ChatSubscriptionAuthStatus = {
  state: 'signed-out',
  authenticated: false,
}

function reserveConversationOperation(
  conversationId: string,
  providerId: string | null,
  existing?: PendingConversationOperation
): PendingConversationOperation | null {
  if (existing) {
    return pendingConversationOperations.get(conversationId) === existing && !existing.controller.signal.aborted
      ? existing
      : null
  }
  if (active.has(conversationId) || pendingConversationOperations.has(conversationId)) return null
  let settleDone!: () => void
  const done = new Promise<void>((resolve) => {
    settleDone = resolve
  })
  const operation: PendingConversationOperation = {
    token: Symbol(conversationId),
    providerId,
    controller: new AbortController(),
    done,
    settleDone,
  }
  pendingConversationOperations.set(conversationId, operation)
  return operation
}

function conversationOperationIsCurrent(conversationId: string, operation: PendingConversationOperation): boolean {
  return pendingConversationOperations.get(conversationId) === operation && !operation.controller.signal.aborted
}

function releaseConversationOperation(conversationId: string, operation: PendingConversationOperation): void {
  if (pendingConversationOperations.get(conversationId) === operation) {
    pendingConversationOperations.delete(conversationId)
  }
  operation.settleDone()
}

async function cancelPendingConversationOperation(conversationId: string): Promise<void> {
  const operation = pendingConversationOperations.get(conversationId)
  if (!operation) return
  operation.controller.abort(new Error('Conversation is being closed'))
  await Promise.race([operation.done, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
}

function cancelPendingCodexOperations(exclude: ReadonlySet<PendingConversationOperation> = new Set()): void {
  const operations = [...pendingConversationOperations.entries()].filter(([, operation]) => {
    const physical = pendingPhysicalProviderId(operation)
    return (
      isCodexSubscriptionProvider(physical ?? '') && subscriptionAccountId(physical) === null && !exclude.has(operation)
    )
  })
  for (const [, operation] of operations) operation.controller.abort(new Error('ChatGPT account changed'))
}

function toCodexAuthStatus(
  status: CodexSubscriptionStatus,
  accountId: string | null = null
): CodexSubscriptionAuthStatus {
  // loginPending belongs to the DEFAULT ACCOUNT state machine; an authenticated extra slot must not become "signing-in".
  if (!accountId && codexLoginPending) return { state: 'signing-in', authenticated: false }
  if (status.authenticated) {
    const account = status.account?.type === 'chatgpt' ? status.account : null
    return {
      state: 'signed-in',
      authenticated: true,
      ...(account ? { email: account.email, planType: account.planType } : {}),
    }
  }
  if (status.state === 'error') {
    return {
      state: status.available ? 'error' : 'unavailable',
      authenticated: false,
      ...(status.error?.message ? { error: status.error.message } : {}),
    }
  }
  if (!status.available || status.state === 'disposed') return { state: 'unavailable', authenticated: false }
  return { state: 'signed-out', authenticated: false }
}

function codexAccountFingerprint(status: CodexSubscriptionAuthStatus): string {
  if (!status.authenticated) return 'signed-out'
  const email = status.email?.trim().toLowerCase()
  if (!email) return 'chatgpt:<unknown>'
  return `chatgpt:${createHash('sha256').update(email).digest('hex')}`
}

function rememberCodexAuth(status: CodexSubscriptionAuthStatus): CodexSubscriptionAuthStatus {
  lastCodexAccountFingerprint = codexAccountFingerprint(status)
  return status
}

async function performCodexIdentityReconciliation(
  current: string,
  accountEpoch: number,
  admittedOperations: ReadonlySet<PendingConversationOperation>
): Promise<void> {
  if (accountEpoch !== codexAccountUpdateEpoch) return
  const stored = getAppSetting(CODEX_ACCOUNT_FINGERPRINT_KEY)
  const unknownFirstRead = current === 'chatgpt:<unknown>' && !codexIdentityReconciledThisProcess
  if (stored === null || stored !== current || unknownFirstRead) {
    // The runtime may omit email. Prioritize isolation in that case: clear once per process,
    // preventing cross-account resume after restart even without a stable identifier.
    await resetCodexAccountThreads(admittedOperations)
  } else if (!codexIdentityReconciledThisProcess) {
    // A hard-delete that failed offline must not be forgotten forever. On the process's first authoritative
    // status, retry only old tombstones without touching valid bindings for the confirmed identity.
    await retryManagedCodexThreadCleanup()
  }
  // An account/updated during teardown makes this snapshot stale. The read owning the new epoch will retry.
  if (accountEpoch !== codexAccountUpdateEpoch) return
  setAppSetting(CODEX_ACCOUNT_FINGERPRINT_KEY, current)
  codexIdentityReconciledThisProcess = true
}

function reconcileCodexIdentity(
  status: CodexSubscriptionAuthStatus,
  admittedOperation?: PendingConversationOperation,
  accountEpoch = codexAccountUpdateEpoch
): Promise<void> {
  // Error/unavailable does not prove logout and must never erase context. Only authoritative account/read qualifies.
  if (status.state !== 'signed-in' && status.state !== 'signed-out') return Promise.resolve()
  const fingerprint = codexAccountFingerprint(status)
  const activeReconciliation = codexIdentityReconciliation
  if (
    activeReconciliation &&
    activeReconciliation.fingerprint === fingerprint &&
    activeReconciliation.accountEpoch === accountEpoch
  ) {
    if (admittedOperation) activeReconciliation.admittedOperations.add(admittedOperation)
    return activeReconciliation.promise
  }

  const admittedOperations = new Set<PendingConversationOperation>()
  if (admittedOperation) admittedOperations.add(admittedOperation)
  const previous = activeReconciliation?.promise ?? Promise.resolve()
  let record!: NonNullable<typeof codexIdentityReconciliation>
  const promise = previous
    .catch(() => undefined)
    .then(() => performCodexIdentityReconciliation(fingerprint, accountEpoch, admittedOperations))
    .finally(() => {
      if (codexIdentityReconciliation === record) codexIdentityReconciliation = null
    })
  record = { fingerprint, accountEpoch, admittedOperations, promise }
  codexIdentityReconciliation = record
  return promise
}

async function codexAuthStatus(
  refresh = false,
  admittedOperation?: PendingConversationOperation,
  accountId: string | null = null
): Promise<CodexSubscriptionAuthStatus> {
  // ADDITIONAL slots bypass default-account reconciliation: each account's CODEX_HOME is exclusively
  // app-owned, and explicit slot login/removal flows define identity boundaries.
  if (accountId) {
    return toCodexAuthStatus(await getCodexSubscriptionManager(accountId).getStatus(refresh), accountId)
  }
  let force = refresh
  while (true) {
    const accountEpoch = codexAccountUpdateEpoch
    const status = toCodexAuthStatus(await getCodexSubscriptionManager().getStatus(force))
    if (accountEpoch !== codexAccountUpdateEpoch) {
      force = true
      continue
    }
    if (!codexLoginPending) await reconcileCodexIdentity(status, admittedOperation, accountEpoch)
    if (accountEpoch !== codexAccountUpdateEpoch) {
      force = true
      continue
    }
    return !codexLoginPending && (status.state === 'signed-in' || status.state === 'signed-out')
      ? rememberCodexAuth(status)
      : status
  }
}

function codexAuthSnapshot(accountId: string | null = null): CodexSubscriptionAuthStatus {
  const snapshot = getCodexSubscriptionManager(accountId).getStatusSnapshot()
  if (snapshot) return toCodexAuthStatus(snapshot, accountId)
  if (!accountId && codexLoginPending) return { state: 'signing-in', authenticated: false }
  return CODEX_PROVISIONAL_AUTH_STATUS
}

function sameCodexAuthStatus(a: CodexSubscriptionAuthStatus, b: CodexSubscriptionAuthStatus): boolean {
  return (
    a.state === b.state &&
    a.authenticated === b.authenticated &&
    a.email === b.email &&
    a.planType === b.planType &&
    a.error === b.error
  )
}

/**
 * `chat:config` is on the startup critical path for ALL providers. Initializes Codex in the background,
 * deduplicated, and only notifies the renderer when public state changes (avoids config → broadcast loops).
 */
function scheduleCodexConfigRefresh(previous: CodexSubscriptionAuthStatus): void {
  const manager = getCodexSubscriptionManager()
  if (manager.isDisposed || codexLoginPending || codexIdentityTransitionPending || codexConfigRefreshPromise) return

  const loginGeneration = codexLoginGeneration
  const accountEpoch = codexAccountUpdateEpoch
  const promise = manager
    .getStatus()
    .then(async (status) => {
      // Login/logout own their flows and broadcasts. A refresh started before them must not publish afterward.
      if (
        loginGeneration !== codexLoginGeneration ||
        accountEpoch !== codexAccountUpdateEpoch ||
        codexLoginPending ||
        codexIdentityTransitionPending
      )
        return
      const current = toCodexAuthStatus(status)
      await reconcileCodexIdentity(current)
      if (!sameCodexAuthStatus(previous, current)) broadcastCodexAuth(current)
    })
    .catch(() => {
      // getStatus already converts failures to public status; this guard prevents unhandled rejections during shutdown/races.
    })
    .finally(() => {
      if (codexConfigRefreshPromise === promise) codexConfigRefreshPromise = null
    })
  codexConfigRefreshPromise = promise
}

/** Companion integration status with the experimental flag (the renderer displays the toggle). */
function chatGptWebStatusPayload(): ChatGptWebStatus & { enabled: boolean } {
  return { ...chatGptWeb.status(), enabled: isChatGptWebEnabled() }
}

let chatGptWebUnsubscribe: (() => void) | null = null
let subagentSessionUnsubscribe: (() => void) | null = null
let pairedReviewLoopCoordinator: ConversationReviewLoopCoordinator | null = null

function broadcastChatGptWebStatus(): void {
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:chatgpt-web:changed', chatGptWebStatusPayload())
    wc.send('chat:review-loop:changed', neutralReviewLoopSnapshots())
  } catch {
    /* Window closed during bridge state transition. */
  }
}

function webReviewLoopSnapshots(): ReviewLoopInfo[] {
  const snapshots: ReviewLoopInfo[] = []
  for (const session of chatGptWeb.status().sessions) {
    const loop = session.reviewLoop
    if (!loop) continue
    const conversation = getConversation(session.conversationId)
    snapshots.push({
      loopId: loop.loopId,
      driver: 'chatgpt-web',
      status: loop.status,
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      participants: {
        executor: {
          conversationId: session.conversationId,
          name: conversation?.name ?? 'Executor',
          modelId: loop.modelId ?? '',
          ...(loop.reasoning ? { reasoning: loop.reasoning } : {}),
          fastMode: loop.fastMode === true,
        },
      },
      startedAt: loop.startedAt,
      ...(loop.jobStartedAt ? { jobStartedAt: loop.jobStartedAt } : {}),
      ...(loop.finishReason ? { finishReason: loop.finishReason } : {}),
    })
  }
  return snapshots
}

function neutralReviewLoopSnapshots(): ReviewLoopInfo[] {
  return [...(pairedReviewLoopCoordinator?.statuses() ?? []), ...webReviewLoopSnapshots()]
}

function broadcastReviewLoopStatus(_snapshots?: ReviewLoopInfo[]): void {
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:review-loop:changed', neutralReviewLoopSnapshots())
  } catch {
    /* Window closed during loop state transition. */
  }
}

/** Neutral participant lock, with the legacy manager fallback kept for old Web controller tests/adapters. */
function reviewLoopLockForConversation(conversationId: string): string | null {
  return lookupReviewLoopByConversation(conversationId)?.loopId ?? chatGptWeb.reviewLoopLockFor(conversationId)
}

function broadcastCodexAuth(status: CodexSubscriptionAuthStatus): void {
  // The dynamic execution catalog comes from the connected account → probe in the background
  // on each DEFAULT account transition. This boundary invalidates model/list calls started under the previous account.
  notifyChatRunnerCapabilityChanges(authChangeResetsRunnerCatalog(status))
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:codex-subscription:auth-changed', status)
  } catch {
    /* Window closed during authentication transition. */
  }
}

/**
 * Users can also switch/log out through the Codex CLI/App sharing CODEX_HOME. We then lack
 * authority to delete the previous identity's threads, but must abort turns and invalidate
 * all local bindings to prevent resuming context under another account.
 */
function handleExternalCodexAccountUpdated(): void {
  codexAccountUpdateEpoch += 1
  codexIdentityTransitionPending = true
  if (codexExternalAccountRefreshPromise) return
  const promise = (async () => {
    let handledEpoch = -1
    while (handledEpoch !== codexAccountUpdateEpoch) {
      let targetEpoch = codexAccountUpdateEpoch
      const boundaryFingerprint = lastCodexAccountFingerprint
      const status = await codexAuthStatus(true)
      // codexAuthStatus already repeats account/read until it gets the latest epoch's snapshot. Adopt that epoch;
      // looping with the old target would cause a third read and a false signed-out boundary.
      targetEpoch = codexAccountUpdateEpoch
      // Another account/updated arrived during account/read or teardown: restart with the new generation.
      const currentFingerprint = codexAccountFingerprint(status)
      // Without a stable email, the event itself is the boundary: it may represent an invisible account switch.
      if (currentFingerprint === 'chatgpt:<unknown>' && boundaryFingerprint === currentFingerprint) {
        await resetCodexAccountThreads()
      }
      if (targetEpoch !== codexAccountUpdateEpoch) continue
      broadcastCodexAuth(status)
      handledEpoch = targetEpoch
    }
  })()
    .catch((error) => {
      console.warn('[codex-subscription] failed to reconcile account/updated:', (error as Error).message)
    })
    .finally(() => {
      if (codexExternalAccountRefreshPromise === promise) {
        codexExternalAccountRefreshPromise = null
        codexIdentityTransitionPending = false
      }
    })
  codexExternalAccountRefreshPromise = promise
}

function cancelPendingGitHubCopilotOperations(): void {
  for (const [, operation] of pendingConversationOperations) {
    if (
      isGitHubCopilotSubscriptionProvider(operation.providerId) &&
      subscriptionAccountId(operation.providerId) === null
    ) {
      operation.controller.abort(new Error('GitHub Copilot account changed'))
    }
  }
}

function toGitHubCopilotAuthStatus(
  status: GitHubCopilotSubscriptionStatus,
  accountId: string | null = null
): ChatSubscriptionAuthStatus {
  // loginPending belongs to the DEFAULT ACCOUNT state machine; an authenticated extra slot must not become "signing-in".
  if (!accountId && githubCopilotLoginPending) return { state: 'signing-in', authenticated: false }
  if (status.authenticated) {
    return {
      state: 'signed-in',
      authenticated: true,
      username: status.account?.login,
      enterpriseUrl: status.account?.host,
    }
  }
  if (status.state === 'error') {
    return {
      state: status.available ? 'error' : 'unavailable',
      authenticated: false,
      ...(status.error?.message ? { error: status.error.message } : {}),
    }
  }
  if (!status.available || status.state === 'disposed') return { state: 'unavailable', authenticated: false }
  return { state: 'signed-out', authenticated: false }
}

async function githubCopilotAuthStatus(
  refresh = false,
  accountId: string | null = null
): Promise<ChatSubscriptionAuthStatus> {
  return toGitHubCopilotAuthStatus(await getGitHubCopilotSubscriptionManager(accountId).getStatus(refresh), accountId)
}

function githubCopilotAuthSnapshot(accountId: string | null = null): ChatSubscriptionAuthStatus {
  const snapshot = getGitHubCopilotSubscriptionManager(accountId).getStatusSnapshot()
  if (snapshot) return toGitHubCopilotAuthStatus(snapshot, accountId)
  if (!accountId && githubCopilotLoginPending) return { state: 'signing-in', authenticated: false }
  return GITHUB_COPILOT_PROVISIONAL_AUTH_STATUS
}

async function validateGitHubCopilotModelSelection(
  modelId: string,
  accountId: string | null = null
): Promise<{ ok: true; model: GitHubCopilotModelInfo } | { ok: false; error: string }> {
  if (!accountId && (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise))
    return { ok: false, error: 'busy' }
  const manager = getGitHubCopilotSubscriptionManager(accountId)
  try {
    const status = await githubCopilotAuthStatus(true, accountId)
    if (!accountId && (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise))
      return { ok: false, error: 'busy' }
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    const models = await manager.listModels(true)
    if (!accountId && (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise))
      return { ok: false, error: 'busy' }
    manager.assertAccountIdentity(identity)
    const model = models.find((candidate) => candidate.id === modelId)
    return model && model.policy?.state !== 'disabled' ? { ok: true, model } : { ok: false, error: 'no-model' }
  } catch (error) {
    return { ok: false, error: githubCopilotErrorMessage(error) }
  }
}

async function validateClaudeModelSelection(
  modelId: string,
  accountId: string | null = null
): Promise<{ ok: true; model: ClaudeModelInfo } | { ok: false; error: string }> {
  if (!accountId && (claudeLoginPending || claudeIdentityTransitionPromise)) return { ok: false, error: 'busy' }
  const manager = getClaudeSubscriptionManager(accountId)
  try {
    const status = await manager.status({ refresh: true })
    if (!accountId && (claudeLoginPending || claudeIdentityTransitionPromise)) return { ok: false, error: 'busy' }
    if (!status.authenticated || !status.accountFingerprint) return { ok: false, error: 'no-key' }
    const identity = { fingerprint: status.accountFingerprint, epoch: status.accountEpoch }
    const models = await manager.listModels()
    manager.assertAccountIdentity(identity)
    const model = models.find((candidate) => candidate.value === modelId || candidate.resolvedModel === modelId)
    return model ? { ok: true, model } : { ok: false, error: 'no-model' }
  } catch (error) {
    return { ok: false, error: claudeSubscriptionErrorMessage(error) }
  }
}

export function claudeRuntimeAxes(
  conversationId: string,
  model: ClaudeModelInfo,
  reasoningOverride?: string,
  fastModeOverride?: boolean,
  strictFrozen = false
): {
  reasoningEffort?: string
  fastMode: boolean
  maestrlyUltra: boolean
  /** strictFrozen: the frozen profile was reproduced EXACTLY (fail-closed; manual turns = true). */
  frozenReproducible: boolean
} {
  const supportedEfforts = model.supportedEffortLevels ?? []
  const requestedEffort = reasoningOverride ?? getConvUiPrefs(conversationId).chat?.reasoning
  const maestrlyUltra = isMaestrlyUltraEffort(requestedEffort, supportedEfforts)
  const reasoningEffort =
    requestedEffort && requestedEffort !== 'off' && model.supportsEffort
      ? maestrlyUltra
        ? supportedEfforts.length
          ? resolveUltraEffort([...supportedEfforts])
          : undefined
        : supportedEfforts.length === 0 ||
            supportedEfforts.includes(requestedEffort as (typeof supportedEfforts)[number])
          ? requestedEffort
          : undefined
      : undefined
  const liveFast = model.supportsFastMode === true && getConvUiPrefs(conversationId).chat?.fastMode === true
  const fastMode =
    model.supportsFastMode === true && (typeof fastModeOverride === 'boolean' ? fastModeOverride : liveFast)
  let frozenReproducible = true
  if (strictFrozen) {
    // Frozen effort (non-'off') is reproducible only if the stream sends EXACTLY that level (or translates ultra
    // using known levels) AND support is evidenced (empty list = no evidence → NEVER pass through).
    // Frozen fast=true requires actual model support. Never silently degrade.
    if (requestedEffort && requestedEffort !== 'off') {
      const reproduced =
        !!reasoningEffort && supportedEfforts.length > 0 && (maestrlyUltra || reasoningEffort === requestedEffort)
      if (!reproduced) frozenReproducible = false
    }
    if (fastModeOverride === true && !fastMode) frozenReproducible = false
  }
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    fastMode,
    maestrlyUltra,
    frozenReproducible,
  }
}

function sameSubscriptionAuthStatus(a: ChatSubscriptionAuthStatus, b: ChatSubscriptionAuthStatus): boolean {
  return (
    a.state === b.state &&
    a.authenticated === b.authenticated &&
    a.email === b.email &&
    a.username === b.username &&
    a.planType === b.planType &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.error === b.error &&
    a.errorCode === b.errorCode
  )
}

function broadcastGitHubCopilotAuth(status: ChatSubscriptionAuthStatus): void {
  notifyChatRunnerCapabilityChanges(authChangeResetsRunnerCatalog(status))
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:github-copilot-subscription:auth-changed', status)
  } catch {
    /* window closed during authentication transition */
  }
}

function scheduleGitHubCopilotConfigRefresh(previous: ChatSubscriptionAuthStatus): void {
  const manager = getGitHubCopilotSubscriptionManager()
  if (manager.isDisposed || githubCopilotLoginPending || githubCopilotConfigRefreshPromise) return
  const promise = githubCopilotAuthStatus()
    .then(async (current) => {
      if (current.authenticated) await retryManagedGitHubCopilotSessionCleanup().catch(() => undefined)
      if (!sameSubscriptionAuthStatus(previous, current)) broadcastGitHubCopilotAuth(current)
    })
    .catch(() => undefined)
    .finally(() => {
      if (githubCopilotConfigRefreshPromise === promise) githubCopilotConfigRefreshPromise = null
    })
  githubCopilotConfigRefreshPromise = promise
}

function claudePhysicalIdentityIsChanging(providerId: string): boolean {
  return subscriptionAccountId(providerId) === null
    ? claudeLoginPending || claudeIdentityTransitionPromise !== null
    : claudeSlotTransitions.has(providerId)
}

function cancelPendingClaudeOperations(): void {
  for (const [, operation] of pendingConversationOperations) {
    if (
      isClaudeSubscriptionProvider(pendingPhysicalProviderId(operation)) &&
      subscriptionAccountId(pendingPhysicalProviderId(operation)) === null
    ) {
      operation.controller.abort(new Error('Claude account changed'))
    }
  }
}

function toClaudeAuthStatus(
  status: ClaudeSubscriptionStatus,
  accountId: string | null = null
): ChatSubscriptionAuthStatus {
  // loginPending belongs to the DEFAULT ACCOUNT state machine; an authenticated extra slot must not become "signing-in".
  if ((!accountId && claudeLoginPending) || status.state === 'signing-in') {
    return { state: 'signing-in', authenticated: false }
  }
  if (status.authenticated) {
    return {
      state: 'signed-in',
      authenticated: true,
      email: status.account?.email,
      planType: status.account?.subscriptionType,
      username: status.account?.organizationName,
    }
  }
  if (status.state === 'error') {
    return {
      state: 'error',
      authenticated: false,
      ...(status.error ? { error: status.error } : {}),
      ...(status.errorCode ? { errorCode: status.errorCode } : {}),
    }
  }
  if (!status.available || status.state === 'disposed' || status.state === 'unavailable') {
    return {
      state: 'unavailable',
      authenticated: false,
      ...(status.error ? { error: status.error } : {}),
    }
  }
  return { state: 'signed-out', authenticated: false }
}

async function claudeAuthStatus(refresh = false, accountId: string | null = null): Promise<ChatSubscriptionAuthStatus> {
  // Additional slots: direct status, bypassing the default-account state machine (boundaries belong to slot flows).
  if (accountId) {
    return toClaudeAuthStatus(await getClaudeSubscriptionManager(accountId).status({ refresh }), accountId)
  }
  const manager = getClaudeSubscriptionManager()
  const previousFingerprint = lastClaudeAccountFingerprint
  const status = await manager.status({ refresh })
  const currentFingerprint = status.accountFingerprint
  if (
    refresh &&
    previousFingerprint !== null &&
    previousFingerprint !== currentFingerprint &&
    !claudeLoginPending &&
    !claudeIdentityTransitionPromise
  ) {
    const generation = ++claudeAuthGeneration
    const transition = resetClaudeAccountSessions()
    claudeIdentityTransitionPromise = transition
    try {
      await transition
      if (generation !== claudeAuthGeneration) return toClaudeAuthStatus(await manager.status({ refresh: true }))
    } finally {
      if (claudeIdentityTransitionPromise === transition) claudeIdentityTransitionPromise = null
    }
  }
  lastClaudeAccountFingerprint = currentFingerprint
  return toClaudeAuthStatus(status)
}

function claudeAuthSnapshot(accountId: string | null = null): ChatSubscriptionAuthStatus {
  const snapshot = getClaudeSubscriptionManager(accountId).getStatusSnapshot()
  if (snapshot) return toClaudeAuthStatus(snapshot, accountId)
  if (!accountId && claudeLoginPending) return { state: 'signing-in', authenticated: false }
  return CLAUDE_PROVISIONAL_AUTH_STATUS
}

function broadcastClaudeAuth(status: ChatSubscriptionAuthStatus): void {
  notifyChatRunnerCapabilityChanges(authChangeResetsRunnerCatalog(status))
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:claude-subscription:auth-changed', status)
  } catch {
    /* window closed during authentication transition */
  }
}

function scheduleClaudeConfigRefresh(previous: ChatSubscriptionAuthStatus): void {
  const manager = getClaudeSubscriptionManager()
  if (manager.isDisposed || claudeLoginPending || claudeIdentityTransitionPromise || claudeConfigRefreshPromise) return
  const generation = claudeAuthGeneration
  const promise = claudeAuthStatus()
    .then(async (current) => {
      if (generation !== claudeAuthGeneration || claudeLoginPending) return
      if (current.authenticated) await retryManagedClaudeSessionCleanup().catch(() => undefined)
      if (!sameSubscriptionAuthStatus(previous, current)) broadcastClaudeAuth(current)
    })
    .catch(() => undefined)
    .finally(() => {
      if (claudeConfigRefreshPromise === promise) claudeConfigRefreshPromise = null
    })
  claudeConfigRefreshPromise = promise
}

function handleClaudeAuthenticationRequired(status: ClaudeSubscriptionStatus): void {
  if (claudeLoginPending) return
  const generation = ++claudeAuthGeneration
  lastClaudeAccountFingerprint = null
  broadcastClaudeAuth(toClaudeAuthStatus(status))
  const transition = resetClaudeAccountSessions()
    .then(() => {
      if (generation !== claudeAuthGeneration) return
      const current = getClaudeSubscriptionManager().getStatusSnapshot()
      if (current) broadcastClaudeAuth(toClaudeAuthStatus(current))
    })
    .catch((error) => {
      console.warn(
        '[claude-subscription] failed to clear sessions after authentication expired:',
        claudeSubscriptionErrorMessage(error)
      )
    })
    .finally(() => {
      if (claudeIdentityTransitionPromise === transition) claudeIdentityTransitionPromise = null
    })
  claudeIdentityTransitionPromise = transition
}

/** Token/account changes are hard context boundaries even when the GitHub login name is unchanged. */
function handleGitHubCopilotAuthUpdated(): void {
  // Login/logout initiated by this service already owns the identity barrier and its final status broadcast.
  // Manager notifications emitted inside those flows must not start a competing cleanup or clear the barrier.
  if (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise) return
  const generation = ++githubCopilotAuthGeneration
  cancelPendingGitHubCopilotOperations()
  for (const run of active.values()) {
    if (!isGitHubCopilotSubscriptionProvider(run.providerId) || subscriptionAccountId(run.providerId) !== null) continue
    run.allowGitHubCopilotPersistence = false
    run.controller.abort(new Error('GitHub Copilot account changed'))
  }
  const promise = deleteAllManagedGitHubCopilotSessions(undefined, { accountId: null })
    .catch((error) => {
      console.warn('[github-copilot] failed to clear sessions after auth change:', githubCopilotErrorMessage(error))
    })
    .then(() => githubCopilotAuthStatus(true))
    .then((status) => {
      if (generation === githubCopilotAuthGeneration) broadcastGitHubCopilotAuth(status)
    })
    .catch(() => undefined)
    .finally(() => {
      if (githubCopilotIdentityTransitionPromise === promise) githubCopilotIdentityTransitionPromise = null
    })
  githubCopilotIdentityTransitionPromise = promise
}

function cancelPendingGrokOperations(): void {
  for (const [, operation] of pendingConversationOperations) {
    if (isGrokSubscriptionProvider(operation.providerId) && subscriptionAccountId(operation.providerId) === null) {
      operation.controller.abort(new Error('Grok account changed'))
    }
  }
}

function toGrokAuthStatus(status: GrokSubscriptionStatus, accountId: string | null = null): ChatSubscriptionAuthStatus {
  // loginPending belongs to the DEFAULT ACCOUNT state machine; an authenticated extra slot must not become "signing-in".
  if (!accountId && grokLoginPending) return { state: 'signing-in', authenticated: false }
  if (status.authenticated) {
    return {
      state: 'signed-in',
      authenticated: true,
      email: status.account?.email,
      username: status.account?.name,
      planType: status.account?.planType,
    }
  }
  if (status.state === 'error') {
    return {
      state: status.available ? 'error' : 'unavailable',
      authenticated: false,
      ...(status.error?.message ? { error: status.error.message } : {}),
    }
  }
  if (!status.available || status.state === 'disposed') return { state: 'unavailable', authenticated: false }
  return { state: 'signed-out', authenticated: false }
}

async function grokAuthStatus(refresh = false, accountId: string | null = null): Promise<ChatSubscriptionAuthStatus> {
  return toGrokAuthStatus(await getGrokSubscriptionManager(accountId).getStatus(refresh), accountId)
}

function grokAuthSnapshot(accountId: string | null = null): ChatSubscriptionAuthStatus {
  const snapshot = getGrokSubscriptionManager(accountId).getStatusSnapshot()
  if (snapshot) return toGrokAuthStatus(snapshot, accountId)
  if (!accountId && grokLoginPending) return { state: 'signing-in', authenticated: false }
  return GROK_PROVISIONAL_AUTH_STATUS
}

async function validateGrokModelSelection(
  modelId: string,
  accountId: string | null = null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!accountId && (grokLoginPending || grokIdentityTransitionPromise)) return { ok: false, error: 'busy' }
  const manager = getGrokSubscriptionManager(accountId)
  try {
    const status = await grokAuthStatus(true, accountId)
    if (!accountId && (grokLoginPending || grokIdentityTransitionPromise)) return { ok: false, error: 'busy' }
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    const models = await manager.listModels(true)
    if (!accountId && (grokLoginPending || grokIdentityTransitionPromise)) return { ok: false, error: 'busy' }
    manager.assertAccountIdentity(identity)
    return models.some((candidate) => candidate.id === modelId) ? { ok: true } : { ok: false, error: 'no-model' }
  } catch (error) {
    return { ok: false, error: grokSubscriptionErrorMessage(error) }
  }
}

function broadcastGrokAuth(status: ChatSubscriptionAuthStatus): void {
  notifyChatRunnerCapabilityChanges(authChangeResetsRunnerCatalog(status))
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('chat:grok-subscription:auth-changed', status)
  } catch {
    /* window closed during authentication transition */
  }
}

function scheduleGrokConfigRefresh(previous: ChatSubscriptionAuthStatus): void {
  const manager = getGrokSubscriptionManager()
  if (manager.isDisposed || grokLoginPending || grokConfigRefreshPromise) return
  const promise = grokAuthStatus()
    .then((current) => {
      if (!sameSubscriptionAuthStatus(previous, current)) broadcastGrokAuth(current)
    })
    .catch(() => undefined)
    .finally(() => {
      if (grokConfigRefreshPromise === promise) grokConfigRefreshPromise = null
    })
  grokConfigRefreshPromise = promise
}

/** Token/account changes are hard context boundaries for Grok (generic AI SDK runner). */
function handleGrokAuthUpdated(): void {
  if (grokLoginPending || grokIdentityTransitionPromise) return
  const generation = ++grokAuthGeneration
  cancelPendingGrokOperations()
  for (const run of active.values()) {
    if (!isGrokSubscriptionProvider(run.providerId) || subscriptionAccountId(run.providerId) !== null) continue
    run.controller.abort(new Error('Grok account changed'))
  }
  invalidateProvider(subscriptionProviderIdFor('grok-subscription', null))
  const promise = grokAuthStatus(true)
    .then((status) => {
      if (generation === grokAuthGeneration) broadcastGrokAuth(status)
    })
    .catch(() => undefined)
    .finally(() => {
      if (grokIdentityTransitionPromise === promise) grokIdentityTransitionPromise = null
    })
  grokIdentityTransitionPromise = promise
}

/** Normalizes accountId from IPC: nonempty string → additional slot; anything else → default account. */
function normalizeAccountId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * IPC boundary for additional slots: accountId must be an EXISTING slot of the channel's provider.
 * Otherwise, a compromised renderer could instantiate managers (and disk homes) with arbitrary IDs —
 * including path traversal in the directory suffix — or authenticate a slot belonging to another provider.
 */
function validSubscriptionAccountId(kind: ChatSubscriptionProviderKind, accountId: string | null): boolean {
  return !accountId || getSubscriptionAccount(accountId)?.kind === kind
}

/** Sanitizes effort from UI/IPC: a short slug without spaces (low/medium/high/xhigh/max…). */
function sanitizeEffort(effort: string): string {
  return effort
    .trim()
    .toLowerCase()
    .slice(0, 24)
    .replace(/[^a-z0-9_-]/g, '')
}

/** Default reasoning level for new conversations; 'off' (= none) if unconfigured. */
function defaultReasoningEffort(): string {
  const r = getAppSetting(CHAT_DEFAULT_REASONING_KEY)
  return typeof r === 'string' && r.trim() ? r : 'off'
}

function codexSerializableReasoningEfforts(modelId: string, efforts: readonly string[]): string[] {
  const astra =
    resolveModelHarnessProfile({
      providerKind: 'codex-subscription',
      modelId,
      astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
    }).id === 'openai-gpt-6-astra-v1'
  return astra
    ? efforts.filter((effort) => OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts.includes(effort))
    : [...efforts]
}

function makeSafeSend(wc: WebContents): SafeSend {
  return (channel, payload) => sendChatEvent(wc, channel, payload)
}

/** Global default (provider/model) for new conversations; null if unconfigured. */
function defaultSelection(): ChatModelRef | null {
  const providers = listAvailableChatProviders()
  if (providers.length === 0) return null
  const savedP = getAppSetting(CHAT_DEFAULT_PROVIDER_KEY)
  const savedM = getAppSetting(CHAT_DEFAULT_MODEL_KEY)
  if (savedP && savedM && providers.some((p) => p.id === savedP)) {
    return { providerId: savedP, modelId: savedM }
  }
  // Fallback: first provider with a key (or any first provider); empty modelId = user picks in the chip / auto-pick on send.
  const provider =
    providers.find((p) =>
      isCodexSubscriptionProvider(p.id)
        ? codexAuthSnapshot(subscriptionAccountId(p.id)).authenticated
        : isGitHubCopilotSubscriptionProvider(p.id)
          ? githubCopilotAuthSnapshot(subscriptionAccountId(p.id)).authenticated
          : isClaudeSubscriptionProvider(p.id)
            ? claudeAuthSnapshot(subscriptionAccountId(p.id)).authenticated
            : isGrokSubscriptionProvider(p.id)
              ? grokAuthSnapshot(subscriptionAccountId(p.id)).authenticated
              : hasApiKey(p.id)
    ) ?? providers[0]
  const modelId = isChatGptWebProvider(savedP) ? '' : (savedM ?? '')
  if (isChatGptWebProvider(savedP)) {
    setAppSetting(CHAT_DEFAULT_PROVIDER_KEY, provider.id)
    setAppSetting(CHAT_DEFAULT_MODEL_KEY, '')
  }
  return { providerId: provider.id, modelId }
}

/** Effective global profile inherited by the Maestro parent and captured by named strategies. */
export function getGlobalMaestroOrchestratorProfile(): MaestroOrchestratorProfileV1 | null {
  const selection = defaultSelection()
  if (!selection?.providerId || !selection.modelId) return null
  return {
    ...selection,
    reasoning: defaultReasoningEffort(),
    fastMode: getAppFlag(CHAT_DEFAULT_FAST_MODE_KEY, false),
  }
}

/** Effective conversation selection: conversation prefs (if the provider still exists) → global default. */
function selectionFor(conversationId: string): ChatModelRef | null {
  const prefs = getConvUiPrefs(conversationId).chat
  if (isChatGptWebProvider(prefs?.providerId)) {
    const fallback = defaultSelection()
    if (fallback) patchConvChat(conversationId, { providerId: fallback.providerId, modelId: fallback.modelId })
    return fallback
  }
  if (prefs?.providerId && getProvider(prefs.providerId)) {
    return { providerId: prefs.providerId, modelId: prefs.modelId ?? '' }
  }
  return defaultSelection()
}

/**
 * Cold start for additional SLOTS: managers start without a cache and provisional snapshots return `connected:false`,
 * which would hide accounts from selectors and invalidate saved model selections until the user opens
 * Settings. Resolve status in the background — deduplicated per account — and publish auth-changed with
 * accountId for renderer reconciliation, mirroring the default account's schedule*ConfigRefresh helpers.
 */
const subscriptionAccountConfigRefreshes = new Set<string>()
function scheduleSubscriptionAccountConfigRefresh(providerId: string, accountId: string): void {
  if (subscriptionAccountConfigRefreshes.has(accountId)) return
  let refresh: (() => Promise<void>) | null = null
  if (isCodexSubscriptionProvider(providerId)) {
    if (getCodexSubscriptionManager(accountId).getStatusSnapshot()) return
    refresh = async () => broadcastCodexAccountAuth(accountId, await codexAuthStatus(false, undefined, accountId))
  } else if (isGitHubCopilotSubscriptionProvider(providerId)) {
    if (getGitHubCopilotSubscriptionManager(accountId).getStatusSnapshot()) return
    refresh = async () => broadcastGitHubCopilotAccountAuth(accountId, await githubCopilotAuthStatus(false, accountId))
  } else if (isClaudeSubscriptionProvider(providerId)) {
    if (getClaudeSubscriptionManager(accountId).getStatusSnapshot()) return
    refresh = async () => broadcastClaudeAccountAuth(accountId, await claudeAuthStatus(false, accountId))
  } else if (isGrokSubscriptionProvider(providerId)) {
    if (getGrokSubscriptionManager(accountId).getStatusSnapshot()) return
    refresh = async () => broadcastGrokAccountAuth(accountId, await grokAuthStatus(false, accountId))
  }
  if (!refresh) return
  subscriptionAccountConfigRefreshes.add(accountId)
  void refresh()
    .catch(() => undefined)
    .finally(() => subscriptionAccountConfigRefreshes.delete(accountId))
}

function buildConfig(): ChatConfig {
  const codexStatus = codexAuthSnapshot()
  const githubCopilotStatus = githubCopilotAuthSnapshot()
  const claudeStatus = claudeAuthSnapshot()
  const grokStatus = grokAuthSnapshot()
  const config: ChatConfig = {
    providers: listAvailableChatProviders().map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      apiKeyPresent: isManagedProvider(p.id) ? false : hasApiKey(p.id),
      ...(isCodexSubscriptionProvider(p.id)
        ? {
            builtIn: true,
            connected: p.accountId ? codexAuthSnapshot(p.accountId).authenticated : codexStatus.authenticated,
          }
        : isGitHubCopilotSubscriptionProvider(p.id)
          ? {
              builtIn: true,
              connected: p.accountId
                ? githubCopilotAuthSnapshot(p.accountId).authenticated
                : githubCopilotStatus.authenticated,
            }
          : isClaudeSubscriptionProvider(p.id)
            ? {
                builtIn: true,
                connected: p.accountId ? claudeAuthSnapshot(p.accountId).authenticated : claudeStatus.authenticated,
              }
            : isGrokSubscriptionProvider(p.id)
              ? {
                  builtIn: true,
                  connected: p.accountId ? grokAuthSnapshot(p.accountId).authenticated : grokStatus.authenticated,
                }
              : { connected: hasApiKey(p.id) }),
      ...(p.kind ? { kind: getProviderKind(p) } : {}),
      ...(p.accountId ? { accountId: p.accountId } : {}),
      ...(p.accountLabel ? { accountLabel: p.accountLabel } : {}),
    })),
    presets: PROVIDER_PRESETS,
    mcpServers: listMcpServers().map((s) => ({
      id: s.id,
      name: s.name,
      transport: s.transport,
      enabled: s.enabled,
      url: s.url,
      command: s.command,
    })),
    appToolsEnabled: getAppFlag('chat.appTools', false),
    imageGenEnabled: getAppFlag(IMAGE_GEN_FLAG, true),
    bashFiltersEnabled: getAppFlag('chat.bashFilters', true),
    openAIHarnessEnabled: getAppFlag('chat.openAIHarness', true),
    astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
    storageMode: apiKeyStorageMode(),
    defaultSelection: defaultSelection(),
    defaultReasoning: defaultReasoningEffort(),
    defaultFastMode: getAppFlag(CHAT_DEFAULT_FAST_MODE_KEY, false),
    imageInterpreter: getImageInterpreter(),
    subscriptionFailover: {
      supportedKinds: [...SUPPORTED_FAILOVER_KINDS],
      routes: listFailoverRoutes(),
    },
  }
  scheduleCodexConfigRefresh(codexStatus)
  scheduleGitHubCopilotConfigRefresh(githubCopilotStatus)
  scheduleClaudeConfigRefresh(claudeStatus)
  scheduleGrokConfigRefresh(grokStatus)
  for (const provider of config.providers) {
    if (provider.accountId) scheduleSubscriptionAccountConfigRefresh(provider.id, provider.accountId)
  }
  return config
}

async function bestEffortWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runnerCapabilityMetaFallback(providerId: string, modelId: string): Promise<ChatModelMeta | null> {
  const accountId = subscriptionAccountId(providerId)
  if (isCodexSubscriptionProvider(providerId)) {
    const model = (
      await getCodexSubscriptionManager(accountId)
        .listModels()
        .catch(() => [])
    ).find((candidate) => candidate.id === modelId || candidate.model === modelId)
    if (!model) return null
    const reasoningEfforts = model.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? []
    const fastModeCapability =
      (model.serviceTiers ?? []).some(
        (tier) =>
          tier.id.toLowerCase() === 'priority' || tier.id.toLowerCase() === 'fast' || tier.name.toLowerCase() === 'fast'
      ) ||
      /^(priority|fast)$/i.test(model.defaultServiceTier ?? '') ||
      (model.legacySpeedTiers ?? []).some((tier) => /^(priority|fast)$/i.test(tier))
    return {
      reasoning: reasoningEfforts.length > 0,
      reasoningEfforts,
      fastModeCapability,
      nativeUltraMode:
        resolveModelHarnessProfile({
          providerKind: 'codex-subscription',
          modelId,
          astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
        }).id === 'openai-gpt-6-astra-v1' && reasoningEfforts.includes('ultra'),
    }
  }
  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const model = (
      await getGitHubCopilotSubscriptionManager(accountId)
        .listModels()
        .catch(() => [])
    ).find((candidate) => candidate.id === modelId)
    return model
      ? {
          reasoning: model.capabilities.supports.reasoningEffort,
          reasoningEfforts: model.supportedReasoningEfforts ?? [],
          fastModeCapability: false,
        }
      : null
  }
  if (isClaudeSubscriptionProvider(providerId)) {
    const model = (
      await getClaudeSubscriptionManager(accountId)
        .listModels()
        .catch(() => [])
    ).find((candidate) => candidate.value === modelId || candidate.resolvedModel === modelId)
    if (!model) return null
    const reasoningEfforts = model.supportedEffortLevels ?? []
    return {
      reasoning:
        model.supportsEffort === true || model.supportsAdaptiveThinking === true || reasoningEfforts.length > 0,
      reasoningEfforts,
      fastModeCapability: model.supportsFastMode === true,
    }
  }
  if (isGrokSubscriptionProvider(providerId)) {
    return { ...grokReasoningMeta(modelId, null), fastModeCapability: true }
  }
  return null
}

/** Return usable models per provider, including authenticated built-in account slots. */
export async function listChatExecutionModels(
  options: {
    refreshSubscriptionAuth?: boolean
    /** Executable runner catalog: excludes BYOK but preserves explicitly selectable built-in account slots. */
    portableExecutionOnly?: boolean
    /** An unavailable runtime must not block other providers in the shared catalog. */
    subscriptionProviderTimeoutMs?: number
  } = {}
): Promise<Array<{ id: string; name: string; models: string[] }>> {
  const providers = listAvailableChatProviders().filter(
    (provider) => !options.portableExecutionOnly || isPortableExecutionProviderId(provider.id)
  )
  const withKey = providers.filter((p) => !isSubscriptionProvider(p.id) && hasApiKey(p.id))
  const custom = await Promise.all(
    withKey.map(async (p) => {
      const models = await fetchModels(p.id)
      return {
        id: p.id,
        name: p.name,
        models: options.refreshSubscriptionAuth ? filterChatModelsSnapshot(models) : await filterChatModels(models),
      }
    })
  )
  // Use only the known snapshot unless explicit refresh was requested, avoiding accidental runtime startup.
  // Built-ins are represented once per account.
  const builtIns = (
    await Promise.all(
      providers
        .filter((provider) => isSubscriptionProvider(provider.id))
        .map((provider): Promise<{ id: string; name: string; models: string[] } | null> => {
          const load = async (): Promise<{ id: string; name: string; models: string[] } | null> => {
            const accountId = subscriptionAccountId(provider.id)
            if (isCodexSubscriptionProvider(provider.id)) {
              const status = options.refreshSubscriptionAuth
                ? await codexAuthStatus(false, undefined, accountId).catch(() => codexAuthSnapshot(accountId))
                : codexAuthSnapshot(accountId)
              if (!status.authenticated) return null
              const models = await getCodexSubscriptionManager(accountId)
                .listModels()
                .catch(() => [])
              return {
                id: provider.id,
                name: provider.name,
                models: models
                  .filter((model) => !model.hidden && model.inputModalities.includes('text'))
                  .map((model) => model.id),
              }
            }
            if (isGitHubCopilotSubscriptionProvider(provider.id)) {
              const status = options.refreshSubscriptionAuth
                ? await githubCopilotAuthStatus(false, accountId).catch(() => githubCopilotAuthSnapshot(accountId))
                : githubCopilotAuthSnapshot(accountId)
              if (!status.authenticated) return null
              const models = await getGitHubCopilotSubscriptionManager(accountId)
                .listModels()
                .catch(() => [])
              return {
                id: provider.id,
                name: provider.name,
                models: filterChatModelsSnapshot(
                  models.filter((model) => model.policy?.state !== 'disabled').map((model) => model.id)
                ),
              }
            }
            if (isClaudeSubscriptionProvider(provider.id)) {
              const status = options.refreshSubscriptionAuth
                ? await claudeAuthStatus(false, accountId).catch(() => claudeAuthSnapshot(accountId))
                : claudeAuthSnapshot(accountId)
              if (!status.authenticated) return null
              const models = await getClaudeSubscriptionManager(accountId)
                .listModels()
                .catch(() => [])
              return {
                id: provider.id,
                name: provider.name,
                models: filterChatModelsSnapshot(models.map((model) => model.value)),
              }
            }
            if (isGrokSubscriptionProvider(provider.id)) {
              const status = options.refreshSubscriptionAuth
                ? await grokAuthStatus(false, accountId).catch(() => grokAuthSnapshot(accountId))
                : grokAuthSnapshot(accountId)
              if (!status.authenticated) return null
              const models = await getGrokSubscriptionManager(accountId)
                .listModels()
                .catch(() => [])
              return {
                id: provider.id,
                name: provider.name,
                models: filterChatModelsSnapshot(models.map((model) => model.id)),
              }
            }
            return null
          }
          return options.subscriptionProviderTimeoutMs
            ? bestEffortWithin(load(), options.subscriptionProviderTimeoutMs, null)
            : load()
        })
    )
  ).filter((provider): provider is { id: string; name: string; models: string[] } => provider !== null)
  return [...builtIns, ...custom]
}

/**
 * Minimal catalog a cloud runner may publish. Excludes account names, base URLs, keys,
 * fingerprints, and native provider state; includes only executable pairs and supported efforts.
 */
export async function listChatRunnerCapabilities(): Promise<
  Array<{ providerId: string; modelId: string; reasoningEfforts: string[]; fastMode: boolean }>
> {
  const providers = await listChatExecutionModels({
    refreshSubscriptionAuth: true,
    portableExecutionOnly: true,
    subscriptionProviderTimeoutMs: 8_000,
  })
  const pairs = providers.flatMap((provider) =>
    provider.models.map((modelId) => ({ providerId: provider.id, modelId }))
  )
  const output: Array<{ providerId: string; modelId: string; reasoningEfforts: string[]; fastMode: boolean }> = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(8, pairs.length) }, async () => {
    for (;;) {
      const index = cursor++
      const pair = pairs[index]
      if (!pair) return
      let meta: ChatModelMeta | null = null
      try {
        meta = await bestEffortWithin(
          effectiveModelMeta(pair.modelId, pair.providerId).then((result) => result.meta),
          2_000,
          null
        )
        if (!meta)
          meta = await bestEffortWithin(runnerCapabilityMetaFallback(pair.providerId, pair.modelId), 2_000, null)
      } catch {
        /* The pair remains executable without a reasoning override; the remote catalog degrades conservatively. */
      }
      const efforts =
        meta?.reasoning === true
          ? meta.reasoningEfforts?.length
            ? meta.reasoningEfforts
            : [...DEFAULT_REASONING_EFFORTS]
          : []
      output[index] = {
        ...pair,
        reasoningEfforts: [...new Set(efforts.map((effort) => effort.trim()).filter(Boolean))],
        fastMode: meta?.fastModeCapability === true,
      }
    }
  })
  // The array is filled by index; on cold start return discovered pairs and let slow runtimes
  // warm up in the background. Catalog SWR will probe again without blocking model selection for minutes.
  await bestEffortWithin(
    Promise.all(workers).then(() => undefined),
    8_000,
    undefined
  )
  return output.filter(Boolean)
}

function toRequestPayload(req: PermissionRequest): Extract<ChatPermissionEvent, { kind: 'request' }> {
  return {
    kind: 'request',
    request: {
      id: req.id,
      conversationId: req.conversationId,
      toolCallId: req.toolCallId,
      toolName: req.toolName ?? req.action,
      action: req.action,
      title: req.title,
      resources: req.resources,
      ...(req.save?.length ? { allowAlways: true } : {}),
    },
  }
}

/** Minimal live snapshot for a remounted ChatView; history still comes from chat-store. */
export function chatRuntimeState(conversationId: string): ChatRuntimeState {
  const run = active.get(conversationId)
  return {
    streaming: active.has(conversationId) || pendingConversationOperations.has(conversationId),
    pendingPermissions: getBroker()
      .pendingFor(conversationId)
      .map((request) => toRequestPayload(request).request),
    pendingQuestions: getQuestionBroker().pendingQuestionsFor(conversationId),
    maestroLive: maestroLiveState(run?.maestroLive),
    midTurnSteering: run?.midTurnSteering === true,
    liveReasoningUpdate: run?.liveReasoningUpdate === true,
    activeHarnessProfile: run?.activeHarnessProfile ?? null,
  }
}

/** Connects the broker to active conversations (asked → prompt + awaiting; resolved → dismiss + transition). */
function wireBroker(b: PermissionBroker): void {
  b.on('asked', (req: PermissionRequest) => {
    const run = active.get(req.conversationId)
    if (!run) return
    run.send(`chat:permission:${req.conversationId}`, toRequestPayload(req))
    if (req.toolCallId) {
      const ev: ChatStreamEvent = {
        kind: 'tool-state',
        messageId: run.messageId,
        toolCallId: req.toolCallId,
        state: { status: 'awaiting-permission', title: req.title },
      }
      run.send(`chat:delta:${req.conversationId}`, ev)
    }
  })
  b.on(
    'resolved',
    (ev: { conversationId: string; toolCallId?: string; requestId: string; decision: 'allow' | 'deny' }) => {
      const run = active.get(ev.conversationId)
      if (!run) return
      const resolved: ChatPermissionEvent = {
        kind: 'resolved',
        requestId: ev.requestId,
        toolCallId: ev.toolCallId,
        decision: ev.decision,
      }
      run.send(`chat:permission:${ev.conversationId}`, resolved)
      if (ev.toolCallId && ev.decision === 'allow') {
        const stateEv: ChatStreamEvent = {
          kind: 'tool-state',
          messageId: run.messageId,
          toolCallId: ev.toolCallId,
          state: { status: 'running' },
        }
        run.send(`chat:delta:${ev.conversationId}`, stateEv)
      }
      // deny: the runner also emits tool-state 'denied' through tool-error (idempotent).
    }
  )
}

/** Effective conversation permission mode: conversation prefs → global Chat default. */
function permModeFor(conversationId: string): 'full' | 'ask' | 'auto' {
  const m = getConvUiPrefs(conversationId).chat?.permMode
  if (m === 'full' || m === 'ask' || m === 'auto') return m
  const configured = getAppSetting('chat.defaultPermissionMode')
  if (configured === 'full' || configured === 'ask' || configured === 'auto') return configured
  const migrated = getAppFlag('yoloMode', true) ? 'full' : 'ask'
  setAppSetting('chat.defaultPermissionMode', migrated)
  return migrated
}

/** Base conversation ruleset for the mode. */
function rulesetFor(conversationId: string): Ruleset {
  switch (permModeFor(conversationId)) {
    case 'full':
      return YOLO_RULESET
    case 'auto':
      return AUTO_RULESET
    default:
      return BYOK_DEFAULT_RULESET
  }
}

/** Effective conversation behavior mode (default agent). */
function modeFor(conversationId: string): ChatMode {
  return normalizeChatMode(getConvUiPrefs(conversationId).chat?.mode)
}

/** Single structural behavior resolver used by admission, compatibility checks and every runtime. */
function behaviorFor(conversationId: string): ChatBehavior {
  return resolveChatBehavior(getConversation(conversationId)?.experience, modeFor(conversationId))
}

/** Sets conversation behavior mode (used by index when approving a plan → return to agent). */
export function setChatMode(conversationId: string, mode: ChatMode): void {
  if (getConversation(conversationId)?.experience === 'maestro') return
  patchConvChat(conversationId, { mode })
}

/**
 * Ends orchestration without forking or rewriting history. Admission is synchronous in the main process, so checking
 * the host-owned pending/active registries before the compare-and-set prevents a new turn from crossing the boundary.
 */
export function convertMaestroConversationToStandard(conversationId: string): MaestroToStandardResult {
  const conversation = getConversation(conversationId)
  if (!conversation) return { ok: false, error: 'invalid-conversation' }
  if (conversation.experience !== 'maestro') return { ok: false, error: 'not-maestro' }
  if (reviewLoopLockForConversation(conversationId)) {
    return { ok: false, error: 'conversation-reserved' }
  }
  if (incompleteMigrationForConversation(conversationId)) {
    return { ok: false, error: 'conversation-migrating' }
  }
  if (
    active.has(conversationId) ||
    pendingConversationOperations.has(conversationId) ||
    getActiveMaestroLiveRun(conversationId) ||
    (conversation.status !== 'idle' && conversation.status !== 'ready' && conversation.status !== 'error')
  ) {
    return { ok: false, error: 'conversation-busy' }
  }

  const converted = updateConversationExperience(conversationId, 'maestro', 'standard')
  if (converted) return { ok: true }
  return getConversation(conversationId)
    ? { ok: false, error: 'not-maestro' }
    : { ok: false, error: 'invalid-conversation' }
}

/** Starts orchestration in place and pins the currently effective model without rewriting the Standard transcript. */
export function convertStandardConversationToMaestro(conversationId: string): StandardToMaestroResult {
  const conversation = getConversation(conversationId)
  if (!conversation) return { ok: false, error: 'invalid-conversation' }
  if (conversation.experience !== 'standard') return { ok: false, error: 'not-standard' }
  if (reviewLoopLockForConversation(conversationId)) {
    return { ok: false, error: 'conversation-reserved' }
  }
  if (incompleteMigrationForConversation(conversationId)) {
    return { ok: false, error: 'conversation-migrating' }
  }
  if (
    active.has(conversationId) ||
    pendingConversationOperations.has(conversationId) ||
    getActiveMaestroLiveRun(conversationId) ||
    (conversation.status !== 'idle' && conversation.status !== 'ready' && conversation.status !== 'error')
  ) {
    return { ok: false, error: 'conversation-busy' }
  }

  const selection = selectionFor(conversationId)
  let converted = false
  transaction(() => {
    converted = updateConversationExperience(conversationId, 'standard', 'maestro')
    if (converted && selection?.providerId && selection.modelId) {
      patchConvChat(conversationId, { providerId: selection.providerId, modelId: selection.modelId })
    }
  })
  if (converted) return { ok: true }
  return getConversation(conversationId)
    ? { ok: false, error: 'not-standard' }
    : { ok: false, error: 'invalid-conversation' }
}

/** Merges into ui_prefs.chat (patchConvUiPrefs is shallow at the first level → preserve other fields). */
function patchConvChat(conversationId: string, partial: Record<string, unknown>): void {
  const cur = getConvUiPrefs(conversationId).chat ?? {}
  patchConvUiPrefs(conversationId, { chat: { ...cur, ...partial } })
}

/**
 * Persists a server-side turn's frozen selection before revealing the conversation to the renderer. Start
 * repeats this patch inside the admission reservation; this early step only prevents provisional UI.
 */
export function primeChatTurnSelection(
  conversationId: string,
  selection: { providerId: string; modelId: string; reasoning?: string; fastMode?: boolean }
): void {
  const previous = getConvUiPrefs(conversationId).chat
  const changed = previous?.providerId !== selection.providerId || previous?.modelId !== selection.modelId
  patchConvChat(conversationId, {
    providerId: selection.providerId,
    modelId: selection.modelId,
    reasoning: selection.reasoning || 'off',
    fastMode: selection.fastMode === true,
    ...(changed ? { imagesUnsupported: false } : {}),
  })
}

/** Resolved conversation tool state (app-tools + disabled MCP servers + image generation). */
function convToolsFor(conversationId: string): ChatConvTools {
  const t = getConvUiPrefs(conversationId).chat?.tools
  return {
    app: t?.app ?? getAppFlag('chat.appTools', false),
    mcpDisabled: t?.mcpDisabled ?? [],
    imageGen: imageGenEnabledFor(conversationId),
  }
}

function getBroker(): PermissionBroker {
  if (!broker) {
    broker = new PermissionBroker({ rulesetFor })
    wireBroker(broker)
  }
  return broker
}

/** Shared executor boundary for host workflows that reuse Chat subagents outside a model tool call. */
export function getChatPermissionBroker(): PermissionBroker {
  return getBroker()
}

/** ask_question broker (round trip from toolCallId to answers; the card comes from the part). Event wiring here
 * only reflects conversation STATUS: pending question → 'asking' (sound + badge + "?"); answered → 'working'. */
export function getChatQuestionBroker(): QuestionBroker {
  if (!questionBroker) {
    questionBroker = new QuestionBroker()
    questionBroker.on('asked', ({ conversationId }: { conversationId: string }) => {
      if (active.has(conversationId)) savedDeps?.emitStatus(conversationId, 'asking')
    })
    questionBroker.on('answered', ({ conversationId }: { conversationId: string }) => {
      // Return to 'working' only when NO other question is pending in this conversation.
      if (active.has(conversationId) && questionBroker!.pendingFor(conversationId).length === 0) {
        savedDeps?.emitStatus(conversationId, 'working')
      }
    })
  }
  return questionBroker
}

const getQuestionBroker = getChatQuestionBroker

/**
 * Inline `@file` / `@folder/` mentions (IDE-style): users write `@src/store.ts` or
 * `@src/components/` (with optional `:L10-20`). File contents/directory listings are injected as
 * HIDDEN parts (sent to the model, not rendered: the mention already appears inline). Deduplicate by path+range
 * to avoid injecting the same file twice. Shared parser in shared/chat-mentions.
 */
type Mention = MentionMatch

function uniqueMentions(text: string): Mention[] {
  const seen = new Set<string>()
  const out: Mention[] = []
  for (const m of findMentions(text)) {
    const key = m.path + (m.startLine ? `:${m.startLine}-${m.endLine ?? m.startLine}` : '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

// Skip large AND sensitive directories (.claude/.agents hold credentials/private data) — same list as file-search.
// Do not skip all dot-directories (so @.github/… remains mentionable); list LARGE dot-directories by name.
const DIR_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
  '.agents',
  '.claude',
  '.venv',
  '.idea',
  '.vs',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.svn',
  '.hg',
  '.terraform',
])

/** Lists a folder's files (recursive, capped) for injection as @folder/ mention context. */
async function listDir(absDir: string, cwd: string, limit = 400): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.isDirectory()) {
        if (DIR_SKIP.has(e.name)) continue
        await walk(path.join(dir, e.name))
      } else if (e.isFile()) {
        out.push(path.relative(cwd, path.join(dir, e.name)).replaceAll('\\', '/'))
      }
    }
  }
  await walk(absDir)
  return out
}

/** Resolves a mention → HIDDEN file part (file contents or directory listing). Prevents escaping cwd. */
async function readMentionPart(cwd: string, m: Mention): Promise<MessagePart | null> {
  const clean = m.path.replace(/\/+$/, '')
  if (!clean) return null
  const abs = path.resolve(cwd, clean)
  const rel = path.relative(path.resolve(cwd), abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null // Outside cwd → reject.
  try {
    const st = await fsp.stat(abs)
    if (st.isDirectory()) {
      const files = await listDir(abs, path.resolve(cwd))
      const body = files.length ? files.join('\n') : '(empty)'
      return {
        type: 'file',
        id: randomUUID(),
        name: `@${clean}/`,
        mediaType: 'text/plain',
        kind: 'text',
        data: `Contents of folder ${clean}/ (${files.length} file(s)):\n${body}`,
        hidden: true,
      }
    }
    let content = await fsp.readFile(abs, 'utf8')
    let name = clean
    if (m.startLine && m.startLine > 0) {
      const lines = content.split('\n')
      const s = m.startLine
      const e = m.endLine && m.endLine >= s ? m.endLine : s
      content = lines.slice(s - 1, e).join('\n')
      name = `${clean}:L${s}${e !== s ? '-' + e : ''}`
    }
    if (content.length > 200_000) content = content.slice(0, 200_000) + '\n… (truncated)'
    return {
      type: 'file',
      id: randomUUID(),
      name: `@${name}`,
      mediaType: 'text/plain',
      kind: 'text',
      data: content,
      hidden: true,
    }
  } catch {
    return null
  }
}

/**
 * Model metadata with the EFFECTIVE WINDOW resolved by precedence: `clamp(userLimit, ceiling)`, where
 * `ceiling = providerWindow (/models/runtime) ?? modelsDevWindow`. Pricing requires an exact host→provider models.dev match;
 * custom/proxy retains capabilities but has unknown pricing. No providerId → canonical metadata (compat). Also powers
 * auto-compact to keep them aligned. Returns raw sources too (so the UI can show the actual ceiling).
 */
async function effectiveModelMeta(
  modelId: string,
  providerId?: string,
  signal?: AbortSignal
): Promise<{ meta: ChatModelMeta | null; providerWindow?: number; catalogWindow?: number; limit?: number }> {
  signal?.throwIfAborted()
  if (!providerId) {
    const canonical = await getModelMeta(modelId)
    signal?.throwIfAborted()
    return { meta: canonical, catalogWindow: canonical?.contextWindow }
  }

  const canonical = await getModelMeta(modelId)
  signal?.throwIfAborted()
  const subscriptionAccount = subscriptionAccountId(providerId)

  if (isCodexSubscriptionProvider(providerId)) {
    const manager = getCodexSubscriptionManager(subscriptionAccount)
    const codexModel = (await manager.listModels().catch(() => [])).find(
      (model) => model.id === modelId || model.model === modelId
    )
    const catalogWindow = canonical?.contextWindow
    // models.dev describes the public API (currently advertising up to 1.1M), not the Codex subscription product.
    // For this provider, only the runtime's dynamic catalog metadata can define the denominator.
    const limit = getContextLimit(providerId, modelId)
    const initialContext = resolveCodexContextWindow({ model: codexModel, userLimit: limit })
    const observed =
      initialContext.requestedNominal != null
        ? manager.getObservedModelContextWindowObservation?.(modelId, initialContext.requestedNominal)
        : undefined
    const resolvedContext = resolveCodexContextWindow({
      model: codexModel,
      userLimit: limit,
      sameRequestObservation: observed,
    })
    // This is nominal by design: the popover's value is exactly what we send as `model_context_window`.
    const providerWindow = resolvedContext.maxNominal ?? undefined
    const effective = resolvedContext.effectiveEstimate ?? undefined
    const reasoningEfforts = codexModel?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) ?? []
    const astraProfileActive =
      resolveModelHarnessProfile({
        providerKind: 'codex-subscription',
        modelId: codexModel?.model ?? modelId,
        astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
      }).id === 'openai-gpt-6-astra-v1'
    const nativeUltraMode = Boolean(
      codexModel?.supportedReasoningEfforts?.some(
        (option) =>
          option.reasoningEffort === 'ultra' && (astraProfileActive || /delegat|subagent/i.test(option.description))
      )
    )
    const fastModeCapability = Boolean(
      codexModel &&
        ((codexModel.serviceTiers ?? []).some(
          (tier) =>
            tier.id.toLowerCase() === 'priority' ||
            tier.id.toLowerCase() === 'fast' ||
            tier.name.toLowerCase() === 'fast'
        ) ||
          /^(priority|fast)$/i.test(codexModel.defaultServiceTier ?? '') ||
          (codexModel.legacySpeedTiers ?? []).some((tier) => /^(priority|fast)$/i.test(tier)))
    )
    const canonicalFields = canonical ? { ...canonical } : {}
    // Prevent the spread from reintroducing the public API window before the runtime cache exists.
    delete canonicalFields.contextWindow
    // Even when both catalogs are temporarily unavailable, expose the explicit false so the generic meter does
    // not infer editability from an omitted metadata object.
    const meta: ChatModelMeta = {
      ...canonicalFields,
      ...(effective != null ? { contextWindow: effective } : {}),
      ...(reasoningEfforts.length ? { reasoning: true, reasoningEfforts } : {}),
      // Without a runtime-published nominal maximum the existing popover must stay locked; models.dev is
      // informational only for Codex Subscription and cannot authorize a synthetic 1M request.
      contextLimitEditable: resolvedContext.configurable,
      ...(codexModel
        ? {
            vision: (codexModel.inputModalities ?? []).includes('image'),
            chatCapable: true,
            fastModeCapability,
            nativeUltraMode,
          }
        : {}),
    }
    return { meta, providerWindow, catalogWindow, limit }
  }

  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const copilotModel = (
      await getGitHubCopilotSubscriptionManager(subscriptionAccount)
        .listModels()
        .catch(() => [])
    ).find((model) => model.id === modelId)
    const catalogWindow = canonical?.contextWindow
    const providerWindow = copilotModel?.capabilities.limits.max_context_window_tokens || undefined
    const effective = resolveContextWindow({ providerWindow })
    const canonicalFields = canonical ? { ...canonical } : {}
    delete canonicalFields.contextWindow
    const reasoningEfforts = copilotModel?.supportedReasoningEfforts ?? []
    const meta: ChatModelMeta | null =
      canonical || copilotModel
        ? {
            ...canonicalFields,
            ...(effective ? { contextWindow: effective } : {}),
            ...(copilotModel
              ? {
                  reasoning: copilotModel.capabilities.supports.reasoningEffort,
                  ...(reasoningEfforts.length ? { reasoningEfforts: [...reasoningEfforts] } : {}),
                  vision: copilotModel.capabilities.supports.vision,
                  chatCapable: true,
                  fastModeCapability: false,
                  nativeUltraMode: false,
                  contextLimitEditable: false,
                }
              : {}),
          }
        : null
    return { meta, providerWindow, catalogWindow }
  }

  if (isClaudeSubscriptionProvider(providerId)) {
    const manager = getClaudeSubscriptionManager(subscriptionAccount)
    const claudeModels = await manager.listModels(signal).catch(() => {
      signal?.throwIfAborted()
      return []
    })
    signal?.throwIfAborted()
    const claudeModel = claudeModels.find((model) => model.value === modelId || model.resolvedModel === modelId)
    const catalogWindow = canonical?.contextWindow
    const providerWindow =
      manager.getObservedModelContextWindow(modelId) ??
      (claudeModel?.resolvedModel ? manager.getObservedModelContextWindow(claudeModel.resolvedModel) : undefined)
    const effective = resolveContextWindow({ providerWindow, catalogWindow })
    const canonicalFields = canonical ? { ...canonical } : {}
    delete canonicalFields.contextWindow
    // The harness reports ALIASES (`opus[1m]`, `fable`), while models.dev indexes concrete IDs → canonical metadata lacks
    // pricing, leaving catalog-priced portions (without native cost) unpriceable. Inject ONLY pricing from the equivalent
    // anthropic entry; retain the observed/canonical window (the latest family
    // advertises 1M, which would inflate a 200k alias's denominator).
    const harnessPricing = hasUsagePricing(canonicalFields)
      ? null
      : await getClaudeHarnessModelMeta(claudeModel?.resolvedModel ?? modelId)
    signal?.throwIfAborted()
    const pricingFields: Pick<ChatModelMeta, 'inputPer1M' | 'outputPer1M' | 'cacheReadPer1M' | 'cacheWritePer1M'> =
      harnessPricing
        ? {
            ...(harnessPricing.inputPer1M != null ? { inputPer1M: harnessPricing.inputPer1M } : {}),
            ...(harnessPricing.outputPer1M != null ? { outputPer1M: harnessPricing.outputPer1M } : {}),
            ...(harnessPricing.cacheReadPer1M != null ? { cacheReadPer1M: harnessPricing.cacheReadPer1M } : {}),
            ...(harnessPricing.cacheWritePer1M != null ? { cacheWritePer1M: harnessPricing.cacheWritePer1M } : {}),
          }
        : {}
    const reasoningEfforts = claudeModel?.supportedEffortLevels ?? []
    const meta: ChatModelMeta | null =
      canonical || claudeModel || hasUsagePricing(pricingFields)
        ? {
            ...canonicalFields,
            ...pricingFields,
            ...(effective ? { contextWindow: effective } : {}),
            ...(claudeModel
              ? {
                  reasoning:
                    claudeModel.supportsEffort === true ||
                    claudeModel.supportsAdaptiveThinking === true ||
                    reasoningEfforts.length > 0,
                  ...(reasoningEfforts.length ? { reasoningEfforts: [...reasoningEfforts] } : {}),
                  vision: true,
                  chatCapable: true,
                  fastModeCapability: claudeModel.supportsFastMode === true,
                  nativeUltraMode: false,
                  contextLimitEditable: false,
                }
              : {}),
          }
        : null
    return { meta, providerWindow, catalogWindow }
  }

  if (isGrokSubscriptionProvider(providerId)) {
    const grokModel = (
      await getGrokSubscriptionManager(subscriptionAccount)
        .listModels()
        .catch(() => [])
    ).find((model) => model.id === modelId)
    const catalogWindow = canonical?.contextWindow
    const providerWindow = grokModel?.contextWindow
    const effective = resolveContextWindow({ providerWindow, catalogWindow })
    const canonicalFields = canonical ? { ...canonical } : {}
    delete canonicalFields.contextWindow
    const reasoningFields = grokReasoningMeta(modelId, canonical)
    const meta: ChatModelMeta | null =
      canonical || grokModel || Object.keys(reasoningFields).length
        ? {
            ...canonicalFields,
            ...reasoningFields,
            ...(effective ? { contextWindow: effective } : {}),
            ...(grokModel
              ? {
                  chatCapable: true,
                  // xAI Priority Processing (`service_tier: "priority"`) — opt-in via toggle Fast.
                  fastModeCapability: true,
                  contextLimitEditable: false,
                }
              : {}),
          }
        : null
    return { meta, providerWindow, catalogWindow }
  }

  const provider = getProvider(providerId)
  const catalogProviderId = provider ? catalogProviderForBaseURL(provider.baseURL) : null
  // The same precedence powers the main selector and profiles: exact provider → canonical model ID.
  const baseMeta = await getProviderModelMeta(modelId, catalogProviderId)
  const catalogWindow = baseMeta?.contextWindow
  const providerWindow = await fetchModelWindow(providerId, modelId).catch(() => undefined)
  const limit = getContextLimit(providerId, modelId)
  const effective = resolveContextWindow({ limit, providerWindow, catalogWindow })
  const outMeta = baseMeta
    ? { ...baseMeta, contextWindow: effective }
    : effective != null
      ? ({ contextWindow: effective } as ChatModelMeta)
      : null
  if (outMeta?.reasoningEfforts?.includes('ultra')) {
    try {
      if (
        resolveChatHarnessMetadata(providerId, modelId, {
          astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
        }).modelHarnessProfileId === 'openai-gpt-6-astra-v1'
      ) {
        outMeta.nativeUltraMode = true
      }
    } catch {
      // Missing provider metadata already degrades through the normal selector path.
    }
  }
  return { meta: outMeta, providerWindow, catalogWindow, limit }
}

interface ContextPreflightResult {
  ok: boolean
  compacted: boolean
  error?: 'context-overflow' | 'context-compaction-failed'
}

/** Target-specific guard. It runs before the pending user message is persisted. */
async function preflightContext(
  conversationId: string,
  selection: ChatModelRef,
  pendingParts: readonly MessagePart[],
  operation: PendingConversationOperation,
  signal: AbortSignal,
  /** Physical Codex window; `undefined` means use the logical provider metadata path. */
  physicalContextWindow?: number | null,
  claudeFailoverChain?: readonly string[],
  physicalClaudeProviderId?: string,
  claudeExecutionAxes?: Pick<ClaudeRuntimeTarget, 'reasoningEffort' | 'fastMode'>
): Promise<ContextPreflightResult> {
  const hasPhysicalContextWindow = physicalContextWindow !== undefined
  const { meta } = hasPhysicalContextWindow
    ? { meta: null }
    : await effectiveModelMeta(selection.modelId, selection.providerId, signal)
  if (isClaudeSubscriptionProvider(selection.providerId) && getClaudeSessionBinding(conversationId)) {
    const conv = getConversation(conversationId)
    const binding = getClaudeSessionBinding(conversationId)!
    const manager = getClaudeSubscriptionManager(binding.accountId)
    const status = manager.getStatusSnapshot()
    const models = await manager.listModels(signal).catch(() => {
      signal.throwIfAborted()
      return []
    })
    signal.throwIfAborted()
    const model = models.find(
      (candidate) => candidate.value === selection.modelId || candidate.resolvedModel === selection.modelId
    )
    if (conv && status?.authenticated && status.accountFingerprint && model) {
      const axes = claudeRuntimeAxes(conversationId, model)
      const compatible = await inspectClaudeSessionCompatibility({
        conversationId,
        projectId: conv.workspaceId,
        cwd: conv.cwd,
        selection,
        resolvedModelId: model.resolvedModel ?? model.value,
        mode: behaviorFor(conversationId),
        permMode: permModeFor(conversationId),
        ...axes,
        manager,
        accountIdentity: {
          fingerprint: status.accountFingerprint,
          epoch: status.accountEpoch,
        },
        broker: getBroker(),
        questionBroker: getQuestionBroker(),
        signal,
      }).catch(() => false)
      if (!compatible) await deleteClaudeSessionForConversation(conversationId)
    }
  }
  const window = hasPhysicalContextWindow ? (physicalContextWindow ?? undefined) : meta?.contextWindow
  if (!window) return { ok: true, compacted: false }
  const pending = estimatePortablePartsTokens(pendingParts) + 16
  const projection = (await currentChatHistoryStats(conversationId, physicalClaudeProviderId)).contextProjection
  const before = projection?.usedTokens ?? 0
  const source = projection?.source ?? 'portable-transcript'
  const load = preflightContextLoad(window, before, pending, source, AUTO_COMPACT_RATIO)
  if (!load.shouldCompact) return { ok: true, compacted: false }

  const compacted = await compactReserved(conversationId, {
    allowActive: true,
    signal,
    contextWindow: window,
    operation,
    claudeFailoverChain,
    claudeExecutionAxes,
  })
  if (!compacted.ok) {
    // Automatic compaction failed AND preflight required it (shouldCompact): do NOT admit the
    // turn — proceeding near the custom limit only postpones overflow with repeated silent failures.
    chatDiag({
      kind: 'preflight-compact-failed',
      conv: conversationId,
      provider: selection.providerId,
      model: selection.modelId,
      effectiveWindow: window,
      usedTokens: before,
      pendingTokens: pending,
      reserveTokens: load.reserveTokens,
      requiredTokens: load.requiredTokens,
      ratio: load.ratio,
      source,
      overflow: load.overflow,
      admitted: false,
      error: compacted.error ?? 'unknown',
    })
    return { ok: false, compacted: false, error: 'context-compaction-failed' }
  }
  const afterProjection = (await currentChatHistoryStats(conversationId, physicalClaudeProviderId)).contextProjection
  const after = afterProjection?.usedTokens ?? 0
  const afterSource = afterProjection?.source ?? 'portable-transcript'
  if (preflightContextLoad(window, after, pending, afterSource, AUTO_COMPACT_RATIO).overflow) {
    return { ok: false, compacted: true, error: 'context-overflow' }
  }
  return { ok: true, compacted: true }
}

/** ISOLATED review-loop preflight: frozen model window + pending + harness reserve
 * (execution history starts empty). Never compacts or inspects/retires the conversation binding. */
async function preflightIsolatedContext(
  conversationId: string,
  selection: FrozenChatSelection,
  pendingParts: readonly MessagePart[],
  signal: AbortSignal
): Promise<ContextPreflightResult> {
  const { meta } = await effectiveModelMeta(selection.modelId, selection.providerId, signal)
  const window = meta?.contextWindow
  if (!window) return { ok: true, compacted: false }
  const pending = estimatePortablePartsTokens(pendingParts) + 16
  // Isolated round: load = 0 (own history still empty) + pending + full harness reserve.
  const load = preflightContextLoad(window, 0, pending, 'portable-transcript', AUTO_COMPACT_RATIO)
  if (load.overflow) {
    chatDiag({
      kind: 'preflight-isolated-overflow',
      conv: conversationId,
      provider: selection.providerId,
      model: selection.modelId,
      effectiveWindow: window,
      usedTokens: 0,
      pendingTokens: pending,
      reserveTokens: load.reserveTokens,
      requiredTokens: load.requiredTokens,
      ratio: load.ratio,
      source: 'portable-transcript',
      overflow: true,
      admitted: false,
    })
    return { ok: false, compacted: false, error: 'context-overflow' }
  }
  return { ok: true, compacted: false }
}

/** Stats recognize an opaque marker only when the same identity will actually be used in the next request.
 * INTERNAL to main: `lastUsage` may contain `contextIdentity`. Project through `toPublicChatHistoryStats` for IPC. */
async function currentChatHistoryStats(
  conversationId: string,
  physicalClaudeProviderId?: string
): Promise<StoredChatHistoryStats> {
  const selection = selectionFor(conversationId)
  // Binding lastMessageId / portable projection: MAIN context only (isolated rounds do not invalidate resume
  // or inflate the reseed/preflight projection).
  const history = listConversationContextMessages(conversationId)
  const latestMessage = lastConversationContextMessage(conversationId)
  let stats: StoredChatHistoryStats
  let runtimeReusable = false
  let runtimeWindowReusable = false
  let usesNativeSeedProjection = false
  if (isCodexSubscriptionProvider(selection?.providerId)) {
    usesNativeSeedProjection = true
    const binding = getCodexThreadBinding(conversationId)
    const conv = getConversation(conversationId)
    const projectContext = await buildProjectContext(conv?.workspaceId ?? '', conv?.cwd ?? '')
    const instructionHash = createHash('sha256').update(projectContext).digest('hex')
    runtimeReusable = !!(
      binding &&
      binding.lastMessageId === latestMessage?.id &&
      binding.instructionHash === instructionHash &&
      binding.accountId === subscriptionAccountId(selection?.providerId)
    )
    // `thread/resume` accepts a model override. Measured occupancy remains valid within the thread, but the window
    // reported by the previous model does not: after a switch, the renderer uses target metadata until fresh usage arrives.
    runtimeWindowReusable = runtimeReusable && binding?.modelId === selection?.modelId
    stats = chatHistoryStats(conversationId, {
      // The visual marker represents a real boundary only while linked to the native Codex thread.
      // If the binding disappears/changes account, history reverts to the bounded portable reseed projection.
      isNativeCompactionActive: (messageId) => runtimeReusable && binding?.lastMessageId === messageId,
    })
    if (runtimeWindowReusable && stats.lastUsage?.modelContextWindow && selection) {
      try {
        // Thread occupancy remains valid, but the persisted denominator applies only to the currently requested
        // nominal limit. This also covers manual limit changes without switching model/provider.
        const current = await effectiveModelMeta(selection.modelId, selection.providerId)
        runtimeWindowReusable = current.meta?.contextWindow === stats.lastUsage.modelContextWindow
      } catch {
        // If the current effective window cannot be confirmed, retain measured occupancy but omit the denominator.
        runtimeWindowReusable = false
      }
    }
  } else if (isGitHubCopilotSubscriptionProvider(selection?.providerId)) {
    usesNativeSeedProjection = true
    const binding = getGitHubCopilotSessionBinding(conversationId)
    const identity = getGitHubCopilotSubscriptionManager(
      subscriptionAccountId(selection?.providerId)
    ).getAccountIdentity()
    runtimeReusable = !!(
      binding &&
      binding.lastMessageId === latestMessage?.id &&
      binding.modelId === selection?.modelId &&
      binding.accountFingerprint === identity.fingerprint
    )
    runtimeWindowReusable = runtimeReusable
    stats = chatHistoryStats(conversationId, {
      isNativeCompactionActive: (messageId) => runtimeReusable && binding?.lastMessageId === messageId,
    })
  } else if (isClaudeSubscriptionProvider(selection?.providerId)) {
    usesNativeSeedProjection = true
    const binding = getClaudeSessionBinding(conversationId)
    const manager = getClaudeSubscriptionManager(
      binding ? binding.accountId : subscriptionAccountId(selection?.providerId)
    )
    const identity = manager.getStatusSnapshot()
    const physicalProviderId = subscriptionProviderIdFor(
      'claude-subscription',
      binding ? binding.accountId : subscriptionAccountId(selection?.providerId)
    )
    const eligible =
      freezeFailoverChain(selection!.providerId).includes(physicalProviderId) &&
      getSubscriptionFailoverRouter().isAdmissible(physicalProviderId)
    runtimeReusable = !!(
      binding &&
      binding.lastMessageId === latestMessage?.id &&
      eligible &&
      (!physicalClaudeProviderId || physicalClaudeProviderId === physicalProviderId) &&
      identity?.available !== false &&
      identity?.authenticated &&
      binding.modelId === manager.getResolvedModelId(selection?.modelId ?? '') &&
      binding.accountFingerprint === identity?.accountFingerprint &&
      binding.accountEpoch === identity?.accountEpoch
    )
    runtimeWindowReusable = runtimeReusable
    stats = chatHistoryStats(conversationId, {
      isNativeCompactionActive: (messageId) => runtimeReusable && binding?.lastMessageId === messageId,
    })
  } else {
    stats = chatHistoryStats(conversationId)
    runtimeReusable = !!(
      selection?.providerId &&
      selection.modelId &&
      stats.lastUsage &&
      stats.lastModel?.providerId === selection.providerId &&
      stats.lastModel.modelId === selection.modelId &&
      latestMessage?.model?.providerId === selection.providerId &&
      latestMessage.model.modelId === selection.modelId
    )
    if (runtimeReusable) {
      try {
        const resolved = resolveChatModel(selection!.providerId, selection!.modelId, {
          astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
        })
        runtimeReusable = stats.lastUsage?.contextIdentity === resolved.providerFingerprint
        if (
          runtimeReusable &&
          getAppFlag('chat.openAIHarness', true) &&
          isOpenAIHarnessActive(true, resolved.harnessProfile)
        ) {
          const state = getOpenAIInferenceState(latestMessage!.id)
          runtimeReusable = !!(
            state &&
            canReplayOpenAIInferenceState(state, {
              providerId: selection!.providerId,
              modelId: selection!.modelId,
              providerFingerprint: resolved.providerFingerprint,
              modelHarnessProfileId: resolved.modelHarnessProfileId,
            })
          )
        }
      } catch {
        runtimeReusable = false
      }
    }
    runtimeWindowReusable = runtimeReusable
  }

  const hasReusableUsage = runtimeReusable && stats.lastUsage !== null
  const usedTokens =
    hasReusableUsage && stats.lastUsage
      ? contextOccupancy(stats.lastUsage)
      : usesNativeSeedProjection
        ? estimateNativeSeedContextTokens(history)
        : estimatePortableContextTokens(history)
  return {
    ...stats,
    contextProjection: {
      usedTokens,
      source: hasReusableUsage ? 'runtime-usage' : 'portable-transcript',
      quality: hasReusableUsage ? 'measured' : 'estimated',
      ...(hasReusableUsage && runtimeWindowReusable && stats.lastUsage?.modelContextWindow
        ? { modelContextWindow: stats.lastUsage.modelContextWindow }
        : {}),
    },
  }
}

/** Internal send options (used by plan decision turns; not exposed to user IPC). */
interface StartSendOpts {
  /** Marks the user message internal (sent to the model, but the renderer does NOT draw a bubble). */
  internal?: boolean
  /** Extra HIDDEN parts (e.g. review-loop findings) — sent to the model, not rendered. */
  hiddenParts?: MessagePart[]
  /** Reservation already acquired by a compound operation (e.g. resend/server-side selection). */
  operation?: PendingConversationOperation
  /** Internal REVIEW LOOP turn: frozen selection + conversation lock + handle created at admission. */
  internalLoop?: {
    executionId: string
    loopId: string
    iteration: number
    maxIterations: number
    role: ReviewLoopRole
    turnPolicy: ReviewLoopTurnPolicy
    source: ReviewLoopSource
    cwdActivityOwner?: string
    reviewerRuntime?: ReviewerToolRuntime
    executorConversationId?: string
    reviewerConversationId?: string
    selectionOverride: FrozenChatSelection
    /** Execution-isolated context (does not use/compose the main transcript). */
    contextPolicy: 'isolated'
    /** Ephemeral provider-native session (does not resume/persist the conversation binding). */
    providerSessionPolicy: 'ephemeral'
    /** JOB abort (Stop): the admission barrier rejects a turn aborted during preflight. */
    signal: AbortSignal
    onAdmitted: (run: ActiveRun) => void
  }
  /** Review-turn callback; releases the reservation if no v2 is accepted. */
  onComplete?: (result: { planSubmitted: boolean; outcome: 'success' | 'error' | 'cancelled' }) => void
}

async function startSend(
  deps: ChatIpcDeps,
  wc: WebContents,
  conversationId: string,
  text: string,
  attachments?: ChatAttachmentInput[],
  opts?: StartSendOpts,
  agentMentions?: readonly StructuredAgentMentionDraft[]
): Promise<{ ok: boolean; error?: string }> {
  if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
  const atts = Array.isArray(attachments) ? attachments : []
  const hiddenParts = opts?.hiddenParts ?? []
  if ((typeof text !== 'string' || !text.trim()) && atts.length === 0 && hiddenParts.length === 0)
    return { ok: false, error: 'empty' }
  const conv = getConversation(conversationId)
  if (!conv) return { ok: false, error: 'invalid-conversation' }

  // COMPANION AUTOMATION LOCK (central guard): while review/bootstrap is active, only its owning internal turn
  // passes. Covers chat:send, resend, plans, and server-side starts — all enter here.
  const internalLoop = opts?.internalLoop
  const internalTurnMode = internalLoop?.turnPolicy === 'reviewer-readonly' ? ('ask' as const) : ('agent' as const)
  const turnBehavior: ChatBehavior = internalLoop ? internalTurnMode : behaviorFor(conversationId)
  const maestroTurn = turnBehavior === 'maestro' ? freezeMaestroTurn(conversationId) : undefined
  const reviewLoopLock = reviewLoopLockForConversation(conversationId)
  const environmentLock = chatGptWeb.projectEnvironmentLockFor(conversationId)
  if (reviewLoopLock) {
    if (!internalLoop || internalLoop.loopId !== reviewLoopLock) return { ok: false, error: 'review-loop-active' }
  } else if (environmentLock) {
    if (!internalLoop || internalLoop.loopId !== environmentLock) {
      return { ok: false, error: 'project-environment-active' }
    }
  } else if (internalLoop) {
    // The loop owning this internal turn was cancelled/ended before admission.
    return { ok: false, error: 'review-loop-inactive' }
  }

  // Resolve provider/model. BYOK requires a key; the built-in provider requires a valid ChatGPT session in the
  // official runtime. If no model is chosen, both auto-select the default/first and persist it in the conversation.
  // Internal review-loop turn: FROZEN selection, without auto-selection or persistence (no fallback).
  let selection = internalLoop
    ? { providerId: internalLoop.selectionOverride.providerId, modelId: internalLoop.selectionOverride.modelId }
    : selectionFor(conversationId)
  if (!selection?.providerId) return { ok: false, error: 'no-provider' }
  if (internalLoop && !selection.modelId) return { ok: false, error: 'no-model' }
  const operation = reserveConversationOperation(conversationId, selection.providerId, opts?.operation)
  if (!operation) return { ok: false, error: 'busy' }
  // Compound operations may reserve the slot before switching provider/model.
  // From here, the label must reflect the provider that will actually start for account boundaries.
  operation.providerId = selection.providerId
  const accountEpochAtAdmission = codexAccountUpdateEpoch
  let githubCopilotIdentityAtAdmission: GitHubCopilotAccountIdentity | undefined
  let githubCopilotModelAtAdmission: GitHubCopilotModelInfo | undefined
  let claudeIdentityAtAdmission: ClaudeSubscriptionAccountIdentity | undefined
  let claudeModelAtAdmission: ClaudeModelInfo | undefined
  const claudeFailoverChain = isClaudeSubscriptionProvider(selection.providerId)
    ? internalLoop
      ? [selection.providerId]
      : freezeFailoverChain(selection.providerId)
    : []
  const claudeRequestedEffort =
    internalLoop?.selectionOverride.reasoning ?? getConvUiPrefs(conversationId).chat?.reasoning
  const claudeRequestedFast = internalLoop
    ? internalLoop.selectionOverride.fastMode === true
    : getConvUiPrefs(conversationId).chat?.fastMode === true
  let claudeRuntimeTarget: ClaudeRuntimeTarget | undefined
  let claudeRuntimeLeaseTransferred = false
  const settleClaudeRuntimeLeaseIfUnowned = (): void => {
    if (claudeRuntimeLeaseTransferred || !claudeRuntimeTarget?.availabilityLease) return
    getSubscriptionFailoverRouter().confirmAttemptOther(
      claudeRuntimeTarget.providerId,
      claudeRuntimeTarget.availabilityLease
    )
    claudeRuntimeLeaseTransferred = true
  }
  const claudeAdmissionError = (
    result: Exclude<Awaited<ReturnType<typeof resolveClaudeRuntimeTarget>>, { ok: true }>
  ): string => {
    if (result.error === 'aborted') return 'busy'
    if (result.reason === 'quota-exhausted') return 'claude-accounts-exhausted'
    if (result.reason === 'not-authenticated') return 'no-key'
    if (result.reason === 'incompatible') return 'no-model'
    return 'unavailable'
  }
  let grokIdentityAtAdmission: GrokAccountIdentity | undefined
  let releaseCwdActivity: (() => void) | null = null
  let admittedRun: ActiveRun | null = null
  let codexRuntimeTarget: CodexRuntimeTarget | null = null
  let codexRuntimeLeaseTransferred = false
  let codexFailoverChain: string[] | null = null
  const settleCodexRuntimeLeaseIfUnowned = (): void => {
    if (codexRuntimeLeaseTransferred || !codexRuntimeTarget?.availabilityLease) return
    codexRuntimeLeaseTransferred = true
    getSubscriptionFailoverRouter().confirmAttemptOther(
      codexRuntimeTarget.providerId,
      codexRuntimeTarget.availabilityLease
    )
  }
  const releaseCwdActivityOnce = () => {
    const release = releaseCwdActivity
    releaseCwdActivity = null
    release?.()
  }
  // SIDECAR OWNERSHIP (declared at function scope for the final finally): artifacts written in
  // startSend belong to the NOT-YET-persisted user message. Any exit before message upsert
  // (preflight/admission/busy return, invalid attachment, interpreter exception) would leave files
  // without an owner row — finally removes those CREATED here until `messageDurable`. After upsert, ownership
  // transfers and nothing is deleted. REUSED artifactIds (from renderer `a.artifactId`) never
  // enter createdArtifactIds and remain untouched.
  const createdArtifactIds: string[] = []
  let messageDurable = false
  try {
    const useCodexSubscription = isCodexSubscriptionProvider(selection.providerId)
    const useGitHubCopilot = isGitHubCopilotSubscriptionProvider(selection.providerId)
    const useClaudeSubscription = isClaudeSubscriptionProvider(selection.providerId)
    const useGrokSubscription = isGrokSubscriptionProvider(selection.providerId)
    // Grok uses the generic AI SDK runner — never mark it official or it would skip runChat.
    const useOfficialSubscription = useCodexSubscription || useGitHubCopilot || useClaudeSubscription
    // Conversation subscription account slot (null = default). Global transition/login state machines govern
    // only the default account; additional slots have their own boundaries (explicit reset on login/removal).
    const selectionAccountId = subscriptionAccountId(selection.providerId)
    if (useCodexSubscription) {
      if (!selectionAccountId && codexIdentityTransitionPending) return { ok: false, error: 'no-key' }
      // Status/configuration is passive and installs no components. Sending explicitly uses the provider:
      // ensure its runtime before probing identity, so a missing/outdated installation does not become
      // `no-key`. ensureRuntimeAsset neither touches CODEX_HOME nor starts OAuth; the same slot is revalidated below.
      await ensurePackagedProviderAsset('codex-runtime', operation.controller.signal)
      const status = await codexAuthStatus(true, operation, selectionAccountId)
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (codexIdentityTransitionPending || accountEpochAtAdmission !== codexAccountUpdateEpoch))
      )
        return { ok: false, error: 'busy' }
      // With a failover chain, the logical account may be unavailable; resolveCodexRuntimeTarget decides.
      const earlyChain = freezeFailoverChain(selection.providerId)
      if (!status.authenticated && earlyChain.length <= 1) return { ok: false, error: 'no-key' }
    } else if (useGitHubCopilot) {
      if (!selectionAccountId && (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise)) {
        return { ok: false, error: 'no-key' }
      }
      // As with Codex, admission is the boundary that may install/update the component. The token store
      // stays intact; getStatus(true) below probes the same identity again once the runtime is available.
      await ensurePackagedProviderAsset('github-copilot-runtime', operation.controller.signal)
      const manager = getGitHubCopilotSubscriptionManager(selectionAccountId)
      const status = await githubCopilotAuthStatus(true, selectionAccountId)
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (githubCopilotLoginPending || !!githubCopilotIdentityTransitionPromise))
      ) {
        return { ok: false, error: 'busy' }
      }
      if (!status.authenticated) return { ok: false, error: 'no-key' }
      githubCopilotIdentityAtAdmission = manager.getAccountIdentity()
      if (!githubCopilotIdentityAtAdmission.fingerprint) return { ok: false, error: 'no-key' }
      manager.assertAccountIdentity(githubCopilotIdentityAtAdmission)
      // Policy is an admission contract, not a late runtime error. Refresh the official catalog before the
      // user message is persisted, and fail closed for unknown/disabled IDs (including manually entered IDs).
      const models = await manager.listModels(true)
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (githubCopilotLoginPending || !!githubCopilotIdentityTransitionPromise))
      ) {
        return { ok: false, error: 'busy' }
      }
      manager.assertAccountIdentity(githubCopilotIdentityAtAdmission)
      if (!selection.modelId) {
        const modelId = models.find((model) => model.policy?.state !== 'disabled')?.id ?? ''
        if (!modelId) return { ok: false, error: 'no-model' }
        selection = { providerId: selection.providerId, modelId }
        patchConvChat(conversationId, { providerId: selection.providerId, modelId })
      }
      const selectedGitHubCopilotModelId = selection?.modelId ?? ''
      githubCopilotModelAtAdmission = models.find((model) => model.id === selectedGitHubCopilotModelId)
      if (!githubCopilotModelAtAdmission || githubCopilotModelAtAdmission.policy?.state === 'disabled') {
        return { ok: false, error: 'no-model' }
      }
    } else if (useClaudeSubscription) {
      if (claudeFailoverChain.length > 1) {
        if (!selection.modelId) {
          for (const providerId of claudeFailoverChain) {
            if (
              claudePhysicalIdentityIsChanging(providerId) ||
              !getSubscriptionFailoverRouter().isAdmissible(providerId)
            )
              continue
            const manager = getClaudeSubscriptionManager(subscriptionAccountId(providerId))
            const status = await manager.status()
            if (!status.authenticated || !status.accountFingerprint) continue
            const modelId = (await manager.listModels(operation.controller.signal))[0]?.value
            if (!modelId) continue
            selection = { providerId: selection.providerId, modelId }
            patchConvChat(conversationId, { providerId: selection.providerId, modelId: selection.modelId })
            break
          }
          if (!selection.modelId) return { ok: false, error: 'no-model' }
        }
        const resolved = await resolveClaudeRuntimeTarget({
          logicalProviderId: selection.providerId,
          modelId: selection.modelId,
          reasoningEffort: claudeRequestedEffort,
          fastMode: claudeRequestedFast,
          chain: claudeFailoverChain,
          attemptedProviderIds: new Set(claudeFailoverChain.filter(claudePhysicalIdentityIsChanging)),
          admit: false,
          signal: operation.controller.signal,
        })
        if (!resolved.ok) return { ok: false, error: claudeAdmissionError(resolved) }
        claudeRuntimeTarget = resolved.target
        settleClaudeRuntimeLeaseIfUnowned()
        claudeModelAtAdmission = resolved.target.model
        claudeIdentityAtAdmission = resolved.target.accountIdentity
        operation.effectiveProviderId = resolved.target.providerId
      } else {
        if (!selectionAccountId && (claudeLoginPending || claudeIdentityTransitionPromise))
          return { ok: false, error: 'no-key' }
        const manager = getClaudeSubscriptionManager(selectionAccountId)
        const status = await manager.status({ refresh: true })
        if (
          !conversationOperationIsCurrent(conversationId, operation) ||
          (!selectionAccountId && (claudeLoginPending || !!claudeIdentityTransitionPromise))
        )
          return { ok: false, error: 'busy' }
        if (!status.authenticated || !status.accountFingerprint) return { ok: false, error: 'no-key' }
        claudeIdentityAtAdmission = {
          fingerprint: status.accountFingerprint,
          epoch: status.accountEpoch,
        }
        manager.assertAccountIdentity(claudeIdentityAtAdmission)
        const models = await manager.listModels(operation.controller.signal, Boolean(internalLoop))
        if (
          !conversationOperationIsCurrent(conversationId, operation) ||
          (!selectionAccountId && (claudeLoginPending || !!claudeIdentityTransitionPromise))
        )
          return { ok: false, error: 'busy' }
        manager.assertAccountIdentity(claudeIdentityAtAdmission)
        if (!selection.modelId) {
          const modelId = models[0]?.value ?? ''
          if (!modelId) return { ok: false, error: 'no-model' }
          selection = { providerId: selection.providerId, modelId }
          patchConvChat(conversationId, {
            providerId: selection.providerId,
            modelId,
          })
        }
        claudeModelAtAdmission = models.find(
          (model) => model.value === selection?.modelId || model.resolvedModel === selection?.modelId
        )
        if (!claudeModelAtAdmission) return { ok: false, error: 'no-model' }
      }
    } else if (useGrokSubscription) {
      if (!selectionAccountId && (grokLoginPending || grokIdentityTransitionPromise)) {
        return { ok: false, error: 'no-key' }
      }
      const manager = getGrokSubscriptionManager(selectionAccountId)
      const status = await grokAuthStatus(true, selectionAccountId)
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (grokLoginPending || !!grokIdentityTransitionPromise))
      ) {
        return { ok: false, error: 'busy' }
      }
      if (!status.authenticated) return { ok: false, error: 'no-key' }
      grokIdentityAtAdmission = manager.getAccountIdentity()
      if (!grokIdentityAtAdmission.fingerprint) return { ok: false, error: 'no-key' }
      manager.assertAccountIdentity(grokIdentityAtAdmission)
      const models = await manager.listModels(true)
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (grokLoginPending || !!grokIdentityTransitionPromise))
      ) {
        return { ok: false, error: 'busy' }
      }
      manager.assertAccountIdentity(grokIdentityAtAdmission)
      if (!selection.modelId) {
        const modelId = models[0]?.id ?? ''
        if (!modelId) return { ok: false, error: 'no-model' }
        selection = { providerId: selection.providerId, modelId }
        patchConvChat(conversationId, { providerId: selection.providerId, modelId })
      }
      if (!models.some((model) => model.id === selection?.modelId)) {
        return { ok: false, error: 'no-model' }
      }
    } else if (!hasApiKey(selection.providerId)) {
      return { ok: false, error: 'no-key' }
    }
    if (!selection.modelId) {
      let modelId = ''
      if (useCodexSubscription) {
        const models = await getCodexSubscriptionManager(selectionAccountId).listModels()
        modelId = (models.find((model) => model.isDefault) ?? models[0])?.id ?? ''
      } else if (useClaudeSubscription) {
        modelId =
          (await getClaudeSubscriptionManager(selectionAccountId).listModels(operation.controller.signal))[0]?.value ??
          ''
      } else if (useGrokSubscription) {
        modelId = (await getGrokSubscriptionManager(selectionAccountId).listModels(true))[0]?.id ?? ''
      } else {
        modelId = (await fetchModels(selection.providerId))[0] ?? ''
      }
      if (!modelId) return { ok: false, error: 'no-model' }
      selection = { providerId: selection.providerId, modelId }
      patchConvChat(conversationId, { providerId: selection.providerId, modelId: selection.modelId })
    }

    if (
      !conversationOperationIsCurrent(conversationId, operation) ||
      (useCodexSubscription &&
        !selectionAccountId &&
        (codexIdentityTransitionPending || accountEpochAtAdmission !== codexAccountUpdateEpoch)) ||
      (useGitHubCopilot &&
        !selectionAccountId &&
        (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise)) ||
      (useClaudeSubscription &&
        !subscriptionAccountId(operation.effectiveProviderId ?? selection.providerId) &&
        (claudeLoginPending || claudeIdentityTransitionPromise)) ||
      (useGrokSubscription && !selectionAccountId && (grokLoginPending || grokIdentityTransitionPromise))
    )
      return { ok: false, error: 'busy' }
    if (useGitHubCopilot && githubCopilotIdentityAtAdmission) {
      getGitHubCopilotSubscriptionManager(selectionAccountId).assertAccountIdentity(githubCopilotIdentityAtAdmission)
    }
    if (useClaudeSubscription && claudeIdentityAtAdmission) {
      ;(claudeRuntimeTarget?.manager ?? getClaudeSubscriptionManager(selectionAccountId)).assertAccountIdentity(
        claudeIdentityAtAdmission
      )
    }
    if (useGrokSubscription && grokIdentityAtAdmission) {
      getGrokSubscriptionManager(selectionAccountId).assertAccountIdentity(grokIdentityAtAdmission)
    }
    releaseCwdActivity = tryAcquireCwdActivity(conv.cwd, 'chat', internalLoop?.cwdActivityOwner)
    if (!releaseCwdActivity) return { ok: false, error: 'cwd-locked' }

    // Start the clock before portable compaction/mention reads, which count toward response time.
    const responseStartedAt = Date.now()
    const parts: MessagePart[] = []
    // `/name args` at message start = skill INVOCATION: a dedicated part (UI chip) with its body
    // ALREADY expanded here (instructions + folder root + inventory). User text retains only the args, and
    // the skill body never appears in the transcript or draft.
    const invocation = parseSkillInvocation(text)
    const invokedSkill = invocation ? await findEffectiveSkill(conv.cwd, conversationId, invocation.name) : null
    let messageText = text
    if (invocation && invokedSkill?.userInvocable) {
      parts.push({
        type: 'skill-invocation',
        id: randomUUID(),
        name: invokedSkill.name,
        ...(invocation.args ? { args: invocation.args } : {}),
        body: renderSkillContext(invokedSkill, { args: invocation.args, invokedBy: 'user' }),
        dir: invokedSkill.dir,
      })
      // Args live ONLY in the skill part (already included in the expanded block) — no duplicate text part.
      messageText = ''
    }
    if (messageText.trim()) parts.push({ type: 'text', id: randomUUID(), text: messageText })
    // STRUCTURED `#agent` mentions (composer chip occurrences): VALIDATED host-side against the
    // final persisted text (`messageText` — the ranges use these same coordinates) and the
    // conversation's EFFECTIVE catalog; never blindly trust the payload. One part per VALID occurrence,
    // preserving id/name/start/end (id identifies the occurrence — two mentions of one agent can coexist).
    // Text detection remains a fallback for manually entered text; these parts are the ONLY
    // deterministic source for the guard (subagent-turn-request).
    if (conv && Array.isArray(agentMentions) && agentMentions.length > 0) {
      const effectiveNames =
        turnBehavior === 'maestro' && maestroTurn
          ? maestroTurn.pool.filter((resource) => resource.enabled).map((resource) => resource.id)
          : (await listEffectiveAgents({ cwd: conv.cwd, conversationId })).map((agent) => agent.name)
      for (const p of buildAgentMentionParts(agentMentions, messageText, effectiveNames)) {
        parts.push(p)
      }
    }

    // Freeze all runtime-selection inputs for this admission. Revalidation may change only the physical
    // account selected from this chain; it must not observe a concurrent model/effort preference change.
    const codexFastMode = useCodexSubscription && getConvUiPrefs(conversationId).chat?.fastMode === true
    const codexRequestedEffort = useCodexSubscription
      ? (internalLoop?.selectionOverride.reasoning ?? getConvUiPrefs(conversationId).chat?.reasoning)
      : undefined
    const frozenCodexChain = useCodexSubscription ? freezeFailoverChain(selection.providerId) : null
    try {
      let imageCount = 0
      let imageBytes = 0
      for (const a of atts) {
        if (!a || (a.kind !== 'image' && a.kind !== 'text')) continue
        if (a.kind === 'text') {
          const data = typeof a.data === 'string' ? a.data : ''
          if (Buffer.byteLength(data, 'utf8') > MAX_ATTACHMENT_TEXT_BYTES) continue
          parts.push({
            type: 'file',
            id: randomUUID(),
            name: a.name || 'file',
            mediaType: a.mediaType || 'text/plain',
            kind: 'text',
            data,
            ...(typeof a.description === 'string' && a.description ? { description: a.description } : {}),
            ...(typeof a.descriptionModel === 'string' && a.descriptionModel
              ? { descriptionModel: a.descriptionModel }
              : {}),
          })
          continue
        }
        if (a.artifactId) {
          parts.push({
            type: 'file',
            id: randomUUID(),
            name: a.name || 'file',
            mediaType: a.mediaType || 'image/png',
            kind: 'image',
            artifactId: a.artifactId,
            byteSize: a.byteSize,
            ...(typeof a.description === 'string' && a.description ? { description: a.description } : {}),
            ...(typeof a.descriptionModel === 'string' && a.descriptionModel
              ? { descriptionModel: a.descriptionModel }
              : {}),
          })
          continue
        }
        const raw = a.bytes ?? a.data
        if (raw == null) continue
        imageCount += 1
        if (imageCount > MAX_ATTACHMENT_IMAGES_PER_MESSAGE) throw new Error('too-many-images')
        const stored = await saveAttachmentImage({
          conversationId,
          bytes: raw,
          label: a.name,
        })
        if (stored.byteSize > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error('image-too-large')
        imageBytes += stored.byteSize
        if (imageBytes > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) throw new Error('images-too-large')
        createdArtifactIds.push(stored.artifactId)
        parts.push({
          type: 'file',
          id: randomUUID(),
          name: a.name || stored.name,
          mediaType: stored.mediaType,
          kind: 'image',
          artifactId: stored.artifactId,
          byteSize: stored.byteSize,
          ...(typeof a.description === 'string' && a.description ? { description: a.description } : {}),
          ...(typeof a.descriptionModel === 'string' && a.descriptionModel
            ? { descriptionModel: a.descriptionModel }
            : {}),
        })
      }
    } catch {
      return { ok: false, error: 'invalid-attachment' }
    }
    // Mentions and extra internal parts enter the projection before any persistence (mentions in skill ARGS
    // also count: the original text is the source).
    for (const m of uniqueMentions(text)) {
      const p = await readMentionPart(conv.cwd, m)
      if (p) parts.push(p)
    }
    for (const p of hiddenParts) parts.push(p)

    const preflightParts: MessagePart[] = parts

    // Isolated = review-loop with its own context (does not touch main conversation transcript/bindings).
    const isolated =
      !!internalLoop && internalLoop.contextPolicy === 'isolated' && internalLoop.providerSessionPolicy === 'ephemeral'
    const frozenProfile = internalLoop?.selectionOverride
    const behaviorRequestedModelId = selection.modelId
    const behaviorProfileFor = (resolvedModelId?: string | null): ClaudeBehaviorProfile | null => {
      const resolution = resolveClaudeBehaviorProfile({
        requestedModelId: behaviorRequestedModelId,
        resolvedModelId,
        fableEnabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
        opusEnabled: getAppFlag(OPUS_5_PROFILE_FLAG, true),
        frozen: isolated && frozenProfile != null,
        frozenProfileId: frozenProfile?.behaviorProfileId,
      })
      if (resolution.reason === 'frozen-profile-mismatch') throw new Error('executor-unavailable')
      return resolution.profile
    }
    const executionScope: ChatExecutionScope | undefined =
      isolated && internalLoop
        ? {
            kind: 'review-loop',
            executionId: internalLoop.executionId,
            loopId: internalLoop.loopId,
            iteration: internalLoop.iteration,
            maxIterations: internalLoop.maxIterations,
            role: internalLoop.role,
            ...(internalLoop.executorConversationId
              ? { executorConversationId: internalLoop.executorConversationId }
              : {}),
            ...(internalLoop.reviewerConversationId
              ? { reviewerConversationId: internalLoop.reviewerConversationId }
              : {}),
          }
        : undefined
    // Findings (user) become internal via opts.internal; the round's assistant bubble is NOT internal
    // (UX/audit with source + reviewLoop). messageMeta does not pass internal to the runner.
    const reviewLoopMessageMeta = executionScope
      ? {
          source: internalLoop!.source,
          executionScope,
          reviewLoop: {
            loopId: executionScope.loopId,
            executionId: executionScope.executionId,
            iteration: executionScope.iteration,
            maxIterations: executionScope.maxIterations,
            ...(executionScope.role ? { role: executionScope.role } : {}),
            ...(executionScope.executorConversationId
              ? { executorConversationId: executionScope.executorConversationId }
              : {}),
            ...(executionScope.reviewerConversationId
              ? { reviewerConversationId: executionScope.reviewerConversationId }
              : {}),
          },
        }
      : undefined
    const runnerMessageMeta = reviewLoopMessageMeta

    // IMAGE INTERPRETER: model without vision + configured interpreter → a vision model describes
    // attachments NOW and caches the description on the part (once per image). Deliberately precedes
    // preflight: the description becomes text that counts toward turn context.
    let imagesDescribed = 0
    const imagesGate = isolated
      ? !!getImageInterpreter() && parts.some((p) => p.type === 'file' && p.kind === 'image' && !p.description)
      : !!getImageInterpreter() && hasImagesToDescribe(conversationId, parts)
    if (imagesGate) {
      const { meta: visionMeta } = await effectiveModelMeta(selection.modelId, selection.providerId).catch(() => ({
        meta: null,
      }))
      const modelSeesImages = supportsChatToolImages({
        modelVision: visionMeta?.vision,
        runtimeImageUnsupported: getConvUiPrefs(conversationId).chat?.imagesUnsupported === true,
      })
      if (!modelSeesImages) {
        const described = await describeConversationImages({
          conversationId,
          cwd: conv.cwd,
          pendingParts: parts,
          signal: operation.controller.signal,
          ...(isolated ? { pendingOnly: true } : {}),
        })
        imagesDescribed = described.described
        if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }
        // Isolated: NEVER retires conversation subscription state (even if historyChanged — pendingOnly prevents it).
        if (!isolated && described.historyChanged) {
          // ALREADY-persisted messages were rewritten with descriptions → native thread/session resume
          // would reuse remote context WITHOUT them (upsert does not change lastMessageId, so the binding would remain
          // "valid"). Retire bindings: the next turn reseeds the full transcript, including descriptions.
          await deleteSubscriptionStateForConversation(conversationId, operation.controller.signal)
          if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }
        }
      }
    }

    const initialClaudeAxes = claudeModelAtAdmission
      ? claudeRuntimeAxes(conversationId, claudeModelAtAdmission, claudeRequestedEffort, claudeRequestedFast, isolated)
      : undefined
    const claudeRuntimeContract =
      internalLoop?.selectionOverride.resolvedModelId ??
      claudeRuntimeTarget?.runtimeModelId ??
      claudeModelAtAdmission?.resolvedModel ??
      claudeModelAtAdmission?.value
    const resolveClaudeTargetForStart = async (admit: boolean) => {
      const resolved = await resolveClaudeRuntimeTarget({
        logicalProviderId: selection!.providerId,
        modelId: selection!.modelId,
        runtimeModelId: claudeRuntimeContract,
        reasoningEffort:
          claudeFailoverChain.length === 1 && !claudeModelAtAdmission?.supportedEffortLevels?.length
            ? undefined
            : initialClaudeAxes?.reasoningEffort,
        fastMode: initialClaudeAxes?.fastMode,
        chain: claudeFailoverChain,
        attemptedProviderIds: new Set(claudeFailoverChain.filter(claudePhysicalIdentityIsChanging)),
        admit,
        signal: operation.controller.signal,
      })
      if (!resolved.ok) return { ok: false as const, error: claudeAdmissionError(resolved) }
      settleClaudeRuntimeLeaseIfUnowned()
      claudeRuntimeTarget = {
        ...resolved.target,
        ...(claudeFailoverChain.length === 1 ? { reasoningEffort: initialClaudeAxes?.reasoningEffort } : {}),
        maestrlyUltra: initialClaudeAxes?.maestrlyUltra ?? resolved.target.maestrlyUltra,
      }
      claudeRuntimeLeaseTransferred = false
      if (!admit) settleClaudeRuntimeLeaseIfUnowned()
      operation.effectiveProviderId = resolved.target.providerId
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        claudePhysicalIdentityIsChanging(resolved.target.providerId)
      )
        return { ok: false as const, error: 'busy' }
      return { ok: true as const, target: claudeRuntimeTarget }
    }
    let smallestClaudeWindow: number | null | undefined
    let preflightedClaudeProviderId: string | undefined
    if (useClaudeSubscription && !isolated) {
      const capability = await resolveClaudeTargetForStart(false)
      if (!capability.ok) return capability
      smallestClaudeWindow = capability.target.contextWindow
      preflightedClaudeProviderId = capability.target.providerId
    }

    const resolveCodexTargetForStart = async (
      admit: boolean
    ): Promise<{ ok: true; target?: CodexRuntimeTarget } | { ok: false; error: string }> => {
      if (!useCodexSubscription) return { ok: true }

      const codexSelection = selection
      if (!codexSelection?.providerId || !codexSelection.modelId) return { ok: false, error: 'no-model' }

      const chain = codexFailoverChain ?? frozenCodexChain ?? freezeFailoverChain(codexSelection.providerId)
      const resolved = await resolveCodexRuntimeTarget({
        logicalProviderId: codexSelection.providerId,
        modelId: codexSelection.modelId,
        reasoningEffort: codexRequestedEffort && codexRequestedEffort !== 'off' ? codexRequestedEffort : undefined,
        astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
        fastMode: codexFastMode,
        configureContextWindow: true,
        chain,
        attemptedProviderIds: new Set(),
        ...(admit ? {} : { admit: false }),
        signal: operation.controller.signal,
      })
      if (!resolved.ok) {
        if (resolved.error === 'aborted') return { ok: false, error: 'busy' }
        if (resolved.reason === 'quota-exhausted') return { ok: false, error: 'codex-accounts-exhausted' }
        if (resolved.reason === 'not-authenticated') return { ok: false, error: 'no-key' }
        if (resolved.reason === 'incompatible') return { ok: false, error: 'no-model' }
        return { ok: false, error: 'unavailable' }
      }

      // Context-only resolution never owns a lease in production. Keep this defensive cleanup for adapters/tests
      // that return one anyway, so replacing an advisory target cannot strand a half-open probe.
      const previous = codexRuntimeTarget
      const sameLease =
        previous?.availabilityLease &&
        resolved.target.availabilityLease &&
        previous.providerId === resolved.target.providerId &&
        previous.availabilityLease.leaseId === resolved.target.availabilityLease.leaseId
      if (previous?.availabilityLease && !sameLease) {
        settleCodexRuntimeLeaseIfUnowned()
      }
      codexRuntimeTarget = resolved.target
      // A lease returned after a different target is a new ownership obligation. Do not reset this flag for a
      // lease-free re-resolution after we already settled the previous lease, or it would be settled twice.
      if (resolved.target.availabilityLease && !sameLease) codexRuntimeLeaseTransferred = false
      if (!admit && resolved.target.availabilityLease) settleCodexRuntimeLeaseIfUnowned()
      codexFailoverChain = chain
      if (
        !conversationOperationIsCurrent(conversationId, operation) ||
        (!selectionAccountId && (codexIdentityTransitionPending || accountEpochAtAdmission !== codexAccountUpdateEpoch))
      ) {
        return { ok: false, error: 'busy' }
      }
      // Mark the physical account early so concurrent reset/logout aborts the correct probe.
      operation.effectiveProviderId = resolved.target.providerId
      return { ok: true, target: resolved.target }
    }

    // Resolve only the physical capability before preflight. It must not hold a half-open lease because the
    // portable summarizer may itself use the same failover admission.
    const capabilityResolution = isolated
      ? ({ ok: true } as { ok: true; target?: CodexRuntimeTarget })
      : await resolveCodexTargetForStart(false)
    if (!capabilityResolution.ok) return capabilityResolution
    const contextWindowForCodexTarget = (target?: CodexRuntimeTarget): number | undefined => {
      const window = target?.effectiveContextWindow ?? target?.contextWindow ?? target?.model.contextWindow
      const normalized = Math.floor(Number(window) || 0)
      return normalized > 0 ? normalized : undefined
    }
    let smallestPreflightedCodexWindow = useCodexSubscription
      ? contextWindowForCodexTarget(capabilityResolution.target)
      : undefined
    const codexPreflightContextWindow = smallestPreflightedCodexWindow
    let preflight =
      isolated && frozenProfile
        ? await preflightIsolatedContext(conversationId, frozenProfile, preflightParts, operation.controller.signal)
        : await preflightContext(
            conversationId,
            selection,
            preflightParts,
            operation,
            operation.controller.signal,
            useClaudeSubscription ? smallestClaudeWindow : codexPreflightContextWindow,
            useClaudeSubscription ? claudeFailoverChain : undefined,
            preflightedClaudeProviderId,
            initialClaudeAxes
          )
    if (!preflight.ok) return { ok: false, error: preflight.error }

    const preflightAtNarrowerCodexWindow = async (contextWindow: number): Promise<ContextPreflightResult> => {
      const narrowerPreflight = await preflightContext(
        conversationId,
        selection!,
        preflightParts,
        operation,
        operation.controller.signal,
        contextWindow
      )
      if (!narrowerPreflight.ok) return narrowerPreflight
      smallestPreflightedCodexWindow =
        smallestPreflightedCodexWindow == null ? contextWindow : Math.min(smallestPreflightedCodexWindow, contextWindow)
      preflight = { ok: true, compacted: preflight.compacted || narrowerPreflight.compacted }
      return narrowerPreflight
    }

    // Recheck the lease-free capability immediately before admission. If another account became the eligible
    // target while compaction ran and its known window is smaller, repeat the guard with that smaller ceiling.
    if (useCodexSubscription && !isolated) {
      const refreshedCapability = await resolveCodexTargetForStart(false)
      if (!refreshedCapability.ok) return refreshedCapability
      const refreshedWindow = contextWindowForCodexTarget(refreshedCapability.target)
      if (
        refreshedWindow != null &&
        (smallestPreflightedCodexWindow == null || refreshedWindow < smallestPreflightedCodexWindow)
      ) {
        const narrowerPreflight = await preflightAtNarrowerCodexWindow(refreshedWindow)
        if (!narrowerPreflight.ok) return { ok: false, error: narrowerPreflight.error }
      }
    }
    // Isolated: NEVER inspects/retires the owning conversation's Claude binding or calls retireIncompatible on it.
    if (!isolated) {
      await retireIncompatibleSubscriptionState(conversationId, selection.providerId, operation.controller.signal)
    }
    if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }

    // ADMISSION BARRIER (after preflight): the loop may have been cancelled during authentication,
    // model resolution, or compaction. Revalidate the lock AND job signal before persisting
    // the message/admitting the runner — no execution starts after Stop.
    if (internalLoop) {
      const ownsReview = reviewLoopLockForConversation(conversationId) === internalLoop.loopId
      const ownsEnvironment = chatGptWeb.projectEnvironmentLockFor(conversationId) === internalLoop.loopId
      if (internalLoop.signal.aborted || (!ownsReview && !ownsEnvironment)) {
        releaseCwdActivityOnce()
        return { ok: false, error: internalLoop.signal.aborted ? 'cancelled' : 'review-loop-inactive' }
      }
    }

    // Codex: acquire the physical account only after preflight/portable compaction (logical selection remains).
    // The final admission is itself a TOCTOU boundary: another operation may consume the target observed by the
    // lease-free resolution and make admission fall through to a smaller physical window. In that case, return
    // the lease before compacting, lower the validated ceiling monotonically, and admit again. The frozen chain
    // bounds churn; no half-open lease is held while compactReserved/preflightContext runs.
    let admittedCodexTarget: CodexRuntimeTarget | undefined
    if (useCodexSubscription && !isolated) {
      const maxAdmissionAttempts = Math.max(2, (frozenCodexChain?.length ?? 1) + 1)
      for (let attempt = 0; attempt < maxAdmissionAttempts; attempt += 1) {
        const admissionResolution = await resolveCodexTargetForStart(true)
        if (!admissionResolution.ok) return admissionResolution

        const admittedWindow = contextWindowForCodexTarget(admissionResolution.target)
        if (
          admittedWindow == null ||
          smallestPreflightedCodexWindow == null ||
          admittedWindow >= smallestPreflightedCodexWindow
        ) {
          admittedCodexTarget = admissionResolution.target
          break
        }

        // The target's lease belongs to this service operation until the runner starts. Give it back before
        // compaction so a helper can use the same frozen chain without being blocked by our own probe.
        settleCodexRuntimeLeaseIfUnowned()
        if (attempt === maxAdmissionAttempts - 1) break
        const narrowerPreflight = await preflightAtNarrowerCodexWindow(admittedWindow)
        if (!narrowerPreflight.ok) return { ok: false, error: narrowerPreflight.error }
      }

      // Failing closed is safer than starting with a target whose context ceiling was never validated.
      if (!admittedCodexTarget) return { ok: false, error: 'unavailable' }
    }
    if (useCodexSubscription && !isolated && !admittedCodexTarget) {
      throw new Error('Codex runtime target was not resolved before start')
    }

    if (useClaudeSubscription && !isolated) {
      let admitted = false
      for (let attempt = 0; attempt < Math.max(2, claudeFailoverChain.length + 1); attempt++) {
        const result = await resolveClaudeTargetForStart(true)
        if (!result.ok) return result
        const window = result.target.contextWindow
        if (
          window == null ||
          (smallestClaudeWindow != null &&
            window >= smallestClaudeWindow &&
            result.target.providerId === preflightedClaudeProviderId)
        ) {
          admitted = true
          break
        }
        settleClaudeRuntimeLeaseIfUnowned()
        const checked = await preflightContext(
          conversationId,
          selection,
          preflightParts,
          operation,
          operation.controller.signal,
          smallestClaudeWindow != null ? Math.min(smallestClaudeWindow, window) : window,
          claudeFailoverChain,
          result.target.providerId,
          initialClaudeAxes
        )
        if (!checked.ok) return { ok: false, error: checked.error }
        smallestClaudeWindow = smallestClaudeWindow != null ? Math.min(smallestClaudeWindow, window) : window
        preflightedClaudeProviderId = result.target.providerId
        preflight = {
          ok: true,
          compacted: preflight.compacted || checked.compacted,
        }
      }
      if (!admitted) return { ok: false, error: 'unavailable' }
      claudeIdentityAtAdmission = claudeRuntimeTarget!.accountIdentity
      claudeModelAtAdmission = claudeRuntimeTarget!.model
    }

    const send = makeSafeSend(wc)
    const controller = new AbortController()
    const assistantMessageId = useOfficialSubscription ? '' : randomUUID()
    const assistantCreatedAt = Date.now()
    const maestroLive =
      maestroTurn && !internalLoop
        ? createMaestroLiveRunPort({
            conversationId,
            assistantMessageId: assistantMessageId || null,
            emit: (event) => send(`chat:maestro-live:${conversationId}`, event),
          })
        : undefined
    let settleDone!: () => void
    const done = new Promise<void>((resolve) => {
      settleDone = resolve
    })
    let settleOutcome!: (outcome: InternalTurnOutcome) => void
    const outcome = new Promise<InternalTurnOutcome>((resolve) => {
      settleOutcome = resolve
    })
    const run: ActiveRun = {
      controller,
      send,
      messageId: assistantMessageId,
      providerId: selection.providerId,
      ...(admittedCodexTarget ? { effectiveProviderId: admittedCodexTarget.providerId } : {}),
      ...(useClaudeSubscription
        ? {
            effectiveProviderId: claudeRuntimeTarget?.providerId ?? selection.providerId,
            claudeSessionProviderId: claudeRuntimeTarget?.providerId ?? selection.providerId,
            claudeSessionAccountId: claudeRuntimeTarget ? claudeRuntimeTarget.accountId : selectionAccountId,
          }
        : {}),
      activeSubscriptionProviders: new Map(),
      ...(useCodexSubscription ? { codexAccountEpoch: accountEpochAtAdmission } : {}),
      ...(githubCopilotIdentityAtAdmission ? { githubCopilotIdentity: githubCopilotIdentityAtAdmission } : {}),
      ...(claudeIdentityAtAdmission ? { claudeIdentity: claudeIdentityAtAdmission } : {}),
      ...(grokIdentityAtAdmission ? { grokIdentity: grokIdentityAtAdmission } : {}),
      // Ephemeral/isolated: persist messages, but do NOT resume/write the main conversation's native binding.
      // Lifecycle remains allowed: the ephemeral thread must execute but must not become a binding.
      allowCodexThreadLifecycle: true,
      allowCodexPersistence: !isolated,
      allowGitHubCopilotPersistence: !isolated,
      allowClaudePersistence: !isolated,
      done,
      settleDone,
      outcome,
      settleOutcome,
      activeHarnessProfile: null,
      midTurnSteering: false,
      liveReasoningUpdate: false,
      acceptedSteeringMessageIds: new Set(),
      ...(maestroLive ? { maestroLive } : {}),
    }
    if (admittedCodexTarget) acquireActiveProvider(run, admittedCodexTarget.providerId)
    else if (useCodexSubscription && isolated) acquireActiveProvider(run, selection.providerId)
    admittedRun = run
    active.set(conversationId, run)
    if (maestroLive) {
      send(`chat:maestro-live:${conversationId}`, { kind: 'run-updated', run: maestroLive.state().run })
    }
    // Create the internal turn handle HERE (same tick as admission) — never via `active.get` after start.
    internalLoop?.onAdmitted(run)
    // The BYOK runner received a preallocated response ID from main; signal early so compaction
    // and mention reads count toward duration too. The Codex adapter still governs its own message.
    if (!useOfficialSubscription) {
      send(`chat:delta:${conversationId}`, {
        kind: 'message-start',
        messageId: assistantMessageId,
        model: selection,
        createdAt: assistantCreatedAt,
        responseStartedAt,
        ...(reviewLoopMessageMeta
          ? { source: reviewLoopMessageMeta.source, reviewLoop: reviewLoopMessageMeta.reviewLoop }
          : {}),
      } satisfies ChatStreamEvent)
    }
    // Persist the user message BEFORE running (include it in the next turn's history).
    // Isolated: centralize source + executionScope here (runners receive messageMeta and cannot omit them).
    upsertChatMessage({
      id: randomUUID(),
      conversationId,
      role: 'user',
      parts,
      ...(opts?.internal || reviewLoopMessageMeta ? { internal: true } : {}),
      ...(reviewLoopMessageMeta ?? {}),
      createdAt: Date.now(),
    })
    // Sidecars now have an owner row — finally no longer touches them.
    messageDurable = true
    if (!useOfficialSubscription) {
      upsertChatMessage({
        id: assistantMessageId,
        conversationId,
        role: 'assistant',
        parts: [],
        model: selection,
        ...(runnerMessageMeta ?? {}),
        createdAt: assistantCreatedAt,
      })
    }
    send(`chat:delta:${conversationId}`, {
      kind: 'user-saved',
      compacted: preflight.compacted,
      // New descriptions changed ALREADY-rendered parts (optimistic bubble/history) → UI reloads the page.
      ...(imagesDescribed ? { imagesDescribed } : {}),
    })

    updateConversationStatus(conversationId, 'working')
    deps.emitStatus(conversationId, 'working')

    // Inherit default effort on the conversation's first run: the runner reads reasoning directly from ui_prefs, so
    // pin it here (undefined → default) to honor Settings. Do not pin default 'off'
    // (keeps ui_prefs clean; no runner reasoning has the same effect). User picker overrides always win.
    const dr = defaultReasoningEffort()
    // Internal review-loop turn: selection (including reasoning) is FROZEN — never pin/persist it here.
    if (!internalLoop && dr !== 'off' && getConvUiPrefs(conversationId).chat?.reasoning === undefined) {
      patchConvChat(conversationId, { reasoning: dr })
    }

    // The runner does NOT rethrow turn errors (emits a stream 'error' event and resolves) → capture here so
    // final status becomes 'error' (sound + error icon), not 'ready'.
    let hadError = false
    // CUT turn (CUT_FINISH_REASONS): 'interrupted' (continuation exhausted), 'other'/'unknown' (abnormal provider
    // termination, e.g. codex-proxy with dead upstream), 'tool-calls' (MAX_STEPS), 'length' (max_tokens).
    // None indicates completion: work may be unfinished. Treat as 'error' rather than green/ready. The runner
    // only lets a cut finish reach here after exhausting transparent retries.
    let wasInterrupted = false
    let maestroTerminalStatus: 'completed' | 'error' | 'aborted' | 'interrupted' = 'error'
    const emit = (ev: ChatStreamEvent) => {
      if (ev.kind === 'message-start') {
        run.messageId = ev.messageId
        run.maestroLive?.bindAssistantMessage(ev.messageId)
      }
      if (ev.kind === 'error') hadError = true
      if (ev.kind === 'finish' && CUT_FINISH_REASONS.has(ev.finishReason)) wasInterrupted = true
      send(`chat:delta:${conversationId}`, ev)
    }
    const applyCodexTurnControl = (control: CodexActiveTurnControlPort | null): void => {
      if (active.get(conversationId) !== run) return
      run.codexTurnControl = control ?? undefined
      run.activeHarnessProfile = control?.harnessProfile ?? null
      run.midTurnSteering = control?.midTurnSteering === true
      run.liveReasoningUpdate = control?.liveReasoningUpdate === true
      send(`chat:delta:${conversationId}`, {
        kind: 'runtime-capabilities',
        midTurnSteering: run.midTurnSteering,
        liveReasoningUpdate: run.liveReasoningUpdate,
        activeHarnessProfile: run.activeHarnessProfile,
      } satisfies ChatStreamEvent)
    }
    const markAcceptedSteeringFailed = (): void => {
      for (const messageId of run.acceptedSteeringMessageIds) {
        const message = getChatMessage(conversationId, messageId)
        if (message?.steering?.status !== 'queued') continue
        const failed: ChatMessage = { ...message, steering: { status: 'failed' } }
        upsertChatMessage(failed)
        send(`chat:delta:${conversationId}`, { kind: 'steering-accepted', message: failed } satisfies ChatStreamEvent)
      }
    }

    // A target that became larger after the lease-free preflight must not reopen room within this admission.
    // The next turn resolves fresh; this turn remains bounded by the smallest physical estimate already validated.
    const admittedCodexContextWindow = contextWindowForCodexTarget(admittedCodexTarget)
    let turnContextWindow = useCodexSubscription
      ? admittedCodexContextWindow != null && smallestPreflightedCodexWindow != null
        ? Math.min(admittedCodexContextWindow, smallestPreflightedCodexWindow)
        : (admittedCodexContextWindow ?? smallestPreflightedCodexWindow)
      : useClaudeSubscription && !isolated
        ? (smallestClaudeWindow ?? claudeRuntimeTarget?.contextWindow ?? undefined)
        : (await effectiveModelMeta(selection.modelId, selection.providerId).catch(() => null))?.meta?.contextWindow
    const observeTurnContextWindow = (value: unknown): void => {
      const next = Math.floor(Number(value) || 0)
      if (next <= 0) return
      turnContextWindow = turnContextWindow && turnContextWindow > 0 ? Math.min(turnContextWindow, next) : next
    }
    const admittedBehaviorResolvedModelId = useClaudeSubscription
      ? isolated && frozenProfile?.resolvedModelId
        ? frozenProfile.resolvedModelId
        : (claudeModelAtAdmission?.resolvedModel ?? claudeModelAtAdmission?.value)
      : useGitHubCopilot
        ? githubCopilotModelAtAdmission?.id
        : undefined
    const admittedBehaviorProfile = behaviorProfileFor(admittedBehaviorResolvedModelId)
    const compactActiveHistory = (claudeTarget?: ClaudeRuntimeTarget) =>
      compact(conversationId, {
        allowActive: true,
        signal: controller.signal,
        persist: false,
        contextWindow: claudeTarget?.contextWindow
          ? turnContextWindow
            ? Math.min(turnContextWindow, claudeTarget.contextWindow)
            : claudeTarget.contextWindow
          : turnContextWindow,
        ...(useClaudeSubscription ? { claudeFailoverChain, claudeExecutionAxes: initialClaudeAxes } : {}),
        behaviorProfile: admittedBehaviorProfile,
        ...(admittedBehaviorResolvedModelId ? { resolvedModelId: admittedBehaviorResolvedModelId } : {}),
        ...(isolated && internalLoop && frozenProfile
          ? {
              executionId: internalLoop.executionId,
              selectionOverride: frozenProfile,
              skipRetireBinding: true,
            }
          : {}),
      })
        .then((result) => {
          if (useClaudeSubscription && !result.ok && (result.usage || result.runtimeEstimatedCostUsd != null)) {
            throw Object.assign(new Error(result.error ?? 'Claude portable compaction failed.'), {
              partialUsage: result.usage,
              runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
            })
          }
          return result.ok && result.summary
            ? {
                summary: result.summary,
                usage: result.usage,
                // Native helper-call cost estimate → runner adds it to turn cost.
                ...(result.runtimeEstimatedCostUsd != null
                  ? { runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd }
                  : {}),
              }
            : null
        })
        .catch((error) => {
          if (
            useClaudeSubscription &&
            (extractIsolatedSummaryAttemptUsage(error) || typeof error?.runtimeEstimatedCostUsd === 'number')
          )
            throw error
          return null
        })

    let turnPromise: Promise<{ planSubmitted: boolean }>
    let maestroGuardContinuation: { prompt: string } | null = null
    if (useCodexSubscription && isolated) {
      const selectedModelId = selection!.modelId
      const logicalProviderId = selection!.providerId
      turnPromise = (async () => {
        const manager = getCodexSubscriptionManager(selectionAccountId)
        const [client, preferredFastTier, models] = await Promise.all([
          manager.getClient(),
          manager.preferredServiceTier(selectedModelId, isolated),
          manager.listModels(isolated),
        ])
        const fastMode = frozenProfile?.fastMode === true
        const liveServiceTier = fastMode && preferredFastTier ? preferredFastTier : 'default'
        const effectiveFastMode = fastMode && preferredFastTier != null
        if (frozenProfile?.serviceTier && liveServiceTier !== frozenProfile.serviceTier) {
          throw new Error('executor-unavailable')
        }
        if (frozenProfile?.fastMode === true && !preferredFastTier) {
          throw new Error('executor-unavailable')
        }
        const serviceTier = frozenProfile?.serviceTier ? frozenProfile.serviceTier : liveServiceTier
        const requestedEffort = turnReasoning(conversationId, frozenProfile)
        const codexModel = models.find((model) => model.id === selectedModelId || model.model === selectedModelId)
        const manualContextLimit = getContextLimit(logicalProviderId, selectedModelId)
        const initialContext = resolveCodexContextWindow({ model: codexModel, userLimit: manualContextLimit })
        const observedContext =
          initialContext.requestedNominal != null
            ? manager.getObservedModelContextWindowObservation?.(selectedModelId, initialContext.requestedNominal)
            : undefined
        const resolvedContext = resolveCodexContextWindow({
          model: codexModel,
          userLimit: manualContextLimit,
          sameRequestObservation: observedContext,
        })
        if (resolvedContext.effectiveEstimate != null) turnContextWindow = resolvedContext.effectiveEstimate
        const supportedEfforts = codexSerializableReasoningEfforts(
          codexModel?.model ?? selectedModelId,
          codexModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? []
        )
        const resolved = resolveNativeReasoningEffort({
          requestedEffort,
          supportedEfforts,
          defaultEffort: codexModel?.defaultReasoningEffort || undefined,
          strict: !!frozenProfile,
        })
        if (!resolved.ok) throw new Error('executor-unavailable')
        if (frozenProfile && resolved.reasoningEffort !== frozenProfile.reasoningEffort) {
          throw new Error('executor-unavailable')
        }
        run.effectiveProviderId = logicalProviderId
        run.codexThreadProviderId = logicalProviderId
        run.codexThreadAccountId = selectionAccountId
        return runCodexSubscriptionChat({
          conversationId,
          projectId: conv.workspaceId,
          cwd: conv.cwd,
          selection,
          mode: turnBehavior,
          maestro: maestroTurn,
          maestroLive: run.maestroLive,
          permMode: permModeFor(conversationId),
          reasoningEffort: resolved.reasoningEffort,
          maestrlyUltra: resolved.maestrlyUltra,
          fastMode: effectiveFastMode,
          serviceTier,
          // A catalog that LISTS modalities without 'image' means the model rejects attachments; send the
          // interpreter description (or note) instead. Missing/empty list = unknown → send the image (as before).
          dropImages: !supportsChatToolImages({
            modelVision:
              codexModel && Array.isArray(codexModel.inputModalities) && codexModel.inputModalities.length > 0
                ? codexModel.inputModalities.includes('image')
                : undefined,
            runtimeImageUnsupported: getConvUiPrefs(conversationId).chat?.imagesUnsupported === true,
          }),
          client,
          runtimeModel: codexModel,
          eligibleChatGptSession: manager.getStatusSnapshot()?.account?.type === 'chatgpt',
          broker: getBroker(),
          questionBroker: getQuestionBroker(),
          emit,
          signal: controller.signal,
          ...(internalLoop?.reviewerRuntime ? { reviewerRuntime: internalLoop.reviewerRuntime } : {}),
          responseStartedAt,
          contextWindow: turnContextWindow,
          ...(runnerMessageMeta ? { messageMeta: runnerMessageMeta } : {}),
          ...(resolvedContext.requestedNominal != null
            ? { requestedContextWindow: resolvedContext.requestedNominal }
            : {}),
          compactHistory: compactActiveHistory,
          initialAccountId: selectionAccountId,
          effectiveProviderId: logicalProviderId,
          onModelContextWindow: (contextWindow, requestedNominal) => {
            observeTurnContextWindow(contextWindow)
            manager.observeModelContextWindow(
              selectedModelId,
              contextWindow,
              requestedNominal === undefined ? resolvedContext.requestedNominal : requestedNominal
            )
          },
          onThreadReady: (threadId) => {
            if (
              !run.allowCodexThreadLifecycle ||
              (selectionAccountId == null &&
                (codexIdentityTransitionPending || run.codexAccountEpoch !== codexAccountUpdateEpoch))
            )
              return false
            run.codexThreadId = threadId
            run.codexThreadProviderId = logicalProviderId
            run.codexThreadAccountId = selectionAccountId
            return true
          },
          canPersistThread: () =>
            run.allowCodexPersistence &&
            (selectionAccountId != null ||
              (!codexIdentityTransitionPending && run.codexAccountEpoch === codexAccountUpdateEpoch)),
          onTurnControl: applyCodexTurnControl,
          ...(reviewLoopMessageMeta
            ? {
                ephemeralSession: true as const,
                executionScope: reviewLoopMessageMeta.executionScope,
              }
            : {}),
        })
      })()
    } else if (useCodexSubscription && admittedCodexTarget && codexFailoverChain) {
      const target = admittedCodexTarget
      const chain = codexFailoverChain
      const selectedModelId = selection.modelId
      const fastMode = isolated ? frozenProfile?.fastMode === true : codexFastMode
      const requestedEffort = turnReasoning(conversationId, frozenProfile)
      const supportedEfforts = codexSerializableReasoningEfforts(
        target.runtimeModelId,
        target.model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
      )
      const resolved = resolveNativeReasoningEffort({
        requestedEffort,
        supportedEfforts,
        defaultEffort: target.model.defaultReasoningEffort || undefined,
        strict: isolated && !!frozenProfile,
      })
      if (!resolved.ok) throw new Error('executor-unavailable')
      if (isolated && frozenProfile && resolved.reasoningEffort !== frozenProfile.reasoningEffort) {
        throw new Error('executor-unavailable')
      }
      const liveServiceTier = target.serviceTier ?? 'default'
      const effectiveFastMode = fastMode && liveServiceTier !== 'default'
      if (isolated && frozenProfile?.serviceTier && liveServiceTier !== frozenProfile.serviceTier) {
        throw new Error('executor-unavailable')
      }
      if (isolated && frozenProfile?.fastMode === true && liveServiceTier === 'default') {
        throw new Error('executor-unavailable')
      }
      const serviceTier = isolated && frozenProfile?.serviceTier ? frozenProfile.serviceTier : liveServiceTier
      const reasoningEffort =
        isolated && frozenProfile?.reasoningEffort
          ? frozenProfile.reasoningEffort
          : (target.reasoningEffort ?? resolved.reasoningEffort)
      const maestrlyUltra = resolved.maestrlyUltra
      try {
        turnPromise = runCodexSubscriptionChat({
          conversationId,
          projectId: conv.workspaceId,
          cwd: conv.cwd,
          selection,
          mode: turnBehavior,
          maestro: maestroTurn,
          maestroLive: run.maestroLive,
          permMode: permModeFor(conversationId),
          reasoningEffort,
          maestrlyUltra,
          fastMode: effectiveFastMode,
          serviceTier,
          dropImages: target.dropImages,
          client: target.client,
          runtimeModel: target.model,
          eligibleChatGptSession: target.manager.getStatusSnapshot()?.account?.type === 'chatgpt',
          broker: getBroker(),
          questionBroker: getQuestionBroker(),
          emit,
          signal: controller.signal,
          ...(internalLoop?.reviewerRuntime ? { reviewerRuntime: internalLoop.reviewerRuntime } : {}),
          responseStartedAt,
          contextWindow: turnContextWindow,
          ...(runnerMessageMeta ? { messageMeta: runnerMessageMeta } : {}),
          ...(target.requestedContextWindow != null ? { requestedContextWindow: target.requestedContextWindow } : {}),
          compactHistory: compactActiveHistory,
          initialAccountId: target.accountId,
          effectiveProviderId: target.providerId,
          failoverChain: chain,
          availabilityLease: target.availabilityLease,
          resolveNextTarget: async (_failure, attempted) => {
            // The runner already marked the current account exhausted; only resolve the next physical target.
            const next = await resolveCodexRuntimeTarget({
              logicalProviderId: selection!.providerId,
              modelId: selectedModelId,
              reasoningEffort: requestedEffort && requestedEffort !== 'off' ? requestedEffort : undefined,
              astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
              fastMode,
              configureContextWindow: true,
              chain,
              attemptedProviderIds: attempted,
              signal: controller.signal,
            })
            if (next.ok) return next.target
            if (next.error === 'aborted') return null
            return {
              reason: next.reason,
              message: next.message,
              ...(next.resetsAt !== undefined ? { resetsAt: next.resetsAt } : {}),
            }
          },
          onEffectiveTargetChanged: ({ providerId, accountId, contextWindow }) => {
            const previous = run.effectiveProviderId
            if (previous && previous !== providerId) releaseActiveProvider(run, previous)
            acquireActiveProvider(run, providerId)
            run.effectiveProviderId = providerId
            run.codexThreadProviderId = providerId
            run.codexThreadAccountId = accountId
            observeTurnContextWindow(contextWindow)
          },
          acquirePhysicalProvider: (providerId) => {
            acquireActiveProvider(run, providerId)
          },
          releasePhysicalProvider: (providerId) => {
            releaseActiveProvider(run, providerId)
          },
          onTurnControl: applyCodexTurnControl,
          onFailoverTransition: (info) => {
            chatDiag({
              type: 'subscription-failover',
              conversationId,
              fromProviderId: info.fromProviderId,
              toProviderId: info.toProviderId,
              reason: info.reason,
              scope: info.scope ?? 'root',
              ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
            })
            send(`chat:subscription-failover:${conversationId}`, {
              scope: info.scope ?? 'root',
              fromProviderId: info.fromProviderId,
              toProviderId: info.toProviderId,
              reason: info.reason,
              ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
            })
          },
          onModelContextWindow: (contextWindow, requestedNominal) => {
            observeTurnContextWindow(contextWindow)
            const providerId = run.effectiveProviderId ?? target.providerId
            getCodexSubscriptionManager(subscriptionAccountId(providerId)).observeModelContextWindow(
              selectedModelId,
              contextWindow,
              requestedNominal === undefined ? target.requestedContextWindow : requestedNominal
            )
          },
          onThreadReady: (threadId, meta) => {
            const physicalProviderId = meta?.providerId ?? run.effectiveProviderId ?? target.providerId
            const accountId =
              meta && 'accountId' in meta ? meta.accountId : (run.codexThreadAccountId ?? target.accountId)
            if (
              !run.allowCodexThreadLifecycle ||
              (accountId == null &&
                (codexIdentityTransitionPending || run.codexAccountEpoch !== codexAccountUpdateEpoch))
            )
              return false
            run.codexThreadId = threadId
            run.codexThreadProviderId = physicalProviderId
            run.codexThreadAccountId = accountId ?? null
            return true
          },
          canPersistThread: () => {
            const accountId =
              run.codexThreadAccountId !== undefined
                ? run.codexThreadAccountId
                : subscriptionAccountId(run.effectiveProviderId ?? run.providerId)
            return (
              run.allowCodexPersistence &&
              (accountId != null ||
                (!codexIdentityTransitionPending && run.codexAccountEpoch === codexAccountUpdateEpoch))
            )
          },
          ...(isolated && reviewLoopMessageMeta
            ? {
                ephemeralSession: true as const,
                executionScope: reviewLoopMessageMeta.executionScope,
              }
            : {}),
        })
        codexRuntimeLeaseTransferred = true
      } catch (error) {
        settleCodexRuntimeLeaseIfUnowned()
        throw error
      }
    } else if (useCodexSubscription) {
      throw new Error('Codex runtime target was not resolved before start')
    } else if (useGitHubCopilot && githubCopilotIdentityAtAdmission && githubCopilotModelAtAdmission) {
      const admittedIdentity = githubCopilotIdentityAtAdmission
      const copilotModel = githubCopilotModelAtAdmission
      turnPromise = (async () => {
        const manager = getGitHubCopilotSubscriptionManager(selectionAccountId)
        manager.assertAccountIdentity(admittedIdentity)
        const supportedEfforts = copilotModel?.supportedReasoningEfforts ?? []
        const supportedEffortNames = supportedEfforts as readonly string[]
        const requestedEffort = turnReasoning(conversationId, frozenProfile)
        const resolved = resolveNativeReasoningEffort({
          requestedEffort,
          supportedEfforts: supportedEffortNames,
          defaultEffort: copilotModel?.defaultReasoningEffort,
          strict: isolated && !!frozenProfile,
        })
        // Loop fail-closed: frozen effort must be reproduced EXACTLY — same effective value as at
        // freeze (never default/omission; Ultra with a changed list resolves differently → fail).
        if (!resolved.ok) throw new Error('executor-unavailable')
        if (isolated && frozenProfile && resolved.reasoningEffort !== frozenProfile.reasoningEffort) {
          throw new Error('executor-unavailable')
        }
        const reasoningEffort = resolved.reasoningEffort
        const maestrlyUltra = resolved.maestrlyUltra
        return runGitHubCopilotChat({
          conversationId,
          projectId: conv.workspaceId,
          cwd: conv.cwd,
          selection,
          behaviorProfile: admittedBehaviorProfile,
          mode: turnBehavior,
          maestro: maestroTurn,
          maestroLive: run.maestroLive,
          permMode: permModeFor(conversationId),
          reasoningEffort,
          maestrlyUltra,
          // The official catalog declares model vision; only EXPLICIT `false` downgrades the attachment to text.
          dropImages: !supportsChatToolImages({
            modelVision: copilotModel?.capabilities?.supports?.vision,
            runtimeImageUnsupported: getConvUiPrefs(conversationId).chat?.imagesUnsupported === true,
          }),
          manager,
          accountIdentity: admittedIdentity,
          broker: getBroker(),
          questionBroker: getQuestionBroker(),
          emit,
          signal: controller.signal,
          ...(internalLoop?.reviewerRuntime ? { reviewerRuntime: internalLoop.reviewerRuntime } : {}),
          responseStartedAt,
          contextWindow: turnContextWindow,
          ...(runnerMessageMeta ? { messageMeta: runnerMessageMeta } : {}),
          compactHistory: compactActiveHistory,
          onSessionReady: (sessionId) => {
            if (!run.allowGitHubCopilotPersistence || (!selectionAccountId && githubCopilotIdentityTransitionPromise))
              return false
            try {
              manager.assertAccountIdentity(admittedIdentity)
            } catch {
              return false
            }
            run.githubCopilotSessionId = sessionId
            return true
          },
          canPersistSession: () => {
            if (!run.allowGitHubCopilotPersistence || (!selectionAccountId && githubCopilotIdentityTransitionPromise))
              return false
            try {
              manager.assertAccountIdentity(admittedIdentity)
              return true
            } catch {
              return false
            }
          },
          ...(isolated && reviewLoopMessageMeta
            ? {
                ephemeralSession: true as const,
                executionScope: reviewLoopMessageMeta.executionScope,
              }
            : {}),
        })
      })()
    } else if (useClaudeSubscription && claudeIdentityAtAdmission && claudeModelAtAdmission) {
      const admittedIdentity = claudeIdentityAtAdmission
      const claudeModel = claudeModelAtAdmission
      const selectedClaudeProviderId = selection.providerId
      const selectedClaudeModelId = selection.modelId
      turnPromise = (async () => {
        const manager = claudeRuntimeTarget?.manager ?? getClaudeSubscriptionManager(selectionAccountId)
        manager.assertAccountIdentity(admittedIdentity)
        const claudeAxes =
          !isolated && initialClaudeAxes
            ? initialClaudeAxes
            : claudeRuntimeAxes(
                conversationId,
                claudeModel,
                turnReasoning(conversationId, frozenProfile),
                isolated ? frozenProfile?.fastMode === true : undefined,
                isolated && !!frozenProfile
              )
        // Loop fail-closed: frozen axes must be reproduced exactly — same effective values as at
        // freeze (never degrade to default; Ultra with a changed list resolves differently → fail).
        if (
          isolated &&
          frozenProfile &&
          (!claudeAxes.frozenReproducible || claudeAxes.reasoningEffort !== frozenProfile.reasoningEffort)
        ) {
          throw new Error('executor-unavailable')
        }
        const { reasoningEffort, fastMode, maestrlyUltra } = claudeAxes
        const resolvedClaudeModelId =
          isolated && frozenProfile?.resolvedModelId
            ? frozenProfile.resolvedModelId
            : (claudeModel.resolvedModel ?? claudeModel.value)
        let effectiveTarget = claudeRuntimeTarget
        const canPersist = (target = effectiveTarget): boolean => {
          if (
            !run.allowClaudePersistence ||
            claudePhysicalIdentityIsChanging(target?.providerId ?? selectedClaudeProviderId)
          )
            return false
          if (
            target &&
            (target.providerId !== run.effectiveProviderId ||
              target.accountIdentity.fingerprint !== run.claudeIdentity?.fingerprint ||
              target.accountIdentity.epoch !== run.claudeIdentity?.epoch)
          )
            return false
          try {
            const owner = target?.manager ?? manager
            if (getClaudeSubscriptionManager(target ? target.accountId : selectionAccountId) !== owner) return false
            owner.assertAccountIdentity(target?.accountIdentity ?? admittedIdentity)
            return true
          } catch {
            return false
          }
        }
        const initialTarget = claudeRuntimeTarget
        const promise = runClaudeChat({
          ...(claudeRuntimeTarget ? { initialTarget: claudeRuntimeTarget } : {}),
          failoverChain: claudeFailoverChain,
          ...(!isolated
            ? {
                resolveNextTarget: async (input: { attemptedProviderIds: ReadonlySet<string>; admit?: boolean }) => {
                  const resolved = await resolveClaudeRuntimeTarget({
                    logicalProviderId: selectedClaudeProviderId,
                    modelId: selectedClaudeModelId,
                    runtimeModelId: resolvedClaudeModelId,
                    reasoningEffort,
                    fastMode,
                    chain: claudeFailoverChain,
                    ...input,
                    attemptedProviderIds: new Set([
                      ...input.attemptedProviderIds,
                      ...claudeFailoverChain.filter(claudePhysicalIdentityIsChanging),
                    ]),
                    signal: controller.signal,
                  })
                  return resolved.ok ? { ...resolved, target: { ...resolved.target, maestrlyUltra } } : resolved
                },
              }
            : {}),
          onEffectiveTargetChanged: (target) => {
            if (controller.signal.aborted || (!run.allowClaudePersistence && !isolated)) return
            effectiveTarget = target
            run.effectiveProviderId = target.providerId
            run.claudeSessionProviderId = target.providerId
            run.claudeSessionAccountId = target.accountId
            run.claudeIdentity = target.accountIdentity
            run.claudeSessionId = undefined
            observeTurnContextWindow(target.contextWindow)
          },
          onFailoverTransition: (event) => {
            chatDiag({
              type: 'subscription-failover',
              conversationId,
              ...event,
            })
            send(`chat:subscription-failover:${conversationId}`, event)
          },
          conversationId,
          projectId: conv.workspaceId,
          cwd: conv.cwd,
          selection,
          resolvedModelId: resolvedClaudeModelId,
          behaviorProfile: admittedBehaviorProfile,
          ...(isolated && frozenProfile?.resolvedModelId
            ? { frozenResolvedModelId: frozenProfile.resolvedModelId }
            : {}),
          mode: turnBehavior,
          maestro: maestroTurn,
          maestroLive: run.maestroLive,
          permMode: permModeFor(conversationId),
          reasoningEffort,
          fastMode,
          maestrlyUltra,
          dropImages: !supportsChatToolImages({
            modelVision: true,
            runtimeImageUnsupported: getConvUiPrefs(conversationId).chat?.imagesUnsupported === true,
          }),
          manager,
          accountIdentity: admittedIdentity,
          broker: getBroker(),
          questionBroker: getQuestionBroker(),
          emit,
          signal: controller.signal,
          ...(internalLoop?.reviewerRuntime ? { reviewerRuntime: internalLoop.reviewerRuntime } : {}),
          responseStartedAt,
          contextWindow: turnContextWindow,
          ...(runnerMessageMeta ? { messageMeta: runnerMessageMeta } : {}),
          compactHistory: compactActiveHistory,
          onModelContextWindow: (contextWindow, target = effectiveTarget) => {
            if (target && !canPersist(target) && !isolated) return
            observeTurnContextWindow(contextWindow)
            const owner = target?.manager ?? manager
            owner.observeModelContextWindow(selectedClaudeModelId, contextWindow)
            owner.observeModelContextWindow(target?.runtimeModelId ?? resolvedClaudeModelId, contextWindow)
          },
          onSessionReady: (sessionId, target = effectiveTarget) => {
            if (!canPersist(target)) return false
            run.claudeSessionId = sessionId
            run.claudeSessionProviderId = target?.providerId ?? selectedClaudeProviderId
            run.claudeSessionAccountId = target ? target.accountId : selectionAccountId
            return true
          },
          canPersistSession: canPersist,
          ...(isolated && reviewLoopMessageMeta
            ? {
                ephemeralSession: true as const,
                executionScope: reviewLoopMessageMeta.executionScope,
              }
            : {}),
        })
        claudeRuntimeLeaseTransferred = true
        return promise.finally(() => {
          // A runner that rejects before registering its attempt still returns the service-owned probe.
          if (
            initialTarget?.availabilityLease &&
            getSubscriptionFailoverRouter().getHealth(initialTarget.providerId).halfOpenLeaseId ===
              initialTarget.availabilityLease.leaseId
          ) {
            getSubscriptionFailoverRouter().confirmAttemptOther(
              initialTarget.providerId,
              initialTarget.availabilityLease
            )
          }
        })
      })()
    } else {
      if (useGrokSubscription && grokIdentityAtAdmission) {
        getGrokSubscriptionManager(selectionAccountId).assertAccountIdentity(grokIdentityAtAdmission)
      }
      turnPromise = runChat({
        conversationId,
        projectId: conv.workspaceId,
        cwd: conv.cwd,
        selection,
        behaviorProfile: admittedBehaviorProfile,
        broker: getBroker(),
        questionBroker: getQuestionBroker(),
        emit,
        signal: controller.signal,
        behaviorOverride: turnBehavior,
        ...(internalLoop?.reviewerRuntime ? { reviewerRuntime: internalLoop.reviewerRuntime } : {}),
        assistantMessageId,
        assistantCreatedAt,
        responseStartedAt,
        contextWindow: turnContextWindow,
        ...(runnerMessageMeta ? { messageMeta: runnerMessageMeta } : {}),
        // Mid-turn compaction produces only summary+usage; the runner persists the milestone inside the live bubble.
        compactHistory: compactActiveHistory,
        ...(internalLoop
          ? {
              // ALWAYS freeze the axis: explicit 'off' when the freeze lacks reasoning (older profiles).
              reasoningOverride: frozenProfile?.reasoning ?? 'off',
              // Frozen EFFECT (after resolving Ultra): the runner requires equality with live resolution.
              frozenReasoningEffort: frozenProfile?.reasoningEffort,
              ...(typeof frozenProfile?.fastMode === 'boolean' ? { fastModeOverride: frozenProfile.fastMode } : {}),
            }
          : {}),
        ...(maestroTurn ? { maestro: maestroTurn, maestroLive: run.maestroLive } : {}),
        ...(isolated && reviewLoopMessageMeta
          ? {
              ephemeralSession: true as const,
              executionScope: reviewLoopMessageMeta.executionScope,
            }
          : {}),
      })
    }

    turnPromise
      .then(async ({ planSubmitted }) => {
        // Codex/Claude reopen within their own native session. Other transports use this host-owned
        // fallback: wait without a cap for workers and start a new internal reconciliation turn before
        // releasing automation/status. A session is observed if the parent already consumed a terminal wait/inspect.
        if (
          turnBehavior === 'maestro' &&
          run.messageId &&
          !useCodexSubscription &&
          !useClaudeSubscription &&
          !controller.signal.aborted
        ) {
          const unobserved = unobservedTurnDelegations(conversationId, run.messageId)
          if (unobserved.length > 0) {
            const settled = await waitForTurnDelegationsTerminal(conversationId, run.messageId, controller.signal)
            const pendingReconciliation = settled.filter((session) => unobserved.some((item) => item.id === session.id))
            if (pendingReconciliation.length > 0) {
              accountGuardedDelegationUsage(conversationId, run.messageId, pendingReconciliation)
              for (const session of pendingReconciliation) markDelegationObserved(session.id)
              maestroGuardContinuation = {
                prompt:
                  'Host guard: the previous Maestro response attempted to finish before reconciling every ' +
                  'delegation. The sessions below are terminal. Use inspect_subagent with session_id whenever ' +
                  'details are needed, reconcile every result and only then answer the user.\n\n' +
                  JSON.stringify(
                    pendingReconciliation.map((session) => ({
                      sessionId: session.id,
                      agent: session.agentName,
                      status: session.status,
                      phase: session.phase,
                      tools: session.toolNames,
                      files: session.files,
                      tests: session.tests,
                      error: session.error,
                    }))
                  ),
              }
              return
            }
          }
        }
        // Pure, tested decision (turn-status): abort→'idle'; error OR mid-stream cut→'error' (red);
        // otherwise→'ready'. `review_plan` retains ready behavior, but
        // emits it silently because the broker already played the dedicated plan alert.
        const { status, silentReady } = finalTurnCompletion({
          aborted: controller.signal.aborted,
          hadError,
          interrupted: wasInterrupted,
          planSubmitted,
        })
        const outcome = controller.signal.aborted
          ? ('cancelled' as const)
          : hadError || wasInterrupted
            ? ('error' as const)
            : ('success' as const)
        if (outcome === 'error') markAcceptedSteeringFailed()
        maestroTerminalStatus = controller.signal.aborted
          ? 'aborted'
          : wasInterrupted
            ? 'interrupted'
            : hadError
              ? 'error'
              : 'completed'
        try {
          opts?.onComplete?.({ planSubmitted, outcome })
        } catch {
          // The lifecycle callback must not alter the turn outcome.
        }
        updateConversationStatus(conversationId, status)
        deps.emitStatus(conversationId, status, silentReady ? { silent: true } : undefined)
        if (controller.signal.aborted) {
          run.settleOutcome({ status: 'cancelled', assistantMessageId: run.messageId || null })
        } else if (hadError || wasInterrupted) {
          run.settleOutcome({
            status: 'error',
            error: wasInterrupted ? 'turn-interrupted' : 'turn-failed',
            assistantMessageId: run.messageId || null,
          })
        } else {
          const assistantId = run.messageId
          const summaryText = assistantId
            ? getChatMessage(conversationId, assistantId)
                ?.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
                .trim() || undefined
            : undefined
          run.settleOutcome({
            status: 'success',
            assistantMessageId: run.messageId || null,
            ...(summaryText ? { summaryText } : {}),
            ...(internalLoop?.reviewerRuntime?.decision?.()
              ? { reviewDecision: internalLoop.reviewerRuntime.decision()! }
              : {}),
          })
        }
      })
      .catch((e) => {
        maestroTerminalStatus = controller.signal.aborted ? 'aborted' : 'error'
        if (!controller.signal.aborted) markAcceptedSteeringFailed()
        if (run.messageId) cancelTurnDelegations(conversationId, run.messageId)
        try {
          opts?.onComplete?.({ planSubmitted: false, outcome: controller.signal.aborted ? 'cancelled' : 'error' })
        } catch {
          // The lifecycle callback must not mask the turn error.
        }
        const message = useGitHubCopilot
          ? githubCopilotErrorMessage(e)
          : useClaudeSubscription
            ? claudeSubscriptionErrorMessage(e)
            : useGrokSubscription
              ? grokSubscriptionErrorMessage(e)
              : e instanceof ChatConfigError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : String(e)
        const ev: ChatStreamEvent = {
          kind: 'error',
          messageId: run.messageId || undefined,
          message,
          responseDurationMs: responseDurationMs(responseStartedAt),
        }
        if (run.messageId) {
          const persisted = getChatMessage(conversationId, run.messageId) ?? {
            id: run.messageId,
            conversationId,
            role: 'assistant' as const,
            parts: [],
            model: selection ?? undefined,
            createdAt: assistantCreatedAt,
          }
          upsertChatMessage(applyChatEvent([persisted], ev)[0])
        }
        send(`chat:delta:${conversationId}`, ev)
        updateConversationStatus(conversationId, 'error')
        deps.emitStatus(conversationId, 'error')
        run.settleOutcome({ status: 'error', error: message, assistantMessageId: run.messageId || null })
      })
      .finally(async () => {
        // Release the slot BEFORE 'done' so the next queued turn does not get "busy"; 'done' is the ONLY
        // turn-end signal (the renderer advances the queue only here) — avoids double triggering (finish + done).
        run.maestroLive?.finish(maestroTerminalStatus)
        applyCodexTurnControl(null)
        // Native threads/sessions persisted by this turn's delegations have served their purpose (resume applies
        // only within the turn). Release is best-effort and never blocks completion: failures remain in
        // cleanup tombstones for the sweeper.
        if (turnBehavior === 'maestro' && run.messageId) {
          void releaseTurnDelegationRuntimes(conversationId, run.messageId).catch(() => undefined)
        }
        if (active.get(conversationId) === run) active.delete(conversationId)
        releaseCwdActivityOnce()
        const guard = maestroGuardContinuation
        if (guard) {
          const continuation = await startSend(deps, wc, conversationId, guard.prompt, undefined, {
            internal: true,
            onComplete: (result) => {
              try {
                opts?.onComplete?.(result)
              } catch {
                // The external callback does not govern the guard lifecycle.
              }
              if (result.outcome === 'success') {
                run.settleOutcome({ status: 'success', assistantMessageId: null })
              } else if (result.outcome === 'cancelled') {
                run.settleOutcome({ status: 'cancelled', assistantMessageId: null })
              } else {
                run.settleOutcome({ status: 'error', error: 'maestro-guard-failed', assistantMessageId: null })
              }
            },
          })
          if (!continuation.ok) {
            try {
              opts?.onComplete?.({ planSubmitted: false, outcome: 'error' })
            } catch {
              // The guard admission failure is already reflected below.
            }
            updateConversationStatus(conversationId, 'error')
            deps.emitStatus(conversationId, 'error')
            run.settleOutcome({
              status: 'error',
              error: continuation.error ?? 'maestro-guard-admission-failed',
              assistantMessageId: null,
            })
            send(`chat:delta:${conversationId}`, { kind: 'done' })
          }
          run.settleDone()
          return
        }
        send(`chat:delta:${conversationId}`, { kind: 'done' })
        run.settleDone()
      })

    return { ok: true }
  } catch (error) {
    if (admittedRun && active.get(conversationId) === admittedRun) active.delete(conversationId)
    releaseCwdActivityOnce()
    if (admittedRun) {
      admittedRun.maestroLive?.finish(admittedRun.controller.signal.aborted ? 'aborted' : 'error')
      // Failure before producing a message: the internal handle needs an outcome (never leave it pending).
      const message = error instanceof Error ? error.message : String(error)
      admittedRun.settleOutcome({ status: 'error', error: message, assistantMessageId: admittedRun.messageId || null })
    }
    admittedRun?.settleDone()
    if (isGitHubCopilotSubscriptionProvider(selection?.providerId)) {
      throw new Error(githubCopilotErrorMessage(error))
    }
    if (isClaudeSubscriptionProvider(selection?.providerId)) {
      throw new Error(claudeSubscriptionErrorMessage(error))
    }
    if (isGrokSubscriptionProvider(selection?.providerId)) {
      throw new Error(grokSubscriptionErrorMessage(error))
    }
    throw error
  } finally {
    settleCodexRuntimeLeaseIfUnowned()
    settleClaudeRuntimeLeaseIfUnowned()
    releaseConversationOperation(conversationId, operation)
    // Exit without a durable message → sidecars created during this admission would be orphaned (no owner row).
    if (!messageDurable && createdArtifactIds.length) {
      await deleteAttachmentImages(conversationId, createdArtifactIds)
    }
  }
}

/**
 * IMPLEMENTATION turn for an approved plan (triggered by plan-ipc on approve). Uses the CURRENT model/mode
 * (the conversation is already in Agent mode). Instructions and final plan go INLINE in an INTERNAL message
 * (hidden bubble), explicitly identifying the content as not a worktree file. The user sees only implementation.
 */
export async function runApprovedPlan(conversationId: string, plan: string): Promise<void> {
  if (!savedDeps) return
  const wc = getMainWebContents()
  if (!wc) return
  const prompt = tFor(getLocale(), 'prompts')('planBroker.implementApprovedPlan', { plan })
  const sendApproved = () => startSend(savedDeps!, wc, conversationId, prompt, undefined, { internal: true })
  let r = await sendApproved()
  if (!r.ok && r.error === 'busy') {
    await waitForConversationSlot(conversationId)
    r = await sendApproved()
  }
  // The pending action was consumed and mode changed to Agent; if the turn could not start (e.g. 'busy', 'no-key'),
  // notify the UI instead of failing silently (the plan stays in history for the user to request again).
  reportDecisionTurnFailure(conversationId, r)
}

/**
 * Plan REVISION turn (triggered by plan-ipc on revise). Structured feedback remains persisted and
 * reaches the model as an INTERNAL message; the user sees the resulting revision, not operational instructions.
 */
export async function runPlanRevision(
  conversationId: string,
  feedbackText: string,
  expectedRevisionVersion?: number
): Promise<void> {
  const releaseFailedRevision = () => releasePlanRevision(conversationId, 'maestrly-chat', expectedRevisionVersion)
  if (!savedDeps) {
    releaseFailedRevision()
    return
  }
  const wc = getMainWebContents()
  if (!wc) {
    releaseFailedRevision()
    return
  }
  const sendRevision = () =>
    startSend(savedDeps!, wc, conversationId, feedbackText, undefined, {
      internal: true,
      onComplete: ({ planSubmitted, outcome }) => {
        if (outcome !== 'success' || !planSubmitted) releaseFailedRevision()
      },
    })
  let r: { ok: boolean; error?: string }
  try {
    r = await sendRevision()
  } catch (error) {
    releaseFailedRevision()
    r = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!r.ok && r.error === 'busy') {
    try {
      await waitForConversationSlot(conversationId)
    } catch (error) {
      releaseFailedRevision()
      r = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (r.ok || r.error === 'busy') {
      try {
        r = await sendRevision()
      } catch (error) {
        releaseFailedRevision()
        r = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
  if (!r.ok) releaseFailedRevision()
  reportDecisionTurnFailure(conversationId, r)
}

async function waitForConversationSlot(conversationId: string): Promise<void> {
  const run = active.get(conversationId)
  const operation = pendingConversationOperations.get(conversationId)
  await Promise.all([run?.done ?? Promise.resolve(), operation?.done ?? Promise.resolve()])
}

/** Emits a conversation error when a plan decision turn (implement/revise) could not start. */
function reportDecisionTurnFailure(conversationId: string, r: { ok: boolean; error?: string }): void {
  if (r.ok || r.error === 'busy') return // 'busy' = a turn is already running; do not overwrite with an error.
  const wc = getMainWebContents()
  const message = tFor(getLocale(), 'prompts')('planBroker.decisionTurnFailed', { reason: r.error ?? 'unknown-error' })
  if (wc) sendChatEvent(wc, `chat:delta:${conversationId}`, { kind: 'error', message })
  updateConversationStatus(conversationId, 'error')
  savedDeps?.emitStatus(conversationId, 'error')
}

function stop(conversationId: string): void {
  releasePlanRevision(conversationId, 'maestrly-chat')
  const run = active.get(conversationId)
  if (run) {
    run.maestroLive?.cancelPending()
    run.controller.abort()
  }
  pendingConversationOperations.get(conversationId)?.controller.abort()
  getBroker().rejectConversation(conversationId)
  getQuestionBroker().rejectConversation(conversationId)
}

async function waitForRuns(runs: ActiveRun[], timeoutMs = 5_000): Promise<void> {
  if (!runs.length) return
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled(runs.map((run) => run.done)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
}

async function waitForChatShutdown(
  conversationId: string,
  run: ActiveRun | undefined,
  operation: PendingConversationOperation | undefined,
  timeoutMs: number
): Promise<boolean> {
  const pending = [run?.done, operation?.done].filter((value): value is Promise<void> => !!value)
  if (pending.length > 0) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }
  return !active.has(conversationId) && !pendingConversationOperations.has(conversationId)
}

async function invalidateActiveCodexRun(conversationId: string, run: ActiveRun, deleteThread = true): Promise<void> {
  run.allowCodexThreadLifecycle = false
  run.allowCodexPersistence = false
  stop(conversationId)
  await waitForRuns([run])
  const threadId = run.codexThreadId
  if (!deleteThread || !threadId) return // If created after timeout, `onThreadReady(false)` hard-deletes it in the runner itself.
  // Hard-delete must run in the physical OWNER account's CODEX_HOME, not the logical selection.
  // Explicit null = default account; only fall back if the owner has not yet been recorded.
  const accountId =
    run.codexThreadAccountId !== undefined
      ? run.codexThreadAccountId
      : subscriptionAccountId(run.effectiveProviderId ?? run.providerId)
  await deleteManagedCodexThread(conversationId, threadId, { accountId })
}

async function invalidateActiveRunUsingCodex(
  conversationId: string,
  run: ActiveRun,
  deleteCodexThread = true
): Promise<void> {
  if (isCodexSubscriptionProvider(run.providerId)) {
    await invalidateActiveCodexRun(conversationId, run, deleteCodexThread)
    return
  }
  // A helper can borrow Codex while the root belongs to Claude/Copilot/BYOK. Abort the root so its helper
  // signal stops too, but do not apply Codex-thread persistence cleanup to a non-Codex conversation.
  stop(conversationId)
  await waitForRuns([run])
}

async function invalidateActiveGitHubCopilotRun(conversationId: string, run: ActiveRun): Promise<void> {
  run.allowGitHubCopilotPersistence = false
  stop(conversationId)
  await waitForRuns([run])
  // The runner deletes sessions not yet persisted; this path covers bindings from previous/resumed turns.
  await deleteGitHubCopilotSessionForConversation(conversationId)
}

async function invalidateActiveClaudeRun(conversationId: string, run: ActiveRun): Promise<void> {
  run.allowClaudePersistence = false
  stop(conversationId)
  await run.done
  await deleteClaudeSessionForConversation(conversationId)
}

/**
 * External conversation teardown (archive/delete/CLI switch): first revoke official thread persistence,
 * then abort and await the run. User `chat:stop` still uses `stop()` and may preserve the interrupted thread.
 */
export async function stopChat(conversationId: string): Promise<void> {
  if (typeof conversationId !== 'string') return
  await cancelPendingConversationOperation(conversationId)
  const run = active.get(conversationId)
  if (run && isCodexSubscriptionProvider(run.providerId)) {
    await invalidateActiveCodexRun(conversationId, run)
  } else if (run && isGitHubCopilotSubscriptionProvider(run.providerId)) {
    await invalidateActiveGitHubCopilotRun(conversationId, run)
  } else if (run && isClaudeSubscriptionProvider(run.providerId)) {
    await invalidateActiveClaudeRun(conversationId, run)
  } else {
    stop(conversationId)
    if (run) await waitForRuns([run])
  }
  // Archive/delete/CLI switch are external boundaries: dormant web sessions must also leave the
  // router, or the tunnel and read-only cwd access survive after the conversation disappears.
  await chatGptWeb.endSession(conversationId)
  chatGptWeb.discardPlanReviews(conversationId)
}

/** Runtime barrier: confirms only after `active` and the admission operation exit through the actual finally. */
export async function stopChatAndWait(conversationId: string, timeoutMs = 10_000): Promise<boolean> {
  if (typeof conversationId !== 'string') return true
  const run = active.get(conversationId)
  const operation = pendingConversationOperations.get(conversationId)
  stop(conversationId)
  operation?.controller.abort(new Error('Conversation is being migrated'))
  const stopped = await waitForChatShutdown(conversationId, run, operation, timeoutMs)
  await chatGptWeb.endSession(conversationId)
  chatGptWeb.discardPlanReviews(conversationId)
  return stopped
}

/** Account changes never abort BYOK providers; stop and await only official-runtime turns.
 * Scope = physical DEFAULT account: default logout preserves runs already failed over to a slot,
 * unless work remains active on the default account itself (e.g. a subagent). */
async function stopActiveCodexRuns(
  excludeOperations: ReadonlySet<PendingConversationOperation> = new Set()
): Promise<void> {
  cancelPendingCodexOperations(excludeOperations)
  const helperOperations = abortPendingCodexHelperOperations(CODEX_SUBSCRIPTION_PROVIDER_ID, excludeOperations)
  const codexRuns = [...active.entries()].filter(([, run]) =>
    runUsesPhysicalProvider(run, CODEX_SUBSCRIPTION_PROVIDER_ID)
  )
  // A per-thread hard-delete is deferred until the helper barrier below; the account-wide delete must never race
  // an ephemeral operation that still owns the same CODEX_HOME.
  await Promise.all(codexRuns.map(([conversationId, run]) => invalidateActiveRunUsingCodex(conversationId, run, false)))
  await waitForCodexEphemeralAttempts(
    CODEX_SUBSCRIPTION_PROVIDER_ID,
    helperOperations.map((operation) => operation.done)
  )
}

async function resetCodexAccountThreads(
  excludeOperations: ReadonlySet<PendingConversationOperation> = new Set()
): Promise<void> {
  await stopActiveCodexRuns(excludeOperations)
  await deleteAllManagedCodexThreads({ accountId: null })
  resetCodexRateLimitBinding(getCodexSubscriptionManager(), CODEX_SUBSCRIPTION_PROVIDER_ID)
  getSubscriptionFailoverRouter().resetProvider(CODEX_SUBSCRIPTION_PROVIDER_ID)
}

async function resetGitHubCopilotAccountSessions(): Promise<void> {
  cancelPendingGitHubCopilotOperations()
  const runs = [...active.entries()].filter(
    ([, run]) => isGitHubCopilotSubscriptionProvider(run.providerId) && subscriptionAccountId(run.providerId) === null
  )
  await Promise.all(runs.map(([conversationId, run]) => invalidateActiveGitHubCopilotRun(conversationId, run)))
  await deleteAllManagedGitHubCopilotSessions(undefined, { accountId: null })
}

async function resetPhysicalClaudeAccount(providerId: string, accountId: string | null): Promise<void> {
  const operations = new Set(
    [...pendingConversationOperations.values()].filter(
      (operation) => pendingPhysicalProviderId(operation) === providerId
    )
  )
  const attempts = listClaudeAttempts().filter((attempt) => attempt.providerId === providerId)
  for (const attempt of attempts) {
    const operation = attempt.conversationId ? pendingConversationOperations.get(attempt.conversationId) : undefined
    if (operation) operations.add(operation)
    attempt.abort(new Error('Claude account changed'))
  }
  for (const operation of operations) operation.controller.abort(new Error('Claude account changed'))
  getClaudeSubscriptionManager(accountId).abortAllQueries()
  const runs = [...active.entries()].filter(([, run]) => runUsesPhysicalProvider(run, providerId))
  for (const [conversationId, run] of runs) {
    run.allowClaudePersistence = false
    stop(conversationId)
  }
  // Identity mutation must wait for actual finally/release, including helpers before root admission.
  await Promise.all([
    ...[...operations].map((operation) => operation.done),
    ...attempts.map((attempt) => attempt.done),
    ...runs.map(([, run]) => run.done),
  ])
  await deleteAllManagedClaudeSessions(undefined, { accountId })
  getSubscriptionFailoverRouter().resetProvider(providerId)
}

async function resetClaudeAccountSessions(): Promise<void> {
  cancelPendingClaudeOperations()
  await resetPhysicalClaudeAccount(subscriptionProviderIdFor('claude-subscription', null), null)
}

async function resetGrokAccountSessions(): Promise<void> {
  cancelPendingGrokOperations()
  const runs = [...active.entries()].filter(
    ([, run]) => isGrokSubscriptionProvider(run.providerId) && subscriptionAccountId(run.providerId) === null
  )
  await Promise.all(
    runs.map(async ([conversationId, run]) => {
      stop(conversationId)
      await waitForRuns([run])
    })
  )
  invalidateProvider(subscriptionProviderIdFor('grok-subscription', null))
}

/** Identity boundary for an additional SLOT: abort turns PHYSICALLY using the account and delete only its threads/sessions. */
async function resetSubscriptionAccountState(providerId: string, accountId: string): Promise<void> {
  if (isClaudeSubscriptionProvider(providerId)) {
    await resetPhysicalClaudeAccount(providerId, accountId)
    return
  }
  const matchesLogical = (candidate: string | null | undefined) =>
    !!candidate && subscriptionAccountId(candidate) === accountId
  const helperOperations = isCodexSubscriptionProvider(providerId) ? abortPendingCodexHelperOperations(providerId) : []
  for (const [, operation] of pendingConversationOperations) {
    const physical = pendingPhysicalProviderId(operation)
    if (matchesLogical(physical)) operation.controller.abort(new Error('Subscription account changed'))
  }
  const runs = [...active.entries()].filter(([, run]) => {
    if (isCodexSubscriptionProvider(providerId)) {
      return physicalAccountId(run) === accountId || runUsesPhysicalProvider(run, providerId)
    }
    return matchesLogical(run.providerId)
  })
  if (isCodexSubscriptionProvider(providerId)) {
    // The account-wide delete below is the deferred physical cleanup. Do not hard-delete an individual thread
    // before the helper barrier has confirmed that this account's CODEX_HOME is quiescent.
    await Promise.all(runs.map(([conversationId, run]) => invalidateActiveRunUsingCodex(conversationId, run, false)))
    await waitForCodexEphemeralAttempts(
      providerId,
      helperOperations.map((operation) => operation.done)
    )
    await deleteAllManagedCodexThreads({ accountId })
    resetCodexRateLimitBinding(getCodexSubscriptionManager(accountId), providerId)
    getSubscriptionFailoverRouter().resetProvider(providerId)
    return
  }
  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    await Promise.all(runs.map(([conversationId, run]) => invalidateActiveGitHubCopilotRun(conversationId, run)))
    await deleteAllManagedGitHubCopilotSessions(undefined, { accountId })
    return
  }
  if (isGrokSubscriptionProvider(providerId)) {
    await Promise.all(
      runs.map(async ([conversationId, run]) => {
        stop(conversationId)
        await waitForRuns([run])
      })
    )
    invalidateProvider(providerId)
    return
  }
}

// ----------------------------------------------------------------------------
// Login/logout for additional SLOTS (multiple accounts). Deliberately simpler than default-account flows:
// each slot has its own home/credentials and does not share global state machines
// (loginPending/transition) — explicit slot reset is the identity boundary.
// ----------------------------------------------------------------------------

function broadcastCodexAccountAuth(accountId: string, status: CodexSubscriptionAuthStatus): void {
  broadcastCodexAuth({ ...status, accountId })
}

async function loginCodexSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; authUrl?: string; status?: CodexSubscriptionAuthStatus; error?: string }> {
  if (!getSubscriptionAccount(accountId)) return { ok: false, error: 'unknown-account' }
  const providerId = subscriptionProviderIdFor('codex-subscription', accountId)
  const signingIn: CodexSubscriptionAuthStatus = { state: 'signing-in', authenticated: false, accountId }
  try {
    await ensurePackagedProviderAsset('codex-runtime')
    const recovered = await codexAuthStatus(true, undefined, accountId)
    const recoveredWithAccount = { ...recovered, accountId }
    if (recovered.authenticated || recovered.state === 'signed-in') {
      broadcastCodexAccountAuth(accountId, recoveredWithAccount)
      return { ok: true, status: recoveredWithAccount }
    }
    if (recovered.state !== 'signed-out') {
      broadcastCodexAccountAuth(accountId, recoveredWithAccount)
      return {
        ok: false,
        error: recovered.error || 'ChatGPT account is unavailable.',
        status: recoveredWithAccount,
      }
    }
    broadcastCodexAccountAuth(accountId, signingIn)
    await resetSubscriptionAccountState(providerId, accountId)
    const manager = getCodexSubscriptionManager(accountId)
    const attempt = await manager.startLogin()
    void manager
      .waitForLogin(attempt.loginId)
      .then(async (completion) => {
        if (!completion.success) {
          broadcastCodexAccountAuth(accountId, {
            state: 'error',
            authenticated: false,
            error: completion.error || 'ChatGPT login failed.',
          })
          return
        }
        const status = await codexAuthStatus(true, undefined, accountId)
        broadcastCodexAccountAuth(accountId, status)
      })
      .catch((error) => {
        broadcastCodexAccountAuth(accountId, {
          state: 'error',
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return { ok: true, authUrl: attempt.authUrl ?? undefined, status: signingIn }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed: CodexSubscriptionAuthStatus = { state: 'error', authenticated: false, error: message, accountId }
    broadcastCodexAccountAuth(accountId, failed)
    return { ok: false, error: message, status: failed }
  }
}

async function logoutCodexSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; status?: CodexSubscriptionAuthStatus; error?: string }> {
  const providerId = subscriptionProviderIdFor('codex-subscription', accountId)
  try {
    await resetSubscriptionAccountState(providerId, accountId)
    try {
      await getCodexSubscriptionManager(accountId).logout()
    } finally {
      await deleteAllManagedCodexThreads({ accountId })
    }
    const status = await codexAuthStatus(true, undefined, accountId)
    broadcastCodexAccountAuth(accountId, status)
    return { ok: true, status: { ...status, accountId } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function broadcastGitHubCopilotAccountAuth(accountId: string, status: ChatSubscriptionAuthStatus): void {
  broadcastGitHubCopilotAuth({ ...status, accountId })
}

async function loginGitHubCopilotSubscriptionAccount(accountId: string): Promise<{
  ok: boolean
  verificationUrl?: string
  userCode?: string
  status?: ChatSubscriptionAuthStatus
  error?: string
}> {
  if (!getSubscriptionAccount(accountId)) return { ok: false, error: 'unknown-account' }
  const providerId = subscriptionProviderIdFor('github-copilot-subscription', accountId)
  const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false, accountId }
  const manager = getGitHubCopilotSubscriptionManager(accountId)
  try {
    await ensurePackagedProviderAsset('github-copilot-runtime')
    const recovered = await githubCopilotAuthStatus(true, accountId)
    const recoveredWithAccount = { ...recovered, accountId }
    if (recovered.authenticated || recovered.state === 'signed-in') {
      broadcastGitHubCopilotAccountAuth(accountId, recoveredWithAccount)
      return { ok: true, status: recoveredWithAccount }
    }
    if (recovered.state !== 'signed-out') {
      broadcastGitHubCopilotAccountAuth(accountId, recoveredWithAccount)
      return {
        ok: false,
        error: recovered.error || 'GitHub Copilot account is unavailable.',
        status: recoveredWithAccount,
      }
    }
    broadcastGitHubCopilotAccountAuth(accountId, signingIn)
    await resetSubscriptionAccountState(providerId, accountId)
    await manager.resetLocalData()
    const attempt = await manager.startLogin()
    void manager
      .waitForLogin(attempt.loginId)
      .then(async (completion) => {
        if (!completion.success) {
          broadcastGitHubCopilotAccountAuth(accountId, {
            state: 'error',
            authenticated: false,
            error: completion.error?.message ?? 'GitHub Copilot login failed.',
          })
          return
        }
        broadcastGitHubCopilotAccountAuth(accountId, await githubCopilotAuthStatus(true, accountId))
      })
      .catch((error) => {
        broadcastGitHubCopilotAccountAuth(accountId, {
          state: 'error',
          authenticated: false,
          error: githubCopilotErrorMessage(error),
        })
      })
    return {
      ok: true,
      verificationUrl: attempt.verificationUriComplete ?? attempt.verificationUri,
      userCode: attempt.userCode,
      status: signingIn,
    }
  } catch (error) {
    const failed: ChatSubscriptionAuthStatus = {
      state: 'error',
      authenticated: false,
      error: githubCopilotErrorMessage(error),
      accountId,
    }
    broadcastGitHubCopilotAccountAuth(accountId, failed)
    return { ok: false, error: failed.error, status: failed }
  }
}

async function logoutGitHubCopilotSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; status?: ChatSubscriptionAuthStatus; error?: string }> {
  const providerId = subscriptionProviderIdFor('github-copilot-subscription', accountId)
  const manager = getGitHubCopilotSubscriptionManager(accountId)
  try {
    // Session hard-delete must happen while the slot token still exists.
    await resetSubscriptionAccountState(providerId, accountId)
    await manager.resetLocalData()
    const status = await githubCopilotAuthStatus(true, accountId)
    broadcastGitHubCopilotAccountAuth(accountId, status)
    return { ok: true, status: { ...status, accountId } }
  } catch (error) {
    return { ok: false, error: githubCopilotErrorMessage(error) }
  }
}

function broadcastClaudeAccountAuth(accountId: string, status: ChatSubscriptionAuthStatus): void {
  broadcastClaudeAuth({ ...status, accountId })
}

async function loginClaudeSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; status?: ChatSubscriptionAuthStatus; error?: string }> {
  if (!getSubscriptionAccount(accountId)) return { ok: false, error: 'unknown-account' }
  const providerId = subscriptionProviderIdFor('claude-subscription', accountId)
  if (claudeSlotTransitions.has(providerId)) return { ok: false, error: 'busy' }
  claudeSlotTransitions.add(providerId)
  const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false, accountId }
  broadcastClaudeAccountAuth(accountId, signingIn)
  const manager = getClaudeSubscriptionManager(accountId)
  void (async () => {
    await resetSubscriptionAccountState(providerId, accountId)
    const completion = await manager.login()
    if (!completion.ok || !completion.status.authenticated) {
      broadcastClaudeAccountAuth(accountId, {
        state: completion.status.available ? 'error' : 'unavailable',
        authenticated: false,
        error: completion.error ?? completion.status.error ?? 'Claude login did not complete.',
      })
      return
    }
    await deleteAllManagedClaudeSessions(undefined, { accountId })
    broadcastClaudeAccountAuth(accountId, toClaudeAuthStatus(completion.status, accountId))
  })()
    .catch((error) => {
      broadcastClaudeAccountAuth(accountId, {
        state: 'error',
        authenticated: false,
        error: claudeSubscriptionErrorMessage(error),
      })
    })
    .finally(() => claudeSlotTransitions.delete(providerId))
  return { ok: true, status: signingIn }
}

async function logoutClaudeSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; status?: ChatSubscriptionAuthStatus; error?: string }> {
  const providerId = subscriptionProviderIdFor('claude-subscription', accountId)
  if (claudeSlotTransitions.has(providerId)) return { ok: false, error: 'busy' }
  claudeSlotTransitions.add(providerId)
  const manager = getClaudeSubscriptionManager(accountId)
  manager.cancelLogin()
  try {
    await resetSubscriptionAccountState(providerId, accountId)
    const completion = await manager.logout()
    const status: ChatSubscriptionAuthStatus = { ...toClaudeAuthStatus(completion.status, accountId), accountId }
    broadcastClaudeAccountAuth(accountId, status)
    return { ok: completion.ok, status, ...(completion.error ? { error: completion.error } : {}) }
  } catch (error) {
    return { ok: false, error: claudeSubscriptionErrorMessage(error) }
  } finally {
    claudeSlotTransitions.delete(providerId)
  }
}

function broadcastGrokAccountAuth(accountId: string, status: ChatSubscriptionAuthStatus): void {
  broadcastGrokAuth({ ...status, accountId })
}

async function loginGrokSubscriptionAccount(
  accountId: string,
  method: GrokLoginMethod = 'browser'
): Promise<{
  ok: boolean
  authUrl?: string
  verificationUrl?: string
  userCode?: string
  status?: ChatSubscriptionAuthStatus
  error?: string
}> {
  if (!getSubscriptionAccount(accountId)) return { ok: false, error: 'unknown-account' }
  const providerId = subscriptionProviderIdFor('grok-subscription', accountId)
  const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false, accountId }
  broadcastGrokAccountAuth(accountId, signingIn)
  const manager = getGrokSubscriptionManager(accountId)
  try {
    await resetSubscriptionAccountState(providerId, accountId)
    await manager.resetLocalData()
    invalidateProvider(providerId)
    const attempt = await manager.startLogin(method)
    void manager
      .waitForLogin(attempt.loginId)
      .then(async (completion) => {
        if (!completion.success) {
          broadcastGrokAccountAuth(accountId, {
            state: 'error',
            authenticated: false,
            error: completion.error?.message ?? 'Grok login failed.',
          })
          return
        }
        invalidateProvider(providerId)
        broadcastGrokAccountAuth(accountId, await grokAuthStatus(true, accountId))
      })
      .catch((error) => {
        broadcastGrokAccountAuth(accountId, {
          state: 'error',
          authenticated: false,
          error: grokSubscriptionErrorMessage(error),
        })
      })
    return {
      ok: true,
      ...(attempt.authUrl ? { authUrl: attempt.authUrl } : {}),
      ...(attempt.verificationUriComplete || attempt.verificationUri
        ? { verificationUrl: attempt.verificationUriComplete ?? attempt.verificationUri ?? undefined }
        : {}),
      ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
      status: signingIn,
    }
  } catch (error) {
    const failed: ChatSubscriptionAuthStatus = {
      state: 'error',
      authenticated: false,
      error: grokSubscriptionErrorMessage(error),
      accountId,
    }
    broadcastGrokAccountAuth(accountId, failed)
    return { ok: false, error: failed.error, status: failed }
  }
}

async function logoutGrokSubscriptionAccount(
  accountId: string
): Promise<{ ok: boolean; status?: ChatSubscriptionAuthStatus; error?: string }> {
  const providerId = subscriptionProviderIdFor('grok-subscription', accountId)
  const manager = getGrokSubscriptionManager(accountId)
  try {
    await resetSubscriptionAccountState(providerId, accountId)
    await manager.resetLocalData()
    invalidateProvider(providerId)
    const status = await grokAuthStatus(true, accountId)
    broadcastGrokAccountAuth(accountId, status)
    return { ok: true, status: { ...status, accountId } }
  } catch (error) {
    return { ok: false, error: grokSubscriptionErrorMessage(error) }
  }
}

/** Completely removes an additional SLOT: logout/home cleanup + threads/sessions + defaults + slot. */
async function removeSubscriptionAccountSlot(accountId: string): Promise<{ ok: boolean; error?: string }> {
  const account = getSubscriptionAccount(accountId)
  if (!account) return { ok: false, error: 'unknown-account' }
  const providerId = subscriptionProviderIdFor(account.kind, accountId)
  if (account.kind === 'claude-subscription') {
    if (claudeSlotTransitions.has(providerId)) return { ok: false, error: 'busy' }
    claudeSlotTransitions.add(providerId)
  }
  try {
    await resetSubscriptionAccountState(providerId, accountId)
    if (account.kind === 'codex-subscription') {
      await getCodexSubscriptionManager(accountId)
        .resetLocalData()
        .catch(() => undefined)
    } else if (account.kind === 'github-copilot-subscription') {
      await getGitHubCopilotSubscriptionManager(accountId)
        .resetLocalData()
        .catch(() => undefined)
    } else if (account.kind === 'grok-subscription') {
      await getGrokSubscriptionManager(accountId)
        .resetLocalData()
        .catch(() => undefined)
      invalidateProvider(providerId)
    } else {
      await getClaudeSubscriptionManager(accountId)
        .wipe()
        .catch(() => undefined)
    }
    // Remove references only after physical teardown finishes; on failure, the slot and route
    // remain consistent for retry.
    removeAccountFromFailoverConfig(providerId)
    removeSubscriptionAccount(accountId)
    // Clear the global default if it points to the removed provider (same policy as BYOK provider-remove).
    if (getAppSetting(CHAT_DEFAULT_PROVIDER_KEY) === providerId) {
      setAppSetting(CHAT_DEFAULT_PROVIDER_KEY, '')
      setAppSetting(CHAT_DEFAULT_MODEL_KEY, '')
      setAppSetting(CHAT_DEFAULT_REASONING_KEY, 'off')
    }
    notifyChatRunnerCapabilityChanges(true)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    claudeSlotTransitions.delete(providerId)
  }
}

async function deleteSubscriptionStateForConversation(
  conversationId: string,
  signal?: AbortSignal,
  options: { preserveClaude?: boolean } = {}
): Promise<void> {
  await Promise.all([
    deleteCodexThreadForConversation(conversationId, { signal }),
    deleteGitHubCopilotSessionForConversation(conversationId),
    ...(options.preserveClaude ? [] : [deleteClaudeSessionForConversation(conversationId)]),
  ])
}

/** Selection alone is reversible; only a committed turn retires cursors owned by a different runtime. */
async function retireIncompatibleSubscriptionState(
  conversationId: string,
  targetProviderId: string,
  signal?: AbortSignal
): Promise<void> {
  if (isCodexSubscriptionProvider(targetProviderId)) {
    await Promise.all([
      deleteGitHubCopilotSessionForConversation(conversationId),
      deleteClaudeSessionForConversation(conversationId),
    ])
    return
  }
  if (isGitHubCopilotSubscriptionProvider(targetProviderId)) {
    await Promise.all([
      deleteCodexThreadForConversation(conversationId, { signal }),
      deleteClaudeSessionForConversation(conversationId),
    ])
    return
  }
  if (isClaudeSubscriptionProvider(targetProviderId)) {
    await Promise.all([
      deleteCodexThreadForConversation(conversationId, { signal }),
      deleteGitHubCopilotSessionForConversation(conversationId),
    ])
    return
  }
  await deleteSubscriptionStateForConversation(conversationId, signal)
}

const COMPACT_SYSTEM =
  'You summarize programming conversations to preserve context when the history gets long. Produce a CONCISE ' +
  "summary (Markdown) in the same language as the conversation, preserving: the user's goal, decided approaches " +
  'and decisions, the current state of the work, relevant files/symbols/commands and the pending next steps. Do ' +
  'NOT invent anything outside the conversation and do NOT answer the last message — just summarize. When the ' +
  'input is already a set of summaries, consolidate all of them without dropping unique facts.'

/**
 * Summarizes active context. Manual/pre-send persists a milestone message; mid-turn returns a summary for the
 * runner to insert the boundary at the exact live-bubble position. Original history remains visible in the UI.
 */
interface CompactOpts {
  allowActive?: boolean
  signal?: AbortSignal
  persist?: boolean
  contextWindow?: number
  claudeFailoverChain?: readonly string[]
  claudeExecutionAxes?: Pick<ClaudeRuntimeTarget, 'reasoningEffort' | 'fastMode'>
  operation?: PendingConversationOperation
  /** Mid-turn compaction of an isolated execution (review-loop): reads only the execution transcript. */
  executionId?: string
  /** Frozen profile (never selectionFor/live prefs). */
  selectionOverride?: FrozenChatSelection
  /** Behavior and canonical identity already frozen by an active turn admission. */
  behaviorProfile?: ClaudeBehaviorProfile | null
  resolvedModelId?: string
  /** Never retires the main conversation's native binding. */
  skipRetireBinding?: boolean
}

/**
 * A textual boundary makes all previous native context obsolete. Invalidate the binding immediately
 * after persisting the milestone so no reconnect can skip the portable summary. Failed remote hard-deletes
 * remain in tombstones; local invalidation has already happened and does not undo successful compaction.
 */
async function retireNativeBindingAfterPortableCompaction(
  conversationId: string,
  providerId: string,
  signal?: AbortSignal
): Promise<void> {
  if (isCodexSubscriptionProvider(providerId)) {
    await deleteCodexThreadForConversation(conversationId, { signal }).catch(() => undefined)
  } else if (isGitHubCopilotSubscriptionProvider(providerId)) {
    await deleteGitHubCopilotSessionForConversation(conversationId)
  } else if (isClaudeSubscriptionProvider(providerId)) {
    await deleteClaudeSessionForConversation(conversationId)
  }
}

async function compact(
  conversationId: string,
  opts: CompactOpts = {}
): Promise<{
  ok: boolean
  error?: string
  summary?: string
  usage?: NormalizedAiUsage
  runtimeEstimatedCostUsd?: number
}> {
  if (opts.allowActive) return compactReserved(conversationId, opts)
  const providerId = selectionFor(conversationId)?.providerId ?? null
  const operation = reserveConversationOperation(conversationId, providerId, opts.operation)
  if (!operation) return { ok: false, error: 'busy' }
  const signal = opts.signal ? AbortSignal.any([opts.signal, operation.controller.signal]) : operation.controller.signal
  try {
    return await compactReserved(conversationId, { ...opts, signal, operation })
  } finally {
    releaseConversationOperation(conversationId, operation)
  }
}

/** Exported for isolated compaction frozen-profile tests (review-loop). */
export async function compactReserved(
  conversationId: string,
  opts: CompactOpts = {}
): Promise<{
  ok: boolean
  error?: string
  summary?: string
  usage?: NormalizedAiUsage
  runtimeEstimatedCostUsd?: number
}> {
  const conv = getConversation(conversationId)
  if (!conv) return { ok: false, error: 'invalid-conversation' }
  if (!opts.allowActive && active.has(conversationId)) return { ok: false, error: 'busy' }
  // Mid-turn round compaction carries the full FROZEN profile (reasoning/fastMode/identity);
  // the normal path rereads the live selection.
  const frozen = opts.selectionOverride ?? null
  const selection = frozen
    ? {
        providerId: frozen.providerId,
        modelId: frozen.modelId,
      }
    : selectionFor(conversationId)
  if (!selection?.providerId || !selection.modelId) return { ok: false, error: 'no-model' }
  const compactClaudeChain = isClaudeSubscriptionProvider(selection.providerId)
    ? frozen
      ? [selection.providerId]
      : (opts.claudeFailoverChain ?? freezeFailoverChain(selection.providerId))
    : []
  let compactResolvedModelId = opts.resolvedModelId ?? frozen?.resolvedModelId
  let compactClaudeTarget: ClaudeRuntimeTarget | undefined
  if (isClaudeSubscriptionProvider(selection.providerId) && !frozen) {
    const prefs = getConvUiPrefs(conversationId).chat
    const resolved = await resolveClaudeRuntimeTarget({
      logicalProviderId: selection.providerId,
      modelId: selection.modelId,
      runtimeModelId: compactResolvedModelId,
      reasoningEffort: opts.claudeExecutionAxes ? opts.claudeExecutionAxes.reasoningEffort : prefs?.reasoning,
      fastMode: opts.claudeExecutionAxes ? opts.claudeExecutionAxes.fastMode : prefs?.fastMode === true,
      chain: compactClaudeChain,
      attemptedProviderIds: new Set(),
      admit: false,
      signal: opts.signal ?? new AbortController().signal,
    })
    if (!resolved.ok) return { ok: false, error: resolved.message }
    compactClaudeTarget = resolved.target
    if (opts.operation) opts.operation.effectiveProviderId = resolved.target.providerId
    if (resolved.target.availabilityLease)
      getSubscriptionFailoverRouter().confirmAttemptOther(resolved.target.providerId, resolved.target.availabilityLease)
    compactResolvedModelId = resolved.target.runtimeModelId
  }
  const compactBehaviorResolution = resolveClaudeBehaviorProfile({
    requestedModelId: selection.modelId,
    resolvedModelId: compactResolvedModelId,
    fableEnabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
    opusEnabled: getAppFlag(OPUS_5_PROFILE_FLAG, true),
    frozen: frozen != null,
    frozenProfileId: frozen?.behaviorProfileId,
  })
  if (compactBehaviorResolution.reason === 'frozen-profile-mismatch') {
    return { ok: false, error: 'executor-unavailable' }
  }
  const compactBehaviorProfile =
    opts.behaviorProfile === undefined ? compactBehaviorResolution.profile : opts.behaviorProfile
  const compactSystem = compileClaudeCompactionSystem(COMPACT_SYSTEM, compactBehaviorProfile)
  const history = opts.executionId
    ? listExecutionContextMessages(conversationId, opts.executionId)
    : listConversationContextMessages(conversationId)
  const historySnapshot = JSON.stringify(history)
  const assertHistoryUnchanged = () => {
    const latest = opts.executionId
      ? listExecutionContextMessages(conversationId, opts.executionId)
      : listConversationContextMessages(conversationId)
    if (JSON.stringify(latest) !== historySnapshot) {
      throw new Error('Conversation changed while context was being compacted; compact again on the latest history.')
    }
  }
  const activeContext = activeChatContext(history)
  // Manual/pre-send retains the old two-message gate; mid-turn allows a suffix of the active bubble.
  if (opts.persist !== false && !opts.allowActive && activeContext.messages.length < 2) {
    return { ok: false, error: 'too-short' }
  }
  let observedClaudeUsage: NormalizedAiUsage | undefined
  let observedClaudeCost = 0
  let observedClaudeCostKnown = false
  let observedClaudeCostComplete = true
  try {
    const compactSignal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(10 * 60_000)])
      : AbortSignal.timeout(10 * 60_000)
    const contextWindow =
      opts.contextWindow ??
      (compactClaudeTarget
        ? (compactClaudeTarget.contextWindow ?? undefined)
        : (await effectiveModelMeta(selection.modelId, selection.providerId, compactSignal)).meta?.contextWindow)
    const compactAccountId = subscriptionAccountId(selection.providerId)
    // Frozen profile: revalidate identity/availability IMMEDIATELY before any summary
    // call. Account/credential changes during the round ABORT compaction (the turn ends) — never
    // fall back to live credentials. Same semantics as revalidateReviewLoopSelection between rounds.
    if (frozen) {
      const revalidated = await revalidateReviewLoopSelection(frozen)
      if (!revalidated.ok) return { ok: false, error: revalidated.error }
    }
    // The chunker below alone splits the payload; no transcript range is omitted.
    const transcript = renderTranscript(history, { maxToolOutputChars: Number.POSITIVE_INFINITY })
    if (!transcript) return { ok: false, error: 'too-short' }
    const maxChunkChars = contextWindow
      ? Math.max(
          24_000,
          Math.min(400_000, Math.floor((contextWindow - portableContextReserveTokens(contextWindow)) * 2))
        )
      : 240_000

    let summarize: Parameters<typeof summarizePortableTranscript>[2]
    if (isCodexSubscriptionProvider(selection.providerId)) {
      if (!compactAccountId && codexIdentityTransitionPending) return { ok: false, error: 'no-key' }
      summarize = (prompt) =>
        runCodexEphemeralWithFailover({
          logicalProviderId: selection.providerId,
          modelId: selection.modelId,
          signal: compactSignal,
          scope: 'helper',
          conversationId,
          extractAttemptUsage: extractIsolatedSummaryAttemptUsage,
          mergeAttemptUsage: mergeIsolatedSummaryAttemptUsage,
          operation: async (target, operationSignal) =>
            summarizeWithCodexRuntime({
              client: target.client,
              cwd: conv.cwd,
              modelId: target.runtimeModelId,
              system: compactSystem,
              prompt,
              signal: operationSignal,
              conversationId,
              accountId: target.accountId ?? compactAccountId ?? null,
              ...(frozen?.reasoningEffort
                ? { effort: frozen.reasoningEffort }
                : target.reasoningEffort
                  ? { effort: target.reasoningEffort }
                  : {}),
              ...(frozen?.serviceTier !== undefined
                ? { serviceTier: frozen.serviceTier }
                : target.serviceTier !== undefined
                  ? { serviceTier: target.serviceTier }
                  : {}),
            }),
        })
    } else if (isGitHubCopilotSubscriptionProvider(selection.providerId)) {
      const status = await githubCopilotAuthStatus(true, compactAccountId)
      if (!status.authenticated) return { ok: false, error: 'no-key' }
      const manager = getGitHubCopilotSubscriptionManager(compactAccountId)
      const identity = manager.getAccountIdentity()
      if (!identity.fingerprint) return { ok: false, error: 'no-key' }
      summarize = (prompt) =>
        summarizeWithGitHubCopilotRuntime({
          manager,
          // Frozen profile: OPAQUE identity from freeze (summarizer aborts on account change) + round reasoning.
          accountIdentity: frozen
            ? {
                fingerprint: frozen.identityFingerprint ?? identity.fingerprint,
                epoch: frozen.identityEpoch ?? identity.epoch,
              }
            : identity,
          conversationId,
          cwd: conv.cwd,
          modelId: selection.modelId,
          system: compactSystem,
          prompt,
          signal: compactSignal,
          // Frozen profile: round's EFFECTIVE EFFORT (after resolving Ultra; never raw or live prefs).
          ...(frozen?.reasoningEffort ? { effort: frozen.reasoningEffort } : {}),
        })
    } else if (isClaudeSubscriptionProvider(selection.providerId)) {
      if (!frozen) {
        const chain = compactClaudeChain
        summarize = (prompt) =>
          runClaudeEphemeralWithFailover({
            logicalProviderId: selection.providerId,
            modelId: selection.modelId,
            runtimeModelId: compactResolvedModelId,
            reasoningEffort: compactClaudeTarget?.reasoningEffort,
            fastMode: compactClaudeTarget?.fastMode === true,
            chain,
            signal: compactSignal,
            conversationId,
            extractAttemptUsage: extractIsolatedSummaryAttemptUsage,
            mergeAttemptUsage: mergeIsolatedSummaryAttemptUsage,
            onAttemptUsage: ({ target, attempt, usage, runtimeEstimatedCostUsd }) => {
              observedClaudeUsage ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
              for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'totalInput'] as const)
                observedClaudeUsage[key] += usage[key]
              if (runtimeEstimatedCostUsd != null) {
                observedClaudeCost += runtimeEstimatedCostUsd
                observedClaudeCostKnown = true
              } else if (usage.totalInput || usage.output) observedClaudeCostComplete = false
              recordModelCallUsage({
                runtime: 'claude-subscription',
                providerId: target.providerId,
                modelId: target.runtimeModelId,
                conversationId,
                agent: 'portable-compaction',
                attempt,
                usage,
              })
            },
            operation: (target, signal) =>
              summarizeWithClaudeRuntime({
                manager: target.manager,
                accountIdentity: target.accountIdentity,
                cwd: conv.cwd,
                modelId: target.runtimeModelId,
                system: compactSystem,
                prompt,
                signal,
                effort: target.reasoningEffort,
                fastMode: target.fastMode,
              }),
          })
      } else {
        if (!compactAccountId && (claudeLoginPending || claudeIdentityTransitionPromise))
          return { ok: false, error: 'no-key' }
        const manager = getClaudeSubscriptionManager(compactAccountId)
        const status = await manager.status({ refresh: true })
        if (!status.authenticated || !status.accountFingerprint) return { ok: false, error: 'no-key' }
        const identity = frozen
          ? {
              // Frozen profile: identity from freeze (summarizer assertAccountIdentity aborts if changed).
              fingerprint: frozen.identityFingerprint ?? status.accountFingerprint,
              epoch: frozen.identityEpoch ?? status.accountEpoch,
            }
          : {
              fingerprint: status.accountFingerprint,
              epoch: status.accountEpoch,
            }
        summarize = (prompt) =>
          summarizeWithClaudeRuntime({
            manager,
            accountIdentity: identity,
            cwd: conv.cwd,
            // Frozen profile: use the effective ID resolved at freeze, never the mutable conversation alias.
            modelId: frozen?.resolvedModelId ?? selection.modelId,
            system: compactSystem,
            prompt,
            signal: compactSignal,
            // Frozen profile: round's EFFECTIVE EFFORT (after resolving Ultra; never raw or live prefs);
            // normal path rereads prefs (current behavior).
            effort: frozen ? frozen.reasoningEffort : getConvUiPrefs(conversationId).chat?.reasoning,
            // Frozen profile: carry effective Fast Mode; manual path keeps current options.
            ...(frozen ? { fastMode: frozen.fastMode } : {}),
          })
      }
    } else {
      if (isGrokSubscriptionProvider(selection.providerId)) {
        if (!compactAccountId && (grokLoginPending || grokIdentityTransitionPromise))
          return { ok: false, error: 'no-key' }
        const status = await grokAuthStatus(true, compactAccountId)
        if (!status.authenticated) return { ok: false, error: 'no-key' }
        const identity = getGrokSubscriptionManager(compactAccountId).getAccountIdentity()
        if (!identity.fingerprint) return { ok: false, error: 'no-key' }
      } else if (!hasApiKey(selection.providerId)) {
        return { ok: false, error: 'no-model' }
      }
      const model = await resolveLanguageModel(selection.providerId, selection.modelId)
      // Frozen profile: serialize EFFECTIVE EFFORT already validated at freeze (buildProviderOptionsForSentEffort),
      // without revalidating against mutable/null metadata — the SAME value sent by the main turn. 'off'/absent
      // → no effort. Normal (manual) path: no override (current behavior).
      const compactProviderOptions = frozen
        ? buildProviderOptionsForSentEffort(
            getProviderKind(getProvider(selection.providerId)),
            frozen.reasoningEffort ?? null
          )
        : buildProviderOptions(getProviderKind(getProvider(selection.providerId)), undefined, null)
      // Frozen profile (Grok): round fastMode → priority service_tier (same runner contract).
      const frozenFastModeOptions = frozen
        ? applyFastModeServiceTier(compactProviderOptions, frozen.fastMode, selection.providerId)
        : compactProviderOptions
      summarize = async (prompt) => {
        const result = await generateText({
          model,
          system: compactSystem,
          prompt,
          abortSignal: compactSignal,
          ...(frozenFastModeOptions ? { providerOptions: frozenFastModeOptions } : {}),
        })
        return { text: result.text ?? '', usage: normalizeAiUsage(result.totalUsage) }
      }
    }

    const compacted = await summarizePortableTranscript(transcript, maxChunkChars, summarize)
    const summary = compacted.summary
    const usage = compacted.usage
    if (opts.persist !== false) {
      const marker: ChatMessage = {
        id: randomUUID(),
        conversationId,
        role: 'assistant',
        parts: [{ type: 'compaction', id: randomUUID(), text: summary, strategy: 'summary' }],
        model: selection,
        usage:
          usage && (usage.totalInput || usage.output)
            ? {
                usageVersion: 2,
                input: usage.input,
                output: usage.output,
                ...(usage.cacheRead ? { cachedInput: usage.cacheRead } : {}),
                ...(usage.cacheCreate ? { cacheCreate: usage.cacheCreate } : {}),
                contextInput: estimateTextTokens(summary),
                contextOutput: 0,
                ...(contextWindow ? { modelContextWindow: contextWindow } : {}),
                ...(compacted.runtimeEstimatedCostUsd != null
                  ? { runtimeEstimatedCostUsd: compacted.runtimeEstimatedCostUsd }
                  : {}),
                billingOnly: true,
              }
            : {
                usageVersion: 2,
                input: 0,
                output: 0,
                contextInput: estimateTextTokens(summary),
                contextOutput: 0,
                ...(contextWindow ? { modelContextWindow: contextWindow } : {}),
                billingOnly: true,
              },
        createdAt: Date.now(),
      }
      transaction(() => {
        assertHistoryUnchanged()
        upsertChatMessage(marker)
      })
      // Isolated compaction NEVER retires the main conversation binding (or writes a main milestone — persist:false).
      if (!opts.skipRetireBinding && !opts.executionId) {
        await retireNativeBindingAfterPortableCompaction(conversationId, selection.providerId, compactSignal)
      }
    }
    return {
      ok: true,
      summary,
      usage,
      // AGGREGATED native helper-call estimate (only when complete) — the runner adds it to
      // turn cost; without it, compactor token pricing still depends on the catalog.
      ...(compacted.runtimeEstimatedCostUsd != null
        ? { runtimeEstimatedCostUsd: compacted.runtimeEstimatedCostUsd }
        : {}),
    }
  } catch (e) {
    const usage = observedClaudeUsage ?? extractIsolatedSummaryAttemptUsage(e)
    const partialCost = observedClaudeCostKnown
      ? observedClaudeCostComplete
        ? observedClaudeCost
        : undefined
      : (e as { runtimeEstimatedCostUsd?: number } | null)?.runtimeEstimatedCostUsd
    return {
      ok: false,
      error: e instanceof ChatConfigError ? e.message : e instanceof Error ? e.message : String(e),
      ...(usage ? { usage } : {}),
      ...(typeof partialCost === 'number' && Number.isFinite(partialCost) && partialCost >= 0
        ? { runtimeEstimatedCostUsd: partialCost }
        : {}),
    }
  }
}

// Dependencies captured at registration for internal turns outside the normal IPC flow.
let savedDeps: ChatIpcDeps | null = null

// ----------------------------------------------------------------------------
// Automatic review loop (ChatGPT Web reviewer → Maestrly Chat executor).
// Internal automated-turn API: create the handle at ActiveRun ADMISSION (never via `active.get`
// after start — race), freeze selection (no auto-fallback), and return a structured outcome.
// ----------------------------------------------------------------------------

/** Validates conversation loop boundaries: cli=chat, no active turn/operation, no pending plan. */
export async function validateReviewLoopStart(
  conversationId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const conv = getConversation(conversationId)
  if (!conv) return { ok: false, error: 'invalid-conversation' }
  // Review-loop executor turns are intentionally forced to Agent. A Maestro conversation can never cross
  // that legacy path because its parent capability boundary is structural, not a mutable chat-mode preference.
  if (conv.experience === 'maestro') return { ok: false, error: 'maestro-experience' }
  if (lookupReviewLoopByConversation(conversationId)) return { ok: false, error: 'review-loop-active' }
  if (chatGptWeb.projectEnvironmentLockFor(conversationId)) {
    return { ok: false, error: 'no-turn-or-operation' }
  }
  if (active.has(conversationId) || pendingConversationOperations.has(conversationId)) {
    return { ok: false, error: 'no-turn-or-operation' }
  }
  if (getPendingPlan(conversationId)) return { ok: false, error: 'pending-plan' }
  return { ok: true }
}

/** Resolves the CURRENT profile (provider+model+reasoning+fastMode+identity) to FREEZE for the loop. No silent fallback. */
export async function resolveReviewLoopSelection(
  conversationId: string
): Promise<{ ok: true; selection: FrozenChatSelection } | { ok: false; error: string }> {
  const selection = selectionFor(conversationId)
  if (!selection?.providerId) return { ok: false, error: 'no-provider' }
  const accountId = subscriptionAccountId(selection.providerId)
  let modelId = selection.modelId
  if (!modelId) {
    if (isCodexSubscriptionProvider(selection.providerId)) {
      const models = await getCodexSubscriptionManager(accountId).listModels()
      modelId = (models.find((model) => model.isDefault) ?? models[0])?.id ?? ''
    } else if (isClaudeSubscriptionProvider(selection.providerId)) {
      const models = await getClaudeSubscriptionManager(accountId).listModels()
      modelId = models[0]?.value ?? ''
    } else if (isGitHubCopilotSubscriptionProvider(selection.providerId)) {
      const models = await getGitHubCopilotSubscriptionManager(accountId).listModels(true)
      modelId = models.find((model) => model.policy?.state !== 'disabled')?.id ?? ''
    } else if (isGrokSubscriptionProvider(selection.providerId)) {
      const models = await getGrokSubscriptionManager(accountId).listModels(true)
      modelId = models[0]?.id ?? ''
    } else {
      const models = await fetchModels(selection.providerId)
      modelId = models[0] ?? ''
    }
    if (!modelId) return { ok: false, error: 'no-model' }
  }
  // Availability + opaque identity: revalidate NOW; if changed later, end the loop with executor_unavailable
  // instead of silently switching model/account.
  let identityFingerprint: string | undefined
  let identityEpoch: number | undefined
  let providerFingerprint: string | undefined
  let serviceTier: string | undefined
  let resolvedModelId: string | undefined
  let claudeModelForFreeze: ClaudeModelInfo | undefined
  if (isCodexSubscriptionProvider(selection.providerId)) {
    const status = await codexAuthStatus(false, undefined, accountId)
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    identityFingerprint = codexAccountFingerprint(status)
    // ADDITIONAL slots bypass the default-account epoch machine (codexAuthStatus): the global epoch
    // is NOT their boundary — only the slot fingerprint (and explicit slot login/removal flows) is.
    if (!accountId) identityEpoch = codexAccountUpdateEpoch
  } else if (isGitHubCopilotSubscriptionProvider(selection.providerId)) {
    const status = await githubCopilotAuthStatus(false, accountId)
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    const identity = getGitHubCopilotSubscriptionManager(accountId).getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    identityFingerprint = identity.fingerprint
    identityEpoch = identity.epoch
  } else if (isClaudeSubscriptionProvider(selection.providerId)) {
    const manager = getClaudeSubscriptionManager(accountId)
    const status = await manager.status({ refresh: false })
    if (!status.authenticated || !status.accountFingerprint) return { ok: false, error: 'no-key' }
    identityFingerprint = status.accountFingerprint
    identityEpoch = status.accountEpoch
    const models = await manager.listModels(undefined, true)
    claudeModelForFreeze = models.find((model) => model.value === modelId || model.resolvedModel === modelId)
    if (!claudeModelForFreeze) return { ok: false, error: 'no-model' }
    resolvedModelId = claudeModelForFreeze.resolvedModel ?? claudeModelForFreeze.value
  } else if (isGrokSubscriptionProvider(selection.providerId)) {
    const manager = getGrokSubscriptionManager(accountId)
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    identityFingerprint = identity.fingerprint
    identityEpoch = identity.epoch
    try {
      providerFingerprint = manager.resolveRuntimeCredential().fingerprint
    } catch {
      return { ok: false, error: 'no-key' }
    }
  } else if (!hasApiKey(selection.providerId)) {
    return { ok: false, error: 'no-key' }
  } else {
    try {
      providerFingerprint = resolveChatModel(selection.providerId, modelId).providerFingerprint
    } catch {
      /* BYOK without a resolvable fingerprint: proceed with only provider/model frozen. */
    }
  }
  const chatPrefs = getConvUiPrefs(conversationId).chat
  const reasoning = chatPrefs?.reasoning
  const fastMode = chatPrefs?.fastMode === true
  if (isCodexSubscriptionProvider(selection.providerId)) {
    const manager = getCodexSubscriptionManager(accountId)
    const preferred = await manager.preferredServiceTier(modelId, true)
    // Freeze the exact value sent to the app-server, including the explicit Standard sentinel.
    serviceTier = fastMode && preferred ? preferred : 'default'
  }
  // Freeze the reasoning axis EFFECT: effort that WILL be sent (after translating Ultra + validating against
  // CURRENT capabilities). Rounds require LIVE resolution to produce the SAME value — effort lists
  // may change and raw sentinels (e.g. Ultra) do not capture effective values. Without evidence of support
  // (empty list/missing metadata) for non-off, the loop does NOT start (fail-closed, executor_unavailable).
  let reasoningEffort: string | undefined
  if (reasoning && reasoning !== 'off') {
    let frozenEffort: string | null = null
    if (isCodexSubscriptionProvider(selection.providerId)) {
      const manager = getCodexSubscriptionManager(accountId)
      const models = await manager.listModels(true)
      const codexModel = models.find((model) => model.id === modelId || model.model === modelId)
      frozenEffort = resolveFrozenSentEffort({
        reasoning,
        supportedEfforts: codexModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? [],
      })
    } else if (isGitHubCopilotSubscriptionProvider(selection.providerId)) {
      const manager = getGitHubCopilotSubscriptionManager(accountId)
      const models = await manager.listModels(true)
      const copilotModel = models.find((model) => model.id === modelId)
      frozenEffort = resolveFrozenSentEffort({
        reasoning,
        supportedEfforts: copilotModel?.supportedReasoningEfforts ?? [],
        // The official runner serializes only low|medium|high|xhigh — never freeze an effort it would omit.
        serializableEfforts: GITHUB_COPILOT_SERIALIZABLE_EFFORTS,
      })
    } else if (isClaudeSubscriptionProvider(selection.providerId)) {
      const claudeModel = claudeModelForFreeze
      frozenEffort =
        claudeModel?.supportsEffort === true
          ? resolveFrozenSentEffort({ reasoning, supportedEfforts: claudeModel.supportedEffortLevels ?? [] })
          : null
    } else {
      // BYOK/Grok: the runner validates against catalog metadata (same source as the turn).
      const selectedProvider = getProvider(selection.providerId)
      const catalogProviderId = selectedProvider ? catalogProviderForBaseURL(selectedProvider.baseURL) : null
      const meta = await getProviderModelMeta(modelId, catalogProviderId)
      frozenEffort =
        meta?.reasoning === true
          ? resolveFrozenSentEffort({ reasoning, supportedEfforts: meta.reasoningEfforts ?? [] })
          : null
    }
    if (frozenEffort === null) return { ok: false, error: 'no-model' }
    reasoningEffort = frozenEffort
  }
  const behaviorProfile = resolveClaudeBehaviorProfile({
    requestedModelId: modelId,
    resolvedModelId,
    fableEnabled: getAppFlag(FABLE_51_PROFILE_FLAG, true),
    opusEnabled: getAppFlag(OPUS_5_PROFILE_FLAG, true),
  }).profile
  return {
    ok: true,
    selection: {
      providerId: selection.providerId,
      modelId,
      // ALWAYS materialize the reasoning axis (including 'off'/default): the loop never rereads live ui_prefs.
      reasoning: reasoning && reasoning !== 'off' ? reasoning : 'off',
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      fastMode,
      ...(serviceTier ? { serviceTier } : {}),
      ...(resolvedModelId ? { resolvedModelId } : {}),
      behaviorProfileId: behaviorProfile?.id ?? null,
      ...(identityFingerprint ? { identityFingerprint } : {}),
      ...(typeof identityEpoch === 'number' ? { identityEpoch } : {}),
      ...(providerFingerprint ? { providerFingerprint } : {}),
    },
  }
}

/**
 * Effective turn reasoning effort. With a frozen profile (loop), the frozen value ALWAYS wins —
 * including 'off'/default (older profiles without the field = 'off'); NEVER reread live ui_prefs. Without a profile,
 * reread prefs (normal behavior). SINGLE source for native runtimes — the BYOK runner receives the same
 * contract via `reasoningOverride` (service.ts) and `resolveTurnReasoning` (runner.ts).
 */
export function turnReasoning(
  conversationId: string,
  frozenProfile: FrozenChatSelection | undefined
): string | undefined {
  return frozenProfile ? (frozenProfile.reasoning ?? 'off') : getConvUiPrefs(conversationId).chat?.reasoning
}

/**
 * Resolves effective native-runtime effort (Codex/Copilot) with the SAME semantics as the turn.
 * `strict` (isolated review-loop execution): reproduce the frozen profile EXACTLY —
 * ok:false for unsupported levels / ultra without known levels, instead of substituting
 * `defaultEffort` (fail-closed). Manual turns remain permissive (default fallback).
 */
export function resolveNativeReasoningEffort(input: {
  requestedEffort: string | undefined
  supportedEfforts: readonly string[]
  defaultEffort: string | undefined
  strict: boolean
}): { ok: true; reasoningEffort?: string; maestrlyUltra: boolean } | { ok: false } {
  const { requestedEffort, supportedEfforts, defaultEffort, strict } = input
  if (!requestedEffort || requestedEffort === 'off') return { ok: true, maestrlyUltra: false }
  if (strict) {
    // Fail-closed: empty list = no evidence (NEVER pass through); unlisted levels and Ultra without levels
    // also fail — reproduce the frozen value exactly (resolveFrozenSentEffort).
    const sent = resolveFrozenSentEffort({ reasoning: requestedEffort, supportedEfforts })
    return sent !== null
      ? { ok: true, reasoningEffort: sent, maestrlyUltra: isMaestrlyUltraEffort(requestedEffort, supportedEfforts) }
      : { ok: false }
  }
  const maestrlyUltra = isMaestrlyUltraEffort(requestedEffort, supportedEfforts)
  if (maestrlyUltra) {
    if (supportedEfforts.length) {
      return { ok: true, reasoningEffort: resolveUltraEffort([...supportedEfforts]), maestrlyUltra }
    }
    return { ok: true, reasoningEffort: defaultEffort, maestrlyUltra }
  }
  if (supportedEfforts.length === 0 || supportedEfforts.includes(requestedEffort)) {
    return { ok: true, reasoningEffort: requestedEffort, maestrlyUltra: false }
  }
  return { ok: true, reasoningEffort: defaultEffort, maestrlyUltra: false }
}

function frozenReasoningIsActive(frozen: FrozenChatSelection): boolean {
  return Boolean(frozen.reasoning && frozen.reasoning !== 'off')
}

/** Compares the frozen effective EFFECT with current capabilities without implicit defaults. */
function frozenEffortMatchesLiveCapabilities(
  frozen: FrozenChatSelection,
  supportedEfforts: readonly string[],
  serializableEfforts?: readonly string[]
): boolean {
  // 'off'/absent sends no override and is reproducible even without metadata.
  if (!frozenReasoningIsActive(frozen)) return true
  if (!frozen.reasoningEffort) return false
  return (
    resolveFrozenSentEffort({
      reasoning: frozen.reasoning!,
      supportedEfforts,
      ...(serializableEfforts ? { serializableEfforts } : {}),
    }) === frozen.reasoningEffort
  )
}

/** Same source as freeze/main for BYOK and Grok: catalog capability metadata. */
async function revalidateGenericFrozenEffort(frozen: FrozenChatSelection): Promise<boolean> {
  if (!frozenReasoningIsActive(frozen)) return true
  try {
    const provider = getProvider(frozen.providerId)
    const catalogProviderId = provider ? catalogProviderForBaseURL(provider.baseURL) : null
    const meta = await getProviderModelMeta(frozen.modelId, catalogProviderId)
    const advertised = meta?.reasoningEfforts ?? []
    const efforts =
      resolveChatHarnessMetadata(frozen.providerId, frozen.modelId, {
        astraHarnessEnabled: getAppFlag('chat.astraHarness', true),
      }).modelHarnessProfileId === 'openai-gpt-6-astra-v1'
        ? advertised.filter((effort) => OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts.includes(effort))
        : advertised
    return meta?.reasoning === true && frozenEffortMatchesLiveCapabilities(frozen, efforts)
  } catch {
    return false
  }
}

/**
 * Revalidates FROZEN profile identity/availability between rounds.
 * Any fingerprint/epoch change → executor_unavailable (never silently switch model/account).
 */
export async function revalidateReviewLoopSelection(
  frozen: FrozenChatSelection
): Promise<{ ok: true } | { ok: false; error: string }> {
  const behaviorResolution = resolveClaudeBehaviorProfile({
    requestedModelId: frozen.modelId,
    resolvedModelId: frozen.resolvedModelId,
    frozen: true,
    frozenProfileId: frozen.behaviorProfileId,
  })
  if (behaviorResolution.reason === 'frozen-profile-mismatch') {
    return { ok: false, error: 'executor-unavailable' }
  }
  const accountId = subscriptionAccountId(frozen.providerId)
  if (isCodexSubscriptionProvider(frozen.providerId)) {
    const status = await codexAuthStatus(false, undefined, accountId)
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    if (frozen.identityFingerprint && codexAccountFingerprint(status) !== frozen.identityFingerprint) {
      return { ok: false, error: 'executor-unavailable' }
    }
    // Global epoch applies only to the DEFAULT account; additional slots are not invalidated by default-account
    // login/logout (also guards older freezes that carried the epoch).
    if (!accountId && typeof frozen.identityEpoch === 'number' && frozen.identityEpoch !== codexAccountUpdateEpoch) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (frozen.serviceTier) {
      try {
        const preferred = await getCodexSubscriptionManager(accountId).preferredServiceTier(frozen.modelId, true)
        const liveServiceTier = frozen.fastMode && preferred ? preferred : 'default'
        if (liveServiceTier !== frozen.serviceTier) return { ok: false, error: 'executor-unavailable' }
      } catch {
        return { ok: false, error: 'executor-unavailable' }
      }
    }
    if (frozenReasoningIsActive(frozen)) {
      try {
        const models = await getCodexSubscriptionManager(accountId).listModels(true)
        const model = models.find((entry) => entry.id === frozen.modelId || entry.model === frozen.modelId)
        if (
          !model ||
          !frozenEffortMatchesLiveCapabilities(
            frozen,
            model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
          )
        ) {
          return { ok: false, error: 'executor-unavailable' }
        }
      } catch {
        return { ok: false, error: 'executor-unavailable' }
      }
    }
    return { ok: true }
  }
  if (isGitHubCopilotSubscriptionProvider(frozen.providerId)) {
    const status = await githubCopilotAuthStatus(false, accountId)
    if (!status.authenticated) return { ok: false, error: 'no-key' }
    const identity = getGitHubCopilotSubscriptionManager(accountId).getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    if (frozen.identityFingerprint && identity.fingerprint !== frozen.identityFingerprint) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (typeof frozen.identityEpoch === 'number' && identity.epoch !== frozen.identityEpoch) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (frozenReasoningIsActive(frozen)) {
      try {
        const models = await getGitHubCopilotSubscriptionManager(accountId).listModels(true)
        const model = models.find((entry) => entry.id === frozen.modelId)
        if (
          !model ||
          !frozenEffortMatchesLiveCapabilities(
            frozen,
            model.supportedReasoningEfforts ?? [],
            GITHUB_COPILOT_SERIALIZABLE_EFFORTS
          )
        ) {
          return { ok: false, error: 'executor-unavailable' }
        }
      } catch {
        return { ok: false, error: 'executor-unavailable' }
      }
    }
    return { ok: true }
  }
  if (isClaudeSubscriptionProvider(frozen.providerId)) {
    const manager = getClaudeSubscriptionManager(accountId)
    const status = await manager.status({ refresh: false })
    if (!status.authenticated || !status.accountFingerprint) return { ok: false, error: 'no-key' }
    if (frozen.identityFingerprint && status.accountFingerprint !== frozen.identityFingerprint) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (typeof frozen.identityEpoch === 'number' && status.accountEpoch !== frozen.identityEpoch) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (frozen.resolvedModelId) {
      try {
        const liveResolvedModelId = await manager.resolveModelId(frozen.modelId, undefined, true)
        if (liveResolvedModelId !== frozen.resolvedModelId) return { ok: false, error: 'executor-unavailable' }
      } catch {
        return { ok: false, error: 'executor-unavailable' }
      }
    }
    if (frozenReasoningIsActive(frozen) || frozen.fastMode) {
      try {
        const models = await manager.listModels(undefined, true)
        const model = models.find((entry) => entry.value === frozen.modelId || entry.resolvedModel === frozen.modelId)
        if (!model) return { ok: false, error: 'executor-unavailable' }
        const axes = claudeRuntimeAxes(
          'review-loop-revalidation',
          model,
          frozen.reasoning ?? 'off',
          frozen.fastMode,
          true
        )
        if (!axes.frozenReproducible || axes.reasoningEffort !== frozen.reasoningEffort) {
          return { ok: false, error: 'executor-unavailable' }
        }
      } catch {
        return { ok: false, error: 'executor-unavailable' }
      }
    }
    return { ok: true }
  }
  if (isGrokSubscriptionProvider(frozen.providerId)) {
    const manager = getGrokSubscriptionManager(accountId)
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) return { ok: false, error: 'no-key' }
    if (frozen.identityFingerprint && identity.fingerprint !== frozen.identityFingerprint) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (typeof frozen.identityEpoch === 'number' && identity.epoch !== frozen.identityEpoch) {
      return { ok: false, error: 'executor-unavailable' }
    }
    if (frozen.providerFingerprint) {
      try {
        if (manager.resolveRuntimeCredential().fingerprint !== frozen.providerFingerprint) {
          return { ok: false, error: 'executor-unavailable' }
        }
      } catch {
        return { ok: false, error: 'no-key' }
      }
    }
    if (!(await revalidateGenericFrozenEffort(frozen))) {
      return { ok: false, error: 'executor-unavailable' }
    }
    return { ok: true }
  }
  if (!hasApiKey(frozen.providerId)) return { ok: false, error: 'no-key' }
  if (frozen.providerFingerprint) {
    try {
      if (resolveChatModel(frozen.providerId, frozen.modelId).providerFingerprint !== frozen.providerFingerprint) {
        return { ok: false, error: 'executor-unavailable' }
      }
    } catch {
      return { ok: false, error: 'executor-unavailable' }
    }
  }
  if (!(await revalidateGenericFrozenEffort(frozen))) {
    return { ok: false, error: 'executor-unavailable' }
  }
  return { ok: true }
}

/**
 * Starts an automated INTERNAL turn (one review-loop round). Create the handle in the SAME tick as
 * ActiveRun admission; cancellation before admission aborts the run as soon as it exists.
 */
export async function startInternalChatTurn(input: {
  conversationId: string
  prompt: string
  hiddenParts?: MessagePart[]
  selection: FrozenChatSelection
  source: ReviewLoopSource
  role?: ReviewLoopRole
  turnPolicy?: ReviewLoopTurnPolicy
  cwdActivityOwner?: string
  reviewerRuntime?: ReviewerToolRuntime
  executorConversationId?: string
  reviewerConversationId?: string
  loopId: string
  iteration: number
  maxIterations: number
  signal: AbortSignal
}): Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }> {
  if (!savedDeps) return { ok: false, error: 'Chat service not initialized' }
  if (getConversation(input.conversationId)?.experience === 'maestro') {
    return { ok: false, error: 'maestro-experience' }
  }
  const wc = getMainWebContents()
  if (!wc) return { ok: false, error: 'Window unavailable' }
  if (input.signal?.aborted) return { ok: false, error: 'cancelled' }
  const role = input.role ?? 'executor'
  const turnPolicy = input.turnPolicy ?? 'executor-agent'
  if (input.source === 'maestrly-review-loop') {
    const reservation = lookupReviewLoopByConversation(input.conversationId)
    const expectedConversationId =
      role === 'executor' ? reservation?.participants.executor : reservation?.participants.reviewer
    const expectedPolicy = role === 'reviewer' ? 'reviewer-readonly' : 'executor-agent'
    const expectedOwner = `review-loop:${input.loopId}:${role}`
    if (
      reservation?.loopId !== input.loopId ||
      reservation.driver !== 'maestrly-pair' ||
      expectedConversationId !== input.conversationId ||
      input.executorConversationId !== reservation.participants.executor ||
      input.reviewerConversationId !== reservation.participants.reviewer ||
      turnPolicy !== expectedPolicy ||
      (role === 'reviewer') !== Boolean(input.reviewerRuntime) ||
      input.cwdActivityOwner !== expectedOwner
    ) {
      return { ok: false, error: 'review-loop-policy-mismatch' }
    }
  } else if (role !== 'executor' || turnPolicy !== 'executor-agent' || input.reviewerRuntime) {
    return { ok: false, error: 'review-loop-policy-mismatch' }
  }
  const executionId = randomUUID()
  let admitted = false
  let resolveHandle!: (handle: InternalTurnHandle) => void
  const handlePromise = new Promise<InternalTurnHandle>((resolve) => {
    resolveHandle = resolve
  })
  const entry: InternalTurnEntry = {
    run: null,
    cancelRequested: false,
    cancel: () => {
      if (entry.cancelRequested) return
      entry.cancelRequested = true
      if (entry.run) {
        entry.run.controller.abort()
        getBroker().rejectConversation(input.conversationId)
        getQuestionBroker().rejectConversation(input.conversationId)
      }
    },
    resolveHandle,
  }
  internalTurns.set(executionId, entry)
  // Connect external cancellation (loop Stop) to the entry BEFORE preflight: abort the run if admitted;
  // if still in preflight, startSend's admission barrier sees the aborted signal and rejects the turn.
  const onExternalAbort = () => entry.cancel()
  input.signal.addEventListener('abort', onExternalAbort, { once: true })
  const result = await startSend(savedDeps, wc, input.conversationId, input.prompt, undefined, {
    internal: true,
    hiddenParts: input.hiddenParts ?? [],
    internalLoop: {
      executionId,
      loopId: input.loopId,
      iteration: input.iteration,
      maxIterations: input.maxIterations,
      role,
      turnPolicy,
      source: input.source,
      ...(input.cwdActivityOwner ? { cwdActivityOwner: input.cwdActivityOwner } : {}),
      ...(input.reviewerRuntime ? { reviewerRuntime: input.reviewerRuntime } : {}),
      ...(input.executorConversationId ? { executorConversationId: input.executorConversationId } : {}),
      ...(input.reviewerConversationId ? { reviewerConversationId: input.reviewerConversationId } : {}),
      selectionOverride: input.selection,
      contextPolicy: 'isolated',
      providerSessionPolicy: 'ephemeral',
      signal: input.signal,
      onAdmitted: (run) => {
        admitted = true
        entry.run = run
        if (entry.cancelRequested) run.controller.abort()
        resolveHandle({
          executionId,
          conversationId: input.conversationId,
          assistantMessageId: () => run.messageId || null,
          done: run.outcome,
          cancel: () => entry.cancel(),
        })
        // The entry is TRANSIENT: remove it on terminal outcome (success/error/cancelled), along with the
        // external abort listener. Compare by identity: never delete a replacement entry.
        void run.outcome.finally(() => {
          invalidateUnifiedUsageCache()
          if (internalTurns.get(executionId) === entry) internalTurns.delete(executionId)
          input.signal.removeEventListener('abort', onExternalAbort)
        })
      },
    },
  })
  if (!result.ok) {
    input.signal.removeEventListener('abort', onExternalAbort)
    // Never leave the handle promise pending (teardown/retry): resolve with an inert handle.
    if (!admitted) {
      resolveHandle({
        executionId,
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        done: Promise.resolve({ status: 'cancelled', assistantMessageId: null }),
        cancel: () => undefined,
      })
    }
    internalTurns.delete(executionId)
    return { ok: false as const, error: result.error ?? 'unknown-error' }
  }
  return { ok: true, handle: await handlePromise }
}

/** Cancels an internal turn by executionId (loop Stop / session shutdown). */
export function cancelInternalChatTurn(executionId: string): void {
  internalTurns.get(executionId)?.cancel()
}

/** Diagnostics (tests): internal turns still awaiting a terminal outcome. */
export function pendingInternalTurnsCount(): number {
  return internalTurns.size
}

/**
 * Persists the auditable final review-loop summary in the conversation (own source; does not reopen Plan).
 * STABLE messageId per loopId → retries upsert the same message, never create another.
 * The `review-summary` scope keeps the summary visible/auditable but outside inference context and the
 * resume/binding boundary (the store excludes everything except legacy/kind=conversation).
 */
export async function persistReviewLoopSummary(input: {
  conversationId: string
  loopId: string
  markdown: string
  role?: ReviewLoopRole
  executorConversationId?: string
  reviewerConversationId?: string
}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const { conversationId, loopId, markdown } = input
  if (!getConversation(conversationId)) return { ok: false, error: 'conversation-not-found' }
  // Deterministic ID: retries of the same loop_id collide on upsert, never duplicate the message.
  const messageId = input.role ? `review-loop-summary:${loopId}:${input.role}` : `review-loop-summary:${loopId}`
  try {
    upsertChatMessage({
      id: messageId,
      conversationId,
      role: 'assistant',
      parts: [{ type: 'text', id: `${messageId}:text`, text: markdown }],
      source: input.role ? 'maestrly-review-loop' : 'chatgpt-web-review-loop',
      executionScope: {
        kind: 'review-summary',
        loopId,
        ...(input.role ? { role: input.role } : {}),
        ...(input.executorConversationId ? { executorConversationId: input.executorConversationId } : {}),
        ...(input.reviewerConversationId ? { reviewerConversationId: input.reviewerConversationId } : {}),
      },
      createdAt: Date.now(),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const wc = getMainWebContents()
    if (wc && !wc.isDestroyed()) {
      wc.send(
        input.role ? `chat:review-loop:delivery:${conversationId}` : `chat:chatgpt-web:delivery:${conversationId}`,
        { messageId }
      )
    }
  } catch {
    // Renderer notification is best-effort: the message is ALREADY stored (upsert succeeded). Retry
    // resends the same ID, and the renderer reconciles without duplication.
  }
  return { ok: true, messageId }
}

/** Forces Agent mode at loop start (the executor never runs in Plan) and notifies the renderer. */
export function forceReviewLoopAgentMode(conversationId: string): void {
  if (getConversation(conversationId)?.experience === 'maestro') return
  if (modeFor(conversationId) !== 'agent') {
    setChatMode(conversationId, 'agent')
    getMainWebContents()?.send(`chat:mode:${conversationId}`, 'agent')
  }
}

function pairedReviewLoops(): ConversationReviewLoopCoordinator {
  if (pairedReviewLoopCoordinator) return pairedReviewLoopCoordinator
  pairedReviewLoopCoordinator = createConversationReviewLoopCoordinator({
    getConversation,
    listConversations: listAllConversations,
    canonicalCwd,
    validateStart: validateReviewLoopStart,
    resolveSelection: resolveReviewLoopSelection,
    revalidateSelection: (_conversationId, selection) => revalidateReviewLoopSelection(selection),
    startTurn: (input) =>
      startInternalChatTurn({
        conversationId: input.conversationId,
        prompt: input.prompt,
        hiddenParts: input.hiddenParts,
        selection: input.selection,
        source: input.source,
        role: input.role,
        turnPolicy: input.turnPolicy,
        cwdActivityOwner: input.cwdActivityOwner,
        loopId: input.loopId,
        iteration: input.iteration,
        maxIterations: input.maxIterations,
        signal: input.signal,
        reviewerRuntime: input.reviewerRuntime,
        executorConversationId: input.executorConversationId,
        reviewerConversationId: input.reviewerConversationId,
      }),
    acquireLease: (cwd, owner, allowedOwners) => tryAcquireLongCwdLease(cwd, owner, allowedOwners),
    registry: {
      reserve: (reservation) => {
        const result = reserveReviewLoop({
          loopId: reservation.loopId,
          driver: reservation.driver,
          cwd: reservation.cwd,
          participants: [
            { driver: reservation.driver, conversationId: reservation.participants.executor },
            { driver: reservation.driver, conversationId: reservation.participants.reviewer },
          ],
        })
        return result.ok ? { ok: true as const } : { ok: false as const, error: 'review-loop-active' }
      },
      release: (loopId) => {
        releaseReviewLoop(loopId)
      },
      lockFor: lookupReviewLoopByConversation,
    },
    searchExecutionContext: (conversationId, input) => searchCompanionConversation(conversationId, input),
    readExecutionContext: (conversationId, input) => readCompanionConversation(conversationId, input),
    getExecutionBrief: (conversationId) => getCompanionConversationContext(conversationId),
    persistSummary: (input) => persistReviewLoopSummary(input),
    onChange: broadcastReviewLoopStatus,
    reviewerPrompt: () => tFor(getLocale(), 'prompts')('reviewLoop.pairedReviewerRound'),
    executorPrompt: ({ iteration, maxIterations }) =>
      tFor(getLocale(), 'prompts')('reviewLoop.pairedImplementFindings', {
        iteration,
        max: maxIterations,
      }),
  })
  return pairedReviewLoopCoordinator
}

/** Registers all `chat:*` channels. Called from `registerIpc()` in index.ts. */
export function registerChatIpc(deps: ChatIpcDeps): void {
  savedDeps = deps
  markInterruptedSubagentSessions()
  if (!subagentSessionUnsubscribe) {
    subagentSessionUnsubscribe = onSubagentSessionChanged((event) => {
      const subscribers = chatSubscribersByConversation.get(event.conversationId)
      if (!subscribers) return
      for (const wc of subscribers.keys()) {
        if (!wc.isDestroyed()) wc.send(`chat:subagent-session:${event.conversationId}`, event)
      }
    })
  }
  registerPerformanceCache('tool-images', () => ({
    id: 'tool-images',
    kind: 'binary-image-lru',
    oldestAgeMs: null,
    ...getEphemeralToolImageCacheSnapshot(),
  }))
  getBroker() // Ensure broker + wiring.
  registerSubagentProfileIpc(deps)
  registerMaestroIpc(deps, { getGlobalOrchestratorProfile: getGlobalMaestroOrchestratorProfile })
  deps.mhandle('chat:maestro:convert-to-standard', (_event, conversationId: unknown) =>
    typeof conversationId === 'string'
      ? convertMaestroConversationToStandard(conversationId)
      : ({ ok: false, error: 'invalid-conversation' } satisfies MaestroToStandardResult)
  )
  deps.mhandle('chat:standard:convert-to-maestro', (_event, conversationId: unknown) =>
    typeof conversationId === 'string'
      ? convertStandardConversationToMaestro(conversationId)
      : ({ ok: false, error: 'invalid-conversation' } satisfies StandardToMaestroResult)
  )
  registerMaestroConfiguratorIpc(deps)
  registerSubscriptionUsageIpc(deps)
  if (!codexAccountUpdatedUnsubscribe) {
    const manager = getCodexSubscriptionManager()
    const subscribe = (manager as Partial<Pick<typeof manager, 'onAccountUpdated'>>).onAccountUpdated
    if (typeof subscribe === 'function') {
      codexAccountUpdatedUnsubscribe = subscribe.call(manager, handleExternalCodexAccountUpdated)
    }
  }
  if (!githubCopilotAuthUpdatedUnsubscribe) {
    githubCopilotAuthUpdatedUnsubscribe =
      getGitHubCopilotSubscriptionManager().onAuthUpdated(handleGitHubCopilotAuthUpdated)
  }
  if (!claudeAuthenticationRequiredUnsubscribe) {
    const manager = getClaudeSubscriptionManager()
    const subscribe = (manager as Partial<Pick<typeof manager, 'onAuthenticationRequired'>>).onAuthenticationRequired
    if (typeof subscribe === 'function') {
      claudeAuthenticationRequiredUnsubscribe = subscribe.call(manager, handleClaudeAuthenticationRequired)
    }
  }
  if (!grokAuthUpdatedUnsubscribe) {
    grokAuthUpdatedUnsubscribe = getGrokSubscriptionManager().onAuthUpdated(handleGrokAuthUpdated)
  }
  // Boot: isolated review-loop executions without a terminal outcome → interrupted (crash/restart).
  // Do not resume loops automatically; preserve usage; leave main bindings untouched.
  try {
    reconcileInterruptedExecutionMessages()
  } catch {
    // Best-effort: an old DB / partial schema must not prevent chat startup.
  }
  try {
    reconcileInterruptedMaestroLiveRuns()
  } catch {
    // Best-effort: the live inbox must never prevent chat startup.
  }

  // The live stream is opt-in per renderer and conversation. Counts stay in MAIN to support multiple
  // consumers in one WebContents; cleanup on `destroyed` prevents orphan subscriptions.
  deps.mon('chat:subscribe', (event, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return
    subscribeChatStream(event.sender, conversationId)
  })
  deps.mon('chat:unsubscribe', (event, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return
    unsubscribeChatStream(event.sender, conversationId)
  })

  deps.mhandle('chat:config', () => buildConfig())
  deps.mhandle(
    'chat:codex-subscription:status',
    async (_event, payload?: { refresh?: boolean; accountId?: string | null }) => {
      const accountId = normalizeAccountId(payload?.accountId)
      if (!validSubscriptionAccountId('codex-subscription', accountId)) {
        return { state: 'unavailable', authenticated: false, accountId } satisfies CodexSubscriptionAuthStatus
      }
      const status = await codexAuthStatus(payload?.refresh === true, undefined, accountId)
      return accountId ? { ...status, accountId } : status
    }
  )
  deps.mhandle('chat:codex-subscription:login', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('codex-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return loginCodexSubscriptionAccount(accountId)
    try {
      await ensurePackagedProviderAsset('codex-runtime')
      // Do not run identity reconciliation from this preflight: it is a read-only guard against resetting an
      // already-authenticated account, not a new authoritative admission/status cycle.
      const recovered = toCodexAuthStatus(await getCodexSubscriptionManager().getStatus(true))
      if (recovered.authenticated || recovered.state === 'signed-in') {
        broadcastCodexAuth(recovered)
        return { ok: true, status: recovered }
      }
      if (recovered.state !== 'signed-out') {
        broadcastCodexAuth(recovered)
        return { ok: false, error: recovered.error || 'ChatGPT account is unavailable.', status: recovered }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedStatus: CodexSubscriptionAuthStatus = { state: 'error', authenticated: false, error: message }
      broadcastCodexAuth(failedStatus)
      return { ok: false, error: message, status: failedStatus }
    }
    codexAccountUpdateEpoch += 1
    const loginGeneration = ++codexLoginGeneration
    codexLoginPending = true
    codexIdentityTransitionPending = true
    const status: CodexSubscriptionAuthStatus = { state: 'signing-in', authenticated: false }
    broadcastCodexAuth(status)
    try {
      // Identity boundary: stop old turns and delete threads/bindings BEFORE starting another OAuth flow.
      await resetCodexAccountThreads()
      const manager = getCodexSubscriptionManager()
      const attempt = await manager.startLogin()
      codexIdentityTransitionPending = false
      void manager
        .waitForLogin(attempt.loginId)
        .then(async (completion) => {
          if (loginGeneration !== codexLoginGeneration) return
          codexIdentityTransitionPending = true
          if (!completion.success) {
            // DEFAULT ACCOUNT boundary: without this scope, additional slots' threads would also be deleted.
            await deleteAllManagedCodexThreads({ accountId: null })
            codexLoginPending = false
            codexIdentityTransitionPending = false
            broadcastCodexAuth({
              state: 'error',
              authenticated: false,
              error: completion.error || 'ChatGPT login failed.',
            })
            return
          }
          // Guard against an old turn completing at the shutdown timeout boundary.
          await resetCodexAccountThreads()
          codexLoginPending = false
          const authenticatedStatus = await codexAuthStatus(true)
          codexIdentityTransitionPending = false
          broadcastCodexAuth(authenticatedStatus)
        })
        .catch(async (error) => {
          if (loginGeneration !== codexLoginGeneration) return
          codexIdentityTransitionPending = true
          await deleteAllManagedCodexThreads({ accountId: null })
          codexLoginPending = false
          codexIdentityTransitionPending = false
          broadcastCodexAuth({
            state: 'error',
            authenticated: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return { ok: true, authUrl: attempt.authUrl ?? undefined, status }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedStatus: CodexSubscriptionAuthStatus = {
        state: 'error',
        authenticated: false,
        error: message,
      }
      if (loginGeneration === codexLoginGeneration) {
        codexLoginPending = false
        codexIdentityTransitionPending = false
        broadcastCodexAuth(failedStatus)
      }
      return { ok: false, error: message, status: failedStatus }
    }
  })
  deps.mhandle('chat:codex-subscription:logout', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('codex-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return logoutCodexSubscriptionAccount(accountId)
    codexAccountUpdateEpoch += 1
    codexLoginGeneration += 1
    codexLoginPending = false
    codexIdentityTransitionPending = true
    try {
      await resetCodexAccountThreads()
      try {
        await getCodexSubscriptionManager().logout()
      } finally {
        // Even if the logout RPC fails, no local binding for the previous identity may survive.
        // Scope = default account: its logout must not delete additional slots' context.
        await deleteAllManagedCodexThreads({ accountId: null })
      }
      const status = await codexAuthStatus(true)
      codexIdentityTransitionPending = false
      broadcastCodexAuth(status)
      return { ok: true, status }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      codexIdentityTransitionPending = false
    }
  })
  deps.mhandle(
    'chat:github-copilot-subscription:status',
    async (_event, payload?: { refresh?: boolean; accountId?: string | null }) => {
      const accountId = normalizeAccountId(payload?.accountId)
      if (!validSubscriptionAccountId('github-copilot-subscription', accountId)) {
        return { state: 'unavailable', authenticated: false, accountId } satisfies ChatSubscriptionAuthStatus
      }
      const status = await githubCopilotAuthStatus(payload?.refresh === true, accountId)
      if (!accountId && status.authenticated) await retryManagedGitHubCopilotSessionCleanup().catch(() => undefined)
      return accountId ? { ...status, accountId } : status
    }
  )
  deps.mhandle('chat:github-copilot-subscription:login', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('github-copilot-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return loginGitHubCopilotSubscriptionAccount(accountId)
    if (githubCopilotLoginPending || githubCopilotIdentityTransitionPromise)
      return { ok: false, error: 'GitHub Copilot account transition is still in progress.' }
    try {
      await ensurePackagedProviderAsset('github-copilot-runtime')
      const recovered = await githubCopilotAuthStatus(true)
      if (recovered.authenticated || recovered.state === 'signed-in') {
        broadcastGitHubCopilotAuth(recovered)
        return { ok: true, status: recovered }
      }
      if (recovered.state !== 'signed-out') {
        broadcastGitHubCopilotAuth(recovered)
        return { ok: false, error: recovered.error || 'GitHub Copilot account is unavailable.', status: recovered }
      }
    } catch (error) {
      const failedStatus: ChatSubscriptionAuthStatus = {
        state: 'error',
        authenticated: false,
        error: githubCopilotErrorMessage(error),
      }
      broadcastGitHubCopilotAuth(failedStatus)
      return { ok: false, error: failedStatus.error, status: failedStatus }
    }
    const generation = ++githubCopilotAuthGeneration
    githubCopilotLoginPending = true
    const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false }
    broadcastGitHubCopilotAuth(signingIn)
    const manager = getGitHubCopilotSubscriptionManager()
    let attempt: Awaited<ReturnType<typeof manager.startLogin>> | undefined
    // Assign the barrier before the first await so no send/compact/second login can enter on the old identity.
    const transition = Promise.resolve().then(async () => {
      await resetGitHubCopilotAccountSessions()
      // API deletion is best-effort and bounded; the app-owned home is the local privacy boundary.
      await manager.resetLocalData()
      if (generation !== githubCopilotAuthGeneration) throw new Error('GitHub Copilot login was superseded')
      attempt = await manager.startLogin()
    })
    githubCopilotIdentityTransitionPromise = transition
    try {
      await transition
      if (!attempt || generation !== githubCopilotAuthGeneration) {
        throw new Error('GitHub Copilot login was superseded')
      }
      const loginAttempt = attempt
      void manager
        .waitForLogin(loginAttempt.loginId)
        .then(async (completion) => {
          if (generation !== githubCopilotAuthGeneration) return
          if (!completion.success) {
            githubCopilotLoginPending = false
            broadcastGitHubCopilotAuth({
              state: 'error',
              authenticated: false,
              error: completion.error?.message ?? 'GitHub Copilot login failed.',
            })
            return
          }
          // The OAuth completion changed the manager identity. Keep a fresh barrier while the status snapshot is
          // reconciled; `loginPending` can drop only after that barrier is already visible to admission paths.
          const finalization = Promise.resolve().then(async () => {
            if (generation !== githubCopilotAuthGeneration) return
            githubCopilotLoginPending = false
            const status = await githubCopilotAuthStatus(true)
            if (generation === githubCopilotAuthGeneration) broadcastGitHubCopilotAuth(status)
          })
          githubCopilotIdentityTransitionPromise = finalization
          try {
            await finalization
          } finally {
            if (githubCopilotIdentityTransitionPromise === finalization) {
              githubCopilotIdentityTransitionPromise = null
            }
          }
        })
        .catch((error) => {
          if (generation !== githubCopilotAuthGeneration) return
          githubCopilotLoginPending = false
          broadcastGitHubCopilotAuth({
            state: 'error',
            authenticated: false,
            error: githubCopilotErrorMessage(error),
          })
        })
      return {
        ok: true,
        verificationUrl: loginAttempt.verificationUriComplete ?? loginAttempt.verificationUri,
        userCode: loginAttempt.userCode,
        status: signingIn,
      }
    } catch (error) {
      if (generation === githubCopilotAuthGeneration) githubCopilotLoginPending = false
      const failedStatus: ChatSubscriptionAuthStatus = {
        state: 'error',
        authenticated: false,
        error: githubCopilotErrorMessage(error),
      }
      if (generation === githubCopilotAuthGeneration) broadcastGitHubCopilotAuth(failedStatus)
      return { ok: false, error: failedStatus.error, status: failedStatus }
    } finally {
      if (githubCopilotIdentityTransitionPromise === transition) githubCopilotIdentityTransitionPromise = null
    }
  })
  deps.mhandle('chat:github-copilot-subscription:logout', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('github-copilot-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return logoutGitHubCopilotSubscriptionAccount(accountId)
    if (githubCopilotIdentityTransitionPromise) {
      return { ok: false, error: 'GitHub Copilot account transition is still in progress.' }
    }
    const generation = ++githubCopilotAuthGeneration
    githubCopilotLoginPending = false
    const manager = getGitHubCopilotSubscriptionManager()
    let status: ChatSubscriptionAuthStatus | undefined
    // Also cancels a pending Device Flow: its older generation can no longer mutate the service state.
    const transition = Promise.resolve().then(async () => {
      // Hard-delete must happen while the old token still exists.
      await resetGitHubCopilotAccountSessions()
      await manager.resetLocalData()
      status = await githubCopilotAuthStatus(true)
      if (generation === githubCopilotAuthGeneration) broadcastGitHubCopilotAuth(status)
    })
    githubCopilotIdentityTransitionPromise = transition
    try {
      await transition
      if (!status) throw new Error('GitHub Copilot logout did not produce an authentication status')
      return { ok: true, status }
    } catch (error) {
      return { ok: false, error: githubCopilotErrorMessage(error) }
    } finally {
      if (githubCopilotIdentityTransitionPromise === transition) githubCopilotIdentityTransitionPromise = null
    }
  })
  deps.mhandle(
    'chat:claude-subscription:status',
    async (_event, payload?: { refresh?: boolean; accountId?: string | null }) => {
      const accountId = normalizeAccountId(payload?.accountId)
      if (!validSubscriptionAccountId('claude-subscription', accountId)) {
        return { state: 'unavailable', authenticated: false, accountId } satisfies ChatSubscriptionAuthStatus
      }
      const status = await claudeAuthStatus(payload?.refresh === true, accountId)
      if (!accountId && status.authenticated) await retryManagedClaudeSessionCleanup().catch(() => undefined)
      return accountId ? { ...status, accountId } : status
    }
  )
  deps.mhandle('chat:claude-subscription:login', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('claude-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return loginClaudeSubscriptionAccount(accountId)
    if (claudeLoginPending || claudeIdentityTransitionPromise) {
      return { ok: false, error: 'Claude account transition is still in progress.' }
    }
    const generation = ++claudeAuthGeneration
    claudeLoginPending = true
    const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false }
    broadcastClaudeAuth(signingIn)
    const manager = getClaudeSubscriptionManager()
    const transition = (async () => {
      await resetClaudeAccountSessions()
      const completion = await manager.login()
      if (generation !== claudeAuthGeneration) return
      if (!completion.ok || !completion.status.authenticated) {
        claudeLoginPending = false
        const failed: ChatSubscriptionAuthStatus = {
          state: completion.status.available ? 'error' : 'unavailable',
          authenticated: false,
          error: completion.error ?? completion.status.error ?? 'Claude login did not complete.',
        }
        broadcastClaudeAuth(failed)
        return
      }
      // Scope = default account: its login must not delete additional slots' sessions.
      await deleteAllManagedClaudeSessions(undefined, { accountId: null })
      lastClaudeAccountFingerprint = completion.status.accountFingerprint
      claudeLoginPending = false
      broadcastClaudeAuth(toClaudeAuthStatus(completion.status))
    })()
    claudeIdentityTransitionPromise = transition
    void transition
      .catch((error) => {
        if (generation !== claudeAuthGeneration) return
        claudeLoginPending = false
        broadcastClaudeAuth({
          state: 'error',
          authenticated: false,
          error: claudeSubscriptionErrorMessage(error),
        })
      })
      .finally(() => {
        if (claudeIdentityTransitionPromise === transition) claudeIdentityTransitionPromise = null
      })
    return { ok: true, status: signingIn }
  })
  deps.mhandle('chat:claude-subscription:logout', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('claude-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return logoutClaudeSubscriptionAccount(accountId)
    const generation = ++claudeAuthGeneration
    claudeLoginPending = false
    const manager = getClaudeSubscriptionManager()
    manager.cancelLogin()
    const previous = claudeIdentityTransitionPromise
    if (previous) await previous.catch(() => undefined)
    let completion: Awaited<ReturnType<typeof manager.logout>> | undefined
    const transition = (async () => {
      await resetClaudeAccountSessions()
      completion = await manager.logout()
      lastClaudeAccountFingerprint = null
      if (generation === claudeAuthGeneration) {
        broadcastClaudeAuth(toClaudeAuthStatus(completion.status))
      }
    })()
    claudeIdentityTransitionPromise = transition
    try {
      await transition
      if (!completion) throw new Error('Claude logout did not produce an authentication status.')
      return {
        ok: completion.ok,
        status: toClaudeAuthStatus(completion.status),
        ...(completion.error ? { error: completion.error } : {}),
      }
    } catch (error) {
      return { ok: false, error: claudeSubscriptionErrorMessage(error) }
    } finally {
      if (claudeIdentityTransitionPromise === transition) claudeIdentityTransitionPromise = null
    }
  })

  deps.mhandle(
    'chat:grok-subscription:status',
    async (_event, payload?: { refresh?: boolean; accountId?: string | null }) => {
      const accountId = normalizeAccountId(payload?.accountId)
      if (!validSubscriptionAccountId('grok-subscription', accountId)) {
        return { state: 'unavailable', authenticated: false, accountId } satisfies ChatSubscriptionAuthStatus
      }
      const status = await grokAuthStatus(payload?.refresh === true, accountId)
      return accountId ? { ...status, accountId } : status
    }
  )
  deps.mhandle(
    'chat:grok-subscription:login',
    async (_event, payload?: { accountId?: string | null; method?: string }) => {
      const accountId = normalizeAccountId(payload?.accountId)
      if (accountId && !validSubscriptionAccountId('grok-subscription', accountId)) {
        return { ok: false, error: 'unknown-account' }
      }
      const method: GrokLoginMethod = payload?.method === 'device' ? 'device' : 'browser'
      if (accountId) return loginGrokSubscriptionAccount(accountId, method)
      if (grokLoginPending || grokIdentityTransitionPromise)
        return { ok: false, error: 'Grok account transition is still in progress.' }
      const generation = ++grokAuthGeneration
      grokLoginPending = true
      const signingIn: ChatSubscriptionAuthStatus = { state: 'signing-in', authenticated: false }
      broadcastGrokAuth(signingIn)
      const manager = getGrokSubscriptionManager()
      let attempt: Awaited<ReturnType<typeof manager.startLogin>> | undefined
      const transition = Promise.resolve().then(async () => {
        await resetGrokAccountSessions()
        await manager.resetLocalData()
        invalidateProvider(subscriptionProviderIdFor('grok-subscription', null))
        if (generation !== grokAuthGeneration) throw new Error('Grok login was superseded')
        attempt = await manager.startLogin(method)
      })
      grokIdentityTransitionPromise = transition
      try {
        await transition
        if (!attempt || generation !== grokAuthGeneration) {
          throw new Error('Grok login was superseded')
        }
        const loginAttempt = attempt
        void manager
          .waitForLogin(loginAttempt.loginId)
          .then(async (completion) => {
            if (generation !== grokAuthGeneration) return
            if (!completion.success) {
              grokLoginPending = false
              broadcastGrokAuth({
                state: 'error',
                authenticated: false,
                error: completion.error?.message ?? 'Grok login failed.',
              })
              return
            }
            const finalization = Promise.resolve().then(async () => {
              if (generation !== grokAuthGeneration) return
              grokLoginPending = false
              invalidateProvider(subscriptionProviderIdFor('grok-subscription', null))
              const status = await grokAuthStatus(true)
              if (generation === grokAuthGeneration) broadcastGrokAuth(status)
            })
            grokIdentityTransitionPromise = finalization
            try {
              await finalization
            } finally {
              if (grokIdentityTransitionPromise === finalization) {
                grokIdentityTransitionPromise = null
              }
            }
          })
          .catch((error) => {
            if (generation !== grokAuthGeneration) return
            grokLoginPending = false
            broadcastGrokAuth({
              state: 'error',
              authenticated: false,
              error: grokSubscriptionErrorMessage(error),
            })
          })
        return {
          ok: true,
          ...(loginAttempt.authUrl ? { authUrl: loginAttempt.authUrl } : {}),
          ...(loginAttempt.verificationUriComplete || loginAttempt.verificationUri
            ? {
                verificationUrl: loginAttempt.verificationUriComplete ?? loginAttempt.verificationUri ?? undefined,
              }
            : {}),
          ...(loginAttempt.userCode ? { userCode: loginAttempt.userCode } : {}),
          status: signingIn,
        }
      } catch (error) {
        if (generation === grokAuthGeneration) grokLoginPending = false
        const failedStatus: ChatSubscriptionAuthStatus = {
          state: 'error',
          authenticated: false,
          error: grokSubscriptionErrorMessage(error),
        }
        if (generation === grokAuthGeneration) broadcastGrokAuth(failedStatus)
        return { ok: false, error: failedStatus.error, status: failedStatus }
      } finally {
        if (grokIdentityTransitionPromise === transition) grokIdentityTransitionPromise = null
      }
    }
  )
  deps.mhandle('chat:grok-subscription:logout', async (_event, payload?: { accountId?: string | null }) => {
    const accountId = normalizeAccountId(payload?.accountId)
    if (accountId && !validSubscriptionAccountId('grok-subscription', accountId)) {
      return { ok: false, error: 'unknown-account' }
    }
    if (accountId) return logoutGrokSubscriptionAccount(accountId)
    if (grokIdentityTransitionPromise) {
      return { ok: false, error: 'Grok account transition is still in progress.' }
    }
    const generation = ++grokAuthGeneration
    grokLoginPending = false
    const manager = getGrokSubscriptionManager()
    let status: ChatSubscriptionAuthStatus | undefined
    const transition = Promise.resolve().then(async () => {
      await resetGrokAccountSessions()
      await manager.resetLocalData()
      invalidateProvider(subscriptionProviderIdFor('grok-subscription', null))
      status = await grokAuthStatus(true)
      if (generation === grokAuthGeneration) broadcastGrokAuth(status)
    })
    grokIdentityTransitionPromise = transition
    try {
      await transition
      if (!status) throw new Error('Grok logout did not produce an authentication status')
      return { ok: true, status }
    } catch (error) {
      return { ok: false, error: grokSubscriptionErrorMessage(error) }
    } finally {
      if (grokIdentityTransitionPromise === transition) grokIdentityTransitionPromise = null
    }
  })
  // Public boundary: the renderer uses only `chat:history:page`. MODEL context comes from
  // runnerContextHistory (main-only).
  deps.mhandle('chat:runtime', (_e, conversationId: string) =>
    typeof conversationId === 'string'
      ? chatRuntimeState(conversationId)
      : {
          streaming: false,
          pendingPermissions: [],
          pendingQuestions: [],
          midTurnSteering: false,
          liveReasoningUpdate: false,
          activeHarnessProfile: null,
        }
  )
  deps.mhandle(
    'chat:steer',
    async (_e, rawConversationId: unknown, rawText: unknown, rawClientUserMessageId: unknown) => {
      const conversationId = typeof rawConversationId === 'string' ? rawConversationId : ''
      const text = typeof rawText === 'string' ? rawText : ''
      const clientUserMessageId = typeof rawClientUserMessageId === 'string' ? rawClientUserMessageId : ''
      if (
        !conversationId ||
        !text.trim() ||
        text.length > 200_000 ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(clientUserMessageId)
      ) {
        return { ok: false as const, error: 'invalid-input' as const }
      }
      const run = active.get(conversationId)
      const control = run?.codexTurnControl
      if (!run || !control || run.activeHarnessProfile !== 'openai-gpt-6-astra-v1' || !run.midTurnSteering) {
        return { ok: false as const, error: 'target-unavailable' as const }
      }
      const existing = getChatMessage(conversationId, clientUserMessageId)
      if (existing?.steering?.status === 'queued') return { ok: true as const, accepted: true as const }
      if (existing) return { ok: false as const, error: 'duplicate-id' as const }
      try {
        const result = await control.steer(text, clientUserMessageId)
        if (result !== 'accepted') return { ok: false as const, error: 'target-unavailable' as const }
        const message: ChatMessage = {
          id: clientUserMessageId,
          conversationId,
          role: 'user',
          parts: [{ type: 'text', id: randomUUID(), text }],
          steering: { status: 'queued' },
          createdAt: Date.now(),
        }
        run.acceptedSteeringMessageIds.add(clientUserMessageId)
        try {
          upsertChatMessage(message)
        } catch {
          // The provider already accepted the input. Never report a pre-acceptance failure and auto-queue a
          // duplicate; the transient bubble still makes the accepted instruction visible for this process.
          chatDiag({
            kind: 'codex-subscription-steering-service',
            conv: conversationId,
            profile: run.activeHarnessProfile,
            result: 'accepted-persistence-failed',
          })
        }
        run.send(`chat:delta:${conversationId}`, { kind: 'steering-accepted', message } satisfies ChatStreamEvent)
        chatDiag({
          kind: 'codex-subscription-steering-service',
          conv: conversationId,
          profile: run.activeHarnessProfile,
          result: 'accepted',
        })
        return { ok: true as const, accepted: true as const }
      } catch {
        chatDiag({
          kind: 'codex-subscription-steering-service',
          conv: conversationId,
          profile: run.activeHarnessProfile,
          result: 'fallback',
        })
        return { ok: false as const, error: 'target-unavailable' as const }
      }
    }
  )
  deps.mhandle('chat:update-live-reasoning', async (_e, rawConversationId: unknown, rawEffort: unknown) => {
    const conversationId = typeof rawConversationId === 'string' ? rawConversationId : ''
    const effort = typeof rawEffort === 'string' ? sanitizeEffort(rawEffort) || 'off' : ''
    const run = active.get(conversationId)
    const control = run?.codexTurnControl
    if (
      !conversationId ||
      !effort ||
      !run ||
      !control ||
      run.activeHarnessProfile !== 'openai-gpt-6-astra-v1' ||
      !run.liveReasoningUpdate
    ) {
      return { ok: false as const, error: 'target-unavailable' as const }
    }
    try {
      const result = await control.updateReasoning(effort)
      return result === 'applied'
        ? { ok: true as const, applied: true as const }
        : { ok: false as const, error: result as 'target-unavailable' | 'invalid-effort' }
    } catch {
      return { ok: false as const, error: 'target-unavailable' as const }
    }
  })
  deps.mhandle(
    'chat:maestro-live:post',
    (
      _event,
      payload?: {
        conversationId?: string
        runId?: string
        text?: string
        agentMentions?: StructuredAgentMentionDraft[]
      }
    ) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const runId = typeof payload?.runId === 'string' ? payload.runId : ''
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (!conversationId || !runId || !text.trim()) return { ok: false as const, error: 'invalid-input' as const }
      const live = active.get(conversationId)?.maestroLive
      if (!live || live.runId !== runId) return { ok: false as const, error: 'run-not-active' as const }
      return live.post(text, Array.isArray(payload?.agentMentions) ? payload.agentMentions : undefined)
    }
  )
  deps.mhandle('chat:maestro-live:snapshot', (_event, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return null
    return active.get(conversationId)?.maestroLive?.state() ?? null
  })
  deps.mhandle(
    'chat:maestro-live:cancel',
    (_event, payload?: { conversationId?: string; runId?: string; messageId?: string }) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const runId = typeof payload?.runId === 'string' ? payload.runId : ''
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : ''
      const live = active.get(conversationId)?.maestroLive
      return !!live && live.runId === runId && !!messageId && live.cancelMessage(messageId)
    }
  )
  deps.mhandle(
    'chat:subagents:list',
    (
      _e,
      conversationId: string,
      options?: { parentMessageId?: string; origin?: 'task' | 'delegate'; limit?: number }
    ) => (typeof conversationId === 'string' ? listSubagentSessions(conversationId, options ?? {}) : [])
  )
  deps.mhandle(
    'chat:subagent:resolve',
    (_e, payload?: { conversationId?: string; parentMessageId?: string; toolCallId?: string }) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const parentMessageId = typeof payload?.parentMessageId === 'string' ? payload.parentMessageId : ''
      const toolCallId = typeof payload?.toolCallId === 'string' ? payload.toolCallId : ''
      return conversationId && parentMessageId && toolCallId
        ? findSubagentSession({ conversationId, parentMessageId, toolCallId })
        : null
    }
  )
  deps.mhandle(
    'chat:subagent:transcript',
    (_e, conversationId: string, sessionId: string, options?: { limit?: number }) => {
      if (typeof conversationId !== 'string' || typeof sessionId !== 'string') return null
      const session = getSubagentSession(sessionId)
      return session?.conversationId === conversationId ? getSubagentTranscriptPage(sessionId, options ?? {}) : null
    }
  )
  // UI pagination (#559, RENDER-ONLY): last N (or before beforeSeq) to avoid overloading the DOM
  // in huge conversations. Does NOT affect model context (from runnerContextHistory in the runner).
  deps.mhandle(
    'chat:history:page',
    (_e, conversationId: string, opts?: { beforeSeq?: number; aroundSeq?: number; limit?: number }) =>
      typeof conversationId === 'string'
        ? listPublicChatMessagesPage(conversationId, opts ?? {})
        : { messages: [], hasMore: false, earliestSeq: null }
  )
  // FULL history summary (cost/context) — cheap (meta_json only): the meter still represents
  // all history despite the paginated list (addresses gap #3 from the refinement review).
  deps.mhandle('chat:history:stats', async (_e, conversationId: string) =>
    typeof conversationId === 'string'
      ? toPublicChatHistoryStats(await currentChatHistoryStats(conversationId))
      : { lastUsage: null, perModel: [], modelIds: [], bytesSaved: 0 }
  )
  // (Former 'chat:usage-stats' became the UNIFIED panel — 'usage:stats' channel in usage/usage-service.ts,
  // which consumes aggregateChatUsage as the 'chat' source.)
  // Chat search (Cmd/Ctrl+F, #559): scans the ENTIRE SQLite conversation (not just the paginated window)
  // and returns matches with `seq` so the UI can paginate/scroll to the message.
  deps.mhandle('chat:search', (_e, conversationId: string, query: string) =>
    typeof conversationId === 'string' && typeof query === 'string' ? searchChatMessages(conversationId, query) : []
  )
  // Generated image (Codex imagegen): renderer identifies the artifact by conversation+message+part — NEVER by
  // path. Main resolves the persisted part, revalidates disk bytes, and returns a data URL for preview/download.
  deps.mhandle(
    'chat:generated-image',
    async (_e, payload?: { conversationId?: string; messageId?: string; partId?: string }) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : ''
      const partId = typeof payload?.partId === 'string' ? payload.partId : ''
      if (!conversationId || !messageId || !partId) return { ok: false as const, error: 'not-found' as const }
      const part = findGeneratedImagePart(conversationId, messageId, partId)
      if (!part) return { ok: false as const, error: 'not-found' as const }
      return readGeneratedImage(conversationId, part.artifactId, part.byteSize)
    }
  )
  // Tool image: the content-addressed handle may be shared, so authorization comes from the persisted
  // owner (conversation+message+part), never the global handle. Running/completed are valid while the
  // corresponding checkpoint exists; call the resolver only after validation.
  deps.mhandle(
    'chat:tool-image',
    async (_e, payload?: { conversationId?: string; messageId?: string; toolPartId?: string; imageId?: string }) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : ''
      const toolPartId = typeof payload?.toolPartId === 'string' ? payload.toolPartId : ''
      const imageId = typeof payload?.imageId === 'string' ? payload.imageId : ''
      if (
        !conversationId ||
        !messageId ||
        !toolPartId ||
        !imageId.startsWith('tool-image:') ||
        !hasChatToolImageOwner(conversationId, messageId, toolPartId, imageId)
      ) {
        return { ok: false as const, error: 'not-found' as const }
      }
      const image = getEphemeralToolImage({ id: imageId })
      if (!image) return { ok: false as const, error: 'not-found' as const }
      return {
        ok: true as const,
        bytes: image.bytes,
        mediaType: image.mediaType,
        byteSize: image.byteSize,
      }
    }
  )
  deps.mhandle(
    'chat:attachment-image',
    async (_e, payload?: { conversationId?: string; messageId?: string; partId?: string }) => {
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const messageId = typeof payload?.messageId === 'string' ? payload.messageId : ''
      const partId = typeof payload?.partId === 'string' ? payload.partId : ''
      if (!conversationId || !messageId || !partId) return { ok: false as const, error: 'not-found' as const }
      const part = findAttachmentImagePart(conversationId, messageId, partId)
      if (!part) return { ok: false as const, error: 'not-found' as const }
      if (part.artifactId) return readAttachmentImage(conversationId, part.artifactId, part.byteSize)
      if (typeof part.data === 'string' && part.data.startsWith('data:')) {
        const legacy = decodeLegacyAttachmentData(part.data)
        if (!legacy) return { ok: false as const, error: 'invalid' as const }
        return {
          ok: true as const,
          bytes: legacy.bytes,
          mediaType: legacy.mediaType,
          byteSize: legacy.bytes.length,
        }
      }
      return { ok: false as const, error: 'not-found' as const }
    }
  )
  deps.mhandle(
    'chat:send',
    (
      event,
      payload: {
        conversationId: string
        text: string
        attachments?: ChatAttachmentInput[]
        agentMentions?: StructuredAgentMentionDraft[]
      }
    ) =>
      startSend(
        deps,
        event.sender,
        payload?.conversationId,
        payload?.text,
        payload?.attachments,
        undefined,
        Array.isArray(payload?.agentMentions) ? payload.agentMentions : undefined
      )
  )
  // '@' autocomplete: searches files AND folders in the conversation cwd.
  deps.mhandle('chat:search-files', (_e, conversationId: string, query: string) => {
    const conv = typeof conversationId === 'string' ? getConversation(conversationId) : undefined
    if (!conv) return Promise.resolve([])
    return searchFiles(conv.cwd, typeof query === 'string' ? query : '')
  })
  // '/' palette: user prompts (app_settings) + project commands (.md in cwd). Built-in ACTIONS
  // (/clear etc.) are defined in the renderer.
  deps.mhandle('chat:commands', async (_e, conversationId: string) => {
    const conv = typeof conversationId === 'string' ? getConversation(conversationId) : undefined
    // Skills enter the palette WITHOUT bodies: choosing one only inserts `/name` into the draft; expansion happens
    // on send (startSend). Show only ENABLED, `user-invocable` skills.
    const skills = conv
      ? (await effectiveSkills(conv.cwd, conversationId))
          .filter((s) => s.userInvocable)
          .map((s) => ({
            name: s.name,
            description: s.description,
            ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
            source: s.source,
          }))
      : []
    return { prompts: listUserPrompts(), project: conv ? await listProjectCommands(conv.cwd) : [], skills }
  })
  // ---- Skill management (Settings + conversation popover) ----
  // `conversationId` is optional: without it, show only GLOBAL skills (~/.agents|.claude/skills) — as in
  // Settings, which has no cwd.
  deps.mhandle('chat:skills:list', (_e, conversationId?: string) =>
    listSkillInfos(typeof conversationId === 'string' && conversationId ? conversationId : undefined)
  )
  deps.mhandle('chat:skills:state', (_e, conversationId?: string) =>
    listSkillsState(typeof conversationId === 'string' && conversationId ? conversationId : undefined)
  )
  deps.mhandle('chat:skills:read', (_e, name: string, conversationId?: string) =>
    typeof name === 'string'
      ? readSkillDetail(name, typeof conversationId === 'string' && conversationId ? conversationId : undefined)
      : Promise.resolve(null)
  )
  deps.mhandle('chat:skills:set-enabled-global', (_e, name: string, enabled: boolean) => {
    if (typeof name === 'string') setSkillEnabledGlobal(name, enabled !== false)
    return { ok: true }
  })
  deps.mhandle(
    'chat:skills:set-override',
    (_e, conversationId: string, name: string, state: 'inherit' | 'on' | 'off') => {
      if (typeof conversationId !== 'string' || typeof name !== 'string') return { ok: false }
      if (state !== 'inherit' && state !== 'on' && state !== 'off') return { ok: false }
      setConversationSkillOverride(conversationId, name, state)
      return { ok: true }
    }
  )
  deps.mhandle('chat:skills:reset-overrides', (_e, conversationId: string) =>
    resetConversationSkillOverrides(typeof conversationId === 'string' ? conversationId : '')
  )
  deps.mhandle('chat:skills:set-selection', (_e, conversationId: string, selection: ChatSkillSelection) =>
    setConversationSkillSelection(typeof conversationId === 'string' ? conversationId : '', selection)
  )
  deps.mhandle('chat:skills:groups:list', () => listSkillGroups())
  deps.mhandle('chat:skills:groups:create', (_e, input: { name?: string; description?: string; skills?: string[] }) =>
    createSkillGroup({
      name: typeof input?.name === 'string' ? input.name : '',
      ...(typeof input?.description === 'string' ? { description: input.description } : {}),
      ...(Array.isArray(input?.skills)
        ? { skills: input.skills.filter((item): item is string => typeof item === 'string') }
        : {}),
    })
  )
  deps.mhandle(
    'chat:skills:groups:update',
    (_e, id: string, patch: { name?: string; description?: string; skills?: string[] }) =>
      updateSkillGroup(typeof id === 'string' ? id : '', {
        ...(typeof patch?.name === 'string' ? { name: patch.name } : {}),
        ...(typeof patch?.description === 'string' ? { description: patch.description } : {}),
        ...(Array.isArray(patch?.skills)
          ? { skills: patch.skills.filter((item): item is string => typeof item === 'string') }
          : {}),
      })
  )
  deps.mhandle('chat:skills:groups:remove', (_e, id: string) => removeSkillGroup(typeof id === 'string' ? id : ''))
  deps.mhandle(
    'chat:skills:create',
    (_e, input: { name: string; description?: string; scope?: ChatSkillScope; conversationId?: string }) => {
      const scope: ChatSkillScope = input?.scope === 'project' ? 'project' : 'global'
      return createSkill({
        name: input?.name ?? '',
        description: input?.description,
        scope,
        cwd: conversationCwd(input?.conversationId),
      })
    }
  )
  deps.mhandle('chat:skills:remove', async (_e, name: string, conversationId?: string) => {
    const cwd = conversationCwd(typeof conversationId === 'string' ? conversationId : undefined)
    const detail = await readSkillDetail(
      typeof name === 'string' ? name : '',
      typeof conversationId === 'string' && conversationId ? conversationId : undefined
    )
    if (!detail) return { ok: false, error: 'not-found' }
    const result = await removeSkillDir(detail.dir, cwd)
    if (result.ok) forgetInstalledSkill(detail.name)
    return result
  })
  // "Convert to skill": the saved prompt becomes an actual folder (and leaves the prompt list).
  deps.mhandle(
    'chat:skills:convert-prompt',
    async (_e, promptId: string, input?: { scope?: ChatSkillScope; conversationId?: string }) => {
      const prompt = listUserPrompts().find((p) => p.id === promptId)
      if (!prompt) return { ok: false, error: 'not-found' }
      const scope: ChatSkillScope = input?.scope === 'project' ? 'project' : 'global'
      const result = await writeSkillFromPrompt({
        name: prompt.name,
        description: prompt.description,
        content: prompt.content,
        scope,
        cwd: conversationCwd(input?.conversationId),
      })
      if (result.ok) removeUserPrompt(prompt.id)
      return result
    }
  )
  deps.mhandle('chat:skills:reveal', async (_e, name: string, conversationId?: string) => {
    const detail = await readSkillDetail(
      typeof name === 'string' ? name : '',
      typeof conversationId === 'string' && conversationId ? conversationId : undefined
    )
    if (!detail) return { ok: false, error: 'not-found' }
    const error = await shell.openPath(detail.dir)
    return error ? { ok: false, error } : { ok: true }
  })
  // ---- Public library (skills.sh) ----
  deps.mhandle('chat:skills:search', async (_e, query: string, conversationId?: string) => {
    const installed = new Set(
      (await listSkillInfos(typeof conversationId === 'string' && conversationId ? conversationId : undefined)).map(
        (s) => s.name
      )
    )
    return searchSkillLibrary(typeof query === 'string' ? query : '', installed)
  })
  deps.mhandle(
    'chat:skills:install',
    (_e, input: { slug: string; scope?: ChatSkillScope; conversationId?: string; overwrite?: boolean }) => {
      const scope: ChatSkillScope = input?.scope === 'project' ? 'project' : 'global'
      return installSkillFromSlug({
        slug: input?.slug ?? '',
        scope,
        cwd: conversationCwd(input?.conversationId),
        overwrite: input?.overwrite === true,
      })
    }
  )
  // Model metadata (window/pricing via models.dev) for the context/cost meter.
  // Model metadata (window/pricing). With providerId, WINDOW precedence: user limit (clamp) →
  // provider window (/models) → models.dev. Without providerId → raw catalog metadata (compat).
  deps.mhandle('chat:model-meta', async (_e, modelId: string, providerId?: string) => {
    if (typeof modelId !== 'string' || !modelId) return null
    const { meta } = await effectiveModelMeta(modelId, typeof providerId === 'string' ? providerId : undefined)
    return meta
  })
  // Manual context limit: get returns the limit + raw sources (provider/catalog ceilings) so the UI
  // can show "limit X of actual Y"; set writes/clears it (null = no limit).
  deps.mhandle('chat:context-limit:get', async (_e, providerId: string, modelId: string) => {
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId)
      return { limit: null, providerWindow: null, catalogWindow: null, effective: null }
    const { meta, providerWindow, catalogWindow, limit } = await effectiveModelMeta(modelId, providerId)
    return {
      limit: limit ?? null,
      providerWindow: providerWindow ?? null,
      catalogWindow: catalogWindow ?? null,
      effective: meta?.contextWindow ?? null,
    }
  })
  deps.mhandle('chat:context-limit:set', (_e, providerId: string, modelId: string, value: number | null) => {
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId) return { ok: false }
    if (isManagedProvider(providerId) && !isCodexSubscriptionProvider(providerId)) {
      return { ok: false, error: 'unsupported' }
    }
    setContextLimit(providerId, modelId, typeof value === 'number' ? value : null)
    return { ok: true }
  })
  // macOS: ensure microphone permission (TCC) BEFORE recording — otherwise getUserMedia returns SILENCE.
  deps.mhandle('chat:ensure-mic-access', async () => {
    if (process.platform !== 'darwin') return { ok: true, status: 'granted' }
    try {
      let status = systemPreferences.getMediaAccessStatus('microphone')
      console.log('[asr] mic access status (before request):', status)
      if (status === 'granted') return { ok: true, status }
      // Actually denied/restricted: macOS does not ask again → take the user to Microphone settings.
      if (status === 'denied' || status === 'restricted') {
        void shell
          .openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
          .catch(() => {})
        return { ok: false, status }
      }
      // not-determined → trigger the prompt (works in packaged app). In dev, getUserMedia triggers the actual prompt
      // (request handler), so do NOT open Settings here: ok:true and the renderer proceeds to capture.
      await systemPreferences.askForMediaAccess('microphone').catch(() => {})
      status = systemPreferences.getMediaAccessStatus('microphone')
      console.log('[asr] mic access status (after):', status)
      return { ok: true, status }
    } catch (e) {
      console.error('[asr] failed to check mic access:', (e as Error)?.message ?? e)
      return { ok: true, status: 'unknown' } // API unavailable → let getUserMedia try.
    }
  })
  // Voice dictation: transcribe 16kHz mono PCM through local Whisper → text. Receives ArrayBuffer (Float32 bytes).
  deps.mhandle('chat:transcribe', async (_e, buf: ArrayBuffer) => {
    const audio = buf instanceof ArrayBuffer ? new Float32Array(buf) : new Float32Array(0)
    const r = await transcribe(audio)
    if (r.text == null) return { error: 'unavailable' }
    if (r.silent) return { error: 'silent' } // Silent audio (mic permission missing / no speech) → UI notifies the user.
    return { text: r.text }
  })
  deps.mhandle('chat:prompts', () => listUserPrompts()) // List only user prompts (Settings screen).
  deps.mhandle('chat:prompt-add', (_e, input: { name: string; description?: string; content: string }) => {
    try {
      const prompt = addUserPrompt(input)
      return { ok: true, id: prompt.id }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  deps.mhandle(
    'chat:prompt-update',
    (_e, id: string, patch: { name?: string; description?: string; content?: string }) => {
      if (typeof id === 'string') updateUserPrompt(id, patch ?? {})
      return { ok: true }
    }
  )
  deps.mhandle('chat:prompt-remove', (_e, id: string) => {
    if (typeof id === 'string') removeUserPrompt(id)
    return { ok: true }
  })
  deps.mon('chat:stop', (_e, conversationId: string) => {
    if (typeof conversationId !== 'string') return
    pairedReviewLoopCoordinator?.stop(conversationId)
    const reservation = lookupReviewLoopByConversation(conversationId)
    if (reservation?.participants.some((participant) => participant.driver === 'chatgpt-web')) {
      chatGptWeb.stopReviewLoop(conversationId)
    }
    stop(conversationId)
  })
  deps.mhandle('chat:clear', async (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
    // Active review loop: clearing history would break round context — the central guard also applies here.
    if (reviewLoopLockForConversation(conversationId)) return { ok: false, error: 'review-loop-active' }
    const operation = reserveConversationOperation(conversationId, selectionFor(conversationId)?.providerId ?? null)
    if (!operation) return { ok: false, error: 'busy' }
    try {
      await deleteSubscriptionStateForConversation(conversationId, operation.controller.signal)
      if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }
      // Await artifact rm INSIDE the reservation: releasing early would let an in-flight rm delete an image
      // just written by the next turn.
      await clearChatMessages(conversationId)
      clearMaestroLiveRunsForConversation(conversationId)
      return { ok: true }
    } finally {
      releaseConversationOperation(conversationId, operation)
    }
  })
  // Compact history (summarize through the model and replace with a recap) — /compact.
  deps.mhandle('chat:compact', (_e, conversationId: string) =>
    typeof conversationId === 'string'
      ? compact(conversationId)
      : Promise.resolve({ ok: false, error: 'invalid-input' })
  )

  // User-defined providers (CRUD).
  deps.mhandle(
    'chat:provider-add',
    (_e, input: { name: string; baseURL: string; key?: string; kind?: ChatProviderKind }) => {
      try {
        const provider = addProvider({ name: input?.name, baseURL: input?.baseURL, kind: input?.kind })
        if (typeof input?.key === 'string' && input.key.trim()) setApiKey(provider.id, input.key)
        notifyChatRunnerCapabilityChanges(false)
        return { ok: true, id: provider.id }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
  deps.mhandle(
    'chat:provider-update',
    (_e, id: string, patch: { name?: string; baseURL?: string; kind?: ChatProviderKind }) => {
      if (isManagedProvider(id)) return { ok: false }
      if (typeof id === 'string') {
        updateProvider(id, patch ?? {})
        invalidateProvider(id)
        invalidateModels(id)
        notifyChatRunnerCapabilityChanges(true)
      }
      return { ok: true }
    }
  )
  deps.mhandle('chat:provider-remove', (_e, id: string) => {
    if (isManagedProvider(id)) return { ok: false }
    if (typeof id === 'string') {
      removeProvider(id)
      clearApiKey(id)
      invalidateProvider(id)
      invalidateModels(id)
      setHiddenChatModels(id, []) // Model filters do not outlive their provider.
      // Clear the global default if it pointed to this provider.
      if (getAppSetting(CHAT_DEFAULT_PROVIDER_KEY) === id) {
        setAppSetting(CHAT_DEFAULT_PROVIDER_KEY, '')
        setAppSetting(CHAT_DEFAULT_MODEL_KEY, '')
        setAppSetting(CHAT_DEFAULT_REASONING_KEY, 'off')
      }
      notifyChatRunnerCapabilityChanges(true)
    }
    return { ok: true }
  })
  // DYNAMIC provider models (GET {baseURL}/models), filtered for chat usability (no TTS/ASR/image)
  // and finally by the USER filter (models hidden in Settings). `includeHidden` returns the full
  // list — consumed by the filter management screen itself.

  deps.mhandle('chat:models', async (_e, providerId: string, force?: boolean, includeHidden?: boolean) => {
    if (typeof providerId !== 'string') return []
    const visible = (models: string[]) => {
      if (includeHidden === true) return models
      const hidden = new Set(getHiddenChatModels()[providerId] ?? [])
      return hidden.size === 0 ? models : models.filter((model) => !hidden.has(model))
    }
    const accountId = subscriptionAccountId(providerId)
    if (isCodexSubscriptionProvider(providerId)) {
      const status = await codexAuthStatus(force === true, undefined, accountId)
      if (!status.authenticated) return []
      const models = await getCodexSubscriptionManager(accountId).listModels(force === true)
      return visible(
        models.filter((model) => !model.hidden && model.inputModalities.includes('text')).map((model) => model.id)
      )
    }
    if (isGitHubCopilotSubscriptionProvider(providerId)) {
      const status = await githubCopilotAuthStatus(force === true, accountId)
      if (!status.authenticated) return []
      try {
        const models = await getGitHubCopilotSubscriptionManager(accountId).listModels(force === true)
        return visible(models.filter((model) => model.policy?.state !== 'disabled').map((model) => model.id))
      } catch (error) {
        throw new Error(githubCopilotErrorMessage(error))
      }
    }
    if (isClaudeSubscriptionProvider(providerId)) {
      const status = await claudeAuthStatus(force === true, accountId)
      if (!status.authenticated) return []
      try {
        return visible(
          (await getClaudeSubscriptionManager(accountId).listModels(undefined, force === true)).map(
            (model) => model.value
          )
        )
      } catch (error) {
        throw new Error(claudeSubscriptionErrorMessage(error))
      }
    }
    if (isGrokSubscriptionProvider(providerId)) {
      const status = await grokAuthStatus(force === true, accountId)
      if (!status.authenticated) return []
      try {
        return visible(
          (await getGrokSubscriptionManager(accountId).listModels(force === true)).map((model) => model.id)
        )
      } catch (error) {
        throw new Error(grokSubscriptionErrorMessage(error))
      }
    }
    return visible(await filterChatModels(await fetchModels(providerId, force === true)))
  })

  // DISPLAYED model filter per provider (Settings › Chat). Store the HIDDEN models.
  deps.mhandle('chat:hidden-models:get', () => getHiddenChatModels())
  deps.mhandle('chat:hidden-models:set', (_e, providerId: string, hidden: string[]) => {
    if (
      typeof providerId !== 'string' ||
      !providerId ||
      !Array.isArray(hidden) ||
      !hidden.every((modelId) => typeof modelId === 'string') ||
      !listAvailableChatProviders().some((provider) => provider.id === providerId)
    ) {
      return { ok: false, error: 'invalid-input' }
    }
    setHiddenChatModels(providerId, hidden)
    return { ok: true }
  })

  // ---- "ChatGPT Web" Companion (EXPERIMENTAL): project tools + explicit delivery via Secure MCP Tunnel.
  if (!chatGptWebUnsubscribe) {
    chatGptWebUnsubscribe = chatGptWeb.onChatGptWebChange(broadcastChatGptWebStatus)
  }
  // Bridge hooks: the only write is an explicit delivery to chat or the originating Plan tab.
  chatGptWeb.setChatGptWebHooks({
    turnCompleted: (conversationId) => {
      if (!getConversation(conversationId)) return
      touchConversation(conversationId, Date.now())
      deps.notifyChatGptWebTurnCompleted?.(conversationId)
    },
    deliverChat: (conversationId, markdown, title) => {
      if (!getConversation(conversationId)) throw new Error('invalid-conversation')
      const body = title ? `## ${title}\n\n${markdown}` : markdown
      const messageId = randomUUID()
      upsertChatMessage({
        id: messageId,
        conversationId,
        role: 'assistant',
        parts: [{ type: 'text', id: randomUUID(), text: body }],
        source: 'chatgpt-web',
        createdAt: Date.now(),
      })
      const wc = getMainWebContents()
      if (wc && !wc.isDestroyed()) wc.send(`chat:chatgpt-web:delivery:${conversationId}`, { messageId })
    },
    deliverPlan: (conversationId, plan, reviewId, title) => {
      const conv = getConversation(conversationId)
      if (!conv) throw new Error('invalid-conversation')
      const staged = stagePlan({
        agentId: conversationId,
        cwd: conv.cwd,
        plan,
        ...(title ? { title } : {}),
        origin: { kind: 'chatgpt-web', reviewId },
        onLifecycle: (outcome) => {
          const resolution = chatGptWeb.resolvePlanReview(conversationId, reviewId, { status: outcome })
          if (!resolution.ok) {
            deps.emitStatus(conversationId, 'error')
          }
        },
      })
      if (!staged.ok) throw new Error(staged.error)
    },
    projectContext: (conversationId, cwd) => {
      const conv = getConversation(conversationId)
      return buildProjectContext(conv?.workspaceId ?? '', cwd)
    },
    listSkills: async (cwd, conversationId) =>
      (await effectiveSkills(cwd, conversationId)).map((skill) => ({
        name: skill.name,
        description: skill.description || skill.name,
      })),
    readSkill: (cwd, name) => readSkillBody(cwd, name),
    getConversationContext: (conversationId, signal) => {
      if (signal?.aborted) throw new Error('session-ended')
      if (!getConversation(conversationId)) throw new Error('invalid-conversation')
      return getCompanionConversationContext(conversationId)
    },
    getConversationRevision: (conversationId, signal) => {
      if (signal?.aborted) throw new Error('session-ended')
      if (!getConversation(conversationId)) throw new Error('invalid-conversation')
      return getCompanionConversationRevision(conversationId)
    },
    searchConversation: (conversationId, input, signal) => {
      if (signal?.aborted) throw new Error('session-ended')
      if (!getConversation(conversationId)) throw new Error('invalid-conversation')
      return searchCompanionConversation(conversationId, input)
    },
    readConversation: (conversationId, input, signal) => {
      if (signal?.aborted) throw new Error('session-ended')
      if (!getConversation(conversationId)) throw new Error('invalid-conversation')
      return readCompanionConversation(conversationId, input)
    },
    // Automatic review loop: the bridge starts/awaits/ends internal execution turns. Explicit start in
    // ChatGPT provides consent; the loop NEVER enters the Plan tab or requests per-round approval.
    reviewLoop: {
      validateStart: (conversationId) => validateReviewLoopStart(conversationId),
      resolveSelection: (conversationId) => resolveReviewLoopSelection(conversationId),
      startInternalTurn: ({
        conversationId,
        prompt,
        hiddenParts,
        selection,
        loopId,
        iteration,
        maxIterations,
        signal,
      }) =>
        startInternalChatTurn({
          conversationId,
          prompt,
          hiddenParts,
          selection,
          source: 'chatgpt-web-review-loop',
          loopId,
          iteration,
          maxIterations,
          signal,
        }),
      revalidateSelection: (selection) => revalidateReviewLoopSelection(selection),
      cancelInternalTurn: (executionId) => cancelInternalChatTurn(executionId),
      persistSummary: ({ conversationId, loopId, markdown }) =>
        persistReviewLoopSummary({ conversationId, loopId, markdown }),
      forceAgentMode: (conversationId) => forceReviewLoopAgentMode(conversationId),
    },
  })
  deps.mhandle('chat:chatgpt-web:status', async () => ({
    ...(await chatGptWeb.refreshRuntimeAssetStatus()),
    enabled: isChatGptWebEnabled(),
  }))
  deps.mhandle('chat:chatgpt-web:capabilities:get', (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !getConversation(conversationId)) {
      throw new Error('invalid-conversation')
    }
    return chatGptWeb.capabilitiesForConversation(conversationId)
  })
  deps.mhandle('chat:chatgpt-web:capabilities:set', (_e, conversationId: string, input: unknown) => {
    if (typeof conversationId !== 'string' || !getConversation(conversationId)) {
      throw new Error('invalid-conversation')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-capabilities')
    const value = input as {
      git?: unknown
      gh?: unknown
      conversation?: unknown
      memory?: unknown
      browser?: unknown
      mcp?: unknown
    }
    if ((value.git !== 'off' && value.git !== 'read') || (value.gh !== 'off' && value.gh !== 'read')) {
      throw new Error('invalid-capabilities')
    }
    if (value.browser !== 'off' && value.browser !== 'inspect' && value.browser !== 'interact') {
      throw new Error('invalid-capabilities')
    }
    if (value.conversation !== 'off' && value.conversation !== 'read') {
      throw new Error('invalid-capabilities')
    }
    if (value.memory !== 'off' && value.memory !== 'read') {
      throw new Error('invalid-capabilities')
    }
    if (!value.mcp || typeof value.mcp !== 'object' || Array.isArray(value.mcp)) {
      throw new Error('invalid-capabilities')
    }
    for (const scope of Object.values(value.mcp as Record<string, unknown>)) {
      if (scope !== 'off' && scope !== 'read' && scope !== 'write') throw new Error('invalid-capabilities')
    }
    return chatGptWeb.setCapabilitiesForConversation(conversationId, {
      git: value.git,
      gh: value.gh,
      conversation: value.conversation,
      memory: value.memory,
      browser: value.browser,
      mcp: value.mcp as Record<string, 'off' | 'read' | 'write'>,
    })
  })
  deps.mhandle(
    'chat:chatgpt-web:configure',
    async (_e, input: { apiKey?: string; tunnelId?: string; appName?: string; enabled?: boolean }) => {
      return chatGptWeb.withTransportConfigurationMutation(async () => {
        const changesTransport =
          typeof input?.apiKey === 'string' ||
          (typeof input?.tunnelId === 'string' && input.tunnelId.trim() !== chatGptWeb.getTunnelId())
        if (changesTransport && chatGptWeb.transportConfigurationHasActiveResources()) {
          throw new Error('End ChatGPT Web sessions and the probe before changing the credential or tunnel.')
        }
        // Disabling the feature also revokes web-app access to the local bridge.
        if (input?.enabled === false) {
          for (const session of chatGptWeb.listSessions()) await chatGptWeb.endSession(session.conversationId)
          await chatGptWeb.stopTunnelProbe()
        }
        if (chatGptWeb.transportConfigurationHasActiveResources()) {
          throw new Error('Configuration was closed while the change was in progress.')
        }
        if (typeof input?.apiKey === 'string') {
          if (input.apiKey.trim()) chatGptWeb.setPlatformApiKey(input.apiKey)
          else chatGptWeb.clearPlatformApiKey()
        }
        if (typeof input?.tunnelId === 'string') chatGptWeb.setTunnelId(input.tunnelId)
        if (typeof input?.appName === 'string') chatGptWeb.setAppName(input.appName)
        if (typeof input?.enabled === 'boolean') setChatGptWebEnabled(input.enabled)
        broadcastChatGptWebStatus()
        return chatGptWebStatusPayload()
      })
    }
  )
  deps.mhandle('chat:chatgpt-web:principals', async (_e, apiKey?: string) => {
    const result = await chatGptWeb.listTunnelPrincipals(typeof apiKey === 'string' && apiKey ? apiKey : undefined)
    return result.ok ? { ok: true, ...result.data } : { ok: false, error: result.error, status: result.status }
  })
  deps.mhandle('chat:chatgpt-web:tunnels', async (_e, apiKey?: string) => {
    const result = await chatGptWeb.listTunnels(typeof apiKey === 'string' && apiKey ? apiKey : undefined)
    if (!result.ok) return { ok: false, error: result.error, status: result.status }
    const tunnels = result.data.data ?? result.data.tunnels ?? []
    return { ok: true, tunnels }
  })
  deps.mhandle('chat:chatgpt-web:create-tunnel', async (_e, input: { name?: string; description?: string }) => {
    return chatGptWeb.withTransportConfigurationMutation(async () => {
      if (chatGptWeb.transportConfigurationHasActiveResources()) {
        return {
          ok: false,
          error: 'End ChatGPT Web sessions and the probe before creating another tunnel.',
        }
      }
      const name = (input?.name ?? '').trim() || 'Maestrly'
      // The API requires `description` (400 without it) — prevent the user from encountering that.
      const description = (input?.description ?? '').trim() || 'Maestrly ChatGPT Web bridge (Secure MCP Tunnel)'
      const result = await chatGptWeb.createTunnel({ name, description })
      if (!result.ok) return { ok: false, error: result.error, status: result.status }
      // Shutdown/reset/start must not have crossed the network call and left a new ID persisted.
      if (chatGptWeb.transportConfigurationHasActiveResources()) {
        return { ok: false, error: 'Configuration changed while the tunnel was being created; try again.' }
      }
      if (result.data.id) chatGptWeb.setTunnelId(result.data.id)
      broadcastChatGptWebStatus()
      return { ok: true, tunnelId: result.data.id }
    })
  })
  deps.mhandle('chat:chatgpt-web:companion-start', async (_e, input?: { conversationId?: string }) => {
    const conversationId = input?.conversationId
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
    const conv = getConversation(conversationId)
    if (!conv) return { ok: false, error: 'invalid-conversation' }
    const started = await chatGptWeb.startSession({ conversationId, cwd: conv.cwd })
    if (!started.ok) return started
    broadcastChatGptWebStatus()
    return {
      ok: true,
      kickoff: chatGptWeb.companionPrompt(conversationId),
      pairingRequired: chatGptWeb.sessionForConversation(conversationId)?.info().pairingRequired ?? true,
    }
  })
  deps.mhandle('chat:chatgpt-web:companion-end', async (_e, input?: { conversationId?: string }) => {
    const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
    if (!conversationId) return { ok: false, error: 'invalid-input' }
    await chatGptWeb.endSession(conversationId)
    broadcastChatGptWebStatus()
    return { ok: true }
  })
  // Probe: keeps the tunnel up while the user creates/updates the app on chatgpt.com (the MCP handshake
  // happens during creation; without a running client, OpenAI's UI returns "Error creating connector").
  deps.mhandle('chat:chatgpt-web:probe-start', async () => {
    const result = await chatGptWeb.startTunnelProbe()
    broadcastChatGptWebStatus()
    return result
  })
  deps.mhandle('chat:chatgpt-web:probe-stop', async () => {
    await chatGptWeb.stopTunnelProbe()
    broadcastChatGptWebStatus()
    return { ok: true }
  })
  deps.mhandle('chat:chatgpt-web:companion-prompt', (_e, input?: { conversationId?: string }) => {
    const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
    if (!conversationId) return { ok: false, kickoff: null }
    return { ok: true, kickoff: chatGptWeb.companionPrompt(conversationId) }
  })
  deps.mhandle('chat:chatgpt-web:companion-session-key', (_e, input?: { conversationId?: string }) => {
    const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
    if (!conversationId) return { ok: false, sessionKey: null }
    const sessionKey = chatGptWeb.companionSessionKey(conversationId)
    return { ok: sessionKey !== null, sessionKey }
  })
  deps.mhandle('chat:chatgpt-web:companion-open', async (_e, input?: { conversationId?: string }) => {
    const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : ''
    if (!conversationId) return { ok: false, error: 'invalid-input' }
    return chatGptWeb.openCompanionWindow(conversationId)
  })
  deps.mhandle('chat:chatgpt-web:browser-reset', async () => {
    await chatGptWeb.resetCompanionStorage()
    return { ok: true }
  })
  deps.mhandle('chat:chatgpt-web:checks', (_e, conversationId?: string) => {
    const conv = typeof conversationId === 'string' ? getConversation(conversationId) : null
    return {
      raw: getChecksConfig(),
      detected: conv ? listChatGptWebChecks(conv.cwd).map((check) => check.name) : [],
    }
  })
  deps.mhandle('chat:chatgpt-web:set-checks', (_e, raw: string) => {
    setChecksConfig(typeof raw === 'string' ? raw : '')
    broadcastChatGptWebStatus()
    return { ok: true }
  })
  deps.mhandle('chat:chatgpt-web:logs', () => chatGptWeb.tunnelLogs())
  deps.mhandle('chat:review-loop:compatible', async (_e, executorConversationId: string) => {
    if (typeof executorConversationId !== 'string' || !executorConversationId) return []
    return pairedReviewLoops().compatible(executorConversationId)
  })
  deps.mhandle('chat:review-loop:start', async (_e, input: StartPairedReviewLoopInput) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'invalid-input' }
    return pairedReviewLoops().start(input)
  })
  deps.mhandle('chat:review-loop:stop', (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
    if (pairedReviewLoopCoordinator?.stop(conversationId)) return { ok: true }
    const web = lookupReviewLoopByConversation(conversationId)
    if (web?.participants.some((participant) => participant.driver === 'maestrly-pair')) return { ok: true }
    if (web?.participants.some((participant) => participant.driver === 'chatgpt-web')) {
      chatGptWeb.stopReviewLoop(conversationId)
      broadcastChatGptWebStatus()
      return { ok: true }
    }
    return { ok: false, error: 'review-loop-not-found' }
  })
  deps.mhandle('chat:review-loop:status', (_e, conversationId?: string) => {
    const snapshots = neutralReviewLoopSnapshots()
    if (typeof conversationId !== 'string' || !conversationId) return snapshots
    return (
      snapshots.find(
        (loop) =>
          loop.participants.executor.conversationId === conversationId ||
          loop.participants.reviewer?.conversationId === conversationId
      ) ?? null
    )
  })
  // Stop review loop (banner): cancels the active job and prevents new rounds; chat Stop
  // still aborts the individual turn — both coexist (loop Stop also aborts the turn).
  deps.mhandle('chat:chatgpt-web:review-loop:stop', (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
    const conv = getConversation(conversationId)
    if (!conv) return { ok: false, error: 'invalid-conversation' }
    chatGptWeb.stopReviewLoop(conversationId)
    broadcastChatGptWebStatus()
    return { ok: true }
  })
  deps.mhandle('chat:chatgpt-web:review-loop:show-preview', (_e, conversationId: string) => {
    if (typeof conversationId !== 'string' || !conversationId) return { ok: false, error: 'invalid-input' }
    if (!getConversation(conversationId)) return { ok: false, error: 'invalid-conversation' }
    return chatGptWeb.showVisualReviewPreview(conversationId)
  })

  // Additional subscription-provider ACCOUNT management (multiple accounts).
  deps.mhandle('chat:subscription-account:add', (_e, input: { kind: string; label: string }) => {
    try {
      const kind = input?.kind
      if (!isChatSubscriptionProviderKind(kind as ChatProviderKind)) {
        return { ok: false, error: 'unknown-kind' }
      }
      const subscriptionKind = kind as ChatSubscriptionProviderKind
      const account = addSubscriptionAccount(subscriptionKind, typeof input?.label === 'string' ? input.label : '')
      notifyChatRunnerCapabilityChanges(false)
      return {
        ok: true,
        accountId: account.id,
        providerId: subscriptionProviderIdFor(subscriptionKind, account.id),
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  deps.mhandle('chat:subscription-account:rename', (_e, accountId: string, label: string) => {
    if (typeof accountId !== 'string' || !accountId || typeof label !== 'string' || !label.trim()) {
      return { ok: false, error: 'invalid-input' }
    }
    return renameSubscriptionAccount(accountId, label) ? { ok: true } : { ok: false, error: 'unknown-account' }
  })
  deps.mhandle('chat:subscription-account:remove', (_e, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) return { ok: false, error: 'invalid-input' }
    return removeSubscriptionAccountSlot(accountId)
  })
  deps.mhandle(
    'chat:subscription-failover:set-route',
    (_e, input: { primaryProviderId: string; enabled: boolean; fallbackProviderIds?: string[] }) => {
      try {
        const route = setFailoverRoute({
          primaryProviderId: typeof input?.primaryProviderId === 'string' ? input.primaryProviderId : '',
          enabled: input?.enabled === true,
          fallbackProviderIds: Array.isArray(input?.fallbackProviderIds) ? input.fallbackProviderIds : [],
        })
        return { ok: true, route }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // MCP servers (their tools enter chat).
  deps.mhandle('chat:mcp-add', (_e, input: Omit<McpServer, 'id' | 'enabled'> & { enabled?: boolean }) => {
    try {
      const s = addMcpServer(input)
      return { ok: true, id: s.id }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  deps.mhandle('chat:mcp-update', async (_e, id: string, patch: Partial<McpServer>) => {
    if (typeof id === 'string') updateMcpServer(id, patch ?? {})
    await chatGptWeb.invalidateMcpConfiguration()
    return { ok: true }
  })
  deps.mhandle('chat:mcp-remove', async (_e, id: string) => {
    if (typeof id === 'string') removeMcpServer(id)
    await chatGptWeb.invalidateMcpConfiguration()
    return { ok: true }
  })
  // Native app tools (drawer) — toggle (in-process, no HTTP/token).
  deps.mhandle('chat:set-app-tools', (_e, enabled: boolean) => {
    setAppFlag('chat.appTools', enabled === true)
    return { ok: true }
  })
  // Image generation (native Codex imagegen + generate_image for other models) — GLOBAL
  // toggle. Default ON; conversations with explicit overrides keep their own values.
  deps.mhandle('chat:set-image-gen', (_e, enabled: boolean) => {
    setAppFlag(IMAGE_GEN_FLAG, enabled === true)
    return { ok: true }
  })
  // Bash output filters (token savings, experimental) — toggle.
  deps.mhandle('chat:set-bash-filters', (_e, enabled: boolean) => {
    setAppFlag('chat.bashFilters', enabled === true)
    return { ok: true }
  })
  // Model describing images for models WITHOUT vision (null/invalid = disabled).
  deps.mhandle('chat:image-interpreter:set', (_e, value: unknown) => setImageInterpreter(value))
  // Optimized OpenAI Responses harness. Global kill switch, default ON; other providers are unaffected.
  deps.mhandle('chat:set-openai-harness', (_e, enabled: boolean) => {
    setAppFlag('chat.openAIHarness', enabled === true)
    return { ok: true }
  })
  // Dedicated Astra profile kill switch. The selected model is unchanged; the next admitted turn resolves default.
  deps.mhandle('chat:set-astra-harness', (_e, enabled: boolean) => {
    setAppFlag('chat.astraHarness', enabled === true)
    return { ok: true }
  })

  // API key (write-only; renderer never receives the value).
  deps.mhandle('chat:key-set', (_e, providerId: string, key: string) => {
    if (typeof providerId !== 'string' || typeof key !== 'string') return { ok: false }
    if (isManagedProvider(providerId)) return { ok: false }
    const mode = setApiKey(providerId, key)
    invalidateProvider(providerId)
    invalidateModels(providerId)
    notifyChatRunnerCapabilityChanges(false)
    return { ok: true, mode, present: hasApiKey(providerId) }
  })
  deps.mhandle('chat:key-clear', (_e, providerId: string) => {
    if (isManagedProvider(providerId)) return { ok: false }
    if (typeof providerId === 'string') {
      clearApiKey(providerId)
      invalidateProvider(providerId)
      invalidateModels(providerId)
      notifyChatRunnerCapabilityChanges(true)
    }
    return { ok: true }
  })

  // Selection (provider/model): global and conversation defaults.
  deps.mhandle('chat:set-default', async (_e, sel: ChatModelRef & { reasoning?: string; fastMode?: boolean }) => {
    if (isGitHubCopilotSubscriptionProvider(sel?.providerId) && sel?.modelId) {
      const validated = await validateGitHubCopilotModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
      if (!validated.ok) return validated
    }
    if (isClaudeSubscriptionProvider(sel?.providerId) && sel?.modelId) {
      const validated = await validateClaudeModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
      if (!validated.ok) return validated
    }
    if (isGrokSubscriptionProvider(sel?.providerId) && sel?.modelId) {
      const validated = await validateGrokModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
      if (!validated.ok) return validated
    }
    if (isChatGptWebProvider(sel?.providerId)) return { ok: false, error: 'unknown-provider' }
    if (sel?.providerId) setAppSetting(CHAT_DEFAULT_PROVIDER_KEY, sel.providerId)
    if (sel?.modelId) setAppSetting(CHAT_DEFAULT_MODEL_KEY, sel.modelId)
    // reasoning is OPTIONAL in the payload; when present, persist the default for new conversations ('off' = none).
    if (typeof sel?.reasoning === 'string') {
      setAppSetting(CHAT_DEFAULT_REASONING_KEY, sanitizeEffort(sel.reasoning) || 'off')
    }
    if (typeof sel?.fastMode === 'boolean') setAppFlag(CHAT_DEFAULT_FAST_MODE_KEY, sel.fastMode)
    return { ok: true }
  })
  deps.mhandle('chat:set-selection', async (_e, conversationId: string, sel: ChatModelRef) => {
    if (typeof conversationId === 'string' && sel?.providerId && sel?.modelId) {
      if (isChatGptWebProvider(sel.providerId)) return { ok: false, error: 'unknown-provider' }
      if (isGitHubCopilotSubscriptionProvider(sel.providerId)) {
        const validated = await validateGitHubCopilotModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
        if (!validated.ok) return validated
      }
      if (isClaudeSubscriptionProvider(sel.providerId)) {
        const validated = await validateClaudeModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
        if (!validated.ok) return validated
      }
      if (isGrokSubscriptionProvider(sel.providerId)) {
        const validated = await validateGrokModelSelection(sel.modelId, subscriptionAccountId(sel.providerId))
        if (!validated.ok) return validated
      }
      const previous = getConvUiPrefs(conversationId).chat
      const changed = previous?.providerId !== sel.providerId || previous?.modelId !== sel.modelId
      const operation = reserveConversationOperation(conversationId, previous?.providerId ?? sel.providerId)
      if (!operation) return { ok: false, error: 'busy' }
      try {
        if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }
        if (changed && isClaudeSubscriptionProvider(previous?.providerId)) {
          await deleteClaudeSessionForConversation(conversationId)
        }
        // Model changes retest image capability → clear the learned flag (imagesUnsupported).
        patchConvChat(conversationId, {
          providerId: sel.providerId,
          modelId: sel.modelId,
          ...(changed ? { imagesUnsupported: false } : {}),
        })
      } finally {
        releaseConversationOperation(conversationId, operation)
      }
    }
    return { ok: true }
  })
  deps.mhandle('chat:get-selection', (_e, conversationId: string) =>
    typeof conversationId === 'string' ? selectionFor(conversationId) : defaultSelection()
  )

  // Permission mode per conversation (full | ask | auto).
  deps.mhandle('chat:get-perm-mode', (_e, conversationId: string) =>
    typeof conversationId === 'string' ? permModeFor(conversationId) : 'ask'
  )
  deps.mhandle('chat:set-perm-mode', (_e, conversationId: string, mode: 'full' | 'ask' | 'auto') => {
    if (typeof conversationId === 'string' && (mode === 'full' || mode === 'ask' || mode === 'auto')) {
      patchConvChat(conversationId, { permMode: mode })
    }
    return { ok: true }
  })

  // Standard behavior mode per conversation.
  deps.mhandle('chat:get-mode', (_e, conversationId: string) =>
    typeof conversationId === 'string' ? modeFor(conversationId) : 'agent'
  )
  deps.mhandle('chat:set-mode', (_e, conversationId: string, mode: unknown) => {
    if (typeof conversationId !== 'string' || !conversationId || !getConversation(conversationId)) {
      return { ok: false, error: 'invalid-conversation' }
    }
    if (getConversation(conversationId)?.experience === 'maestro') {
      return { ok: false, error: 'maestro-experience' }
    }
    if (!isChatMode(mode)) return { ok: false, error: 'invalid-mode' }
    patchConvChat(conversationId, { mode })
    return { ok: true }
  })

  // Reasoning per conversation: raw provider effort or Maestrly namespaced sentinel. 'off'/empty = none.
  deps.mhandle('chat:get-reasoning', (_e, conversationId: string) => {
    const r = typeof conversationId === 'string' ? getConvUiPrefs(conversationId).chat?.reasoning : undefined
    // Picker never touched in this conversation (undefined) → inherit global default; otherwise honor its own value.
    return typeof r === 'string' && r.trim() ? r : defaultReasoningEffort()
  })
  deps.mhandle('chat:set-reasoning', async (_e, conversationId: string, effort: string) => {
    if (typeof conversationId === 'string' && typeof effort === 'string') {
      patchConvChat(conversationId, { reasoning: sanitizeEffort(effort) || 'off' })
    }
    return { ok: true }
  })

  // Fast/Priority per conversation for Codex. Default OFF; BYOK providers simply ignore the flag.
  deps.mhandle(
    'chat:get-fast-mode',
    (_e, conversationId: string) =>
      typeof conversationId === 'string' && getConvUiPrefs(conversationId).chat?.fastMode === true
  )
  deps.mhandle('chat:set-fast-mode', (_e, conversationId: string, enabled: boolean) => {
    if (typeof conversationId === 'string' && typeof enabled === 'boolean') {
      patchConvChat(conversationId, { fastMode: enabled })
    }
    return { ok: true }
  })

  // Tools PER CONVERSATION (app-tools + disabled MCP servers + image generation).
  deps.mhandle('chat:get-conv-tools', (_e, conversationId: string) =>
    typeof conversationId === 'string'
      ? convToolsFor(conversationId)
      : { app: false, mcpDisabled: [], imageGen: getAppFlag(IMAGE_GEN_FLAG, true) }
  )
  deps.mhandle(
    'chat:set-conv-tools',
    (_e, conversationId: string, patch: { app?: boolean; mcpDisabled?: string[]; imageGen?: boolean }) => {
      if (typeof conversationId === 'string') {
        const cur = getConvUiPrefs(conversationId).chat?.tools ?? {}
        patchConvChat(conversationId, { tools: { ...cur, ...(patch ?? {}) } })
      }
      return { ok: true }
    }
  )

  // Edit last message + resend: truncate from the edited message seq and run a new turn.
  deps.mhandle(
    'chat:resend',
    async (
      event,
      payload: {
        conversationId: string
        fromMessageId: string
        text: string
        agentMentions?: StructuredAgentMentionDraft[]
      }
    ) => {
      const { conversationId, fromMessageId, text } = payload ?? {}
      if (typeof conversationId !== 'string' || typeof fromMessageId !== 'string')
        return { ok: false, error: 'invalid-input' }
      const operation = reserveConversationOperation(conversationId, selectionFor(conversationId)?.providerId ?? null)
      if (!operation) return { ok: false, error: 'busy' }
      try {
        // Preserve original ATTACHMENTS (editing changes text only) — otherwise images/files disappear on resend.
        // Exclude `hidden` parts (@file mention content): reinject them when reparsing text.
        // COPY BYTES of images with artifactId here, BEFORE truncation: deleteChatMessagesFrom
        // below removes the old message's sidecars — reusing artifactId would point the new message to
        // deleted files. startSend writes NEW artifacts from the copied bytes.
        const original = getChatMessage(conversationId, fromMessageId)
        const attachments: ChatAttachmentInput[] = await preserveResendAttachments(
          conversationId,
          (original?.parts ?? []).filter(
            (p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file' && !p.hidden
          )
        )
        await deleteSubscriptionStateForConversation(conversationId, operation.controller.signal, {
          preserveClaude: isClaudeSubscriptionProvider(selectionFor(conversationId)?.providerId),
        })
        if (!conversationOperationIsCurrent(conversationId, operation)) return { ok: false, error: 'busy' }
        // The EDITOR's `#agent` selection (occurrences with id/range) goes to startSend — SAME host-side
        // validation as chat:send (buildAgentMentionParts). Old agent-mention parts from the original
        // message are NOT automatically preserved: the user may have removed the chip in the editor.
        const agentMentions = Array.isArray(payload?.agentMentions) ? payload.agentMentions : undefined
        const seq = getMessageSeq(fromMessageId)
        if (seq != null) deleteChatMessagesFrom(conversationId, seq)
        return await startSend(deps, event.sender, conversationId, text, attachments, { operation }, agentMentions)
      } finally {
        releaseConversationOperation(conversationId, operation)
      }
    }
  )

  // Permissions.
  deps.mon(
    'chat:permission-respond',
    (_e, requestId: string, reply: 'once' | 'always' | 'reject', message?: string) => {
      if (typeof requestId === 'string') getBroker().reply({ requestId, reply, message })
    }
  )
  // ask_question (mark X): user answers (string[][]) → resolve the tool's blocked execute.
  deps.mon('chat:question-respond', (_e, toolCallId: string, answers: string[][]) => {
    if (typeof toolCallId === 'string') getQuestionBroker().reply(toolCallId, Array.isArray(answers) ? answers : [])
  })
}

/** Aborts everything and completes only after the official app-server closes (idempotent quit/teardown). */
export function disposeChat(): Promise<void> {
  if (chatDisposePromise) return chatDisposePromise
  chatDisposePromise = (async () => {
    // Multiple accounts: shut down ALL instances created in this process (default + additional slots).
    for (const claudeInstance of listClaudeSubscriptionManagers()) {
      claudeInstance.cancelLogin()
      claudeInstance.abortAllQueries()
    }
    const pendingSnapshot = [...pendingConversationOperations.values()]
    const pairedReviewDispose = pairedReviewLoopCoordinator?.dispose() ?? Promise.resolve()
    for (const operation of pendingSnapshot) operation.controller.abort(new Error('Chat service is shutting down'))
    abortAllCodexEphemeralAttempts()
    const claudeAttempts = listClaudeAttempts()
    for (const attempt of claudeAttempts) attempt.abort(new Error('Chat service is shutting down'))
    for (const entry of internalTurns.values()) entry.cancel()
    const snapshot = [...active.entries()]
    const ids = new Set(snapshot.map(([id]) => id))
    for (const [, run] of snapshot) run.controller.abort()
    if (broker) for (const id of ids) broker.rejectConversation(id)
    if (questionBroker) for (const id of ids) questionBroker.rejectConversation(id)
    await Promise.all([
      waitForRuns(snapshot.map(([, run]) => run)),
      waitForAllCodexEphemeralAttemptsBestEffort(pendingSnapshot.map((operation) => operation.done)),
      Promise.all([
        ...claudeAttempts.map((attempt) => attempt.done),
        ...snapshot.filter(([, run]) => isClaudeSubscriptionProvider(run.providerId)).map(([, run]) => run.done),
      ]),
      pairedReviewDispose,
      maestroConfiguratorService.stop(),
    ])
    active.clear()
    pendingConversationOperations.clear()
    for (const wc of [...chatSubscriptionsByWebContents.keys()]) clearChatSubscriptions(wc)
    codexAccountUpdatedUnsubscribe?.()
    codexAccountUpdatedUnsubscribe = null
    githubCopilotAuthUpdatedUnsubscribe?.()
    githubCopilotAuthUpdatedUnsubscribe = null
    claudeAuthenticationRequiredUnsubscribe?.()
    claudeAuthenticationRequiredUnsubscribe = null
    grokAuthUpdatedUnsubscribe?.()
    grokAuthUpdatedUnsubscribe = null
    chatGptWebUnsubscribe?.()
    chatGptWebUnsubscribe = null
    subagentSessionUnsubscribe?.()
    subagentSessionUnsubscribe = null
    pairedReviewLoopCoordinator = null
    await chatGptWeb.disposeChatGptWeb().catch(() => undefined)
    await codexExternalAccountRefreshPromise
    await githubCopilotIdentityTransitionPromise
    await claudeIdentityTransitionPromise
    await grokIdentityTransitionPromise
    const grokProviderIds = listGrokSubscriptionManagers().map((manager) =>
      subscriptionProviderIdFor('grok-subscription', manager.accountId)
    )
    await Promise.all([
      ...listCodexSubscriptionManagers().map((manager) => manager.dispose()),
      ...listGitHubCopilotSubscriptionManagers().map((manager) => manager.dispose()),
      ...listClaudeSubscriptionManagers().map((manager) => Promise.resolve(manager.dispose())),
      disposeGrokSubscriptionManager(),
      disposeMcpRuntime(),
    ])
    clearEphemeralToolImages()
    for (const providerId of grokProviderIds) invalidateProvider(providerId)
  })()
  return chatDisposePromise
}
