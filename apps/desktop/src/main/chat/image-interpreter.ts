/**
 * IMAGE INTERPRETER — lends vision to models without it.
 *
 * When the conversation model rejects images, attachments were simply omitted (an
 * `[image omitted]` history note). A vision model selected in Settings
 * (provider + model + effort) now describes the image in ONE standalone call — no tools, outside the conversation,
 * no persisted thread/session — caching the description on the part itself (`description`).
 *
 * Caching is mandatory: history is resent each turn; otherwise each turn would pay
 * for another vision call per image. FAILURES are also cached (in memory by image+context+config):
 * without this, broken interpreters (timeout/auth/no vision) retry on EVERY message —
 * up to 8×120s delay per turn. Changing interpreter or restarting rearms attempts.
 *
 * Cache/failure/in-flight work is scoped to EFFECTIVE credential/account IDENTITY (official-provider
 * fingerprint/epoch; BYOK API-key hash): account switches within a slot or API-key changes reuse nothing
 * from the previous identity and never attribute its work to the new identity.
 *
 * Limitation: the main model never sees pixels. Details missing from the description cannot
 * be answered — hence the prompt requests exhaustive literal transcription, not a summary.
 */

import { createHash, randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { buildProviderOptions, type ChatImageInterpreter, type ChatMessage, type MessagePart } from '../../shared/chat'
import { getAppSetting, setAppSetting } from '../store'
import {
  getProvider,
  getProviderKind,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isGitHubCopilotSubscriptionProvider,
  isGrokSubscriptionProvider,
  subscriptionAccountId,
} from './catalog'
import { getClaudeSubscriptionManager } from './claude-agent-sdk/manager'
import { freezeFailoverChain } from './subscription-failover/config'
import { getCodexSubscriptionManager } from './codex-subscription/manager'
import { getApiKey, hasApiKey } from './credentials'
import { getGitHubCopilotSubscriptionManager } from './github-copilot/manager'
import { getGrokSubscriptionManager } from './grok-subscription/manager'
import { catalogProviderForBaseURL, getProviderModelMeta } from './model-meta'
import { getChatMessage, listConversationContextMessages, updateChatMessageParts } from './chat-store'
import { getOpenAIInferenceState, updateChatMessageWithOpenAIInferenceState } from './openai/inference-store'
import { patchOpenAILedgerToolOutputs } from './openai/ledger'
import { patchOpenAIToolExecutionOutputs } from './openai/execution'
import { activeChatContext } from './message'
import { decodeLegacyAttachmentData, resolveFileImageBytesSync } from './attachment-artifacts'
import { recordModelCallUsage, type DiagnosticUsage } from './usage-diagnostics'
import {
  summarizeWithClaudeRuntime,
  summarizeWithCodexRuntime,
  summarizeWithGitHubCopilotRuntime,
  type IsolatedImageInput,
  type IsolatedSummaryResult,
} from './portable-summarizer'
import * as portableSummarizer from './portable-summarizer'
import { buildOpenAIProviderFingerprint, resolveLanguageModel } from './provider'
import {
  describeToolOutputImages,
  EPHEMERAL_IMAGE_CACHE_TTL_MS as EPHEMERAL_TOOL_IMAGE_CACHE_TTL_MS,
  MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES as MAX_EPHEMERAL_TOOL_IMAGE_CACHE_ENTRIES,
  MAX_TOOL_IMAGES_PER_RESULT,
  mergeToolOutputImageDescriptions,
  hasEphemeralToolImage,
  onEphemeralImageConversationCleanup,
  onEphemeralToolImageCacheEviction,
  resolveEphemeralToolImage,
} from './tool-output'
import { toolOutputImages, type ChatToolImage, type ToolOutput } from '../../shared/chat'

export const IMAGE_INTERPRETER_KEY = 'chat.imageInterpreter'

/** Per-turn described-image cap: a forgotten history attachment must not cause a burst of calls. */
const MAX_IMAGES_PER_TURN = MAX_TOOL_IMAGES_PER_RESULT
/** A stuck description must not block the turn indefinitely. */
export const DESCRIBE_TIMEOUT_MS = 120_000
/** Attempts per image+context+config per app session; exhausted = omission note without retry. */
const MAX_IMAGE_DESCRIBE_ATTEMPTS = 2

/**
 * NEGATIVE CACHE (memory): failures by `imageId/partId + conversationId + cwd + provider + model + effort +
 * IDENTITY`. Images without `description` remain eligible every turn (needsDescription), so without this
 * map permanent failures would retry forever. Byte handles may be shared across conversations,
 * but execution and billing must not. Deliberately not persisted: restarting the app or changing interpreter
 * deserves another chance.
 *
 * The final segment (`identity`, see interpreterIdentityFingerprint) scopes cache to EFFECTIVE
 * credentials/account: switching accounts in the same slot (or keys for the same provider/model) changes identity;
 * the new identity reuses no descriptions/failures from the old one.
 */
const describeFailures = new Map<string, number>()
const failureKey = (
  partId: string,
  conversationId: string,
  cwd: string,
  interpreter: ChatImageInterpreter,
  identity: string
): string =>
  `${partId}\0${conversationId}\0${cwd}\0${interpreter.providerId}\0${interpreter.modelId}\0${interpreter.effort ?? ''}\0${identity}`

/**
 * Extra ephemeral tool-image key segment: digest of the name sent in the interpreter prompt
 * (`userPrompt(image.name)`). Byte cache deduplicates by content, so two tool outputs can
 * share the SAME handle under different names — descriptions/failures for one name must not leak
 * to another. Hash instead of raw concatenation: tool-output names must not collide with
 * the key's `\0` separators.
 */
function ephemeralImageNameDigest(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex')
}

type EphemeralImageDescription = { text: string; model?: string }

interface CachedEphemeralImageDescription extends EphemeralImageDescription {
  imageId: string
  lastAccessAt: number
  accessOrder: number
}

interface InflightEphemeralImageDescription {
  generation: number
  controller: AbortController
  timeoutSignal: AbortSignal
  consumers: number
  settled: boolean
  cancelledByConsumers: boolean
  promise: Promise<EphemeralImageDescription | null>
}

/** Single-flight by handle+conversation+cwd+config: same-conversation workers share descriptions without mixing ownership. */
const inflightByEphemeralImage = new Map<string, InflightEphemeralImageDescription>()
/** Positive process-local cache: bounded like the host-owned tool-image cache and never persisted globally. */
const describedEphemeralImages = new Map<string, CachedEphemeralImageDescription>()
let describedEphemeralImageAccessOrder = 0
let imageInterpreterGeneration = 0

function clearDescribedEphemeralImages(): void {
  describedEphemeralImages.clear()
  describedEphemeralImageAccessOrder = 0
}

function pruneDescribedEphemeralImages(now = Date.now()): void {
  for (const [key, entry] of describedEphemeralImages) {
    if (now - entry.lastAccessAt > EPHEMERAL_TOOL_IMAGE_CACHE_TTL_MS) describedEphemeralImages.delete(key)
  }
  while (describedEphemeralImages.size > MAX_EPHEMERAL_TOOL_IMAGE_CACHE_ENTRIES) {
    const oldest = [...describedEphemeralImages.entries()].sort((a, b) => a[1].accessOrder - b[1].accessOrder)[0]
    if (!oldest) break
    describedEphemeralImages.delete(oldest[0])
  }
}

function getDescribedEphemeralImage(key: string): EphemeralImageDescription | null {
  pruneDescribedEphemeralImages()
  const cached = describedEphemeralImages.get(key)
  if (!cached) return null
  cached.lastAccessAt = Date.now()
  cached.accessOrder = ++describedEphemeralImageAccessOrder
  return { text: cached.text, ...(cached.model ? { model: cached.model } : {}) }
}

function cacheDescribedEphemeralImage(args: {
  key: string
  imageId: string
  description: EphemeralImageDescription
  generation: number
}): void {
  if (args.generation !== imageInterpreterGeneration || descriptionConversationDeleted(args.key)) return
  if (!hasEphemeralToolImage({ id: args.imageId })) return
  pruneDescribedEphemeralImages()
  const now = Date.now()
  const existing = describedEphemeralImages.get(args.key)
  if (!existing) {
    while (describedEphemeralImages.size >= MAX_EPHEMERAL_TOOL_IMAGE_CACHE_ENTRIES) {
      const oldest = [...describedEphemeralImages.entries()].sort((a, b) => a[1].accessOrder - b[1].accessOrder)[0]
      if (!oldest) break
      describedEphemeralImages.delete(oldest[0])
    }
  }
  describedEphemeralImages.set(args.key, {
    imageId: args.imageId,
    text: args.description.text,
    ...(args.description.model ? { model: args.description.model } : {}),
    lastAccessAt: now,
    accessOrder: ++describedEphemeralImageAccessOrder,
  })
}

// Byte-cache eviction must also release descriptions for the same opaque handle.
onEphemeralToolImageCacheEviction((imageId) => {
  if (imageId === null) {
    clearDescribedEphemeralImages()
    return
  }
  for (const [key, entry] of describedEphemeralImages) {
    if (entry.imageId === imageId) describedEphemeralImages.delete(key)
  }
})

/**
 * Key = `<imageId|partId>\0<conversationId>\0<cwd>\0<providerId>\0<modelId>\0<effort>\0<identity>` (ephemeral
 * tool images add a final name-digest segment, ignored here).
 */
function descriptionKeySegments(key: string): { first: string; conversationId: string } | null {
  const firstSeparator = key.indexOf('\0')
  if (firstSeparator === -1) return null
  const secondSeparator = key.indexOf('\0', firstSeparator + 1)
  if (secondSeparator === -1) return null
  return { first: key.slice(0, firstSeparator), conversationId: key.slice(firstSeparator + 1, secondSeparator) }
}

/**
 * Conversations whose durable rows were ALL removed. In-flight descriptions can complete
 * AFTER cleanup and try recaching metadata without a durable owner (shared bytes
 * remain for other conversations, so handle guards do not block this). Conversation UUIDs are never
 * reused, so entries never become stale; bound size for sanity.
 */
const deletedDescriptionConversations = new Set<string>()
const MAX_DELETED_DESCRIPTION_CONVERSATIONS = 10_000

function markDescriptionConversationDeleted(conversationId: string): void {
  deletedDescriptionConversations.add(conversationId)
  if (deletedDescriptionConversations.size > MAX_DELETED_DESCRIPTION_CONVERSATIONS) {
    deletedDescriptionConversations.clear()
  }
}

function descriptionConversationDeleted(key: string): boolean {
  const segments = descriptionKeySegments(key)
  return segments !== null && deletedDescriptionConversations.has(segments.conversationId)
}

function recordDescribeFailure(key: string): void {
  if (descriptionConversationDeleted(key)) return
  describeFailures.set(key, (describeFailures.get(key) ?? 0) + 1)
}

/** Entire conversation removed: its scoped descriptions AND failures no longer have a durable owner. */
function removeDescriptionMetadataForConversation(conversationId: string): void {
  for (const key of [...describedEphemeralImages.keys()]) {
    if (descriptionKeySegments(key)?.conversationId === conversationId) describedEphemeralImages.delete(key)
  }
  for (const key of [...describeFailures.keys()]) {
    if (descriptionKeySegments(key)?.conversationId === conversationId) describeFailures.delete(key)
  }
}

/** Only removed conversation handles/parts: retain remaining cache for the still-live conversation. */
function removeDescriptionMetadataForRefs(conversationId: string, removedIds: ReadonlySet<string>): void {
  if (removedIds.size === 0) return
  for (const key of [...describedEphemeralImages.keys()]) {
    const segments = descriptionKeySegments(key)
    if (segments?.conversationId === conversationId && removedIds.has(segments.first))
      describedEphemeralImages.delete(key)
  }
  for (const key of [...describeFailures.keys()]) {
    const segments = descriptionKeySegments(key)
    if (segments?.conversationId === conversationId && removedIds.has(segments.first)) describeFailures.delete(key)
  }
}

onEphemeralImageConversationCleanup((cleanup) => {
  // Only ACTUAL conversation deletion sets a tombstone: "clear" leaves it usable —
  // tombstoning would disable its description cache for the rest of the session.
  if (cleanup.kind === 'deleted') {
    markDescriptionConversationDeleted(cleanup.conversationId)
    removeDescriptionMetadataForConversation(cleanup.conversationId)
    return
  }
  if (cleanup.kind === 'conversation') {
    removeDescriptionMetadataForConversation(cleanup.conversationId)
    return
  }
  removeDescriptionMetadataForRefs(cleanup.conversationId, cleanup.removedIds)
})

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function releaseEphemeralImageConsumer(flight: InflightEphemeralImageDescription): void {
  flight.consumers--
  if (flight.consumers > 0 || flight.settled || flight.controller.signal.aborted) return
  // Keep Stop local to the last consumer. A shared request with another consumer must be allowed to finish.
  flight.cancelledByConsumers = true
  flight.controller.abort(new DOMException('No image interpreter consumers remain.', 'AbortError'))
}

function waitForEphemeralImageDescription(
  flight: InflightEphemeralImageDescription,
  signal: AbortSignal
): Promise<EphemeralImageDescription | null> {
  flight.consumers++
  return new Promise((resolve, reject) => {
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal.removeEventListener('abort', onAbort)
      releaseEphemeralImageConsumer(flight)
    }
    const onAbort = (): void => {
      release()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    flight.promise.then(
      (result) => {
        release()
        resolve(result)
      },
      (error: unknown) => {
        release()
        reject(error)
      }
    )
  })
}

const SYSTEM = [
  'You are an image interpreter. Another AI assistant cannot see images and will only receive your text.',
  'Your description IS the image for that assistant: it must be exhaustive, literal and free of speculation.',
].join(' ')

const extractIsolatedSummaryAttemptUsage = (value: unknown): DiagnosticUsage | undefined => {
  try {
    return portableSummarizer.isolatedSummaryAttemptUsage?.(value)
  } catch {
    return undefined
  }
}

const mergeIsolatedSummaryAttemptUsage = (
  result: IsolatedSummaryResult,
  failedAttemptUsage: DiagnosticUsage
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

function userPrompt(name: string): string {
  return [
    `Describe the attached image (file name: "${name}") for an AI assistant that cannot see it.`,
    '',
    'Rules:',
    '- Transcribe ALL visible text VERBATIM: error messages, stack traces, code, logs, labels, values, URLs.',
    '  Keep code and terminal output inside fenced blocks, preserving line breaks.',
    '- Describe the structure: what kind of image it is (screenshot, diagram, photo, chart), the layout, the',
    '  UI elements and any highlighted, circled or annotated region.',
    '- For charts/tables, list the axes, series and data points you can read.',
    '- State only what is visible. Do not guess intent, do not give advice, do not add a preamble or closing.',
    '- If the image is unreadable or empty, say exactly that.',
  ].join('\n')
}

/** Reads global setting. Invalid/corrupt format → disabled (never breaks sending). */
export function getImageInterpreter(): ChatImageInterpreter | null {
  const raw = getAppSetting(IMAGE_INTERPRETER_KEY)
  if (!raw) return null
  try {
    return normalizeImageInterpreter(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * True only when the configured interpreter is locally eligible for the unknown-vision fallback.
 *
 * `false` is deliberately fail-open for unknown child models: it means the provider is missing, known
 * unauthenticated, or readiness has not been established without a refresh. In those cases the child keeps the
 * raw image instead of receiving an omission note after a guaranteed failed interpreter attempt.
 */
export function hasConfiguredImageInterpreter(): boolean {
  const interpreter = getImageInterpreter()
  if (!interpreter) return false

  try {
    const provider = getProvider(interpreter.providerId)
    if (!provider) return false
    const accountId = subscriptionAccountId(interpreter.providerId)

    if (isCodexSubscriptionProvider(interpreter.providerId)) {
      const status = getCodexSubscriptionManager(accountId).getStatusSnapshot()
      // Codex can establish its app-server connection in describeImage; a ready snapshot is not required here.
      return status?.authenticated === true
    }

    if (isGitHubCopilotSubscriptionProvider(interpreter.providerId)) {
      const manager = getGitHubCopilotSubscriptionManager(accountId)
      const status = manager.getStatusSnapshot()
      return status?.authenticated === true && status.connected === true && status.accountFingerprint !== null
    }

    if (isClaudeSubscriptionProvider(interpreter.providerId)) {
      const status = getClaudeSubscriptionManager(accountId).getStatusSnapshot()
      return status?.authenticated === true && status.accountFingerprint !== null
    }

    if (isGrokSubscriptionProvider(interpreter.providerId)) {
      const status = getGrokSubscriptionManager(accountId).getStatusSnapshot()
      // Grok uses its authenticated BYOK-compatible path and does not require an active connected snapshot.
      return status?.authenticated === true
    }

    return hasApiKey(interpreter.providerId)
  } catch {
    // Readiness checks must never make a child turn fail, and must not refresh/spawn a provider runtime.
    return false
  }
}

/**
 * EFFECTIVE interpreter credential/account identity, computed ONLY from local state (manager snapshot or
 * secure-store) — never refreshes/network-calls or exposes tokens. Final segment of
 * cache/single-flight/failure keys: same provider/model/image under ANOTHER account/key reuses nothing
 * from the previous identity. Official-manager identity (fingerprint + epoch) changes AT the
 * login/logout/switch event (snapshot clears), so new keys never find old entries, including
 * during concurrent transitions. BYOK uses the existing backend+credential fingerprint from provider.ts.
 *
 * Returns empty string when identity cannot be established locally (e.g. snapshot not loaded).
 * In that state, do not read/write cache: unknown identities cannot reuse data
 * (single-flight still shares among simultaneous consumers using the same key).
 */
function interpreterIdentityFingerprint(interpreter: ChatImageInterpreter): string {
  const { providerId } = interpreter
  try {
    const provider = getProvider(providerId)
    if (!provider) return ''
    const accountId = subscriptionAccountId(providerId)

    if (isCodexSubscriptionProvider(providerId)) {
      // Codex snapshot exposes no fingerprint/epoch; identity is the runtime account. `account/updated`
      // clears the snapshot → unknown identity (empty string) reuses nothing across account switches.
      const status = getCodexSubscriptionManager(accountId).getStatusSnapshot()
      if (!status) return ''
      if (!status.authenticated) return 'codex:signed-out'
      const email = status.account?.type === 'chatgpt' ? status.account.email : null
      return email
        ? `codex:${createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex')}`
        : 'codex:unknown'
    }

    if (isGitHubCopilotSubscriptionProvider(providerId)) {
      const { fingerprint, epoch } = getGitHubCopilotSubscriptionManager(accountId).getAccountIdentity()
      return fingerprint ? `sub:${fingerprint}:${epoch}` : ''
    }

    if (isClaudeSubscriptionProvider(providerId)) {
      const identities = freezeFailoverChain(providerId).map((id) => {
        const status = getClaudeSubscriptionManager(subscriptionAccountId(id)).getStatusSnapshot()
        return status ? [id, status.accountFingerprint ?? null, status.accountEpoch, status.authenticated] : null
      })
      if (identities.some((entry) => entry === null)) return ''
      // An in-flight description may already be on B even while A's identity is unchanged.
      return `claude-route:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`
    }

    if (isGrokSubscriptionProvider(providerId)) {
      const { fingerprint, epoch } = getGrokSubscriptionManager(accountId).getAccountIdentity()
      return fingerprint ? `sub:${fingerprint}:${epoch}` : ''
    }

    const apiKey = getApiKey(providerId)
    if (!apiKey) return 'byok:none'
    return `byok:${buildOpenAIProviderFingerprint(provider, getProviderKind(provider), apiKey)}`
  } catch {
    // Identity must never fail the turn: unknown = no reuse.
    return ''
  }
}

/** Validates renderer payload. null/empty = disable. */
export function normalizeImageInterpreter(value: unknown): ChatImageInterpreter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!providerId || !modelId) return null
  const effort = typeof raw.effort === 'string' ? raw.effort.trim().toLowerCase().slice(0, 24) : ''
  return { providerId, modelId, ...(effort && effort !== 'off' ? { effort } : {}) }
}

export function setImageInterpreter(value: unknown): { ok: boolean; value: ChatImageInterpreter | null } {
  const normalized = normalizeImageInterpreter(value)
  setAppSetting(IMAGE_INTERPRETER_KEY, normalized ? JSON.stringify(normalized) : '')
  // New config = new chance: neither result nor failure belongs to the new interpreter generation.
  imageInterpreterGeneration++
  describeFailures.clear()
  clearDescribedEphemeralImages()
  return { ok: true, value: normalized }
}

function needsDescription(part: MessagePart): part is Extract<MessagePart, { type: 'file' }> {
  return part.type === 'file' && part.kind === 'image' && !part.description?.trim()
}

/** `data:<mime>;base64,<...>` → three runtime-required formats. Malformed/oversized data URL = skip image. */
function decodeImage(part: Extract<MessagePart, { type: 'file' }>, conversationId: string): IsolatedImageInput | null {
  if (part.artifactId) {
    const image = resolveFileImageBytesSync(conversationId, part)
    if (!image) return null
    const base64 = Buffer.from(image.bytes).toString('base64')
    return { name: part.name, mediaType: image.mediaType, base64, dataUrl: `data:${image.mediaType};base64,${base64}` }
  }
  const legacy = decodeLegacyAttachmentData(part.data)
  if (!legacy) return null
  const base64 = legacy.bytes.toString('base64')
  return { name: part.name, mediaType: legacy.mediaType, base64, dataUrl: `data:${legacy.mediaType};base64,${base64}` }
}

/**
 * Does outgoing content (new message + ACTIVE context) contain any image WITHOUT a description? Cheap turn
 * gate: only then resolve model metadata (which may require network access).
 */
export function hasImagesToDescribe(conversationId: string, pendingParts: readonly MessagePart[]): boolean {
  if (pendingParts.some(needsDescription)) return true
  // Only MAIN context the model will SEE: isolated-round images never return to it.
  return activeChatContext(listConversationContextMessages(conversationId)).messages.some((message) =>
    message.parts.some(needsDescription)
  )
}

/** One isolated description. Throws on auth/network failure — caller treats as "no description" (fallback). */
async function describeImage(
  interpreter: ChatImageInterpreter,
  image: IsolatedImageInput,
  conversationId: string,
  cwd: string,
  signal: AbortSignal
): Promise<string> {
  const { providerId, modelId, effort } = interpreter
  const accountId = subscriptionAccountId(providerId)
  const prompt = userPrompt(image.name)
  // Interpreter calls are billable: enter the diagnostic ledger (model-call-usage) like other
  // model calls. (Conversation meter excludes them — persistence would require extra history messages,
  // invalidating native-session resume; recorded decision.)
  const record = (
    runtime: 'byok-ai-sdk' | 'codex-subscription' | 'github-copilot-subscription' | 'claude-subscription',
    usage: DiagnosticUsage | undefined,
    details: { providerId?: string; modelId?: string; attempt?: number } = {}
  ): void => {
    if (usage && (usage.totalInput || usage.output)) {
      recordModelCallUsage({
        runtime,
        providerId: details.providerId ?? providerId,
        modelId: details.modelId ?? modelId,
        conversationId,
        agent: 'image-interpreter',
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
          client: target.client,
          cwd,
          modelId: target.runtimeModelId,
          system: SYSTEM,
          prompt,
          signal: operationSignal,
          images: [image],
          conversationId,
          accountId: target.accountId ?? accountId ?? null,
          ...(target.reasoningEffort ? { effort: target.reasoningEffort } : effort ? { effort } : {}),
          ...(target.serviceTier !== undefined ? { serviceTier: target.serviceTier } : {}),
        }),
    })
    return result.text
  }

  if (isGitHubCopilotSubscriptionProvider(providerId)) {
    const manager = getGitHubCopilotSubscriptionManager(accountId)
    const status = await manager.getStatus().catch(() => null)
    if (!status?.authenticated || !status.connected) throw new Error('Image interpreter provider is not connected.')
    const identity = manager.getAccountIdentity()
    if (!identity.fingerprint) throw new Error('Image interpreter provider is not authenticated.')
    const result = await summarizeWithGitHubCopilotRuntime({
      manager,
      accountIdentity: identity,
      // Ephemeral store-free session; ID is only for cleanup and must not touch the real conversation.
      conversationId: `image-interpreter:${Date.now()}`,
      cwd,
      modelId,
      system: SYSTEM,
      prompt,
      signal,
      images: [image],
      ...(effort ? { effort } : {}),
    })
    record('github-copilot-subscription', result.usage)
    return result.text
  }

  if (isClaudeSubscriptionProvider(providerId)) {
    const { runClaudeEphemeralWithFailover } = await import('./subscription-failover/claude-ephemeral')
    const result = await runClaudeEphemeralWithFailover({
      logicalProviderId: providerId,
      modelId,
      reasoningEffort: effort,
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
          system: SYSTEM,
          prompt,
          signal: operationSignal,
          images: [image],
          effort: target.reasoningEffort,
          fastMode: target.fastMode,
        }),
    })
    return result.text
  }

  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Unknown image interpreter provider: ${providerId}`)
  if (isGrokSubscriptionProvider(providerId)) {
    const status = await getGrokSubscriptionManager(accountId)
      .getStatus()
      .catch(() => null)
    if (!status?.authenticated) throw new Error('Image interpreter provider is not authenticated.')
  } else if (!hasApiKey(providerId)) {
    throw new Error('Image interpreter provider has no API key.')
  }
  const meta = await getProviderModelMeta(modelId, catalogProviderForBaseURL(provider.baseURL)).catch(() => null)
  const providerOptions = buildProviderOptions(getProviderKind(provider), effort, meta)
  const result = await generateText({
    model: resolveLanguageModel(providerId, modelId),
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: image.dataUrl },
          { type: 'text', text: prompt },
        ],
      },
    ],
    abortSignal: signal,
    ...(providerOptions ? { providerOptions } : {}),
  })
  // Local normalization (avoid importing runner normalizeAiUsage and creating runner↔interpreter cycle).
  const rawUsage = result.totalUsage as
    | { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown }
    | undefined
  const count = (value: unknown): number => {
    const num = Number(value)
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
  }
  const totalInput = count(rawUsage?.inputTokens)
  const cacheRead = Math.min(totalInput, count(rawUsage?.cachedInputTokens))
  record('byok-ai-sdk', {
    input: totalInput - cacheRead,
    output: count(rawUsage?.outputTokens),
    cacheRead,
    cacheCreate: 0,
    totalInput,
  })
  return result.text ?? ''
}

/** Describes an image returned by a tool without turning it into a persisted attachment. */
function startEphemeralImageDescription(args: {
  key: string
  imageId: string
  interpreter: ChatImageInterpreter
  image: IsolatedImageInput
  conversationId: string
  cwd: string
  /** Starting credential/account identity; empty = unknown → cache neither successes nor failures. */
  identity: string
}): InflightEphemeralImageDescription {
  const existing = inflightByEphemeralImage.get(args.key)
  if (
    existing &&
    existing.generation === imageInterpreterGeneration &&
    !existing.settled &&
    !existing.controller.signal.aborted
  )
    return existing
  if (existing && inflightByEphemeralImage.get(args.key) === existing) inflightByEphemeralImage.delete(args.key)
  const controller = new AbortController()
  const timeoutSignal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
  const signal = AbortSignal.any([controller.signal, timeoutSignal])
  const generation = imageInterpreterGeneration
  const flight: InflightEphemeralImageDescription = {
    generation,
    controller,
    timeoutSignal,
    consumers: 0,
    settled: false,
    cancelledByConsumers: false,
    promise: Promise.resolve(null),
  }
  inflightByEphemeralImage.set(args.key, flight)
  flight.promise = (async () => {
    try {
      const text = (await describeImage(args.interpreter, args.image, args.conversationId, args.cwd, signal)).trim()
      // Providers should honor the signal, but a late resolution must not turn a timeout/Stop into a result.
      signal.throwIfAborted()
      if (!text) {
        if (args.identity && generation === imageInterpreterGeneration) recordDescribeFailure(args.key)
        return null
      }
      if (args.identity && generation === imageInterpreterGeneration) describeFailures.delete(args.key)
      const description = {
        text,
        model: `${getProvider(args.interpreter.providerId)?.name ?? args.interpreter.providerId}/${args.interpreter.modelId}`,
      }
      if (args.identity && generation === imageInterpreterGeneration) {
        cacheDescribedEphemeralImage({ key: args.key, imageId: args.imageId, description, generation })
      }
      return description
    } catch {
      // Cancellation caused solely by all consumers leaving is not an interpreter failure and must not poison
      // the negative cache. A timeout/provider error with an active consumer remains cacheable as before.
      if (flight.cancelledByConsumers && !flight.timeoutSignal.aborted) return null
      if (args.identity && generation === imageInterpreterGeneration) recordDescribeFailure(args.key)
      return null
    } finally {
      flight.settled = true
      if (inflightByEphemeralImage.get(args.key) === flight) inflightByEphemeralImage.delete(args.key)
    }
  })()
  return flight
}

export async function describeEphemeralToolImage(args: {
  image: ChatToolImage
  conversationId: string
  cwd: string
  signal: AbortSignal
}): Promise<{ text: string; model?: string } | null> {
  args.signal.throwIfAborted()
  const interpreter = getImageInterpreter()
  if (!interpreter) return null
  const resolved = resolveEphemeralToolImage(args.image)
  if (!resolved) return null
  const name = args.image.name ?? 'tool-output-image'
  // Physical account may rotate; retain identity in the in-flight key but do not cache its result.
  const fingerprint =
    interpreterIdentityFingerprint(interpreter) ||
    (isClaudeSubscriptionProvider(interpreter.providerId) ? `unknown:${randomUUID()}` : '')
  const identity = isClaudeSubscriptionProvider(interpreter.providerId) ? '' : fingerprint
  const key = `${failureKey(args.image.id, args.conversationId, args.cwd, interpreter, fingerprint)}\0${ephemeralImageNameDigest(name)}`
  // Unknown identity = nothing from previous/other identities may be reused.
  const cached = identity ? getDescribedEphemeralImage(key) : null
  if (cached) return cached
  if (identity && (describeFailures.get(key) ?? 0) >= MAX_IMAGE_DESCRIBE_ATTEMPTS) return null
  const image: IsolatedImageInput = {
    name,
    mediaType: resolved.mediaType,
    base64: resolved.data,
    dataUrl: `data:${resolved.mediaType};base64,${resolved.data}`,
  }
  const flight = startEphemeralImageDescription({
    key,
    imageId: args.image.id,
    interpreter,
    image,
    conversationId: args.conversationId,
    cwd: args.cwd,
    identity,
  })
  return waitForEphemeralImageDescription(flight, args.signal)
}

export interface DescribeImagesArgs {
  conversationId: string
  cwd: string
  /** Message parts NOT YET persisted — mutated in place before insert. */
  pendingParts: MessagePart[]
  signal: AbortSignal
  /** Isolated review-loop: describe pending attachments only (never rewrite main conversation history). */
  pendingOnly?: boolean
}

export interface DescribeImagesResult {
  /** Descriptions written this cycle (0 = unchanged; caller need not reload UI). */
  described: number
  /** An ALREADY-PERSISTED message was rewritten — native thread/session binding is stale: resume
   * would reuse remote context WITHOUT descriptions (upsert does not change lastMessageId). */
  historyChanged: boolean
}

/** One description cycle per conversation: runner prewarming and next send may overlap;
 * serialization lets the second rescan AFTER the first and find a ready cache (avoid paying twice). */
const inflightByConversation = new Map<string, Promise<DescribeImagesResult>>()

/**
 * Describes undescribed images in the new message AND active history, writing results to parts.
 * One image failure does not affect others or the turn: without description, history falls back to omission
 * notes (and negative caching prevents infinite retries on every message).
 */
export async function describeConversationImages(args: DescribeImagesArgs): Promise<DescribeImagesResult> {
  const previous = inflightByConversation.get(args.conversationId)
  if (previous) await previous.catch(() => undefined)
  const run = describeConversationImagesInner(args)
  inflightByConversation.set(args.conversationId, run)
  try {
    return await run
  } finally {
    if (inflightByConversation.get(args.conversationId) === run) inflightByConversation.delete(args.conversationId)
  }
}

async function describeConversationImagesInner(args: DescribeImagesArgs): Promise<DescribeImagesResult> {
  const interpreter = getImageInterpreter()
  if (!interpreter) return { described: 0, historyChanged: false }
  const identity = isClaudeSubscriptionProvider(interpreter.providerId)
    ? ''
    : interpreterIdentityFingerprint(interpreter)

  // Order: pending message first (what user is viewing), then ACTIVE context from newest
  // to oldest — if capped, the oldest, least-relevant attachment remains undescribed.
  // Images before a compaction milestone are excluded: no longer sent to the model.
  const targets: { part: Extract<MessagePart, { type: 'file' }>; message?: ChatMessage }[] = []
  for (const part of args.pendingParts) if (needsDescription(part)) targets.push({ part })
  if (!args.pendingOnly) {
    const active = activeChatContext(listConversationContextMessages(args.conversationId)).messages
    for (let i = active.length - 1; i >= 0; i--) {
      for (const part of active[i].parts) if (needsDescription(part)) targets.push({ part, message: active[i] })
    }
  }
  if (targets.length === 0) return { described: 0, historyChanged: false }

  const label = `${getProvider(interpreter.providerId)?.name ?? interpreter.providerId}/${interpreter.modelId}`
  let described = 0
  const touched = new Map<string, ChatMessage>()
  for (const target of targets.slice(0, MAX_IMAGES_PER_TURN)) {
    if (args.signal.aborted) break
    const key = failureKey(target.part.id, args.conversationId, args.cwd, interpreter, identity)
    // Unknown identity = failures from another identity cannot block the attempt.
    if (identity && (describeFailures.get(key) ?? 0) >= MAX_IMAGE_DESCRIBE_ATTEMPTS) continue
    const image = decodeImage(target.part, args.conversationId)
    if (!image) continue
    const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
    const signal = AbortSignal.any([args.signal, timeout])
    let text = ''
    try {
      text = (await describeImage(interpreter, image, args.conversationId, args.cwd, signal)).trim()
    } catch {
      // Provider down / missing key / no vision: fallback to the existing omission-note behavior.
      // Never fail the turn over an attachment. TURN cancellation is not image failure;
      // interpreter timeout/error is (negative cache).
      if (args.signal.aborted) break
      if (identity) recordDescribeFailure(key)
      continue
    }
    if (!text) {
      if (identity) recordDescribeFailure(key)
      continue
    }
    if (identity) describeFailures.delete(key)
    target.part.description = text
    target.part.descriptionModel = label
    described++
    if (target.message) touched.set(target.message.id, target.message)
  }
  // History parts were mutated in the SQLite-read copy → rewrite only affected messages, with
  // conditional rereading: clear/delete/truncate/edit during description must not be reverted
  // or resurrected — update-only; patch each part only if it STILL references the same image
  // (same `data`) and still lacks a description.
  for (const message of touched.values()) {
    const current = getChatMessage(args.conversationId, message.id)
    if (!current) continue
    const describedById = new Map(
      message.parts
        .filter((part): part is Extract<MessagePart, { type: 'file' }> => part.type === 'file')
        .map((part) => [part.id, part])
    )
    let changed = false
    const parts = current.parts.map((part) => {
      if (part.type !== 'file' || part.kind !== 'image') return part
      const described = describedById.get(part.id)
      if (described?.kind !== 'image' || part.artifactId !== described.artifactId || part.data !== described.data)
        return part
      // Already described by a newer cycle, or not described this cycle → retain current state.
      if (!described.description?.trim() || part.description?.trim()) return part
      changed = true
      return { ...part, description: described.description, descriptionModel: described.descriptionModel }
    })
    if (changed) updateChatMessageParts(args.conversationId, message.id, parts)
  }
  return { described, historyChanged: touched.size > 0 }
}

/**
 * Post-learning enrichment of TOOL images persisted without descriptions.
 *
 * With optimistic catalog vision (unknown/wrong), tool images
 * (browser_screenshot, MCP…) persist in part state WITHOUT interpretation — provider then
 * rejects the next step. After learning `imagesUnsupported`, describe this turn's MESSAGE tool outputs
 * (the rejection-triggering bubble) in the background while ephemeral bytes remain,
 * so next `dropImages` replay receives TEXT rather than an omission note. Best-effort and scoped to
 * the supplied message (never rewrites other conversations/review-loop scopes); failures enter the
 * standard interpreter negative cache (no infinite retries).
 */
export async function describePersistedToolImages(args: {
  conversationId: string
  cwd: string
  /** Bubble (or any message) whose tool outputs need descriptions. */
  message: Pick<ChatMessage, 'parts'>
  signal: AbortSignal
}): Promise<Array<{ toolCallId: string; output: ToolOutput }>> {
  if (!getImageInterpreter()) return []
  const enriched: Array<{ toolCallId: string; output: ToolOutput }> = []
  for (const part of args.message.parts) {
    if (part.type !== 'tool') continue
    const output = part.state.status === 'completed' || part.state.status === 'running' ? part.state.output : undefined
    if (output === undefined || typeof output === 'string' || toolOutputImages(output).length === 0) continue
    const updated = await describeToolOutputImages(output, (image) =>
      describeEphemeralToolImage({
        image,
        conversationId: args.conversationId,
        cwd: args.cwd,
        signal: args.signal,
      })
    )
    // Same reference = unchanged (already described, failure, or no interpreter) — omit from result.
    if (updated !== output) enriched.push({ toolCallId: part.toolCallId, output: updated })
  }
  return enriched
}

/**
 * Applies post-turn enrichment to an ALREADY-persisted message without inserting or reverting newer
 * state. Rereads the row (and OpenAI sidecar if present), not turn snapshot, and applies
 * MONOTONIC description merging by image ID (see `mergeToolOutputImageDescriptions`): preserve text,
 * structuredContent, isError, and other NEW current-output fields — never revert a
 * newer version (running→completed, reexecution with same handles). Copy only missing descriptions of
 * snapshot-described images; different image (edit/truncate/rewrite) → no ID match
 * → no-op. Read + conditional write in the SAME synchronous event-loop tick — no TOCTOU window.
 * For OpenAI checkpoints, write visual message + CURRENT sidecar ledger atomically; execution
 * checkpoint (crash recovery) receives the same description-merge patch.
 */
export function applyPersistedToolImageEnrichment(args: {
  conversationId: string
  messageId: string
  enriched: ReadonlyArray<{ toolCallId: string; output: ToolOutput }>
}): void {
  if (args.enriched.length === 0) return
  const current = getChatMessage(args.conversationId, args.messageId)
  if (!current) return
  const byCallId = new Map(args.enriched.map((entry) => [entry.toolCallId, entry.output]))
  let changed = false
  const parts = current.parts.map((part) => {
    if (part.type !== 'tool') return part
    const output = byCallId.get(part.toolCallId)
    if (output === undefined) return part
    if (part.state.status !== 'completed' && part.state.status !== 'running') return part
    // Description merge: CURRENT output is authoritative; unmatched IDs (rewritten output) → no-op.
    const merged = mergeToolOutputImageDescriptions(part.state.output, output)
    if (merged === undefined || merged === part.state.output) return part
    changed = true
    return { ...part, state: { ...part.state, output: merged } }
  })
  if (!changed) return
  const sidecar = getOpenAIInferenceState(args.messageId)
  if (sidecar) {
    // CURRENT sidecar ledger (never turn snapshot): canonical patch + entry ID guard.
    const ledger = patchOpenAILedgerToolOutputs(sidecar.ledger, args.enriched)
    updateChatMessageWithOpenAIInferenceState(args.conversationId, args.messageId, parts, { ...sidecar, ledger })
  } else {
    updateChatMessageParts(args.conversationId, args.messageId, parts)
  }
  // Crash recovery rehydrates tool results from durable checkpoint → same patch (internal ID guard;
  // if message was removed, FK CASCADE already deleted the row and lookup is a no-op).
  patchOpenAIToolExecutionOutputs({ conversationId: args.conversationId, messageId: args.messageId }, args.enriched)
}
