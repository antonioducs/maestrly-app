/**
 * BYOK bridge to the Vercel AI SDK, adapted conceptually from opencode `aisdk.ts`/`provider.ts`.
 * Resolve provider, model and credential directly through the native Anthropic/Responses adapters or
 * `createOpenAICompatible({ name, baseURL, apiKey, fetch })(modelId)`.
 *
 * Electron's `net.fetch` preserves main-process proxy/certificate behavior. Credentials come from
 * secure storage, never the renderer. Managed OAuth providers such as Grok use a runtime credential
 * and authenticated transport; their access tokens are never treated as BYOK API keys.
 */

import { createHash } from 'node:crypto'
import { net } from 'electron'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ChatProviderKind } from '../../shared/chat'
import {
  getProvider,
  getProviderKind,
  isGrokSubscriptionProvider,
  subscriptionAccountId,
  type ChatProvider,
} from './catalog'
import { getApiKey } from './credentials'
import {
  resolveChatHarness,
  type ChatHarnessCapabilities,
  type ChatHarnessProfile,
  type ChatPromptProfile,
} from './harness'
import type { ModelHarnessProfileId, RuntimeModelCapabilities } from './model-harness-profile'
import { openAIResponsesFetch } from './openai/raw-input'
import { getGrokSubscriptionManager } from './grok-subscription/manager'
import { GrokNotAuthenticatedError } from './grok-subscription/manager'

/** BYOK configuration error (missing key or unknown provider), presented as a readable UI message. */
export class ChatConfigError extends Error {
  constructor(
    message: string,
    readonly code: 'no-key' | 'unknown-provider'
  ) {
    super(message)
    this.name = 'ChatConfigError'
  }
}

/**
 * Runtime credential kept separate from the provider descriptor.
 * BYOK: actual API key, net.fetch and a key fingerprint.
 * Grok OAuth: nonsecret sentinel, authenticated manager fetch and an identity/epoch fingerprint.
 */
export interface ProviderRuntimeCredential {
  apiKey: string
  fetch: typeof fetch
  fingerprint: string
}

/** Resolve modelId to LanguageModel independently of the native Anthropic or OpenAI-compatible adapter. */
type ModelResolver = (modelId: string) => LanguageModelV4

/** Cache resolvers by provider ID and credential fingerprint; rebuild when credentials change. */
const providerCache = new Map<string, { key: string; resolve: ModelResolver }>()

function resolveByokCredential(providerId: string, descriptor: ChatProvider): ProviderRuntimeCredential {
  const apiKey = getApiKey(providerId)
  if (!apiKey) throw new ChatConfigError(`No API key configured for ${descriptor.name}.`, 'no-key')
  return {
    apiKey,
    fetch: net.fetch as unknown as typeof globalThis.fetch,
    fingerprint: buildOpenAIProviderFingerprint(descriptor, getProviderKind(descriptor), apiKey),
  }
}

function resolveGrokCredential(providerId: string): ProviderRuntimeCredential {
  try {
    return getGrokSubscriptionManager(subscriptionAccountId(providerId)).resolveRuntimeCredential()
  } catch (error) {
    if (error instanceof GrokNotAuthenticatedError) {
      throw new ChatConfigError('Grok is not authenticated. Sign in with your Grok subscription.', 'no-key')
    }
    throw error
  }
}

/** Resolve a runtime credential for BYOK or managed OAuth providers. Tokens never leave the main process. */
export function resolveProviderRuntimeCredential(providerId: string): ProviderRuntimeCredential {
  const descriptor = getProvider(providerId)
  if (!descriptor) throw new ChatConfigError(`Unknown provider: ${providerId}`, 'unknown-provider')
  if (isGrokSubscriptionProvider(providerId)) return resolveGrokCredential(providerId)
  return resolveByokCredential(providerId, descriptor)
}

/**
 * Transport kind used by the AI SDK adapter.
 * Grok subscription speaks OpenAI-compatible chat/completions — never auto-promote grok-* into the
 * OpenAI Responses harness (which keys off GPT model IDs and Responses-only capabilities).
 */
function adapterKind(descriptor: ChatProvider): ChatProviderKind {
  if (isGrokSubscriptionProvider(descriptor.id) || descriptor.kind === 'grok-subscription') {
    return 'openai'
  }
  return getProviderKind(descriptor)
}

