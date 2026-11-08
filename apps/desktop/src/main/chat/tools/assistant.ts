/**
 * Host tools only the Maestrly assistant conversation gets: the overview across this computer, its remote hosts and
 * its bots. Like the conversation-link tools, the runner places a runtime in the MAIN tool context, and only for a
 * turn the person typed; other turns (linked, unattended, bot or web) get the names but no runtime, so every tool
 * refuses. Other conversations never see the names, so their catalogs stay as they are.
 */
import { z } from 'zod'
import { type AssistantOverview, compactOverview } from '../../../shared/assistant-overview'
import type { ChatQuestion } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import type {
  ConversationLinkError,
  ConversationReadResult,
  ConversationSendResult,
} from '../../../shared/conversation-link'
import {
  assertConversationTurnProvenanceCurrent,
  currentConversationTurnProvenance,
} from '../conversation-link-authorization'
import { isAssistantRoleConversation } from '../harness/assistant-role'
import {
  HOST_BOT_READ_GUIDANCE,
  HOST_BOT_SEND_GUIDANCE,
  HOST_MAESTRLY_OVERVIEW_GUIDANCE,
  HOST_RESPOND_PENDING_GUIDANCE,
} from '../harness/host-contracts'
import { FLEET_MESSAGE_TEXT_MAX } from '@maestrly/bot-fleet-protocol'
import type { BotReadResult } from '../../assistant/bot-tools'
import type { RespondPendingResult } from '../../assistant/respond-pending'
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

/** Room left in a bot message for the line that marks it as the assistant's. */
export const BOT_SEND_MAX = FLEET_MESSAGE_TEXT_MAX - 200

const botRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe('The bot ref from maestrly_overview (bot:<serverId>:<botId>).')

export const botReadInputSchema = z
  .object({
    ref: botRef,
    runId: z.string().min(1).max(256).optional().describe("A routine run's runId: read that run instead."),
    messages: z.number().int().min(1).max(20).optional().describe('Recent messages to return (default 6).'),
  })
  .strict()
export type BotReadInput = z.infer<typeof botReadInputSchema>

export const botSendInputSchema = z
  .object({
    ref: botRef,
    message: z
      .string()
      .trim()
      .min(1)
      .max(BOT_SEND_MAX)
      .describe('Self-contained message: what you need, the context it needs, and what to answer.'),
  })
  .strict()
export type BotSendInput = z.infer<typeof botSendInputSchema>

export const respondPendingInputSchema = z
  .object({
    ref: z.string().trim().min(1).max(300).describe('The conversation or bot ref from maestrly_overview.'),
    itemId: z.string().trim().min(1).max(300).describe("The pending item's itemId from maestrly_overview."),
    answer: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('question'),
          option: z.string().trim().min(1).max(200).describe("The label of one of the question's options."),
        })
        .strict(),
      z.object({ kind: z.literal('permission'), decision: z.enum(['allow', 'deny']) }).strict(),
    ]),
  })
  .strict()
export type RespondPendingToolInput = z.infer<typeof respondPendingInputSchema>

type AskQuestion = (questions: ChatQuestion[]) => Promise<string[][]>

