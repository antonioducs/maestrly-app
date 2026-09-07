/**
 * IMAGE GENERATION toggle resolution (global + conversation override) and the
 * `generate_image`.
 *
 * Single source for the host-managed `generate_image` tool offered to Codex, Claude/Opus, Copilot, and BYOK.
 * Every provider runs an ephemeral Codex thread underneath; native imagegen in the main thread
 * stays disabled to avoid exposing a second contract without `outputPath`.
 */
import type { ChatStreamEvent, ChatSubagentUsage } from '../../shared/chat'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { getAppFlag, getConvUiPrefs } from '../store'
import { canExposeGeneratedImageTool } from './tool-capabilities'
import type { GeneratedImageEmission, GeneratedImageUsage } from './tools/util'

/** Global app_settings flag. Default ON: preserves existing Codex behavior. */
export const IMAGE_GEN_FLAG = 'chat.imageGen'

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

/**
 * Should `generate_image` enter this turn's catalog? Only with Agent capabilities (Agent or Design),
 * the toggle enabled, and a connected ChatGPT subscription.
 */
export async function generateImageToolEnabled(conversationId: string, mode: ChatBehavior): Promise<boolean> {
  if (!canExposeGeneratedImageTool({ mode, enabled: imageGenEnabledFor(conversationId) })) return false
  return codexImageGenConnected()
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
