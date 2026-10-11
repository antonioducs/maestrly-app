import type { AcpContentBlock, AcpPromptResult, AcpSessionSetupResult } from '../acp/protocol'
import { isAcpMessageChunk } from '../acp/protocol'
import type { IsolatedSummaryResult } from '../portable-summarizer'
import { AntigravityModelUnavailableError } from './errors'
import {
  ANTIGRAVITY_SESSION_META,
  type AntigravityAccountIdentity,
  type AntigravitySubscriptionManager,
} from './manager'
import { resolveAntigravityModelValue } from './models'

export interface AntigravityIsolatedPromptArgs {
  manager: AntigravitySubscriptionManager
  accountIdentity: AntigravityAccountIdentity
  modelId: string
  reasoningEffort?: string
  system: string
  prompt: string
  images?: readonly { data: string; mimeType: string }[]
  signal: AbortSignal
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

/**
 * One tool-less prompt in a throwaway ACP session (summaries, one-shot text, image descriptions). No MCP server is
 * attached and every built-in tool stays disabled; the session is deleted afterwards.
 */
export async function runAntigravityIsolatedPrompt(args: AntigravityIsolatedPromptArgs): Promise<{ text: string }> {
  if (args.signal.aborted) throw abortError(args.signal)
  args.manager.assertAccountIdentity(args.accountIdentity)
  const modelValue = resolveAntigravityModelValue(await args.manager.listModels(), args.modelId, args.reasoningEffort)
  if (!modelValue) throw new AntigravityModelUnavailableError(args.modelId)
  const release = args.manager.retain()
  let sessionId: string | undefined
  let unsubscribe: (() => void) | undefined
  try {
    const connection = await args.manager.connection(args.signal)
    const { client } = connection
    const created = await client.request<AcpSessionSetupResult>(
      'session/new',
      { cwd: args.manager.workDir, mcpServers: [], _meta: ANTIGRAVITY_SESSION_META },
      { signal: args.signal }
    )
    if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
    const id = created.sessionId
    sessionId = id
    await client.request(
      'session/set_config_option',
      { sessionId: id, configId: 'model', value: modelValue },
      { signal: args.signal }
    )
    let text = ''
    unsubscribe = connection.subscribe(id, (update) => {
      if (update.sessionUpdate !== 'agent_message_chunk' || !isAcpMessageChunk(update)) return
      const content = update.content as { type?: string; text?: unknown }
      if (content.type === 'text' && typeof content.text === 'string') text += content.text
    })
    const prompt: AcpContentBlock[] = [
      { type: 'text', text: `<system>\n${args.system}\n</system>\n\n${args.prompt}` },
      ...(args.images ?? []).map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data })),
    ]
    const cancel = () => client.notify('session/cancel', { sessionId: id })
    args.signal.addEventListener('abort', cancel, { once: true })
    let result: AcpPromptResult
    try {
      result = await client.request<AcpPromptResult>(
        'session/prompt',
        { sessionId: id, prompt },
        { signal: args.signal }
      )
    } finally {
      args.signal.removeEventListener('abort', cancel)
    }
    if (result.stopReason === 'cancelled') throw abortError(args.signal)
    if (result.stopReason === 'refusal') throw new Error('Google declined to answer this request.')
    args.manager.assertAccountIdentity(args.accountIdentity)
    return { text: text.trim() }
  } catch (error) {
    throw args.manager.translateError(error)
  } finally {
    unsubscribe?.()
    if (sessionId) void args.manager.deleteSession(sessionId)
    release()
  }
}

/** Portable summarizer entry point; the ACP server reports no token usage. */
export async function summarizeWithAntigravityRuntime(
  args: AntigravityIsolatedPromptArgs
): Promise<IsolatedSummaryResult> {
  return { text: (await runAntigravityIsolatedPrompt(args)).text }
}
