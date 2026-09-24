/**
 * Host tools that start persistent conversations from natural-language requests. The tools are thin: the runner
 * gives the MAIN tool context a runtime bound to the admitted human turn, and everything else (explicit-intent
 * check, scope, settings validation, journaling, admission) happens in main-owned services. Child contexts never
 * receive the runtime, and the tool names are parent-only in every child filter.
 */
import { z } from 'zod'
import {
  conversationDispatchBatchSchema,
  type ConversationDispatchBatch,
  type ConversationDispatchBatchResult,
  type ConversationDispatchModelOption,
  type ConversationDispatchSettings,
} from '../../../shared/conversation-dispatch'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import {
  assertConversationDispatchGrantCurrent,
  currentHumanTurnOrigin,
  evaluateConversationDispatchGrant,
} from '../conversation-dispatch-authorization'
import { HOST_CONVERSATION_DISPATCH_GUIDANCE } from '../harness/host-contracts'
import { CONVERSATION_DISPATCH_TOOL_NAMES, conversationDispatchToolsAllowed } from '../tool-policy'
import { defineTool } from './util'

export interface ConversationDispatchToolRuntime {
  listModels(): Promise<{ models: ConversationDispatchModelOption[]; current: ConversationDispatchSettings | null }>
  startConversations(batch: ConversationDispatchBatch, signal: AbortSignal): Promise<ConversationDispatchBatchResult>
}

/**
 * Runtime for the turn currently admitted in `conversationId`, or undefined when the tools must not be offered:
 * restricted/Maestro modes, and every turn that was not started by text the person typed.
 */
export function conversationDispatchRuntimeFor(
  conversationId: string,
  mode: ChatBehavior
): ConversationDispatchToolRuntime | undefined {
  if (!conversationDispatchToolsAllowed(mode)) return undefined
  const origin = currentHumanTurnOrigin(conversationId)
  if (!origin) return undefined
  return {
    async listModels() {
      const [service, chat] = await Promise.all([
        import('../../conversation-dispatch-service'),
        import('../service'),
      ])
      return {
        models: await service.listConversationDispatchModels(),
        current: chat.conversationExecutionSettings(conversationId),
      }
    },
    async startConversations(batch, signal) {
      const evaluated = evaluateConversationDispatchGrant(origin)
      if (!evaluated.ok) return { ok: false, error: evaluated.message, items: [] }
      const grant = evaluated.grant
      const { getConversationDispatchService } = await import('../../conversation-dispatch-service')
      const service = await getConversationDispatchService()
      return service.dispatchBatch({
        grant,
        batch,
        signal: AbortSignal.any([signal, grant.signal]),
        assertCurrent: () => assertConversationDispatchGrantCurrent(grant),
      })
    },
  }
}

export function isConversationDispatchToolName(name: string): boolean {
  return (CONVERSATION_DISPATCH_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Runner helper: when this turn may start conversations, add the tool names to the enabled built-ins and return the
 * runtime to place ONLY in the main tool context.
 */
export function enableConversationDispatchTools(
  enabled: Set<string>,
  conversationId: string,
  mode: ChatBehavior
): ConversationDispatchToolRuntime | undefined {
  const runtime = conversationDispatchRuntimeFor(conversationId, mode)
  if (runtime) for (const name of CONVERSATION_DISPATCH_TOOL_NAMES) enabled.add(name)
  return runtime
}

const UNAVAILABLE =
  'Starting conversations is not available here. It only works in the main agent turn of a project conversation, ' +
  'started by a message the person typed.'

export const listConversationModelsTool = defineTool<
  z.ZodObject<Record<string, never>>,
  { models: ConversationDispatchModelOption[]; current: ConversationDispatchSettings | null } | { error: string }
>({
  name: 'list_conversation_models',
  description:
    'List the models that new conversations can use (canonical providerId/modelId, supported effort levels and ' +
    'whether Fast mode is available), plus the settings of this conversation that omitted fields inherit. Use it to ' +
    'map what the person said ("Opus", "GPT high", "fast on") before calling start_conversations.',
  parameters: z.object({}).strict(),
  execute: async (_args, ctx) => {
    if (!ctx.conversationDispatch) return { error: UNAVAILABLE }
    try {
      return await ctx.conversationDispatch.listModels()
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})

export const startConversationsTool = defineTool<typeof conversationDispatchBatchSchema, ConversationDispatchBatchResult>({
  name: 'start_conversations',
  description: HOST_CONVERSATION_DISPATCH_GUIDANCE,
  parameters: conversationDispatchBatchSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationDispatch) return { ok: false, error: UNAVAILABLE, items: [] }
    try {
      return await ctx.conversationDispatch.startConversations(args, ctx.signal)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), items: [] }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result, null, 2),
})