export interface AssistantToolRuntime {
  overview(input: MaestrlyOverviewInput): Promise<AssistantOverview | { error: string }>
  /** A conversation of a remote computer, named by its `host:` ref in the overview. */
  readRemote(
    hostId: string,
    conversationId: string,
    input: { messages?: number; beforeSeq?: number }
  ): Promise<ConversationReadResult | ConversationLinkError>
  sendRemote(
    hostId: string,
    conversationId: string,
    input: { message: string; reportBack?: boolean },
    askQuestion: AskQuestion
  ): Promise<ConversationSendResult>
  botRead(input: BotReadInput): Promise<BotReadResult | ConversationLinkError>
  botSend(input: BotSendInput, askQuestion: AskQuestion): Promise<ConversationSendResult>
  respondPending(input: RespondPendingToolInput, askQuestion: AskQuestion): Promise<RespondPendingResult>
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
  const originKey = `message:${provenance.messageId}`
  const turnEnded = (error: string): ConversationLinkError => ({ ok: false, code: 'turn-ended', error })
  const remoteDeps = async () => {
    const [{ assistantHostAccess }, { tMain }] = await Promise.all([
      import('../../assistant/assistant-context'),
      import('../../i18n'),
    ])
    const access = assistantHostAccess()
    return {
      invoke: access
        ? access.invoker.invoke
        : () => Promise.reject(new Error('This computer reaches no remote computers.')),
      hosts: () => access?.hosts() ?? [],
      viaLine: () => tMain('main')('assistant.viaLine'),
    }
  }
  const botDeps = async () => {
    const [{ assistantBotServer }, { tMain }] = await Promise.all([
      import('../../assistant/assistant-context'),
      import('../../i18n'),
    ])
    return {
      server: assistantBotServer,
      viaLine: () => tMain('main')('assistant.viaLine'),
      now: () => Date.now(),
    }
  }
  return {
    async overview(input) {
      const refusal = ended()
      if (refusal) return { error: refusal }
      const { collectAssistantOverview } = await import('../../assistant/assistant-context')
      return collectAssistantOverview(conversationId, { query: input.query })
    },
    async readRemote(hostId, remoteId, input) {
      const refusal = ended()
      if (refusal) return turnEnded(refusal)
      const { readRemoteConversation } = await import('../../assistant/remote-conversations')
      return readRemoteConversation(await remoteDeps(), hostId, remoteId, input)
    },
    async sendRemote(hostId, remoteId, input, askQuestion) {
      const refusal = ended()
      if (refusal) return turnEnded(refusal)
      const [{ sendRemoteConversation }, { admitAssistantAction }] = await Promise.all([
        import('../../assistant/remote-conversations'),
        import('../../assistant/action-budget'),
      ])
      return sendRemoteConversation(await remoteDeps(), hostId, remoteId, input, (target, preview) => {
        const late = ended()
        if (late) return Promise.resolve(false)
        return admitAssistantAction(askQuestion, originKey, target.conversationId, {
          kind: 'send',
          targetName: target.workspaceName ? `${target.name} (${target.workspaceName})` : target.name,
          preview,
        })
      })
    },
    async botRead(input) {
      const refusal = ended()
      if (refusal) return turnEnded(refusal)
      const { readBot } = await import('../../assistant/bot-tools')
      return readBot(await botDeps(), input)
    },
    async botSend(input, askQuestion) {
      const refusal = ended()
      if (refusal) return turnEnded(refusal)
      const [{ sendBot }, { admitAssistantAction }] = await Promise.all([
        import('../../assistant/bot-tools'),
        import('../../assistant/action-budget'),
      ])
      return sendBot(await botDeps(), input, (target, preview) => {
        if (ended()) return Promise.resolve(false)
        return admitAssistantAction(askQuestion, originKey, target.ref, {
          kind: 'bot-send',
          targetName: target.name,
          preview,
        })
      })
    },
    async respondPending(input, askQuestion) {
      const refusal = ended()
      if (refusal) return { ok: false, code: 'unavailable', error: refusal }
      const [{ respondPending }, budget, chat, { assistantBotServer }, bots, { getConversation }] = await Promise.all([
        import('../../assistant/respond-pending'),
        import('../../assistant/action-budget'),
        import('../service'),
        import('../../assistant/assistant-context'),
        import('../../fleet/client/bot-actions'),
        import('../../store'),
      ])
      return respondPending(
        {
          localPending: (id) => {
            const conversation = id === conversationId ? undefined : getConversation(id)
            if (!conversation || conversation.archived) return null
            return { name: conversation.name, ...chat.chatPendingInteractions(id) }
          },
          replyPermission: (requestId, reply) => {
            if (!ended()) chat.replyChatPermission(requestId, reply)
          },
          replyQuestion: (toolCallId, answers) => {
            if (!ended()) chat.replyChatQuestion(toolCallId, answers)
          },
          botServer: assistantBotServer,
          resolveBot: (fleet, botId, interactionId, resolution) => {
            const late = ended()
            if (late) return Promise.reject(new Error(late))
            return bots.resolveBotInteraction(fleet, botId, interactionId, resolution)
          },
          admit: (targetRef, action) =>
            ended() ? Promise.resolve(false) : budget.admitAssistantAction(askQuestion, originKey, targetRef, action),
          confirmApproval: async (action) =>
            !ended() &&
            (await budget.confirmAssistantAction(askQuestion, action, { allowRelease: false })) === 'once' &&
            !ended(),
        },
        input
      )
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

const unavailableLink = (): ConversationLinkError => ({
  ok: false,
  code: 'unavailable',
  error: ASSISTANT_TOOLS_UNAVAILABLE,
})

export const botReadTool = defineTool<typeof botReadInputSchema, BotReadResult | ConversationLinkError>({
  name: 'bot_read',
  description: HOST_BOT_READ_GUIDANCE,
  parameters: botReadInputSchema,
  metadata: { readOnly: true, parallelSafe: true },
  execute: async (args, ctx) => {
    if (!ctx.assistant) return unavailableLink()
    try {
      return await ctx.assistant.botRead(args)
    } catch (error) {
      return { ok: false, code: 'unavailable', error: errorText(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result),
})

export const botSendTool = defineTool<typeof botSendInputSchema, ConversationSendResult>({
  name: 'bot_send',
  description: HOST_BOT_SEND_GUIDANCE,
  parameters: botSendInputSchema,
  metadata: { readOnly: false, parallelSafe: false },
  execute: async (args, ctx) => {
    if (!ctx.assistant) return unavailableLink()
    try {
      return await ctx.assistant.botSend(args, ctx.askQuestion)
    } catch (error) {
      return { ok: false, code: 'delivery-failed', error: errorText(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result),
})

export const respondPendingTool = defineTool<typeof respondPendingInputSchema, RespondPendingResult>({
  name: 'respond_pending',
  description: HOST_RESPOND_PENDING_GUIDANCE,
  parameters: respondPendingInputSchema,
  metadata: { readOnly: false, parallelSafe: false },
  execute: async (args, ctx) => {
    if (!ctx.assistant) return { ok: false, code: 'unavailable', error: ASSISTANT_TOOLS_UNAVAILABLE }
    try {
      return await ctx.assistant.respondPending(args, ctx.askQuestion)
    } catch (error) {
      return { ok: false, code: 'delivery-failed', error: errorText(error) }
    }
  },
  toModelText: (_args, result) => JSON.stringify(result),
})
