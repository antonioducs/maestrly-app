/**
 * IMAGE GENERATION toggle resolution (global + conversation override), the choice of who draws, and the
 * `generate_image`.
 *
 * Single source for the host-managed `generate_image` tool offered to every model, Codex included. Images are drawn
 * by the ChatGPT subscription (an ephemeral Codex thread) or by a Google AI subscription (an ephemeral Antigravity
 * session with Google's image model), following the `chat.imageGenProvider` preference. Native imagegen in the
 * main Codex thread stays disabled to avoid exposing a second contract without `outputPath`.
 */
import type { ChatStreamEvent, ChatSubagentUsage } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { isImageGenProvider, type ImageGenProvider } from '../../shared/image-generation'
import { getAppFlag, getAppSetting, getConvUiPrefs, setAppSetting } from '../store'
import { canExposeGeneratedImageTool } from './tool-capabilities'
import type { GeneratedImageEmission, GeneratedImageUsage } from './tools/util'

/** Global app_settings flag. Default ON: preserves existing Codex behavior. */
export const IMAGE_GEN_FLAG = 'chat.imageGen'
/** Global choice of who draws: `auto` (default), `chatgpt` or `google`. */
export const IMAGE_GEN_PROVIDER_KEY = 'chat.imageGenProvider'

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

/** Converts the image envelope to the format used by isolated-call aggregators. */
export function normalizeGeneratedImageUsage(usage: GeneratedImageUsage): {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
} {
  const input = Math.max(0, Number(usage.input) || 0)
  const output = Math.max(0, Number(usage.output) || 0)
  const cacheRead = Math.max(0, Number(usage.cachedInput) || 0)
  const cacheCreate = Math.max(0, Number(usage.cacheCreate) || 0)
  return { input, output, cacheRead, cacheCreate, totalInput: input + cacheRead + cacheCreate }
}

/** Adds a generation to an isolated-call collection. Token pricing uses the catalog because Codex
 * does not report official prices; never invent an asset price. */
export function mergeGeneratedImageUsage(
  target: Map<string, ChatSubagentUsage>,
  usage: GeneratedImageUsage
): void {
  const normalized = normalizeGeneratedImageUsage(usage)
  if (!normalized.totalInput && !normalized.output) return
  const key = `${usage.providerId}\0${usage.modelId}`
  const existing = target.get(key)
  if (existing) {
    existing.input += normalized.input
    existing.output += normalized.output
    existing.cachedInput = (existing.cachedInput ?? 0) + normalized.cacheRead
    existing.cacheCreate = (existing.cacheCreate ?? 0) + normalized.cacheCreate
    existing.catalogInput = (existing.catalogInput ?? 0) + normalized.input
    existing.catalogOutput = (existing.catalogOutput ?? 0) + normalized.output
    existing.catalogCacheRead = (existing.catalogCacheRead ?? 0) + normalized.cacheRead
    existing.catalogCacheCreate = (existing.catalogCacheCreate ?? 0) + normalized.cacheCreate
    return
  }
  target.set(key, {
    providerId: usage.providerId,
    modelId: usage.modelId,
    input: normalized.input,
    output: normalized.output,
    ...(normalized.cacheRead ? { cachedInput: normalized.cacheRead } : {}),
    ...(normalized.cacheCreate ? { cacheCreate: normalized.cacheCreate } : {}),
    catalogInput: normalized.input,
    catalogOutput: normalized.output,
    catalogCacheRead: normalized.cacheRead,
    catalogCacheCreate: normalized.cacheCreate,
  })
}

/** RESOLVED conversation toggle: explicit override > global flag. */
export function imageGenEnabledFor(conversationId: string): boolean {
  const tools = getConvUiPrefs(conversationId).chat?.tools
  return tools?.imageGen ?? getAppFlag(IMAGE_GEN_FLAG, true)
}

/**
 * Is any eligible Codex account in the DEFAULT account's failover route authenticated (snapshot)?
 * Uses SNAPSHOTS only — never forces refresh or spawns the app-server in the turn path (`chat:config`
 * bootstrap fills these snapshots at startup). Actual execution revalidates via resolve.
 */
export async function codexImageGenConnected(): Promise<boolean> {
  try {
    const { CODEX_SUBSCRIPTION_PROVIDER_ID } = await import('./catalog')
    const { anyCodexFailoverAccountConnected } = await import('./subscription-failover')
    return anyCodexFailoverAccountConnected(CODEX_SUBSCRIPTION_PROVIDER_ID)
  } catch {
    return false
  }
}

export function getImageGenProvider(): ImageGenProvider {
  const value = getAppSetting(IMAGE_GEN_PROVIDER_KEY)
  return isImageGenProvider(value) ? value : 'auto'
}

export function setImageGenProvider(provider: ImageGenProvider): void {
  setAppSetting(IMAGE_GEN_PROVIDER_KEY, provider)
}

/** Who draws one image: the ChatGPT subscription (Codex) or one Google AI account (Antigravity). */
export type ImageGenRoute = { provider: 'chatgpt' } | { provider: 'google'; accountId: string | null }

export interface ImageGenRouteOptions {
  /**
   * Google AI account of a conversation running on Antigravity (null = default account). It draws first, on the
   * server process the conversation already runs. Undefined for conversations on any other provider.
   */
  antigravityAccountId?: string | null
}

