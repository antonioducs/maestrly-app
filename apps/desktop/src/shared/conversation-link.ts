import { z } from 'zod'
import type { ConversationStatus } from './conversation'

/**
 * Conversation links: agents in different persistent conversations list, read, wait for and message each other.
 * Shared by main and the renderer; authorization, delivery and journaling stay in main.
 */

/**
 * Agent-to-agent turns allowed after each message a person typed. A human turn is hop 0; every message an agent
 * sends starts a turn one hop further, and a person typing in a conversation brings it back to 0.
 */
export const CONVERSATION_LINK_MAX_HOPS = 3
export const CONVERSATION_MESSAGE_MAX_BODY = 60_000
/** Final answers relayed as results are cut here; read_conversation shows the rest. */
export const CONVERSATION_RESULT_MAX_BODY = 20_000
/** Per-message text returned by read_conversation. */
export const CONVERSATION_READ_MAX_TEXT = 4_000
export const CONVERSATION_READ_DEFAULT_MESSAGES = 6
export const CONVERSATION_LIST_DEFAULT_LIMIT = 30
export const CONVERSATION_WAIT_DEFAULT_SECONDS = 300
export const CONVERSATION_WAIT_MAX_SECONDS = 900

/** `message`: sent with send_to_conversation; `report`: report_to_source; `result`: a final answer brought back. */
export type ConversationPeerMessageKind = 'message' | 'report' | 'result'
/** How another conversation relates to this one: it started this one, was started from it, or exchanged messages. */
export type ConversationRelation = 'source' | 'child' | 'linked'
export type ConversationTurnResultStatus = 'success' | 'error' | 'cancelled'
export type ConversationLinkErrorCode =
  | 'unavailable'
  | 'turn-ended'
  | 'not-found'
  | 'self'
  | 'archived'
  | 'not-linked'
  | 'hop-limit'
  | 'declined'
  | 'no-source'
  | 'delivery-failed'

const conversationId = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe('Canonical conversationId from list_conversations or a start_conversations result.')

export const listConversationsInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('Words in the conversation or workspace name; case and accents are ignored.'),
    workspaceId: z.string().trim().min(1).max(300).optional().describe('Only conversations of this workspace.'),
    includeArchived: z.boolean().optional().describe('Also list archived conversations.'),
    limit: z.number().int().min(1).max(100).optional().describe(`Default ${CONVERSATION_LIST_DEFAULT_LIMIT}.`),
  })
  .strict()

export const readConversationInputSchema = z
  .object({
    conversationId,
    messages: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe(`Recent messages to return (default ${CONVERSATION_READ_DEFAULT_MESSAGES}).`),
    beforeSeq: z.number().int().positive().optional().describe('Return messages older than this seq.'),
  })
  .strict()

export const waitConversationInputSchema = z
  .object({
    conversationId,
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(CONVERSATION_WAIT_MAX_SECONDS)
      .optional()
      .describe(`Default ${CONVERSATION_WAIT_DEFAULT_SECONDS}.`),
  })
  .strict()

export const sendToConversationInputSchema = z
  .object({
    conversationId,
    message: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_MESSAGE_MAX_BODY)
      .describe('Self-contained message: what you need, the context it needs, and what to answer.'),
    reportBack: z
      .boolean()
      .optional()
      .describe('Only when the person wants the result brought back: deliver the final answer to this message here.'),
  })
  .strict()

export const reportToSourceInputSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_MESSAGE_MAX_BODY)
      .describe('Self-contained report: what was done, results, open questions.'),
  })
  .strict()

export type ListConversationsInput = z.infer<typeof listConversationsInputSchema>
export type ReadConversationInput = z.infer<typeof readConversationInputSchema>
export type WaitConversationInput = z.infer<typeof waitConversationInputSchema>
export type SendToConversationInput = z.infer<typeof sendToConversationInputSchema>
export type ReportToSourceInput = z.infer<typeof reportToSourceInputSchema>

export interface ConversationSummary {
  conversationId: string
  name: string
  scope: 'project' | 'standalone'
  workspaceId: string | null
  workspaceName: string | null
  branch: string | null
  status: ConversationStatus
  /** A turn is running or about to start. */
  running: boolean
  archived: boolean
  relation: ConversationRelation | null
  lastActivityAt: number | null
}

export interface ConversationTranscriptEntry {
  seq: number
  role: 'user' | 'assistant'
  /** Sending conversation of a message that came from another conversation. */
  from?: string
  text: string
  truncated?: true
}

export interface ConversationReadResult {
  conversation: ConversationSummary
  /** Latest assistant answer with text; absent when paging older messages. */
  lastReply: { seq: number; text: string; truncated?: true } | null
  messages: ConversationTranscriptEntry[]
  hasMore: boolean
  earliestSeq: number | null
}

export interface ConversationLinkError {
  ok: false
  code: ConversationLinkErrorCode
  error: string
}

export type ConversationSendResult =
  | {
      ok: true
      status: 'delivered' | 'queued' | 'deferred'
      conversationId: string
      conversationName: string
      messageId?: string
      replayed?: true
      note?: string
    }
  | ConversationLinkError

export type ConversationWaitResult =
  | { ok: true; status: 'idle' | 'timeout'; result: ConversationReadResult }
  | ConversationLinkError
