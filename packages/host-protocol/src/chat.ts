import { z } from 'zod'
import { id, revision, errorSchema } from './common.js'
import { attachmentRefSchema, botTurnSchema, isoDate, modelSelectionSchema, turnStatusSchema, usageSchema } from './bots.js'

/** Host capability advertised by host.inspect once the chat experience domains exist. */
export const CHAT_HOST_CAPABILITY = 'chat.experience.v1'
/** Runtime capability: the guest enriches tool, reasoning and usage events for the transcript. */
export const TRANSCRIPT_CAPABILITY = 'bot.transcript.v1'
/** Runtime capability: the guest accepts per-bot MCP servers and skills before a turn. */
export const EXTENSIONS_CAPABILITY = 'bot.extensions.v1'
/** Longest tool output that travels in an event and is kept in a transcript part. */
export const TOOL_OUTPUT_MAX = 8 * 1024

/**
 * One piece of an assistant message as the person sees it. A turn is folded into these parts
 * from the durable events, so what the screen showed live and what the history shows later are
 * the same projection of the same rows.
 */
export const transcriptPartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), id, text: z.string().max(256 * 1024) }),
  z.strictObject({ type: z.literal('reasoning'), id, text: z.string().max(64 * 1024) }),
  z.strictObject({
    type: z.literal('tool'),
    id,
    callId: z.string().min(1).max(128),
    toolName: z.string().max(80),
    summary: z.string().max(400),
    input: z.unknown().optional(),
    output: z.string().max(TOOL_OUTPUT_MAX).optional(),
    exitCode: z.number().int().optional(),
    changes: z.array(z.strictObject({ path: z.string().max(512), kind: z.string().max(20) })).max(64).optional(),
    state: z.enum(['running', 'done', 'error']),
    startedAt: isoDate,
    finishedAt: isoDate.optional(),
  }),
  z.strictObject({ type: z.literal('file'), id, path: z.string().max(512), name: z.string().max(255), size: z.number().int().nonnegative() }),
])
export type TranscriptPart = z.infer<typeof transcriptPartSchema>

export const transcriptMessageSchema = z.strictObject({
  id,
  conversationId: id,
  role: z.enum(['user', 'assistant', 'system']),
  turnId: id.optional(),
  sequence: z.number().int().nonnegative(),
  createdAt: isoDate,
  parts: z.array(transcriptPartSchema).max(512),
  attachments: z.array(attachmentRefSchema).max(16),
  turnStatus: turnStatusSchema.optional(),
  responseStartedAt: isoDate.optional(),
  responseDurationMs: z.number().int().nonnegative().optional(),
  usage: usageSchema.optional(),
  model: modelSelectionSchema.optional(),
  error: errorSchema.optional(),
  /** true while the assistant message only exists as accumulated events (turn still running). */
  streaming: z.boolean(),
})
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>

export const transcriptPageSchema = z.strictObject({
  messages: z.array(transcriptMessageSchema),
  turns: z.array(botTurnSchema),
  hasMore: z.boolean(),
  /** Highest event sequence folded into this page; live subscriptions resume from here. */
  cursor: revision,
})
export type TranscriptPage = z.infer<typeof transcriptPageSchema>
