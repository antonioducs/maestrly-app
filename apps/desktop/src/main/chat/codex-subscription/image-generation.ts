/**
 * Image generation for ANY provider via an EPHEMERAL Codex app-server thread, following `portable-summarizer.ts`:
 * a one-shot thread with no tools or persistence, always deleted at the end, never touching the conversation's
 * resumable binding. Imagegen is a Codex runtime feature (ChatGPT subscription), so reuse the connected
 * subscription instead of a parallel Image API with separate credentials/billing. Results use the SAME native
 * imagegen artifact store (`generated-images.ts`), reusing the card, preview, download, and all cleanup
 * (message/conversation deletion/wipe) paths.
 */
import { randomUUID } from 'node:crypto'
import type { CodexAppServerClient } from './client'
import { codexTextInput } from './protocol'
import type { CodexSubscriptionManager, CodexSubscriptionModel } from './manager'
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../catalog'
import { deleteGeneratedImages, saveGeneratedImage, type StoredGeneratedImage } from '../generated-images'
import { recordModelCallUsage } from '../usage-diagnostics'
import type { GeneratedImageUsage } from '../tools/util'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Artifact already written to disk + the prompt actually used by the model (when reported). */
export interface GeneratedImageArtifact extends StoredGeneratedImage {
  revisedPrompt?: string
  /** Auxiliary thread usage; asset/image cost deliberately remains unpriced here. */
  usage?: GeneratedImageUsage
}

/**
 * ORCHESTRATOR turn model (`gpt-image` draws; this model receives the request and calls the native tool). Prefer
 * the smallest catalog model; the constant covers an unavailable/offline catalog.
 */
const FALLBACK_IMAGE_GEN_MODEL = 'gpt-5.6-mini'
const IMAGE_GEN_REQUEST_TIMEOUT_MS = 30_000

/** Minimal instruction: one imagegen call with the user prompt, without investigation or a text response. */
const IMAGE_GEN_INSTRUCTIONS =
  'You are an image generation runner inside Maestrly. Call the native image generation tool EXACTLY ONCE ' +
  'with the user prompt as given, then stop. Do not investigate the workspace, do not ask questions and do ' +
  'not write any explanation: the image itself is the only deliverable.'

