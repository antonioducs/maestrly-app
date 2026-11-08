/**
 * Host tools only the Maestrly assistant conversation gets: the overview across this computer, its remote hosts and
 * its bots. Like the conversation-link tools, the runner places a runtime in the MAIN tool context, and only for a
 * turn the person typed; other turns (linked, unattended, bot or web) get the names but no runtime, so every tool
 * refuses. Other conversations never see the names, so their catalogs stay as they are.
 */
import { z } from 'zod'
import { type AssistantOverview, compactOverview } from '../../../shared/assistant-overview'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import {
  assertConversationTurnProvenanceCurrent,
  currentConversationTurnProvenance,
} from '../conversation-link-authorization'
import { isAssistantRoleConversation } from '../harness/assistant-role'
import { HOST_MAESTRLY_OVERVIEW_GUIDANCE } from '../harness/host-contracts'
import { ASSISTANT_TOOL_NAMES } from '../tool-policy'
import { conversationLinkToolsOffered } from './conversation-link'
import { defineTool } from './util'

export const maestrlyOverviewInputSchema = z
  .object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Keep only conversations, workspaces, computers or bots whose name holds this text.'),
  })
  .strict()
export type MaestrlyOverviewInput = z.infer<typeof maestrlyOverviewInputSchema>

export interface AssistantToolRuntime {
  overview(input: MaestrlyOverviewInput): Promise<AssistantOverview | { error: string }>
}

/** Whether the conversation's turns get the assistant tool names at all. */
export function assistantToolsOffered(conversationId: string, mode: ChatBehavior): boolean {
  return isAssistantRoleConversation(conversationId) && conversationLinkToolsOffered(conversationId, mode)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Runtime for the turn the person typed in the assistant conversation; undefined for any other turn. */
export function assistantRuntimeFor(conversationId: string, mode: ChatBehavior): AssistantToolRuntime | undefined {
  if (!assistantToolsOffered(conversationId, mode)) return undefined
  const provenance = currentConversationTurnProvenance(conversationId)
  if (provenance?.kind !== 'human') return undefined
  const ended = (): string | null => {
    try {
      assertConversationTurnProvenanceCurrent(provenance)
      return null
    } catch (error) {
      return errorText(error)
    }
  }
  return {
    async overview(input) {
      const refusal = ended()
      if (refusal) return { error: refusal }
      const { collectAssistantOverview } = await import('../../assistant/assistant-context')
      return collectAssistantOverview(conversationId, { query: input.query })
    },
  }
}

/**
 * Runner helper: in the assistant conversation, add the tool names to the enabled built-ins and return the runtime
 * to place ONLY in the main tool context when the person typed this turn. The names do not depend on who started
 * the turn, so a native session survives a switch between typed and host turns.
 */
export function enableAssistantTools(
  enabled: Set<string>,
  conversationId: string,
  mode: ChatBehavior
): AssistantToolRuntime | undefined {
  if (!assistantToolsOffered(conversationId, mode)) return undefined
  for (const name of ASSISTANT_TOOL_NAMES) enabled.add(name)
  return assistantRuntimeFor(conversationId, mode)
}

export const ASSISTANT_TOOLS_UNAVAILABLE =
  'The Maestrly assistant tools are not available here. They only work in the assistant conversation, in a turn the ' +
  'person started.'

export const maestrlyOverviewTool = defineTool<typeof maestrlyOverviewInputSchema, Record<string, unknown>>({
  name: 'maestrly_overview',
  description: HOST_MAESTRLY_OVERVIEW_GUIDANCE,
  parameters: maestrlyOverviewInputSchema,
  metadata: { readOnly: true, parallelSafe: true },
  execute: async (args, ctx) => {
    if (!ctx.assistant) return { error: ASSISTANT_TOOLS_UNAVAILABLE }
    try {
      const result = await ctx.assistant.overview(args)
      return 'error' in result ? result : compactOverview(result, Date.now())
    } catch (error) {
      return { error: errorText(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result),
})
