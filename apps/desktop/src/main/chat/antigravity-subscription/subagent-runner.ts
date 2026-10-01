import type { ToolSet } from 'ai'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { AcpPromptResult, AcpSessionSetupResult } from '../acp/protocol'
import { isAcpMessageChunk } from '../acp/protocol'
import type { ChatAgent } from '../agents'
import { resolveAntigravityHarness } from '../harness/adapters/antigravity'
import type { ResolvedHarness } from '../harness/types'
import { MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { CONVERSATION_DISPATCH_TOOL_NAMES } from '../tool-policy'
import { selectSubagentToolNames } from '../tools'
import { AntigravityModelUnavailableError, AntigravityToolsUnavailableError, antigravityErrorMessage } from './errors'
import { type AntigravityHostToolset, registerAntigravityHostToolset } from './host-mcp'
import {
  ANTIGRAVITY_SESSION_META,
  type AntigravityAccountIdentity,
  type AntigravitySubscriptionManager,
} from './manager'
import { resolveAntigravityModelValue } from './models'
import { renderAntigravityToolCatalog } from './tool-catalog'

const FORBIDDEN_CHILD_TOOLS = new Set<string>([
  'task',
  'delegate',
  'review_plan',
  'ask_question',
  'todo_write',
  ...CONVERSATION_DISPATCH_TOOL_NAMES,
])

export interface RunAntigravitySubagentArgs {
  manager: AntigravitySubscriptionManager
  accountIdentity: AntigravityAccountIdentity
  conversationId: string
  cwd: string
  profile: SubagentExecutionSnapshotV1
  definition: ChatAgent
  signal: AbortSignal
  agentName: string
  task: string
  readOnly: boolean
  harness?: ResolvedHarness
  tools: ToolSet
  allowSkillLoader?: boolean
  progress?: (line: string) => void
  onTextUpdate?: SubagentTextUpdateHandler
}

export interface AntigravitySubagentResult {
  text: string
  error?: string
  model?: ChatModelRef
  /** Shared subagent result shape; never set because the ACP server reports no token usage. */
  usage?: NormalizedAiUsage
}

function abortedError(model: ChatModelRef): Error {
  return Object.assign(new Error('Subagent aborted'), { subagentModel: model })
}

/**
 * One Maestrly subagent in its own throwaway ACP session: the child gets only the tools its definition allows
 * (never delegation, questions, or plans), served by a dedicated loopback MCP toolset. The ACP server reports no
 * token usage, so none is recorded.
 */
export async function runAntigravitySubagent(args: RunAntigravitySubagentArgs): Promise<AntigravitySubagentResult> {
  args.signal.throwIfAborted()
  const effective = args.profile.effective
  if (!effective) return { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` }
  const model: ChatModelRef = { providerId: effective.providerId, modelId: effective.modelId }
  const allowedNames = selectSubagentToolNames({
    definition: args.definition,
    readOnly: args.readOnly,
    providedHostTools: args.tools,
    allowSkillLoader: args.allowSkillLoader,
  })
  const tools: ToolSet = Object.fromEntries(
    Object.entries(args.tools).filter(([name]) => allowedNames.has(name) && !FORBIDDEN_CHILD_TOOLS.has(name))
  )
  const instructions = [
    (args.harness ?? resolveAntigravityHarness(effective.modelId)).prompts.subagent ?? '',
    args.definition.prompt,
    `You are the delegated Maestrly subagent "${args.agentName}". Work only on the supplied task.`,
    `The user's project is ${args.cwd}; your own working directory is a private scratch folder, so always use absolute project paths with Maestrly's tools.`,
    MEMORY_TOOL_GUIDANCE,
    args.readOnly
      ? 'This delegated run is strictly read-only. Do not modify files, execute mutating commands, or spawn subagents.'
      : 'You are a worker. Do not spawn subagents. Return a concise result to the parent when the task is complete.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const toolAbort = new AbortController()
  const toolSignal = AbortSignal.any([args.signal, toolAbort.signal])
  const release = args.manager.retain()
  let toolset: AntigravityHostToolset | null = null
  let sessionId: string | null = null
  let unsubscribe: (() => void) | null = null
  try {
    args.manager.assertAccountIdentity(args.accountIdentity)
    const modelValue = resolveAntigravityModelValue(
      await args.manager.listModels(),
      effective.modelId,
      effective.sentEffort ?? undefined
    )
    if (!modelValue) throw new AntigravityModelUnavailableError(effective.modelId)
    const childToolset = await registerAntigravityHostToolset(tools)
    toolset = childToolset
    const connection = await args.manager.connection(args.signal)
    const { client } = connection
    const created = await client.request<AcpSessionSetupResult>('session/new', {
      cwd: args.manager.workDir,
      mcpServers: [childToolset.mcpServer],
      _meta: ANTIGRAVITY_SESSION_META,
    })
    if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
    const id = created.sessionId
    sessionId = id
    await client.request('session/set_config_option', { sessionId: id, configId: 'model', value: modelValue })

    let text = ''
    const emitText = createSubagentTextEmitter(args.onTextUpdate)
    unsubscribe = connection.subscribe(id, (update) => {
      if (update.sessionUpdate !== 'agent_message_chunk' || !isAcpMessageChunk(update)) return
      const content = update.content as { type?: string; text?: unknown }
      if (content.type !== 'text' || typeof content.text !== 'string') return
      text += content.text
      emitText(text)
    })
    childToolset.setActiveTurn({
      tools,
      signal: toolSignal,
      onToolStart: ({ toolName }) => args.progress?.(`${toolName} started`),
      onToolResult: () => undefined,
    })
    args.progress?.(`Starting subagent ${args.agentName}`)
    const prompt = `<maestrly_instructions>\n${instructions}\n</maestrly_instructions>\n\n${renderAntigravityToolCatalog(childToolset.specs)}\n\n# Task\n${args.task}`
    const cancel = () => client.notify('session/cancel', { sessionId: id })
    args.signal.addEventListener('abort', cancel, { once: true })
    let result: AcpPromptResult
    try {
      result = await client.request<AcpPromptResult>(
        'session/prompt',
        { sessionId: id, prompt: [{ type: 'text', text: prompt }] },
        { signal: args.signal }
      )
    } finally {
      args.signal.removeEventListener('abort', cancel)
    }
    if (args.signal.aborted || result.stopReason === 'cancelled') throw abortedError(model)
    args.manager.assertAccountIdentity(args.accountIdentity)
    if (!childToolset.wasInitialized()) return { text, error: new AntigravityToolsUnavailableError().message, model }
    if (result.stopReason === 'refusal') return { text, error: 'Google declined to answer this request.', model }
    return { text: text.trim() || '(the subagent returned no text)', model }
  } catch (error) {
    toolAbort.abort()
    if (args.signal.aborted || (error instanceof Error && error.message === 'Subagent aborted')) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { subagentModel: model })
    }
    return { text: '', error: antigravityErrorMessage(args.manager.translateError(error)).message, model }
  } finally {
    toolAbort.abort()
    unsubscribe?.()
    toolset?.setActiveTurn(null)
    toolset?.dispose()
    if (sessionId) void args.manager.deleteSession(sessionId)
    release()
  }
}
