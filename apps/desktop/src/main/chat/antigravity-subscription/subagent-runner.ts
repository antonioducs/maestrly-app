import type { ToolSet } from 'ai'
import { getConversation } from '../../store'
import type { ChatModelRef } from '../../../shared/chat'
import type { SubagentExecutionSnapshotV1 } from '../../../shared/subagent-profiles'
import type { AcpPromptResult } from '../acp/protocol'
import { isAcpMessageChunk } from '../acp/protocol'
import type { ChatAgent } from '../agents'
import { resolveAntigravityHarness } from '../harness/adapters/antigravity'
import type { ResolvedHarness } from '../harness/types'
import { MEMORY_TOOL_GUIDANCE, PERSONAL_MEMORY_TOOL_GUIDANCE } from '../memory-tool-guidance'
import type { NormalizedAiUsage } from '../subagent-runner'
import { createSubagentTextEmitter, type SubagentTextUpdateHandler } from '../subagent-text-stream'
import { PARENT_ONLY_CONVERSATION_TOOL_NAMES } from '../tool-policy'
import { selectSubagentToolNames } from '../tools'
import { subagentEnvironment } from '../tools/command-shell'
import {
  AntigravityModelUnavailableError,
  AntigravityToolsUnavailableError,
  antigravityErrorMessage,
  antigravityExecutionErrorChunk,
  createAntigravityApiFailureHold,
  isAntigravityHarnessLost,
} from './errors'
import { type AntigravityHostToolset, registerAntigravityHostToolset } from './host-mcp'
import {
  ANTIGRAVITY_SESSION_META,
  type AntigravityAccountIdentity,
  type AntigravityConnection,
  type AntigravitySubscriptionManager,
} from './manager'
import { resolveAntigravityModelValue } from './models'
import { assertAntigravityPromptFits } from './prompt-limit'
import { releasesApiFailure } from './stream-map'

const FORBIDDEN_CHILD_TOOLS = new Set<string>([
  'task',
  'delegate',
  'review_plan',
  'ask_question',
  'todo_write',
  ...PARENT_ONLY_CONVERSATION_TOOL_NAMES,
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
  /** MCP and app tools, which the catalog lists without schemas when it outgrows its budget. */
  deferrableToolNames?: ReadonlySet<string>
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
  const first = await runAntigravitySubagentOnce(args)
  if (!first.retryable || args.signal.aborted) return first.result
  // Nothing ran yet, so starting over in a fresh session repeats no side effect.
  args.progress?.('Google Antigravity lost the session; retrying the subagent')
  return (await runAntigravitySubagentOnce(args)).result
}

async function runAntigravitySubagentOnce(
  args: RunAntigravitySubagentArgs
): Promise<{ result: AntigravitySubagentResult; retryable?: boolean }> {
  args.signal.throwIfAborted()
  const effective = args.profile.effective
  if (!effective) {
    return { result: { text: '', error: `Subagent "${args.agentName}" has no runnable execution profile.` } }
  }
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
    getConversation(args.conversationId)?.scope === 'standalone' ? PERSONAL_MEMORY_TOOL_GUIDANCE : MEMORY_TOOL_GUIDANCE,
    args.readOnly
      ? 'This delegated run is strictly read-only. Do not modify files, execute mutating commands, or spawn subagents.'
      : 'You are a worker. Do not spawn subagents. Return a concise result to the parent when the task is complete.',
    subagentEnvironment({
      cwd: args.cwd,
      standalone: getConversation(args.conversationId)?.scope === 'standalone',
      commandShell: 'bash' in tools,
    }),
  ]
    .filter(Boolean)
    .join('\n\n')

  const toolAbort = new AbortController()
  const toolSignal = AbortSignal.any([args.signal, toolAbort.signal])
  const release = args.manager.retain()
  let connection: AntigravityConnection | null = null
  let toolset: AntigravityHostToolset | null = null
  let sessionId: string | null = null
  let unsubscribe: (() => void) | null = null
  let toolsStarted = 0
  try {
    args.manager.assertAccountIdentity(args.accountIdentity)
    const modelValue = resolveAntigravityModelValue(
      await args.manager.listModels(),
      effective.modelId,
      effective.sentEffort ?? undefined
    )
    if (!modelValue) throw new AntigravityModelUnavailableError(effective.modelId)
    const childToolset = await registerAntigravityHostToolset(tools, {
      summarizable: args.deferrableToolNames ? [[...args.deferrableToolNames]] : [],
      deferred: args.deferrableToolNames ? [...args.deferrableToolNames] : [],
    })
    toolset = childToolset
    const prompt = `<maestrly_instructions>\n${instructions}\n</maestrly_instructions>\n\n${childToolset.catalog}\n\n# Task\n${args.task}`
    assertAntigravityPromptFits([{ type: 'text', text: prompt }])
    connection = await args.manager.connection(args.signal)
    const { client } = connection
    const created = await connection.newSession({
      cwd: args.manager.workDir,
      mcpServers: [childToolset.mcpServer],
      _meta: ANTIGRAVITY_SESSION_META,
    })
    if (!created.sessionId) throw new Error('Google Antigravity did not create a session.')
    const id = created.sessionId
    sessionId = id
    await client.request('session/set_config_option', { sessionId: id, configId: 'model', value: modelValue })

    let text = ''
    let failure = null as Error | null
    const emitText = createSubagentTextEmitter(args.onTextUpdate)
    const apiFailure = createAntigravityApiFailureHold<string>()
    unsubscribe = connection.subscribe(id, (update) => {
      if (releasesApiFailure(update)) {
        const released = apiFailure.release()
        if (released) {
          text += released
          emitText(text)
        }
      }
      if (update.sessionUpdate !== 'agent_message_chunk' || !isAcpMessageChunk(update)) return
      const content = update.content as { type?: string; text?: unknown }
      if (content.type !== 'text' || typeof content.text !== 'string') return
      failure ??= antigravityExecutionErrorChunk(content.text)
      if (failure || apiFailure.hold(content.text, content.text)) return
      text += content.text
      emitText(text)
    })
    childToolset.setActiveTurn({
      tools,
      signal: toolSignal,
      onToolStart: ({ toolName }) => {
        toolsStarted++
        args.progress?.(`${toolName} started`)
      },
      onToolResult: () => undefined,
    })
    args.progress?.(`Starting subagent ${args.agentName}`)
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
    failure ??= apiFailure.settle()
    if (failure) throw failure
    if (!childToolset.wasInitialized()) {
      return { result: { text, error: new AntigravityToolsUnavailableError().message, model } }
    }
    if (result.stopReason === 'refusal') {
      return { result: { text, error: 'Google declined to answer this request.', model } }
    }
    return { result: { text: text.trim() || '(the subagent returned no text)', model } }
  } catch (error) {
    toolAbort.abort()
    if (args.signal.aborted || (error instanceof Error && error.message === 'Subagent aborted')) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { subagentModel: model })
    }
    const translated = args.manager.translateError(error)
    return {
      result: { text: '', error: antigravityErrorMessage(translated).message, model },
      retryable: toolsStarted === 0 && isAntigravityHarnessLost(translated),
    }
  } finally {
    toolAbort.abort()
    unsubscribe?.()
    toolset?.setActiveTurn(null)
    toolset?.dispose()
    if (sessionId) void args.manager.deleteSession(sessionId)
    connection?.release()
    release()
  }
}
