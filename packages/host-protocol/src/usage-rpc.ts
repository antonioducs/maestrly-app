import { z } from 'zod'
import { id } from './common.js'
import { isoDate } from './bots.js'

/**
 * Usage over the turn ledger: one row per finished turn, summed here by model, by bot and by
 * day. The Host has no prices; the application prices a model row with the public catalogue.
 * A window is bounded so a summary is always one bounded scan of an indexed range.
 */
export const USAGE_MAX_WINDOW_DAYS = 90
const count = z.number().int().nonnegative()
const tokens = {
  turns: count,
  input: count,
  cachedInput: count,
  output: count,
  reasoningOutput: count,
  toolCalls: count,
}
export const usageModelRowSchema = z.strictObject({ provider: z.string().min(1).max(40), model: z.string().min(1).max(120), ...tokens })
export type UsageModelRow = z.infer<typeof usageModelRowSchema>
export const usageBotRowSchema = z.strictObject({ botId: id, name: z.string().max(80), ...tokens })
export type UsageBotRow = z.infer<typeof usageBotRowSchema>
export const usageDayRowSchema = z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...tokens })
export type UsageDayRow = z.infer<typeof usageDayRowSchema>
export const usageSummarySchema = z.strictObject({
  since: isoDate,
  until: isoDate,
  botId: id.optional(),
  ...tokens,
  firstAt: isoDate.optional(),
  lastAt: isoDate.optional(),
  byModel: z.array(usageModelRowSchema).max(500),
  byBot: z.array(usageBotRowSchema).max(500),
  byDay: z.array(usageDayRowSchema).max(USAGE_MAX_WINDOW_DAYS + 1),
})
export type UsageSummary = z.infer<typeof usageSummarySchema>

const envelope = { version: z.literal(1), id }
const request = <M extends string, S extends z.ZodType>(method: M, params: S) => z.strictObject({ ...envelope, method: z.literal(method), params })
export const usageRequests = [
  request('usage.summary', z.strictObject({ botId: id.optional(), since: isoDate, until: isoDate.optional() })),
] as const
export const usageRequestSchema = z.discriminatedUnion('method', [...usageRequests])
export type UsageRequest = z.infer<typeof usageRequestSchema>
export type UsageMethod = UsageRequest['method']
export const usageMethods = usageRequests.map((schema) => schema.shape.method.value) as readonly UsageMethod[]
export const usageResultSchemas = { 'usage.summary': usageSummarySchema } satisfies Record<UsageMethod, z.ZodType>
export type UsageResult<M extends UsageMethod> = z.infer<(typeof usageResultSchemas)[M]>

/**
 * The window a summary covers, validated the same way on the Host and in an application: a
 * parsable start, an end no earlier than it, and at most USAGE_MAX_WINDOW_DAYS between them.
 * Returns the code an application can show, or null when the window is acceptable.
 */
export function usageWindowProblem(since: string, until: string): 'USAGE_RANGE_INVALID' | null {
  const start = Date.parse(since)
  const end = Date.parse(until)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'USAGE_RANGE_INVALID'
  if (end - start > USAGE_MAX_WINDOW_DAYS * 86_400_000) return 'USAGE_RANGE_INVALID'
  return null
}
