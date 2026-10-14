/**
 * ChatGPT-subscription web search: an EPHEMERAL Codex app-server thread with native search on and everything else
 * off, following `codex-subscription/image-generation.ts`. The thread is always deleted at the end and never touches
 * the conversation's resumable binding. Runtime modules load dynamically to keep the tool registry lightweight.
 */
import { randomUUID } from 'node:crypto'
import { getConversation } from '../../store'
import type { CodexAppServerClient } from '../codex-subscription/client'
import { codexTextInput } from '../codex-subscription/protocol'
import { codexImageGenConnected } from '../image-gen'
import { recordModelCallUsage } from '../usage-diagnostics'
import type { WebSearchBackend, WebSearchRequest } from './types'

export const CHATGPT_SEARCH_TIMEOUT_MS = 90_000
const FALLBACK_SEARCH_MODEL = 'gpt-5.6-mini'
const SEARCH_REQUEST_TIMEOUT_MS = 30_000

const WEB_SEARCH_INSTRUCTIONS =
  'You are a web search runner inside Maestrly. Use the native web search tool to research the query; never ' +
  'answer from memory. Do not investigate the workspace and do not ask questions. Reply concisely with the facts ' +
  'you found, then end with a "Sources:" line followed by a numbered list of "title — URL" lines for the pages you used.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function requestDeadline(label: string): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`)),
      SEARCH_REQUEST_TIMEOUT_MS
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

