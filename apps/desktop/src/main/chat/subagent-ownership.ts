import type { ChatExecutionScope, ChatModelRef, ChatUsage } from '../../shared/chat'
import { getDb } from '../store'
import { deleteChatMessage, upsertChatMessage } from './chat-store'
import type { NormalizedAiUsage } from './subagent-runner'

/** Ownership contract for the message id used by provider-native subagent checkpoints. */
export type SubagentMessageOwnership =
  | { kind: 'conversation' }
  | { kind: 'host-managed'; cleanup: 'delete' }
  /** The host owns all persistence. No chat_message row or conversation FK is created or removed here. */
  | { kind: 'standalone' }

interface HostManagedMessageArgs {
  conversationId: string
  messageId: string
  model: ChatModelRef
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonNegativeFinite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

function modelOf(outcome: unknown, fallback: ChatModelRef): ChatModelRef {
  const record = outcome && isRecord(outcome) ? outcome : undefined
  const partial = record && isRecord(record.partial) ? record.partial : undefined
  const candidate = record?.model ?? record?.subagentModel ?? partial?.model
  if (
    isRecord(candidate) &&
    typeof candidate.providerId === 'string' &&
    candidate.providerId.length > 0 &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.length > 0
  ) {
    return { providerId: candidate.providerId, modelId: candidate.modelId }
  }
  return fallback
}

function usageOf(outcome: unknown): NormalizedAiUsage | undefined {
  if (!outcome || !isRecord(outcome)) return undefined
  const usage =
    outcome.usage ?? outcome.subagentUsage ?? (isRecord(outcome.partial) ? outcome.partial.usage : undefined)
  if (!isRecord(usage)) return undefined
  const normalized: NormalizedAiUsage = {
    input: nonNegativeFinite(usage.input),
    output: nonNegativeFinite(usage.output),
    cacheRead: nonNegativeFinite(usage.cacheRead),
    cacheCreate: nonNegativeFinite(usage.cacheCreate),
    totalInput: nonNegativeFinite(usage.totalInput),
  }
  return normalized.input || normalized.output || normalized.cacheRead || normalized.cacheCreate
    ? normalized
    : undefined
}

function hostManagedBillingUsage(outcome: unknown): ChatUsage | undefined {
  const usage = usageOf(outcome)
  const record = outcome && isRecord(outcome) ? outcome : undefined
  const partial = record && isRecord(record.partial) ? record.partial : undefined
  const runtimeEstimatedCostUsd = nonNegativeFinite(
    record?.runtimeEstimatedCostUsd ?? record?.subagentRuntimeEstimatedCostUsd ?? partial?.runtimeEstimatedCostUsd
  )
  const runtimeValue =
    record?.runtimeEstimatedCostUsd ?? record?.subagentRuntimeEstimatedCostUsd ?? partial?.runtimeEstimatedCostUsd
  const hasRuntimeCost = typeof runtimeValue === 'number' && Number.isFinite(runtimeValue) && runtimeValue >= 0
  if (!usage && !hasRuntimeCost) return undefined

  return {
    usageVersion: 2,
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    ...(usage?.cacheRead ? { cachedInput: usage.cacheRead } : {}),
    ...(usage?.cacheCreate ? { cacheCreate: usage.cacheCreate } : {}),
    billingOnly: true,
    ...(hasRuntimeCost ? { runtimeEstimatedCostUsd } : {}),
  }
}

function persistHostManagedMessage(args: HostManagedMessageArgs): void {
  if (getDb().prepare('SELECT 1 FROM chat_messages WHERE id = ?').get(args.messageId)) {
    throw new Error(`Host-managed subagent message id is already owned: ${args.messageId}`)
  }
  const executionScope: ChatExecutionScope = { kind: 'host', executionId: args.messageId }
  upsertChatMessage({
    id: args.messageId,
    conversationId: args.conversationId,
    role: 'assistant',
    parts: [],
    model: args.model,
    internal: true,
    executionScope,
    createdAt: Date.now(),
  })
}

function persistHostManagedBilling(args: HostManagedMessageArgs, outcome: unknown): void {
  const usage = hostManagedBillingUsage(outcome)
  if (!usage) return
  upsertChatMessage({
    id: args.messageId,
    conversationId: args.conversationId,
    role: 'assistant',
    parts: [],
    model: modelOf(outcome, args.model),
    usage,
    internal: true,
    executionScope: { kind: 'host', executionId: args.messageId },
    createdAt: Date.now(),
  })
}

/** Runs one provider subagent with a durable parent row only when the selected ownership contract requires it. */
export async function withSubagentMessageOwnership<T>(args: {
  conversationId: string
  messageId: string
  model: ChatModelRef
  ownership?: SubagentMessageOwnership
  execute: () => Promise<T>
}): Promise<T> {
  const ownership = args.ownership ?? { kind: 'conversation' as const }
  if (ownership.kind === 'standalone') return args.execute()
  const hostManaged = ownership.kind === 'host-managed'
  if (hostManaged) persistHostManagedMessage(args)

  let result: T | undefined
  let failed = false
  let executionError: unknown
  try {
    result = await args.execute()
  } catch (error) {
    failed = true
    executionError = error
  }

  try {
    if (hostManaged) persistHostManagedBilling(args, failed ? executionError : result)
  } finally {
    if (hostManaged && ownership.cleanup === 'delete') deleteChatMessage(args.messageId)
  }

  if (failed) throw executionError
  return result as T
}