function getProviderInstance(providerId: string): ModelResolver {
  const descriptor = getProvider(providerId)
  if (!descriptor) throw new ChatConfigError(`Unknown provider: ${providerId}`, 'unknown-provider')
  const credential = resolveProviderRuntimeCredential(providerId)

  const cached = providerCache.get(providerId)
  if (cached && cached.key === credential.fingerprint) return cached.resolve

  const kind = adapterKind(descriptor)
  let resolve: ModelResolver
  if (kind === 'anthropic') {
    // Use the native Anthropic Messages adapter for stop_reason/tool_use, thinking, prompt caching and
    // effort. The compatibility shim lost stop_reason and returned finish_reason 'other', ending the
    // agent loop after a tool call. The API key is sent in the x-api-key header.
    const anthropic = createAnthropic({
      name: descriptor.id,
      baseURL: descriptor.baseURL,
      apiKey: credential.apiKey,
      fetch: credential.fetch,
    })
    resolve = (modelId) => anthropic.languageModel(modelId)
  } else if (kind === 'openai-responses') {
    // The native Responses adapter preserves reasoning items across tool steps in the same turn.
    // The chat/completions shim loses reasoning at each tool call, degrading GPT 5.x agent tasks.
    // Select responses(modelId) explicitly instead of relying on the package default.
    const openai = createOpenAI({
      name: descriptor.id,
      baseURL: descriptor.baseURL,
      apiKey: credential.apiKey,
      fetch: openAIResponsesFetch,
    })
    resolve = (modelId) => openai.responses(modelId)
  } else {
    const oai = createOpenAICompatible({
      name: descriptor.id,
      baseURL: descriptor.baseURL,
      apiKey: credential.apiKey,
      fetch: credential.fetch,
      includeUsage: true,
    })
    resolve = (modelId) => oai(modelId)
  }
  providerCache.set(providerId, { key: credential.fingerprint, resolve })
  return resolve
}

/**
 * Resolve a LanguageModel for `streamText({ model })`. Throw ChatConfigError when no key is configured.
 * `modelId` may be a user-supplied ID outside the catalog.
 */
export function resolveLanguageModel(providerId: string, modelId: string): LanguageModelV4 {
  return getProviderInstance(providerId)(modelId)
}

export interface ResolvedChatModel {
  model: LanguageModelV4
  transport: ChatProviderKind
  harnessProfile: ChatHarnessProfile
  modelHarnessProfileId: ModelHarnessProfileId
  promptProfile: ChatPromptProfile
  capabilities: ChatHarnessCapabilities
  /** Bind opaque sidecars to their originating endpoint, protocol and credential without persisting the key. */
  providerFingerprint: string
}

export type ResolvedChatHarness = Omit<ResolvedChatModel, 'model' | 'providerFingerprint'>

/**
 * Resolve harness metadata without instantiating the provider or requiring a configured key;
 * safe for local decisions such as choosing a compaction policy.
 */
export function resolveChatHarnessMetadata(
  providerId: string,
  modelId: string,
  options: {
    astraHarnessEnabled?: boolean
    runtimeModelCapabilities?: RuntimeModelCapabilities
    adapterCapabilities?: RuntimeModelCapabilities
    runtimeReasoningEfforts?: readonly string[]
  } = {}
): ResolvedChatHarness {
  const descriptor = getProvider(providerId)
  if (!descriptor) throw new ChatConfigError(`Unknown provider: ${providerId}`, 'unknown-provider')
  // Harness transport: Grok stays on legacy (openai-compat). Official OpenAI Responses stays Responses.
  const transport = isGrokSubscriptionProvider(providerId) ? 'openai' : getProviderKind(descriptor)
  const harness = resolveChatHarness(
    // Pass the catalog kind for non-Grok so Responses still activates for openai-responses providers.
    isGrokSubscriptionProvider(providerId) ? 'openai' : getProviderKind(descriptor),
    modelId,
    descriptor.baseURL,
    options
  )
  return {
    transport,
    harnessProfile: harness.profile,
    modelHarnessProfileId: harness.modelHarnessProfileId,
    promptProfile: harness.promptProfile,
    capabilities: harness.capabilities,
  }
}

function normalizedFingerprintBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return trimmed
  }
}

/**
 * Opaque fingerprint of the backend receiving encrypted reasoning items. Changing endpoint, kind or key
 * invalidates replay. Only the SHA-256 credential hash is included, and the entire payload is hashed again.
 */
export function buildOpenAIProviderFingerprint(
  descriptor: Pick<ChatProvider, 'baseURL'>,
  transport: ChatProviderKind,
  apiKey: string
): string {
  const credentialHash = createHash('sha256').update(apiKey).digest('hex')
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        baseURL: normalizedFingerprintBaseURL(descriptor.baseURL),
        transport,
        credentialHash,
      })
    )
    .digest('hex')
}

/** Resolve the model and agent protocol without making callers infer capabilities from the provider name. */
export function resolveChatModel(
  providerId: string,
  modelId: string,
  options: Parameters<typeof resolveChatHarnessMetadata>[2] = {}
): ResolvedChatModel {
  const descriptor = getProvider(providerId)
  if (!descriptor) throw new ChatConfigError(`Unknown provider: ${providerId}`, 'unknown-provider')
  const credential = resolveProviderRuntimeCredential(providerId)
  const metadata = resolveChatHarnessMetadata(providerId, modelId, options)
  return {
    model: getProviderInstance(providerId)(modelId),
    ...metadata,
    providerFingerprint: isGrokSubscriptionProvider(providerId)
      ? credential.fingerprint
      : buildOpenAIProviderFingerprint(descriptor, metadata.transport, credential.apiKey),
  }
}

/** Invalidate the cache after a key changes or is removed; recreate the provider on next use. */
export function invalidateProvider(providerId?: string): void {
  if (providerId) providerCache.delete(providerId)
  else providerCache.clear()
}