export async function searchWithCodexRuntime(args: {
  client: CodexAppServerClient
  conversationId: string
  cwd: string
  conversationScope?: 'project' | 'standalone'
  modelId: string
  query: string
  maxResults: number
  signal: AbortSignal
}): Promise<{ kind: 'summary'; text: string }> {
  const { CODEX_SUBSCRIPTION_PROVIDER_ID } = await import('../catalog')
  let threadId = ''
  let turnId = ''
  let latestUsage: Record<string, unknown> | null = null
  let usageReported = false
  let searched = false
  let answer = ''
  let resolveCompleted!: (status: string) => void
  let rejectCompleted!: (error: Error) => void
  const completed = new Promise<string>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })
  let off = () => {}
  // Abort does not wait for runtime confirmation: an app-server that ignores interruption must not hang the tool.
  let rejectAborted!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  void aborted.catch(() => {})
  const onAbort = () => {
    if (threadId && turnId) void args.client.interruptTurn({ threadId, turnId }).catch(() => {})
    const reason = args.signal.reason
    rejectAborted(reason instanceof Error ? reason : new Error('Web search was aborted.'))
  }
  const reportUsage = (): void => {
    if (usageReported) return
    if (!isRecord(latestUsage) || !isRecord(latestUsage.tokenUsage)) return
    const total = isRecord(latestUsage.tokenUsage.total) ? latestUsage.tokenUsage.total : null
    if (!total) return
    const inputTokens = Math.max(0, Number(total.inputTokens) || 0)
    const cachedInput = Math.min(inputTokens, Math.max(0, Number(total.cachedInputTokens) || 0))
    const output = Math.max(0, Number(total.outputTokens) || 0)
    if (!inputTokens && !output) return
    usageReported = true
    const input = inputTokens - cachedInput
    recordModelCallUsage({
      runtime: 'codex-subscription',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: args.modelId,
      conversationId: args.conversationId,
      usage: { input, output, cacheRead: cachedInput, cacheCreate: 0, totalInput: inputTokens },
    })
  }
  const standalone = args.conversationScope === 'standalone'
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
        ...(standalone ? { baseInstructions: WEB_SEARCH_INSTRUCTIONS } : {}),
        config: {
          ...(standalone
            ? {
                project_doc_max_bytes: 0,
                'features.skill_search': false,
                'skills.include_instructions': false,
                'features.skill_mcp_dependency_install': false,
              }
            : {}),
          'features.multi_agent': false,
          'features.multi_agent_v2': false,
          'features.shell_tool': false,
          'features.apps': false,
          'features.plugins': false,
          'features.tool_suggest': false,
          'features.image_generation': false,
          web_search: 'live',
        },
        developerInstructions: WEB_SEARCH_INSTRUCTIONS,
        personality: 'pragmatic',
      } as Parameters<CodexAppServerClient['startThread']>[0] & { dynamicTools: []; environments: [] },
      { timeoutMs: 0 }
    )
    void startThreadRequest.catch(() => {})
    const threadDeadline = requestDeadline('Codex web search thread/start')
    let started: Awaited<typeof startThreadRequest>
    try {
      started = await Promise.race([
        startThreadRequest,
        aborted,
        threadDeadline.promise,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('The Codex app-server exited while starting a web search')
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
        if (item?.type === 'webSearch') searched = true
        else if (item?.type === 'agentMessage' && typeof item.text === 'string') answer = item.text
      } else if (method === 'turn/completed') {
        const turn = isRecord(params.turn) ? params.turn : null
        resolveCompleted(typeof turn?.status === 'string' ? turn.status : 'failed')
      } else if (method === 'thread/deleted') {
        rejectCompleted(new Error('The web search thread was deleted before completion'))
      }
    })
    const startTurnRequest = args.client.startTurn(
      {
        threadId,
        clientUserMessageId: randomUUID(),
        input: [codexTextInput(`Search the web for: ${args.query}\nCite up to ${args.maxResults} sources.`)],
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
    const turnDeadline = requestDeadline('Codex web search turn/start')
    let turn: Awaited<typeof startTurnRequest>
    try {
      turn = await Promise.race([
        startTurnRequest,
        aborted,
        turnDeadline.promise,
        args.client.waitForExit().then(() => {
          throw args.client.failure ?? new Error('The Codex app-server exited while starting a web search turn')
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
        throw args.client.failure ?? new Error('The Codex app-server exited during a web search')
      }),
    ])
    args.signal.throwIfAborted()
    if (status !== 'completed') throw new Error(`ChatGPT web search ${status}`)
    // Never report a search that did not happen, even when the model answered from memory.
    if (!searched) throw new Error('ChatGPT did not run a web search for this query.')
    const text = answer.trim()
    if (!text) throw new Error('ChatGPT returned no search answer.')
    return { kind: 'summary', text }
  } finally {
    reportUsage()
    args.signal.removeEventListener('abort', onAbort)
    off()
    if (threadId) {
      if (turnId) await args.client.interruptTurn({ threadId, turnId }).catch(() => {})
      await args.client.deleteThread({ threadId }, { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    }
  }
}

/** Resolves the default Codex account's failover route, as image generation does, and runs the ephemeral search. */
export async function searchWebWithChatGpt(request: WebSearchRequest): Promise<{ kind: 'summary'; text: string }> {
  const [{ CODEX_SUBSCRIPTION_PROVIDER_ID }, failover, { resolveImageGenModel }] = await Promise.all([
    import('../catalog'),
    import('../subscription-failover'),
    import('../codex-subscription/image-generation'),
  ])
  const notConnected = 'Connect your ChatGPT (Codex) account in Maestrly settings to search with ChatGPT.'
  try {
    return await failover.runCodexEphemeralWithFailover({
      logicalProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: FALLBACK_SEARCH_MODEL,
      resolveModelId: (manager, models) => resolveImageGenModel(manager, models),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(CHATGPT_SEARCH_TIMEOUT_MS)]),
      scope: 'helper',
      conversationId: request.conversationId,
      operation: async (target, signal) =>
        searchWithCodexRuntime({
          conversationScope: getConversation(request.conversationId)?.scope,
          client: target.client,
          conversationId: request.conversationId,
          cwd: request.cwd,
          modelId: target.runtimeModelId,
          query: request.query,
          maxResults: request.maxResults,
          signal,
        }),
    })
  } catch (error) {
    if (error instanceof failover.CodexAccountsExhaustedError) throw error
    if (error instanceof failover.CodexRuntimeUnavailableError && error.reason === 'not-authenticated')
      throw new Error(notConnected)
    const message = error instanceof Error ? error.message : String(error)
    if (/not authenticated|Connect your ChatGPT/i.test(message)) throw new Error(notConnected)
    throw error
  }
}

export function createChatGptBackend(): WebSearchBackend {
  return {
    id: 'chatgpt',
    label: 'ChatGPT',
    unavailableReason: 'connect a ChatGPT (Codex) account in Settings → Accounts',
    available: codexImageGenConnected,
    search: searchWebWithChatGpt,
  }
}
