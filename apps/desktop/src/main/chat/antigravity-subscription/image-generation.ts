/**
 * Image generation on a Google AI subscription through the Antigravity ACP server's own built-in `generate_image`
 * tool, which draws with Google's Gemini image model. Follows `isolated-prompt.ts`: one throwaway session in the
 * app-owned work directory, with no MCP server and only that built-in enabled. A policy scoped to the session approves
 * its single call. The server returns the image inline, and the bytes go straight into the same generated-image store
 * as Codex images, so the card, preview, download and cleanup paths are shared.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AcpPromptResult, AcpSessionSetupResult, AcpSessionUpdate } from '../acp/protocol'
import { deleteGeneratedImages, MAX_GENERATED_IMAGE_BYTES, saveGeneratedImage } from '../generated-images'
import type { GeneratedImageEmission } from '../tools/util'
import { antigravityErrorMessage, isAntigravityQuotaError, redactAntigravityCredentials } from './errors'
import type { AntigravityAccountIdentity, AntigravitySubscriptionManager } from './manager'
import { type AntigravityModelEntry, resolveAntigravityModelValue } from './models'
import { antigravityAcpHome, isStrictlyInside } from './paths'
import { ANTIGRAVITY_IMAGE_TOOL, createAntigravityImagePermissionPolicy } from './permissions'

/** Image sessions enable exactly one built-in tool; every other session enables none. */
export const ANTIGRAVITY_IMAGE_SESSION_META = Object.freeze({
  agy: Object.freeze({ enabledTools: Object.freeze([ANTIGRAVITY_IMAGE_TOOL]) }),
})

/** How long a turn cancelled after its image arrived may take to stop before the session is discarded. */
const CANCEL_GRACE_MS = 5_000
const MODEL_TEXT_LIMIT = 300

const IMAGE_GEN_INSTRUCTIONS =
  `You are an image generation runner inside Maestrly. Call the ${ANTIGRAVITY_IMAGE_TOOL} tool EXACTLY ONCE with ` +
  'the request below as its prompt, as given, and the aspect ratio the request implies (1:1 when it implies none). ' +
  'Then stop. Do not ask questions and do not write any explanation: the image itself is the only deliverable.'

const QUOTA_MESSAGE =
  'Google AI image generation limit reached. Wait for the limit to reset, or choose ChatGPT as the image generator in Maestrly settings.'

export interface AntigravityImageArgs {
  manager: AntigravitySubscriptionManager
  accountIdentity: AntigravityAccountIdentity
  conversationId: string
  prompt: string
  signal: AbortSignal
}

/** What one tool update says about the image call; null for updates that are not a finished tool call. */
export type AntigravityImageToolEvent =
  | {
      status: 'completed'
      data?: string
      mimeType?: string
      imagePath?: string
      revisedPrompt?: string
      imageName?: string
    }
  | { status: 'failed'; error?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/**
 * The cheapest chat model that can call the tool, at its lowest thinking level. The model only forwards the request:
 * the image comes from Google's image model whichever one is chosen.
 */
export function pickAntigravityImageModel(
  entries: readonly AntigravityModelEntry[]
): { modelId: string; effort: 'low' } | null {
  const chat = entries.filter((entry) => !/image/i.test(`${entry.id} ${entry.displayName}`))
  const isFlash = (entry: AntigravityModelEntry) => /flash/i.test(`${entry.id} ${entry.displayName}`)
  const isLite = (entry: AntigravityModelEntry) => /lite/i.test(`${entry.id} ${entry.displayName}`)
  const entry =
    chat.find((candidate) => isFlash(candidate) && !isLite(candidate)) ?? chat.find(isFlash) ?? chat[0] ?? entries[0]
  return entry ? { modelId: entry.id, effort: 'low' } : null
}

/**
 * Reads a `tool_call` / `tool_call_update` of the image session. Only `generate_image` is enabled there, so the
 * only tool call that can finish is the image call. The server puts the image inline (`content[].content`, an ACP
 * image block) and its file path and final prompt in `rawOutput`.
 */
export function parseAntigravityImageToolUpdate(update: AcpSessionUpdate): AntigravityImageToolEvent | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null
  const value = update as Record<string, unknown>
  const content = Array.isArray(value.content) ? value.content : []
  const blocks = content.map((item) => (isRecord(item) && isRecord(item.content) ? item.content : null))
  if (value.status === 'failed') {
    const error = blocks
      .map((block) => (block?.type === 'text' ? text(block.text) : undefined))
      .filter(Boolean)
      .join('\n')
    return { status: 'failed', ...(error ? { error } : {}) }
  }
  if (value.status !== 'completed') return null
  const image = blocks.find((block) => block?.type === 'image' && typeof block.data === 'string' && block.data)
  const raw = isRecord(value.rawOutput) ? value.rawOutput : {}
  const imagePath = text(raw.imagePath)
  const revisedPrompt = text(raw.prompt)
  const imageName = text(raw.imageName)
  return {
    status: 'completed',
    ...(image ? { data: image.data as string } : {}),
    ...(image && typeof image.mimeType === 'string' ? { mimeType: image.mimeType } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}),
    ...(imageName ? { imageName } : {}),
  }
}

/**
 * Fallback when the server reports only the file: read it as base64, and only from this session's own directory in
 * the account's ACP home, where the server writes generated images.
 */
