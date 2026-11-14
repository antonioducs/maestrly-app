/**
 * Web search on a Google AI subscription through the Antigravity ACP server's own built-in `search_web` tool, which
 * answers from Google Search grounding. Follows `image-generation.ts`: one throwaway session in the app-owned work
 * directory, with no MCP server and only that built-in enabled, whose single call a session-scoped policy approves.
 * The tool's grounded answer is the result, so the turn is cancelled as soon as it arrives instead of waiting for the
 * model to restate it.
 */
import type { AcpPromptResult, AcpSessionSetupResult, AcpSessionUpdate } from '../acp/protocol'
import { antigravityErrorMessage, isAntigravityQuotaError, redactAntigravityCredentials } from './errors'
import type { AntigravityAccountIdentity, AntigravitySubscriptionManager } from './manager'
import { pickAntigravityHelperModel, resolveAntigravityModelValue } from './models'
import { ANTIGRAVITY_SEARCH_TOOL, createAntigravitySearchPermissionPolicy } from './permissions'

/** Search sessions enable exactly one built-in tool. */
export const ANTIGRAVITY_SEARCH_SESSION_META = Object.freeze({
  agy: Object.freeze({ enabledTools: Object.freeze([ANTIGRAVITY_SEARCH_TOOL]) }),
})

/** How long a turn cancelled after its search result arrived may take to stop before the session is discarded. */
const CANCEL_GRACE_MS = 5_000
const MODEL_TEXT_LIMIT = 300

const SEARCH_INSTRUCTIONS =
  `You are a web search runner inside Maestrly. Call the ${ANTIGRAVITY_SEARCH_TOOL} tool EXACTLY ONCE with the ` +
  'query below, as given, as its query. Then stop. Never answer from memory, do not ask questions and do not write ' +
  'any explanation: the search result itself is the only deliverable.'

const QUOTA_MESSAGE =
  'Google AI web search limit reached. Wait for the limit to reset, or choose another web search provider in Maestrly settings.'

export interface AntigravitySearchArgs {
  manager: AntigravitySubscriptionManager
  accountIdentity: AntigravityAccountIdentity
  query: string
  signal: AbortSignal
}

/** What one tool update says about the search call; null for updates that are not a finished tool call. */
export type AntigravitySearchToolEvent = { status: 'completed'; text: string } | { status: 'failed'; error?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

/**
 * Reads a `tool_call` / `tool_call_update` of the search session. Only `search_web` is enabled there, so the only
 * tool call that can finish is the search. The server sends the grounded answer, in Markdown with numbered sources,
 * both as `rawOutput` and as a text block in `content`.
 */
export function parseAntigravitySearchToolUpdate(update: AcpSessionUpdate): AntigravitySearchToolEvent | null {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return null
  const value = update as Record<string, unknown>
  const content = Array.isArray(value.content) ? value.content : []
  const texts = content
    .map((item) => (isRecord(item) && isRecord(item.content) ? item.content : null))
    .flatMap((block) =>
      block?.type === 'text' && typeof block.text === 'string' && block.text.trim() ? [block.text] : []
    )
  if (value.status === 'failed') {
    const error = texts.join('\n').trim()
    return { status: 'failed', ...(error ? { error } : {}) }
  }
  if (value.status !== 'completed') return null
  const raw = typeof value.rawOutput === 'string' ? value.rawOutput : ''
  return { status: 'completed', text: (raw.trim() ? raw : texts.join('\n\n')).trim() }
}

function failure(error: unknown): Error {
  if (isAntigravityQuotaError(error)) return new Error(QUOTA_MESSAGE)
  return new Error(antigravityErrorMessage(error).message)
}

/** One web search on a Google AI account; resolves with the grounded answer as the tool wrote it. */
export async function searchWebWithAntigravityRuntime(args: AntigravitySearchArgs): Promise<{ text: string }> {
  const { manager, signal } = args
  if (signal.aborted) throw abortError(signal)
  const release = manager.retain()
  let sessionId: string | undefined
  let unsubscribe: (() => void) | undefined
  let removePolicy: (() => void) | undefined
  try {
    manager.assertAccountIdentity(args.accountIdentity)
    const models = await manager.listModels()
    const model = pickAntigravityHelperModel(models)
    const modelValue = model && resolveAntigravityModelValue(models, model.modelId, model.effort)
    if (!modelValue) throw new Error('Google AI has no model available to search the web.')
    const connection = await manager.connection(signal)
    const { client } = connection
    const created = await client.request<AcpSessionSetupResult>(
      'session/new',
      { cwd: manager.workDir, mcpServers: [], _meta: ANTIGRAVITY_SEARCH_SESSION_META },
      { signal }
    )
    if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
    const id = created.sessionId
    sessionId = id
    removePolicy = manager.setSessionPermissionPolicy(id, createAntigravitySearchPermissionPolicy())
    await client.request(
      'session/set_config_option',
      { sessionId: id, configId: 'model', value: modelValue },
      { signal }
    )

    let event: AntigravitySearchToolEvent | null = null
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
      event = parseAntigravitySearchToolUpdate(update)
      if (event) finished()
    })
    const cancel = () => client.notify('session/cancel', { sessionId: id })
    // The query goes last, on one line, so a multi-line query cannot pose as more instructions.
    const query = args.query.replace(/\s+/g, ' ').trim()
    const prompt = client.request<AcpPromptResult>(
      'session/prompt',
      { sessionId: id, prompt: [{ type: 'text', text: `<system>\n${SEARCH_INSTRUCTIONS}\n</system>\n\n${query}` }] },
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
    const outcome = event as AntigravitySearchToolEvent | null
    if (outcome && !result) {
      // The search result is in; the model's restatement of it is not worth waiting for.
      cancel()
      await Promise.race([prompt.catch(() => undefined), delay(CANCEL_GRACE_MS)])
    }
    if (!outcome) {
      if (result?.stopReason === 'cancelled') throw abortError(signal)
      if (result?.stopReason === 'refusal') throw new Error('Google declined to search the web for this query.')
      const said = redactAntigravityCredentials(modelText.trim()).slice(0, MODEL_TEXT_LIMIT)
      throw new Error(
        said
          ? `Google AI did not run a web search. It answered: ${said}`
          : 'Google AI did not run a web search for this query.'
      )
    }
    if (outcome.status === 'failed') {
      const detail = outcome.error ? `: ${redactAntigravityCredentials(outcome.error).slice(0, MODEL_TEXT_LIMIT)}` : '.'
      throw new Error(`Google AI web search failed${detail}`)
    }
    if (!outcome.text) throw new Error('Google AI returned no search results.')
    manager.assertAccountIdentity(args.accountIdentity)
    return { text: outcome.text }
  } catch (error) {
    if (signal.aborted) throw abortError(signal)
    throw failure(manager.translateError(error))
  } finally {
    unsubscribe?.()
    removePolicy?.()
    // The server cannot delete sessions; this removes the session's files.
    if (sessionId) void manager.deleteSession(sessionId)
    release()
  }
}
