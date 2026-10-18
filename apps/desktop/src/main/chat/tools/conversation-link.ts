/**
 * Host tools that list, read, wait for and message other existing conversations. The tools are thin: the runner gives
 * the MAIN tool context a runtime bound to the admitted turn (typed by the person, or started by another
 * conversation), and the conversation-link service owns authorization by provenance, journaling and delivery. Child
 * contexts never receive the runtime, and the names are parent-only in every child filter.
 */
import type { ChatQuestion } from '../../../shared/chat'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import {
  listConversationsInputSchema,
  readConversationInputSchema,
  reportToSourceInputSchema,
  sendToConversationInputSchema,
  waitConversationInputSchema,
  type ConversationLinkError,
  type ConversationReadResult,
  type ConversationSendResult,
  type ConversationSummary,
  type ConversationWaitResult,
  type ListConversationsInput,
  type ReadConversationInput,
  type ReportToSourceInput,
  type SendToConversationInput,
  type WaitConversationInput,
} from '../../../shared/conversation-link'
import { isBotMode } from '../../fleet/instance/config'
import { autonomousPolicy } from '../autonomous'
import {
  assertConversationTurnProvenanceCurrent,
  currentConversationTurnProvenance,
} from '../conversation-link-authorization'
import {
  HOST_LIST_CONVERSATIONS_GUIDANCE,
  HOST_READ_CONVERSATION_GUIDANCE,
  HOST_REPORT_TO_SOURCE_GUIDANCE,
  HOST_SEND_TO_CONVERSATION_GUIDANCE,
  HOST_WAIT_CONVERSATION_GUIDANCE,
} from '../harness/host-contracts'
import { remoteChatPolicy } from '../remote-policy'
import {
  CONVERSATION_LINK_TOOL_NAMES,
  conversationLinkToolsAllowed,
  PARENT_ONLY_CONVERSATION_TOOL_NAMES,
} from '../tool-policy'
import { defineTool } from './util'

type AskQuestion = (questions: ChatQuestion[]) => Promise<string[][]>

export interface ConversationLinkToolRuntime {
  list(input: ListConversationsInput): Promise<{ conversations: ConversationSummary[] } | { error: string }>
  read(input: ReadConversationInput): Promise<ConversationReadResult | ConversationLinkError>
  wait(input: WaitConversationInput, signal: AbortSignal): Promise<ConversationWaitResult>
  /** `askQuestion` lets the person confirm the first message to a conversation not linked to this one. */
  send(input: SendToConversationInput, askQuestion: AskQuestion): Promise<ConversationSendResult>
  report(input: ReportToSourceInput): Promise<ConversationSendResult>
}

/** Ask the person in the chat before messaging a conversation this one has no link with; dismissal declines. */
async function confirmSend(askQuestion: AskQuestion, target: ConversationSummary, preview: string): Promise<boolean> {
  const { tMain } = await import('../../i18n')
  const t = tMain('main')
  const labels = { send: t('conversationLink.sendConfirm'), cancel: t('conversationLink.sendCancel') }
  try {
    const answers = await askQuestion([
      {
        header: t('conversationLink.sendHeader'),
        question: t('conversationLink.sendQuestion', {
          name: target.name,
          workspace: target.workspaceName ? ` (${target.workspaceName})` : '',
          preview,
        }),
        options: [{ label: labels.send }, { label: labels.cancel }],
      },
    ])
    return answers[0]?.[0] === labels.send
  } catch {
    return false
  }
}

/** Whether the conversation's turns get the tool names at all: never in Plan/Maestro, bots, unattended or web turns. */
function conversationLinkToolsOffered(conversationId: string, mode: ChatBehavior): boolean {
  return (
    conversationLinkToolsAllowed(mode) &&
    !isBotMode() &&
    !autonomousPolicy(conversationId) &&
    !remoteChatPolicy(conversationId)
  )
}

/**
 * Runtime for the turn currently admitted in `conversationId`, or undefined when the tools must not act:
 * Plan/Maestro, bots, unattended and Kanban web turns, and turns started neither by the person nor by another
 * conversation.
 */