async function readSessionImage(
  manager: AntigravitySubscriptionManager,
  sessionId: string,
  imagePath: string
): Promise<string> {
  const local = imagePath.replace(/^file:\/\//, '')
  const sessionDir = path.join(antigravityAcpHome(manager.root), 'brain', sessionId)
  if (!path.isAbsolute(local) || !isStrictlyInside(sessionDir, local)) {
    throw new Error('Google AI reported the generated image outside its session directory.')
  }
  const real = await fsp.realpath(local)
  if (!isStrictlyInside(await fsp.realpath(sessionDir), real)) {
    throw new Error('Google AI reported the generated image outside its session directory.')
  }
  const stat = await fsp.lstat(real)
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('The image Google AI generated could not be read.')
  }
  return (await fsp.readFile(real)).toString('base64')
}

function failure(error: unknown): Error {
  if (isAntigravityQuotaError(error)) return new Error(QUOTA_MESSAGE)
  return new Error(antigravityErrorMessage(error).message)
}

/** One image on a Google AI account. Never resolves with bytes: the image becomes an app-owned artifact handle. */
export async function generateImageWithAntigravityRuntime(args: AntigravityImageArgs): Promise<GeneratedImageEmission> {
  const { manager, signal } = args
  if (signal.aborted) throw abortError(signal)
  const release = manager.retain()
  let sessionId: string | undefined
  let unsubscribe: (() => void) | undefined
  let removePolicy: (() => void) | undefined
  try {
    manager.assertAccountIdentity(args.accountIdentity)
    const models = await manager.listModels()
    const model = pickAntigravityImageModel(models)
    const modelValue = model && resolveAntigravityModelValue(models, model.modelId, model.effort)
    if (!modelValue) throw new Error('Google AI has no model available to generate images.')
    const connection = await manager.connection(signal)
    const { client } = connection
    const created = await client.request<AcpSessionSetupResult>(
      'session/new',
      { cwd: manager.workDir, mcpServers: [], _meta: ANTIGRAVITY_IMAGE_SESSION_META },
      { signal }
    )
    if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
    const id = created.sessionId
    sessionId = id
    removePolicy = manager.setSessionPermissionPolicy(id, createAntigravityImagePermissionPolicy())
    await client.request(
      'session/set_config_option',
      { sessionId: id, configId: 'model', value: modelValue },
      { signal }
    )

    let event: AntigravityImageToolEvent | null = null
    let modelText = ''
    let finished!: () => void
    const toolFinished = new Promise<void>((resolve) => {
      finished = resolve
    })
    unsubscribe = connection.subscribe(id, (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = (update as { content?: { type?: string; text?: unknown } }).content
        if (content?.type === 'text' && typeof content.text === 'string') modelText += content.text
        return
      }
      if (event) return
      event = parseAntigravityImageToolUpdate(update)
      if (event) finished()
    })
    const cancel = () => client.notify('session/cancel', { sessionId: id })
    const prompt = client.request<AcpPromptResult>(
      'session/prompt',
      {
        sessionId: id,
        prompt: [{ type: 'text', text: `<system>\n${IMAGE_GEN_INSTRUCTIONS}\n</system>\n\n${args.prompt}` }],
      },
      { signal }
    )
    void prompt.catch(() => undefined)
    signal.addEventListener('abort', cancel, { once: true })
    let result: AcpPromptResult | undefined
    try {
      result = await Promise.race([prompt, toolFinished.then(() => undefined)])
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    if (signal.aborted) throw abortError(signal)
    // Cast: TS narrows `event` to `null` because the listener assigns it.
    const outcome = event as AntigravityImageToolEvent | null
    if (outcome && !result) {
      // The image is in; the model's closing remark is not worth waiting for.
      cancel()
      await Promise.race([prompt.catch(() => undefined), delay(CANCEL_GRACE_MS)])
    }
    if (!outcome) {
      if (result?.stopReason === 'cancelled') throw abortError(signal)
      if (result?.stopReason === 'refusal') throw new Error('Google declined to generate this image.')
      const said = redactAntigravityCredentials(modelText.trim()).slice(0, MODEL_TEXT_LIMIT)
      throw new Error(
        said
          ? `Google AI did not generate an image. It answered: ${said}`
          : 'Google AI did not generate an image for this prompt.'
      )
    }
    if (outcome.status === 'failed') {
      const detail = outcome.error ? `: ${redactAntigravityCredentials(outcome.error).slice(0, MODEL_TEXT_LIMIT)}` : '.'
      throw new Error(`Google AI image generation failed${detail}`)
    }
    const data = outcome.data ?? (outcome.imagePath ? await readSessionImage(manager, id, outcome.imagePath) : '')
    if (!data) throw new Error('Google AI finished the image call without returning an image.')
    manager.assertAccountIdentity(args.accountIdentity)
    const stored = await saveGeneratedImage({
      conversationId: args.conversationId,
      result: data,
      label: (outcome.imageName ?? args.prompt).slice(0, 48),
    })
    if (signal.aborted) {
      await deleteGeneratedImages(args.conversationId, [stored.artifactId])
      throw abortError(signal)
    }
    const revisedPrompt =
      outcome.revisedPrompt && outcome.revisedPrompt !== args.prompt.trim() ? outcome.revisedPrompt : ''
    return { ...stored, ...(revisedPrompt ? { revisedPrompt } : {}) }
  } catch (error) {
    if (signal.aborted) throw abortError(signal)
    throw failure(manager.translateError(error))
  } finally {
    unsubscribe?.()
    removePolicy?.()
    // The server cannot delete sessions; this removes the session's files, the generated image included.
    if (sessionId) void manager.deleteSession(sessionId)
    release()
  }
}