function requestDeadline(label: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${IMAGE_GEN_REQUEST_TIMEOUT_MS}ms`)),
      IMAGE_GEN_REQUEST_TIMEOUT_MS
    )
    timer.unref()
  })
  void promise.catch(() => {})
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** Smallest available model (`mini` heuristic), falling back to the catalog default and then the constant. */
export async function resolveImageGenModel(
  manager: CodexSubscriptionManager,
  availableModels?: readonly CodexSubscriptionModel[]
): Promise<string> {
  try {
    const models = availableModels ?? (await manager.listModels())
    const mini = models.find((model) => /mini/i.test(model.id) || /mini/i.test(model.model))
    if (mini) return mini.id
    const fallback = models.find((model) => model.isDefault) ?? models[0]
    if (fallback) return fallback.id
  } catch {
    // An unavailable catalog (offline/expired token) must not block generation: the runtime accepts the constant id;
    // if that model is also absent, the turn fails with an explicit app-server error.
  }
  return FALLBACK_IMAGE_GEN_MODEL
}

/**
 * Ephemeral thread with imagegen ON and everything else off (shell, web search, MCP, subagents). Result base64
 * never leaves this module: it becomes an app-owned file, and only the opaque handle is returned.
 */
export async function generateImageWithCodexRuntime(args: {
  client: CodexAppServerClient
  conversationId: string
  cwd: string
  modelId: string
  prompt: string
  signal: AbortSignal
  /** Receive usage even when the thread consumed tokens but failed to materialize an asset. */
  onUsage?: (usage: GeneratedImageUsage) => void
}): Promise<GeneratedImageArtifact> {
  let threadId = ''
  let turnId = ''
  let latestUsage: Record<string, unknown> | null = null
  let reportedUsage: GeneratedImageUsage | undefined
  let usageReported = false
  /** Last received image item. Kept raw and processed only after the turn ends. */
  let imageItem: Record<string, unknown> | null = null
  let resolveCompleted!: (status: string) => void
  let rejectCompleted!: (error: Error) => void
  const completed = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  let off = () => {}
  /**
   * Abort does NOT wait for runtime confirmation: request interruption and stop locally immediately. An app-server
   * that ignores interruption would otherwise leave the tool hanging forever after the model/turn stopped waiting.
   */
  let rejectAborted!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  void aborted.catch(() => {})
  const onAbort = () => {
    if (threadId && turnId) void args.client.interruptTurn({ threadId, turnId }).catch(() => {})
    const reason = args.signal.reason
    rejectAborted(reason instanceof Error ? reason : new Error('Image generation was aborted.'))
  }
  const readImageUsage = (): GeneratedImageUsage | undefined => {
    if (reportedUsage) return reportedUsage
    if (!isRecord(latestUsage) || !isRecord(latestUsage.tokenUsage)) return undefined
    const total = isRecord(latestUsage.tokenUsage.total) ? latestUsage.tokenUsage.total : null
    if (!total) return undefined
    const inputTokens = Math.max(0, Number(total.inputTokens) || 0)
    const cachedInput = Math.min(inputTokens, Math.max(0, Number(total.cachedInputTokens) || 0))
    const output = Math.max(0, Number(total.outputTokens) || 0)
    const cacheCreate = 0
    if (!inputTokens && !output && !cacheCreate) return undefined
    reportedUsage = {
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: args.modelId,
      input: Math.max(0, inputTokens - cachedInput),
      output,
      ...(cachedInput ? { cachedInput } : {}),
      ...(cacheCreate ? { cacheCreate } : {}),
    }
    if (!usageReported) {
      usageReported = true
      const usage = reportedUsage
      recordModelCallUsage({
        runtime: 'codex-subscription',
        providerId: usage.providerId,
        modelId: usage.modelId,
        conversationId: args.conversationId,
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cachedInput ?? 0,
          cacheCreate: usage.cacheCreate ?? 0,
          totalInput: usage.input + (usage.cachedInput ?? 0) + (usage.cacheCreate ?? 0),
        },
      })
      try {
        args.onUsage?.(usage)
      } catch {
        // Accounting must never turn a successful image generation into a failed tool call.
      }
    }
    return reportedUsage
  }
  args.signal.throwIfAborted()
  args.signal.addEventListener('abort', onAbort, { once: true })
  try {
    // Do not abort the original RPC: if the app-server already created the thread, only a late response reveals
    // the id needed to delete it. The race releases the caller immediately; the continuation owns cleanup.
    const startThreadRequest = args.client.startThread(
      {
        model: args.modelId,
        cwd: args.cwd,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        ephemeral: true,
        dynamicTools: [],
        // Empty = official contract to disable environment access (shell/apply_patch/view_image).
        environments: [],
        config: {
          'features.multi_agent': false,
          'features.multi_agent_v2': false,
          'features.shell_tool': false,
          'features.apps': false,
          'features.plugins': false,
          'features.tool_suggest': false,
          'features.image_generation': true,
          web_search: 'disabled',
        },
        developerInstructions: IMAGE_GEN_INSTRUCTIONS,
        personality: 'pragmatic',
      } as Parameters<CodexAppServerClient['startThread']>[0] & { dynamicTools: []; environments: [] },
      { timeoutMs: 0 }
    )
    void startThreadRequest.catch(() => {})
    const threadDeadline = requestDeadline('Codex image generation thread/start')
    let started: Awaited<typeof startThreadRequest>
    try {
      started = await Promise.race([
        startThreadRequest,
        aborted,
        threadDeadline.promise,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('The Codex app-server exited while starting image generation')
        }),
      ])
    } catch (error) {
      void startThreadRequest
        .then((lateThread) =>
          args.client
            .deleteThread({ threadId: lateThread.thread.id }, { signal: AbortSignal.timeout(15_000) })
            .catch(() => {})
        )
        .catch(() => {})
      throw error
    } finally {
      threadDeadline.cancel()
    }
    threadId = started.thread.id
    args.signal.throwIfAborted()
    off = args.client.onNotification(({ method, params }) => {
      if (!isRecord(params) || params.threadId !== threadId) return
      if (method === 'thread/tokenUsage/updated') {
        latestUsage = params
      } else if (method === 'turn/started') {
        const turn = isRecord(params.turn) ? params.turn : null
        if (turn && typeof turn.id === 'string') turnId = turn.id
        if (args.signal.aborted) onAbort()
      } else if (method === 'item/completed') {
        const item = isRecord(params.item) ? params.item : null
        // Only the FIRST item counts: the instruction requests one image, and replay must not create two artifacts.
        if (item?.type === 'imageGeneration' && !imageItem) imageItem = item
      } else if (method === 'turn/completed') {
        const turn = isRecord(params.turn) ? params.turn : null
        resolveCompleted(typeof turn?.status === 'string' ? turn.status : 'failed')
      } else if (method === 'thread/deleted') {
        rejectCompleted(new Error('The image generation thread was deleted before completion'))
      }
    })
    const startTurnRequest = args.client.startTurn(
      {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [codexTextInput(args.prompt)],
        cwd: args.cwd,
        model: args.modelId,
        approvalPolicy: 'untrusted',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: null,
        summary: 'auto',
        personality: 'pragmatic',
        collaborationMode: {
          mode: 'default',
          settings: { model: args.modelId, reasoning_effort: null, developer_instructions: null },
        },
      },
      { timeoutMs: 0 }
    )
    void startTurnRequest.catch(() => {})
    const turnDeadline = requestDeadline('Codex image generation turn/start')
    let turn: Awaited<typeof startTurnRequest>
    try {
      turn = await Promise.race([
        startTurnRequest,
        aborted,
        turnDeadline.promise,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('The Codex app-server exited while starting an image turn')
        }),
      ])
    } catch (error) {
      void startTurnRequest
        .then((lateTurn) =>
          args.client
            .interruptTurn({ threadId, turnId: lateTurn.turn.id }, { signal: AbortSignal.timeout(15_000) })
            .catch(() => {})
        )
        .catch(() => {})
      throw error
    } finally {
      turnDeadline.cancel()
    }
    turnId = turn.turn.id
    if (args.signal.aborted) onAbort()
    const status = await Promise.race([
      completed,
      aborted,
      args.client.waitForExit().then(() => {
        throw args.client.failure ?? new Error('The Codex app-server exited during image generation')
      }),
    ])
    args.signal.throwIfAborted()
    if (status !== 'completed') throw new Error(`Image generation ${status}`)
    const usage = readImageUsage()
    // Cast: TS narrows `imageItem` to `null` because assignment happens inside the listener.
    const item = imageItem as Record<string, unknown> | null
    if (!item) throw new Error('The model did not produce an image for this prompt.')
    const itemStatus = typeof item.status === 'string' ? item.status : 'completed'
    if (itemStatus === 'failed' || itemStatus === 'error') throw new Error('Image generation failed.')
    const revisedPrompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt.trim() : ''
    const label = (revisedPrompt || args.prompt).slice(0, 48)
    const stored = await saveGeneratedImage({
      conversationId: args.conversationId,
      result: typeof item.result === 'string' ? item.result : '',
      label,
    })
    if (args.signal.aborted) {
      await deleteGeneratedImages(args.conversationId, [stored.artifactId])
      args.signal.throwIfAborted()
    }
    return { ...stored, ...(revisedPrompt ? { revisedPrompt } : {}), ...(usage ? { usage } : {}) }
  } finally {
    readImageUsage()
    args.signal.removeEventListener('abort', onAbort)
    off()
    if (threadId) {
      if (turnId) await args.client.interruptTurn({ threadId, turnId }).catch(() => {})
      await args.client.deleteThread({ threadId }, { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }
  }
}

/**
 * Entry point for `generate_image`: resolve the Codex account/client/model and run the ephemeral thread. Use the
 * DEFAULT Codex account's failover route; the conversation may use any provider (Claude, Copilot, BYOK), which has
 * no failover of its own here.
 */
export async function generateImageForConversation(args: {
  conversationId: string
  cwd: string
  prompt: string
  signal: AbortSignal
  onUsage?: (usage: GeneratedImageUsage) => void
}): Promise<GeneratedImageArtifact> {
  const { CODEX_SUBSCRIPTION_PROVIDER_ID } = await import('../catalog')
  const { runCodexEphemeralWithFailover, CodexAccountsExhaustedError, CodexRuntimeUnavailableError } = await import(
    '../subscription-failover'
  )
  try {
    return await runCodexEphemeralWithFailover({
      logicalProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: FALLBACK_IMAGE_GEN_MODEL,
      resolveModelId: (manager, models) => resolveImageGenModel(manager, models),
      signal: args.signal,
      scope: 'helper',
      conversationId: args.conversationId,
      operation: async (target, signal) => {
        return generateImageWithCodexRuntime({
          client: target.client,
          conversationId: args.conversationId,
          cwd: args.cwd,
          modelId: target.runtimeModelId,
          prompt: args.prompt,
          signal,
          onUsage: args.onUsage,
        })
      },
    })
  } catch (error) {
    if (error instanceof CodexAccountsExhaustedError) throw error
    if (error instanceof CodexRuntimeUnavailableError && error.reason === 'not-authenticated') {
      throw new Error('Connect your ChatGPT (Codex) account in Maestrly settings to generate images.')
    }
    const message = error instanceof Error ? error.message : String(error)
    // Snapshot already unauthenticated (no chain member connected) → keep the clear connect hint.
    if (/not authenticated|Connect your ChatGPT/i.test(message)) {
      throw new Error('Connect your ChatGPT (Codex) account in Maestrly settings to generate images.')
    }
    throw error
  }
}