/**
 * First Google AI account with a stored sign-in, in drawing order: the conversation's own account, the default one,
 * then additional accounts. Reads token files only; never starts the ACP server.
 */
async function antigravityImageAccount(
  conversationId: string,
  preferred: string | null | undefined
): Promise<{ accountId: string | null } | null> {
  try {
    const { ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, listSubscriptionAccounts, withSubscriptionAccount } = await import(
      './catalog'
    )
    const { getAntigravitySubscriptionManager } = await import('./antigravity-subscription/manager')
    const { autonomousProviderAllowed } = await import('./autonomous')
    const additional = listSubscriptionAccounts()
      .filter((account) => account.kind === 'antigravity-subscription')
      .map((account) => account.id)
    const candidates = [...new Set([...(preferred === undefined ? [] : [preferred]), null, ...additional])]
    for (const accountId of candidates) {
      const providerId = withSubscriptionAccount(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, accountId)
      if (!autonomousProviderAllowed(providerId, conversationId)) continue
      if (getAntigravitySubscriptionManager(accountId).getAccountIdentity().fingerprint) return { accountId }
    }
  } catch {
    // A readiness check must never fail the turn.
  }
  return null
}

/**
 * Who draws for this conversation, from local snapshots only. `auto` keeps ChatGPT first, except in conversations
 * running on Google AI, which draw with their own account. An explicit choice never falls back to the other one.
 */
export async function resolveImageGenRoute(
  conversationId: string,
  options: ImageGenRouteOptions = {}
): Promise<ImageGenRoute | null> {
  const chatgpt = async (): Promise<ImageGenRoute | null> =>
    (await codexImageGenConnected()) ? { provider: 'chatgpt' } : null
  const google = async (): Promise<ImageGenRoute | null> => {
    const account = await antigravityImageAccount(conversationId, options.antigravityAccountId)
    return account ? { provider: 'google', accountId: account.accountId } : null
  }
  const preference = getImageGenProvider()
  if (preference === 'chatgpt') return chatgpt()
  if (preference === 'google') return google()
  if (options.antigravityAccountId !== undefined) return (await google()) ?? (await chatgpt())
  return (await chatgpt()) ?? (await google())
}

/**
 * Should `generate_image` enter this turn's catalog? Only with Agent capabilities (Agent or Design),
 * the toggle enabled, and a connected subscription that can draw (see {@link resolveImageGenRoute}).
 */
export async function generateImageToolEnabled(
  conversationId: string,
  mode: ChatBehavior,
  options: ImageGenRouteOptions = {}
): Promise<boolean> {
  if (!canExposeGeneratedImageTool({ mode, enabled: imageGenEnabledFor(conversationId) })) return false
  return (await resolveImageGenRoute(conversationId, options)) !== null
}

/**
 * Entry point of `generate_image` for every runner: draws on the resolved route. With no route connected, ChatGPT
 * is still attempted (its runtime revalidates the snapshot) unless Google AI was chosen explicitly.
 */
export async function generateConversationImage(
  args: {
    conversationId: string
    cwd: string
    prompt: string
    signal: AbortSignal
    onUsage?: (usage: GeneratedImageUsage) => void
  } & ImageGenRouteOptions
): Promise<GeneratedImageEmission> {
  const route = await resolveImageGenRoute(args.conversationId, args)
  if (route?.provider === 'google') {
    const { getAntigravitySubscriptionManager } = await import('./antigravity-subscription/manager')
    const { generateImageWithAntigravityRuntime } = await import('./antigravity-subscription/image-generation')
    const manager = getAntigravitySubscriptionManager(route.accountId)
    return generateImageWithAntigravityRuntime({
      manager,
      accountIdentity: manager.getAccountIdentity(),
      conversationId: args.conversationId,
      prompt: args.prompt,
      signal: args.signal,
    })
  }
  const preference = getImageGenProvider()
  if (!route && preference === 'google') {
    throw new Error('Connect a Google AI account in Maestrly settings to generate images.')
  }
  const { generateImageForConversation } = await import('./codex-subscription/image-generation')
  try {
    return await generateImageForConversation({
      conversationId: args.conversationId,
      cwd: args.cwd,
      prompt: args.prompt,
      signal: args.signal,
      onUsage: args.onUsage,
    })
  } catch (error) {
    // Either subscription would have done: name both in the connection hint.
    if (!route && preference === 'auto' && error instanceof Error && /Connect your ChatGPT/.test(error.message)) {
      throw new Error('Connect a ChatGPT or Google AI account in Maestrly settings to generate images.')
    }
    throw error
  }
}

/**
 * Connects tool `ctx.emitGeneratedImage` to runner `apply`. `force`: the file is ALREADY on disk when
 * this event fires, so persist its referencing part immediately — if the turn dies afterward, the
 * artifact remains visible instead of becoming an orphan sidecar. partId derives from toolCallId (idempotent
 * when replaying the same step, like itemId for native imagegen).
 */
export function emitGeneratedImagePart(
  apply: (event: ChatStreamEvent, force?: boolean) => void,
  messageId: string,
  toolCallId: string,
  image: GeneratedImageEmission
): void {
  apply(
    {
      kind: 'generated-image',
      messageId,
      partId: `${toolCallId}_image`,
      artifactId: image.artifactId,
      name: image.name,
      mediaType: image.mediaType,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
      byteSize: image.byteSize,
    },
    true
  )
}