export function conversationLinkRuntimeFor(
  conversationId: string,
  mode: ChatBehavior
): ConversationLinkToolRuntime | undefined {
  if (!conversationLinkToolsOffered(conversationId, mode)) return undefined
  const provenance = currentConversationTurnProvenance(conversationId)
  if (!provenance) return undefined
  const caller = {
    conversationId,
    originKey: `message:${provenance.messageId}`,
    kind: provenance.kind,
    hop: provenance.hop,
    peerConversationId: provenance.kind === 'linked' ? provenance.peerConversationId : null,
    reportBack: provenance.kind === 'linked' ? provenance.reportBack : false,
    assertCurrent: () => assertConversationTurnProvenanceCurrent(provenance),
  }
  const ended = (): ConversationLinkError | null => {
    try {
      caller.assertCurrent()
      return null
    } catch (error) {
      return { ok: false, code: 'turn-ended', error: error instanceof Error ? error.message : String(error) }
    }
  }
  const service = async () => (await import('../../conversation-link-service')).getConversationLinkService()
  return {
    async list(input) {
      const refusal = ended()
      if (refusal) return { error: refusal.error }
      return { conversations: (await service()).list(caller, input) }
    },
    async read(input) {
      return ended() ?? (await service()).read(caller, input)
    },
    async wait(input, signal) {
      return ended() ?? (await service()).wait(caller, input, signal)
    },
    async send(input, askQuestion) {
      return (
        ended() ??
        (await service()).send(caller, input, (target, preview) => confirmSend(askQuestion, target, preview))
      )
    },
    async report(input) {
      return ended() ?? (await service()).report(caller, input)
    },
  }
}

export function isParentOnlyConversationToolName(name: string): boolean {
  return (PARENT_ONLY_CONVERSATION_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Runner helper: when the conversation offers them, add the tool names to the enabled built-ins, and return the
 * runtime to place ONLY in the main tool context when this turn may talk to other conversations.
 *
 * Like the dispatch tools, the names do not depend on who started the turn, so a native session survives a switch
 * between typed and host turns; without a runtime every tool refuses.
 */
export function enableConversationLinkTools(
  enabled: Set<string>,
  conversationId: string,
  mode: ChatBehavior
): ConversationLinkToolRuntime | undefined {
  if (!conversationLinkToolsOffered(conversationId, mode)) return undefined
  for (const name of CONVERSATION_LINK_TOOL_NAMES) enabled.add(name)
  return conversationLinkRuntimeFor(conversationId, mode)
}

const UNAVAILABLE =
  'Talking to other conversations is not available here. It only works in the main agent turn of a standalone or ' +
  'project conversation, started by the person or by another conversation.'

const unavailable = (): ConversationLinkError => ({ ok: false, code: 'unavailable', error: UNAVAILABLE })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const json = (_args: unknown, result: unknown) => JSON.stringify(result, null, 2)

export const listConversationsTool = defineTool<
  typeof listConversationsInputSchema,
  { conversations: ConversationSummary[] } | { error: string }
>({
  name: 'list_conversations',
  description: HOST_LIST_CONVERSATIONS_GUIDANCE,
  parameters: listConversationsInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationLink) return { error: UNAVAILABLE }
    try {
      return await ctx.conversationLink.list(args)
    } catch (error) {
      return { error: errorText(error) }
    }
  },
  toModelText: json,
})

export const readConversationTool = defineTool<
  typeof readConversationInputSchema,
  ConversationReadResult | ConversationLinkError
>({
  name: 'read_conversation',
  description: HOST_READ_CONVERSATION_GUIDANCE,
  parameters: readConversationInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationLink) return unavailable()
    try {
      return await ctx.conversationLink.read(args)
    } catch (error) {
      return { ok: false, code: 'unavailable', error: errorText(error) }
    }
  },
  toModelText: json,
})

export const waitConversationTool = defineTool<typeof waitConversationInputSchema, ConversationWaitResult>({
  name: 'wait_conversation',
  description: HOST_WAIT_CONVERSATION_GUIDANCE,
  parameters: waitConversationInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationLink) return unavailable()
    try {
      return await ctx.conversationLink.wait(args, ctx.signal)
    } catch (error) {
      return { ok: false, code: 'unavailable', error: errorText(error) }
    }
  },
  toModelText: json,
})

export const sendToConversationTool = defineTool<typeof sendToConversationInputSchema, ConversationSendResult>({
  name: 'send_to_conversation',
  description: HOST_SEND_TO_CONVERSATION_GUIDANCE,
  parameters: sendToConversationInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationLink) return unavailable()
    try {
      return await ctx.conversationLink.send(args, ctx.askQuestion)
    } catch (error) {
      return { ok: false, code: 'delivery-failed', error: errorText(error) }
    }
  },
  toModelText: json,
})

export const reportToSourceTool = defineTool<typeof reportToSourceInputSchema, ConversationSendResult>({
  name: 'report_to_source',
  description: HOST_REPORT_TO_SOURCE_GUIDANCE,
  parameters: reportToSourceInputSchema,
  execute: async (args, ctx) => {
    if (!ctx.conversationLink) return unavailable()
    try {
      return await ctx.conversationLink.report(args)
    } catch (error) {
      return { ok: false, code: 'delivery-failed', error: errorText(error) }
    }
  },
  toModelText: json,
})

