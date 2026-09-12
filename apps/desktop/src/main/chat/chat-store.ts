/**
 * BYOK chat message persistence (`chat_messages`, created by store.ts initStore).
 *
 * Lean port of opencode `session/store.ts` + `sql.ts`: one row per message, JSON parts, monotonically increasing
 * conversation `seq` (stable ordering even with equal created_at). Conversation IS the session
 * (conversation_id), so no separate `chat_session` table — envelope (model/finish/usage/error)
 * goes in `meta_json`. Idempotent upserts persist the assistant under construction at every checkpoint.
 */

import { getDb } from '../store'
import type {
  ChatExecutionScope,
  ChatHistoryPage,
  ChatHistoryStats,
  ChatMessage,
  ChatModelRef,
  ChatModelUsage,
  ChatPerModelUsage,
  ChatReviewLoopMeta,
  ChatSearchHit,
  ChatUsage,
  ChatUsageStats,
  MessagePart,
} from '../../shared/chat'
import { totalTokensOf, toolOutputImages } from '../../shared/chat'
import { deleteConversationGeneratedImages, deleteGeneratedImages } from './generated-images'
import { deleteAttachmentImages, deleteConversationAttachmentImages } from './attachment-artifacts'
import { clipPersistedToolOutput, parseParts } from './message'
import {
  clearConversationToolImageMetadata,
  releaseConversationToolImageMetadata,
  releaseUnreferencedEphemeralToolImages,
  sanitizeToolOutputForPersistence,
} from './tool-output'

/**
 * PERSISTED/INTERNAL main-process usage. Extends public `ChatUsage` with the OPAQUE identity
 * of the backend measuring context (same BYOK `providerFingerprint` hash; Claude
 * subscription hashes account+prompt). Used ONLY to invalidate measurements after endpoint/transport/key
 * changes — NEVER crosses IPC/preload/renderer. Use `toPublicChatUsage` at boundaries.
 */
export interface StoredChatUsage extends ChatUsage {
  contextIdentity?: string
}

/**
 * PERSISTED/INTERNAL main-process message. Extends public `ChatMessage` with:
 *  - `providerFingerprint`: opaque BYOK backend identity for interleaved reasoning replay;
 *  - `usage` as `StoredChatUsage` (may carry `contextIdentity` to revalidate context measurements).
 * Never crosses main boundary — use `toPublicChatMessage` at boundaries.
 */
export interface StoredChatMessage extends Omit<ChatMessage, 'usage'> {
  usage?: StoredChatUsage
  providerFingerprint?: string
}

/** Internal history stats — `lastUsage` may contain `contextIdentity`; project before IPC. */
export interface StoredChatHistoryStats extends Omit<ChatHistoryStats, 'lastUsage'> {
  lastUsage: StoredChatUsage | null
}

/** Internal history page (StoredChatMessage) — must NOT reach IPC without public projection. */
export interface StoredChatHistoryPage {
  messages: StoredChatMessage[]
  hasMore: boolean
  earliestSeq: number | null
  latestSeq: number | null
  hasMoreAfter?: boolean
}

/** Store-only row used by the ChatGPT Web conversation projection. Never crosses the bridge directly. */
export interface CompanionConversationMessageRow {
  seq: number
  message: StoredChatMessage
}

export interface CompanionConversationMessagePage {
  messages: CompanionConversationMessageRow[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

interface MetaJson {
  model?: ChatModelRef
  providerFingerprint?: string
  source?: ChatMessage['source']
  finishReason?: string
  usage?: StoredChatUsage
  error?: string
  errorCode?: ChatMessage['errorCode']
  responseDurationMs?: number
  internal?: boolean
  /** Execution scope; absent = main conversation (legacy). */
  executionScope?: ChatExecutionScope
  memoryContext?: ChatMessage['memoryContext']
  steering?: ChatMessage['steering']
}

function parseMemoryContext(raw: unknown): ChatMessage['memoryContext'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.revision !== 'string' || !Array.isArray(value.sources)) return undefined
  const sources = value.sources.slice(0, 10).flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return []
    const item = source as Record<string, unknown>
    if (
      (item.kind !== 'local' && item.kind !== 'shared') ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string'
    )
      return []
    return [
      {
        kind: item.kind as 'local' | 'shared',
        id: item.id.slice(0, 500),
        title: item.title.slice(0, 500),
        ...(typeof item.repo === 'string' ? { repo: item.repo.slice(0, 2_000) } : {}),
        ...(typeof item.path === 'string' ? { path: item.path.slice(0, 2_000) } : {}),
        ...(typeof item.heading === 'string' ? { heading: item.heading.slice(0, 500) } : {}),
        ...(typeof item.startLine === 'number' ? { startLine: item.startLine } : {}),
        ...(typeof item.endLine === 'number' ? { endLine: item.endLine } : {}),
      },
    ]
  })
  return {
    revision: value.revision.slice(0, 200),
    sources,
    ...(typeof value.degradedReason === 'string' ? { degradedReason: value.degradedReason.slice(0, 500) } : {}),
  }
}

function parseExecutionScope(raw: unknown): ChatExecutionScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const scope = raw as Record<string, unknown>
  if (scope.kind === 'conversation') return { kind: 'conversation' }
  // Final loop summary: outside main context and resume boundary. Deliberately lenient —
  // degrading to main-context (undefined) would reintroduce contamination; kind alone suffices for exclusion.
  if (scope.kind === 'review-summary') {
    return {
      kind: 'review-summary',
      loopId: typeof scope.loopId === 'string' ? scope.loopId : '',
      ...(scope.role === 'executor' || scope.role === 'reviewer' ? { role: scope.role } : {}),
      ...(typeof scope.executorConversationId === 'string'
        ? { executorConversationId: scope.executorConversationId }
        : {}),
      ...(typeof scope.reviewerConversationId === 'string'
        ? { reviewerConversationId: scope.reviewerConversationId }
        : {}),
    }
  }
  if (scope.kind === 'host') {
    return typeof scope.executionId === 'string' && scope.executionId
      ? { kind: 'host', executionId: scope.executionId }
      : undefined
  }
  if (scope.kind !== 'review-loop') return undefined
  const executionId = typeof scope.executionId === 'string' ? scope.executionId : ''
  const loopId = typeof scope.loopId === 'string' ? scope.loopId : ''
  const iteration =
    typeof scope.iteration === 'number' && Number.isFinite(scope.iteration) ? Math.floor(scope.iteration) : 0
  const maxIterations =
    typeof scope.maxIterations === 'number' && Number.isFinite(scope.maxIterations)
      ? Math.floor(scope.maxIterations)
      : 0
  if (!executionId || !loopId || iteration < 1 || maxIterations < 1) return undefined
  return {
    kind: 'review-loop',
    executionId,
    loopId,
    iteration,
    maxIterations,
    ...(scope.role === 'executor' || scope.role === 'reviewer' ? { role: scope.role } : {}),
    ...(typeof scope.executorConversationId === 'string'
      ? { executorConversationId: scope.executorConversationId }
      : {}),
    ...(typeof scope.reviewerConversationId === 'string'
      ? { reviewerConversationId: scope.reviewerConversationId }
      : {}),
  }
}

function reviewLoopMetaOf(scope: ChatExecutionScope | undefined): ChatReviewLoopMeta | undefined {
  if (scope?.kind !== 'review-loop') return undefined
  return {
    loopId: scope.loopId,
    executionId: scope.executionId,
    iteration: scope.iteration,
    maxIterations: scope.maxIterations,
    ...(scope.role ? { role: scope.role } : {}),
    ...(scope.executorConversationId ? { executorConversationId: scope.executorConversationId } : {}),
    ...(scope.reviewerConversationId ? { reviewerConversationId: scope.reviewerConversationId } : {}),
  }
}

/** Main-context messages (legacy or `kind: 'conversation'`). */
export function isConversationContextMessage(message: Pick<StoredChatMessage, 'executionScope'>): boolean {
  return !message.executionScope || message.executionScope.kind === 'conversation'
}

/** Isolated review-loop execution messages. */
export function isExecutionContextMessage(
  message: Pick<StoredChatMessage, 'executionScope'>,
  executionId: string
): boolean {
  return message.executionScope?.kind === 'review-loop' && message.executionScope.executionId === executionId
}

/** Reads meta_json usage, retaining `contextIdentity` only if a nonempty string (defensive). */
function parseStoredUsage(raw: unknown): StoredChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as StoredChatUsage
  if (typeof u.input !== 'number' || typeof u.output !== 'number') return undefined
  const identity = typeof u.contextIdentity === 'string' && u.contextIdentity.length > 0 ? u.contextIdentity : undefined
  // Shallow copy: do not reuse parsed object (caller may mutate); discard invalid identity.
  const { contextIdentity: _drop, ...rest } = u
  return identity ? { ...rest, contextIdentity: identity } : { ...rest }
}

interface UsageSlice {
  providerId: string
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  runtimeEstimatedCostUsd?: number
  catalogInput: number
  catalogOutput: number
  catalogCacheRead: number
  catalogCacheCreate: number
  subagent: boolean
}

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const runtimeCost = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function usageSlice(
  providerId: string,
  modelId: string,
  values: {
    input?: unknown
    output?: unknown
    cachedInput?: unknown
    cacheCreate?: unknown
    runtimeEstimatedCostUsd?: unknown
    catalogInput?: unknown
    catalogOutput?: unknown
    catalogCacheRead?: unknown
    catalogCacheCreate?: unknown
  },
  subagent: boolean,
  disjoint: boolean
): UsageSlice {
  const reportedInput = tokenCount(values.input)
  const reportedRead = tokenCount(values.cachedInput)
  const reportedCreate = tokenCount(values.cacheCreate)
  const cacheRead = disjoint ? reportedRead : Math.min(reportedRead, reportedInput)
  const cacheCreate = disjoint ? reportedCreate : Math.min(reportedCreate, reportedInput - cacheRead)
  return {
    providerId,
    modelId,
    input: disjoint ? reportedInput : reportedInput - cacheRead - cacheCreate,
    output: tokenCount(values.output),
    cacheRead,
    cacheCreate,
    runtimeEstimatedCostUsd: runtimeCost(values.runtimeEstimatedCostUsd),
    catalogInput: tokenCount(values.catalogInput),
    catalogOutput: tokenCount(values.catalogOutput),
    catalogCacheRead: tokenCount(values.catalogCacheRead),
    catalogCacheCreate: tokenCount(values.catalogCacheCreate),
    subagent,
  }
}

function persistedAggregate<T extends ChatModelUsage | ChatPerModelUsage>(usage: T): T {
  if (usage.runtimeEstimatedCostUsd != null) return usage
  const copy = { ...usage }
  delete copy.catalogInput
  delete copy.catalogOutput
  delete copy.catalogCacheRead
  delete copy.catalogCacheCreate
  return copy
}

/** Expands persisted envelope into provider+model slices without duplicating `sub*` totals. */
function usageSlices(usage: StoredChatUsage | ChatUsage, parent: ChatModelRef): UsageSlice[] {
  const disjoint = usage.usageVersion === 2
  const slices = [usageSlice(parent.providerId, parent.modelId, usage, false, disjoint)]
  const subTotal = usageSlice(
    parent.providerId,
    parent.modelId,
    {
      input: usage.subInput,
      output: usage.subOutput,
      cachedInput: usage.subCachedInput,
      cacheCreate: usage.subCacheCreate,
    },
    true,
    disjoint
  )
  const detailed = Array.isArray(usage.subagentUsage)
    ? usage.subagentUsage.filter(
        (u) => u && typeof u.providerId === 'string' && !!u.providerId && typeof u.modelId === 'string' && !!u.modelId
      )
    : []
  const detailedTotal = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  for (const u of detailed) {
    const slice = usageSlice(u.providerId, u.modelId, u, true, true)
    slices.push(slice)
    detailedTotal.input += slice.input
    detailedTotal.output += slice.output
    detailedTotal.cacheRead += slice.cacheRead
    detailedTotal.cacheCreate += slice.cacheCreate
  }

  // Detailed breakdown replaces its covered portion; any envelope residual stays on the parent model.
  // Preserves partial records without duplicating complete breakdowns or trusting smaller corrupt totals.
  const residual: UsageSlice = {
    ...subTotal,
    input: Math.max(0, subTotal.input - detailedTotal.input),
    output: Math.max(0, subTotal.output - detailedTotal.output),
    cacheRead: Math.max(0, subTotal.cacheRead - detailedTotal.cacheRead),
    cacheCreate: Math.max(0, subTotal.cacheCreate - detailedTotal.cacheCreate),
  }
  if (residual.input || residual.output || residual.cacheRead || residual.cacheCreate) slices.push(residual)
  return slices
}

function addHistoryUsage(byModel: Map<string, ChatPerModelUsage>, usage: StoredChatUsage, parent: ChatModelRef): void {
  for (const slice of usageSlices(usage, parent)) {
    const key = `${slice.providerId}\0${slice.modelId}`
    const agg =
      byModel.get(key) ??
      ({
        providerId: slice.providerId || null,
        modelId: slice.modelId || null,
        input: 0,
        output: 0,
        cachedInput: 0,
        cacheCreate: 0,
        subInput: 0,
        subOutput: 0,
        subCachedInput: 0,
        subCacheCreate: 0,
        catalogInput: 0,
        catalogOutput: 0,
        catalogCacheRead: 0,
        catalogCacheCreate: 0,
      } satisfies ChatPerModelUsage)
    if (slice.subagent) {
      agg.subInput += slice.input
      agg.subOutput += slice.output
      agg.subCachedInput += slice.cacheRead
      agg.subCacheCreate += slice.cacheCreate
    } else {
      agg.input += slice.input
      agg.output += slice.output
      agg.cachedInput += slice.cacheRead
      agg.cacheCreate += slice.cacheCreate
    }
    if (slice.runtimeEstimatedCostUsd != null) {
      agg.runtimeEstimatedCostUsd = (agg.runtimeEstimatedCostUsd ?? 0) + slice.runtimeEstimatedCostUsd
      agg.catalogInput = (agg.catalogInput ?? 0) + slice.catalogInput
      agg.catalogOutput = (agg.catalogOutput ?? 0) + slice.catalogOutput
      agg.catalogCacheRead = (agg.catalogCacheRead ?? 0) + slice.catalogCacheRead
      agg.catalogCacheCreate = (agg.catalogCacheCreate ?? 0) + slice.catalogCacheCreate
    } else {
      agg.catalogInput = (agg.catalogInput ?? 0) + slice.input
      agg.catalogOutput = (agg.catalogOutput ?? 0) + slice.output
      agg.catalogCacheRead = (agg.catalogCacheRead ?? 0) + slice.cacheRead
      agg.catalogCacheCreate = (agg.catalogCacheCreate ?? 0) + slice.cacheCreate
    }
    byModel.set(key, agg)
  }
}

function rowToMessage(r: any): StoredChatMessage {
  let meta: MetaJson = {}
  try {
    meta = r.meta_json ? JSON.parse(r.meta_json) : {}
  } catch {
    meta = {}
  }
  const executionScope = parseExecutionScope(meta.executionScope)
  const reviewLoop = reviewLoopMetaOf(executionScope)
  const memoryContext = parseMemoryContext(meta.memoryContext)
  const source =
    meta.source === 'chatgpt-web' || meta.source === 'chatgpt-web-review-loop' || meta.source === 'maestrly-review-loop'
      ? meta.source
      : undefined
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    parts: parseParts(r.parts_json ?? '[]'),
    model: meta.model,
    // Defensive: non-string or empty/corrupt value is absent (untrusted origin).
    ...(typeof meta.providerFingerprint === 'string' && meta.providerFingerprint.length > 0
      ? { providerFingerprint: meta.providerFingerprint }
      : {}),
    ...(source ? { source } : {}),
    finishReason: meta.finishReason,
    usage: parseStoredUsage(meta.usage),
    error: meta.error,
    errorCode: meta.errorCode,
    ...(typeof meta.responseDurationMs === 'number' ? { responseDurationMs: meta.responseDurationMs } : {}),
    ...(meta.internal ? { internal: true } : {}),
    ...(executionScope ? { executionScope } : {}),
    ...(reviewLoop ? { reviewLoop } : {}),
    ...(memoryContext ? { memoryContext } : {}),
    ...(meta.steering?.status === 'queued' || meta.steering?.status === 'failed'
      ? { steering: { status: meta.steering.status } }
      : {}),
    createdAt: r.created_at,
  }
}

function metaOf(m: StoredChatMessage): string {
  const meta: MetaJson = {}
  if (m.model) meta.model = m.model
  if (typeof m.providerFingerprint === 'string' && m.providerFingerprint.length > 0) {
    meta.providerFingerprint = m.providerFingerprint
  }
  if (m.source) meta.source = m.source
  if (m.finishReason) meta.finishReason = m.finishReason
  if (m.usage) meta.usage = m.usage
  if (m.error) meta.error = m.error
  if (m.errorCode) meta.errorCode = m.errorCode
  if (typeof m.responseDurationMs === 'number') meta.responseDurationMs = m.responseDurationMs
  if (m.internal) meta.internal = true
  if (m.executionScope) meta.executionScope = m.executionScope
  else if (m.reviewLoop) {
    meta.executionScope = {
      kind: 'review-loop',
      executionId: m.reviewLoop.executionId,
      loopId: m.reviewLoop.loopId,
      iteration: m.reviewLoop.iteration,
      maxIterations: m.reviewLoop.maxIterations,
      ...(m.reviewLoop.role ? { role: m.reviewLoop.role } : {}),
      ...(m.reviewLoop.executorConversationId ? { executorConversationId: m.reviewLoop.executorConversationId } : {}),
      ...(m.reviewLoop.reviewerConversationId ? { reviewerConversationId: m.reviewLoop.reviewerConversationId } : {}),
    }
  }
  if (m.steering?.status === 'queued' || m.steering?.status === 'failed') meta.steering = m.steering
  const memoryContext = parseMemoryContext(m.memoryContext)
  if (memoryContext) {
    // Sanitize at the write boundary too. TypeScript callers are not the only possible runtime source, and
    // retrieved content must never reach meta_json even if an untyped adapter adds extra source fields.
    meta.memoryContext = memoryContext
  }
  return JSON.stringify(meta)
}

/** Next monotonic conversation seq. */
function nextSeq(conversationId: string): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM chat_messages WHERE conversation_id = ?')
    .get(conversationId) as { n: number }
  return r.n
}

/**
 * Tool images are process-local. Keep this last line of defence at the SQL boundary so a future adapter cannot
 * accidentally put a data URL/base64 field into `parts_json`, even if it arrives through an untyped runtime.
 */
function persistedParts(parts: MessagePart[]): MessagePart[] {
  return parts.map((part) => {
    if (part.type !== 'tool') return part
    const state = part.state
    if (state.status === 'error') {
      const error = sanitizeToolOutputForPersistence(state.error)
      return {
        ...part,
        state: { ...state, error: clipPersistedToolOutput(typeof error === 'string' ? error : error.text) },
      }
    }
    if (state.status === 'denied') {
      if (!state.reason) return part
      const reason = sanitizeToolOutputForPersistence(state.reason)
      return {
        ...part,
        state: { ...state, reason: typeof reason === 'string' ? clipPersistedToolOutput(reason) : reason.text },
      }
    }
    if (state.status !== 'completed' && state.status !== 'running') return part
    const output = state.output
    if (output === undefined) return part
    const safeOutput = sanitizeToolOutputForPersistence(output)
    return {
      ...part,
      state: {
        ...state,
        output:
          typeof safeOutput === 'string'
            ? clipPersistedToolOutput(safeOutput)
            : { ...safeOutput, text: clipPersistedToolOutput(safeOutput.text) },
      },
    }
  })
}

function toolImageRefsFromParts(parts: MessagePart[]): Set<string> {
  const refs = new Set<string>()
  for (const part of parts) {
    if (part.type !== 'tool' || (part.state.status !== 'completed' && part.state.status !== 'running')) continue
    for (const image of toolOutputImages(part.state.output)) {
      if (typeof image.id === 'string') refs.add(image.id)
    }
  }
  return refs
}

function toolImageRefsFromRows(rows: Array<{ parts_json: string | null }>): Set<string> {
  const refs = new Set<string>()
  for (const row of rows) {
    for (const ref of toolImageRefsFromParts(parseParts(row.parts_json ?? '[]'))) refs.add(ref)
  }
  return refs
}

function toolImageRefsFromJson(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) toolImageRefsFromJson(entry, refs)
    return refs
  }
  if (!value || typeof value !== 'object') return refs
  const candidate = value as Record<string, unknown>
  if (Array.isArray(candidate.images)) {
    for (const image of candidate.images) {
      if (
        image &&
        typeof image === 'object' &&
        typeof (image as { id?: unknown }).id === 'string' &&
        (image as { id: string }).id.startsWith('tool-image:')
      ) {
        refs.add((image as { id: string }).id)
      }
    }
  }
  for (const entry of Object.values(candidate)) toolImageRefsFromJson(entry, refs)
  return refs
}

function toolImageRefsFromJsonText(value: string | null): Set<string> {
  if (!value) return new Set<string>()
  try {
    return toolImageRefsFromJson(JSON.parse(value))
  } catch {
    return new Set<string>()
  }
}

function jsonTextContainsToolImage(value: string | null, imageId: string): boolean {
  return !!value && toolImageRefsFromJsonText(value).has(imageId)
}

function inferenceStateContainsToolImage(value: string | null, toolPartId: string, imageId: string): boolean {
  if (!value) return false
  try {
    const parsed = JSON.parse(value) as { ledger?: { entries?: unknown } }
    if (!Array.isArray(parsed?.ledger?.entries)) return false
    return parsed.ledger.entries.some((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const candidate = entry as { type?: unknown; toolCallId?: unknown; output?: unknown }
      return (
        candidate.type === 'tool-result' &&
        candidate.toolCallId === toolPartId &&
        toolImageRefsFromJson(candidate.output).has(imageId)
      )
    })
  } catch {
    return false
  }
}

function mergeToolImageRefs(target: Set<string>, source: ReadonlySet<string>): void {
  for (const ref of source) target.add(ref)
}

function toolImageRefsFromMessageSidecars(messageIds: readonly string[]): Set<string> {
  const refs = new Set<string>()
  const db = getDb()
  for (let offset = 0; offset < messageIds.length; offset += 500) {
    const chunk = messageIds.slice(offset, offset + 500)
    const placeholders = chunk.map(() => '?').join(', ')
    const toolRows = db
      .prepare(`SELECT output_json FROM chat_tool_executions WHERE message_id IN (${placeholders})`)
      .all(...chunk) as Array<{ output_json: string | null }>
    for (const row of toolRows) mergeToolImageRefs(refs, toolImageRefsFromJsonText(row.output_json))
    const inferenceRows = db
      .prepare(`SELECT state_json FROM chat_inference_state WHERE message_id IN (${placeholders})`)
      .all(...chunk) as Array<{ state_json: string | null }>
    for (const row of inferenceRows) mergeToolImageRefs(refs, toolImageRefsFromJsonText(row.state_json))
  }
  return refs
}

function toolImageRefsFromMessageRows(rows: Array<{ id: string; parts_json: string | null }>): Set<string> {
  const refs = toolImageRefsFromRows(rows)
  mergeToolImageRefs(refs, toolImageRefsFromMessageSidecars(rows.map((row) => row.id)))
  return refs
}

function persistedToolImageRefs(): Set<string> {
  const rows = getDb().prepare('SELECT id, parts_json FROM chat_messages').all() as Array<{
    id: string
    parts_json: string | null
  }>
  return toolImageRefsFromMessageRows(rows)
}

function releaseRemovedToolImageRefs(refs: ReadonlySet<string>): void {
  if (refs.size === 0) return
  releaseUnreferencedEphemeralToolImages(refs, persistedToolImageRefs())
}

/**
 * Verifies that a tool-image handle is owned by the exact message/tool part requested at the IPC boundary.
 * Message parts are the normal source; provider-native OpenAI checkpoints are accepted only when their sidecar
 * row is tied to the same message and tool call. The lookup deliberately returns a boolean so no persisted
 * output metadata crosses into the renderer.
 */
export function hasChatToolImageOwner(
  conversationId: string,
  messageId: string,
  toolPartId: string,
  imageId: string
): boolean {
  if (!conversationId || !messageId || !toolPartId || !imageId) return false
  const db = getDb()
  const message = db
    .prepare('SELECT parts_json FROM chat_messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId) as { parts_json?: string | null } | undefined
  if (!message) return false

  const part = parseParts(message.parts_json ?? '[]').find(
    (candidate): candidate is Extract<MessagePart, { type: 'tool' }> =>
      candidate.type === 'tool' && (candidate.id === toolPartId || candidate.toolCallId === toolPartId)
  )
  if (
    part &&
    (part.state.status === 'running' || part.state.status === 'completed') &&
    toolOutputImages(part.state.output).some((image) => image.id === imageId)
  ) {
    return true
  }

  // OpenAI's native execution checkpoint can be newer than, or intentionally separate from, the visual part.
  // Bind the sidecar lookup to both the message and call id; never accept an image found anywhere in the DB.
  const execution = db
    .prepare(
      `SELECT status, output_json
       FROM chat_tool_executions
       WHERE conversation_id = ? AND message_id = ? AND call_id = ?`
    )
    .get(conversationId, messageId, toolPartId) as { status?: unknown; output_json?: string | null } | undefined
  if (
    execution &&
    (execution.status === 'running' || execution.status === 'completed') &&
    jsonTextContainsToolImage(execution.output_json ?? null, imageId)
  ) {
    return true
  }

  const inference = db.prepare('SELECT state_json FROM chat_inference_state WHERE message_id = ?').get(messageId) as
    | { state_json?: string | null }
    | undefined
  return inferenceStateContainsToolImage(inference?.state_json ?? null, toolPartId, imageId)
}

/**
 * Inserts OR updates a message (idempotent by ID). First write allocates `seq`; updates
 * preserve existing `seq` (replace only parts/meta), allowing assistant persistence at every streaming
 * checkpoint without reordering history.
 */
export function upsertChatMessage(m: StoredChatMessage): void {
  const existing = getDb().prepare('SELECT seq FROM chat_messages WHERE id = ?').get(m.id) as
    | { seq: number }
    | undefined
  const seq = existing ? existing.seq : nextSeq(m.conversationId)
  getDb()
    .prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
       VALUES (@id, @conversationId, @role, @parts, @meta, @seq, @createdAt)
       ON CONFLICT(id) DO UPDATE SET parts_json = excluded.parts_json, meta_json = excluded.meta_json`
    )
    .run({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      parts: JSON.stringify(persistedParts(m.parts)),
      meta: metaOf(m),
      seq,
      createdAt: m.createdAt,
    })
}

/** Reads ONE message by ID + conversation; null if absent (clear/delete/truncate). */
export function getChatMessage(conversationId: string, messageId: string): StoredChatMessage | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId) as any
  return row ? (rowToMessage(row) as StoredChatMessage) : null
}

/**
 * UPDATE-only parts for an EXISTING message: never inserts. Used by post-turn enrichment
 * (background image descriptions) — if row disappeared (clear/delete/truncate) or belongs elsewhere,
 * do nothing and return false instead of resurrecting the bubble.
 */
export function updateChatMessageParts(conversationId: string, messageId: string, parts: MessagePart[]): boolean {
  const result = getDb()
    .prepare('UPDATE chat_messages SET parts_json = ? WHERE id = ? AND conversation_id = ?')
    .run(JSON.stringify(persistedParts(parts)), messageId, conversationId)
  return result.changes > 0
}

/** Conversation messages in seq ASC order. INTERNAL to main (StoredChatMessage) — project for IPC. */
export function listChatMessages(conversationId: string): StoredChatMessage[] {
  return (
    getDb()
      .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as any[]
  ).map(rowToMessage)
}

/**
 * SQL predicate: MAIN-context message (legacy without executionScope OR kind=conversation).
 * Excludes isolated review-loop messages. NULL/invalid meta_json DEGRADES to legacy main-context — store
 * parses corruption defensively, so SQL predicates must not throw `malformed JSON`.
 */
const CONVERSATION_CONTEXT_SQL = `(json_valid(meta_json) <> 1
  OR json_extract(meta_json, '$.executionScope.kind') IS NULL
  OR json_extract(meta_json, '$.executionScope.kind') = 'conversation')`

/**
 * Hidden orchestration messages are never part of the remote companion's visible conversation.
 *
 * Unlike the local runner predicate, malformed non-empty metadata fails closed here: it cannot prove that
 * a row is a legacy/main-context message without risking that an internal or isolated message is exposed.
 * SQL NULL and empty metadata remain the explicitly supported legacy representation.
 */
const COMPANION_VISIBLE_MESSAGE_SQL = `(
  meta_json IS NULL
  OR trim(meta_json) = ''
  OR (
    json_valid(meta_json) = 1
    AND (
      json_extract(meta_json, '$.executionScope.kind') IS NULL
      OR json_extract(meta_json, '$.executionScope.kind') = 'conversation'
    )
    AND COALESCE(json_extract(meta_json, '$.internal'), 0) <> 1
  )
)`

/**
 * SQL predicate: ISOLATED execution message (review-loop). Invalid meta_json NEVER matches —
 * `json_valid` prevents json_extract `malformed JSON` and avoids classifying corruption as a round.
 */
const EXECUTION_SCOPE_REVIEW_LOOP_SQL = `json_valid(meta_json) = 1
  AND json_extract(meta_json, '$.executionScope.kind') = 'review-loop'`

/**
 * Reusable main-context transcript (manual turns + legacy).
 * Excludes isolated review-loop execution messages.
 */
export function listConversationContextMessages(conversationId: string): StoredChatMessage[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM chat_messages
         WHERE conversation_id = ? AND ${CONVERSATION_CONTEXT_SQL}
         ORDER BY seq ASC`
      )
      .all(conversationId) as any[]
  ).map(rowToMessage)
}

/**
 * Conversation-scoped source rows for the remote companion projection. The caller must still sanitize parts.
 * Keeping seq alongside the parsed message avoids exposing generic transcript APIs to the bridge layer.
 */
export function listCompanionConversationMessages(conversationId: string): CompanionConversationMessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ? AND ${COMPANION_VISIBLE_MESSAGE_SQL}
       ORDER BY seq ASC`
    )
    .all(conversationId) as any[]
  return rows.map((row) => ({ seq: row.seq as number, message: rowToMessage(row) }))
}

/**
 * Search source rows in recent-first order; only the dedicated safe projection is allowed to decide whether
 * text matches. The bounded caller can therefore prioritize the latest decision when older messages overflow it.
 */
export function listCompanionConversationSearchCandidates(conversationId: string): CompanionConversationMessageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ?
         AND ${COMPANION_VISIBLE_MESSAGE_SQL}
       ORDER BY seq DESC`
    )
    .all(conversationId) as any[]
  return rows.map((row) => ({ seq: row.seq as number, message: rowToMessage(row) }))
}

/** Balanced, context-scoped window around an exact visible seq. A foreign execution seq returns null. */
export function readCompanionConversationPage(
  conversationId: string,
  aroundSeq: number,
  limit: number,
  isProjectable: (row: CompanionConversationMessageRow) => boolean = () => true
): CompanionConversationMessagePage | null {
  const db = getDb()
  const anchorRecord = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ? AND seq = ? AND ${COMPANION_VISIBLE_MESSAGE_SQL}
       LIMIT 1`
    )
    .get(conversationId, aroundSeq)
  if (!anchorRecord) return null

  const toRow = (row: any): CompanionConversationMessageRow => ({
    seq: row.seq as number,
    message: rowToMessage(row),
  })
  const anchor = toRow(anchorRecord)
  if (!isProjectable(anchor)) return null

  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 20))
  const beforeLimit = Math.floor(boundedLimit / 2)
  const collectProjectable = (direction: 'before' | 'after', target: number): CompanionConversationMessageRow[] => {
    const projectable: CompanionConversationMessageRow[] = []
    let cursor = aroundSeq
    let firstQuery = true
    const batchSize = Math.max(32, target)
    while (projectable.length < target) {
      const comparison = direction === 'before' ? '<' : firstQuery ? '>=' : '>'
      const order = direction === 'before' ? 'DESC' : 'ASC'
      const candidates = db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE conversation_id = ? AND seq ${comparison} ? AND ${COMPANION_VISIBLE_MESSAGE_SQL}
           ORDER BY seq ${order} LIMIT ?`
        )
        .all(conversationId, cursor, batchSize) as any[]
      if (candidates.length === 0) break
      for (const candidate of candidates) {
        const row = toRow(candidate)
        if (isProjectable(row)) projectable.push(row)
        if (projectable.length >= target) break
      }
      if (candidates.length < batchSize || projectable.length >= target) break
      cursor = candidates.at(-1).seq as number
      firstQuery = false
    }
    return projectable
  }

  // Fetch one extra projected row on each side as the continuation sentinel. The SQL predicate alone is
  // message-level; the callback is what makes the limit and flags describe the safe remote projection.
  const projectableBefore = collectProjectable('before', beforeLimit + 1)
  const before = projectableBefore.slice(0, beforeLimit).reverse()
  const projectableFromTarget = collectProjectable('after', boundedLimit - before.length + 1)
  const fromTarget = projectableFromTarget.slice(0, boundedLimit - before.length)
  const rows = [...before, ...fromTarget]
  const hasMoreBefore = projectableBefore.length > before.length
  const hasMoreAfter = projectableFromTarget.length > fromTarget.length
  return {
    messages: rows,
    hasMoreBefore,
    hasMoreAfter,
  }
}

/**
 * Transcript of ONE isolated review-loop execution. Only that iteration's messages.
 */
export function listExecutionContextMessages(conversationId: string, executionId: string): StoredChatMessage[] {
  if (!executionId) return []
  return (
    getDb()
      .prepare(
        `SELECT * FROM chat_messages
         WHERE conversation_id = ?
           AND ${EXECUTION_SCOPE_REVIEW_LOOP_SQL}
           AND json_extract(meta_json, '$.executionScope.executionId') = ?
         ORDER BY seq ASC`
      )
      .all(conversationId, executionId) as any[]
  ).map(rowToMessage)
}

/**
 * SINGLE source of model-bound turn context (ALL runners, BYOK and native): isolated
 * review-loop → only that execution's messages; normal/main turn → main context
 * (legacy + kind=conversation, WITHOUT isolated rounds). UI/audit/billing still use
 * `listChatMessages` — nothing here changes renderer visibility or billing.
 */
export function runnerContextHistory(
  conversationId: string,
  opts: { ephemeralSession?: boolean; executionScope?: ChatExecutionScope } = {}
): StoredChatMessage[] {
  if (opts.ephemeralSession && opts.executionScope?.kind === 'review-loop') {
    return listExecutionContextMessages(conversationId, opts.executionScope.executionId)
  }
  return listConversationContextMessages(conversationId)
}

/** Last main-context message (bindings/resume use this, NOT the full transcript). */
export function lastConversationContextMessage(conversationId: string): StoredChatMessage | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ? AND ${CONVERSATION_CONTEXT_SQL}
       ORDER BY seq DESC LIMIT 1`
    )
    .get(conversationId) as any
  return row ? rowToMessage(row) : undefined
}

/** Assistant message of an isolated execution (if present). */
export function getExecutionAssistantMessage(
  conversationId: string,
  executionId: string
): StoredChatMessage | undefined {
  if (!executionId) return undefined
  const row = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ?
         AND role = 'assistant'
         AND ${EXECUTION_SCOPE_REVIEW_LOOP_SQL}
         AND json_extract(meta_json, '$.executionScope.executionId') = ?
       ORDER BY seq DESC LIMIT 1`
    )
    .get(conversationId, executionId) as any
  return row ? rowToMessage(row) : undefined
}

/**
 * Interrupted isolated executions (assistant without terminal outcome). Used at boot to mark
 * interrupted/process failure without fabricating success.
 */
export function listInterruptedExecutionAssistantMessages(conversationId?: string): StoredChatMessage[] {
  const params: string[] = []
  const convFilter = conversationId ? 'AND conversation_id = ?' : ''
  if (conversationId) params.push(conversationId)
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE role = 'assistant'
         AND ${EXECUTION_SCOPE_REVIEW_LOOP_SQL}
         AND (json_extract(meta_json, '$.finishReason') IS NULL OR json_extract(meta_json, '$.finishReason') = '')
         AND (json_extract(meta_json, '$.error') IS NULL OR json_extract(meta_json, '$.error') = '')
         ${convFilter}
       ORDER BY seq ASC`
    )
    .all(...params) as any[]
  return rows.map(rowToMessage)
}

/**
 * Boot/crash recovery: marks nonterminal isolated-execution assistants interrupted.
 * Preserves durable usage; NEVER fabricates success or touches main bindings. Raw `error` is audit-only —
 * renderer translates PUBLIC `errorCode` (never exposes internal codes to users).
 */
export function reconcileInterruptedExecutionMessages(conversationId?: string): number {
  const pending = listInterruptedExecutionAssistantMessages(conversationId)
  for (const message of pending) {
    upsertChatMessage({
      ...message,
      finishReason: message.finishReason || 'interrupted',
      error: message.error || 'process-interrupted',
      errorCode: message.errorCode || 'review-loop-process-interrupted',
    })
  }
  return pending.length
}

/**
 * UI message page (#559, RENDER-ONLY). Returns LAST `limit` messages (or those before
 * `beforeSeq`) in ASC order using `(conversation_id, seq)` index. Does NOT replace `listChatMessages`
 * (still supplies model context/export) — a separate NEW function.
 */
export function listChatMessagesPage(
  conversationId: string,
  opts: { beforeSeq?: number; aroundSeq?: number; limit?: number } = {}
): StoredChatHistoryPage {
  const rawLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 100
  const limit = Math.max(1, Math.min(rawLimit, 1000))
  const beforeSeq =
    typeof opts.beforeSeq === 'number' && Number.isFinite(opts.beforeSeq) ? Math.floor(opts.beforeSeq) : undefined
  const aroundSeq =
    typeof opts.aroundSeq === 'number' && Number.isFinite(opts.aroundSeq) ? Math.floor(opts.aroundSeq) : undefined
  const db = getDb()
  let rows: any[]
  if (typeof aroundSeq === 'number') {
    // ANCHORED WINDOW (search, #559): half BEFORE + half FROM target seq → center the match
    // with context on both sides, WITHOUT paging 50 times from the end (duplicated pages + DOM growth).
    const half = Math.floor(limit / 2)
    const before = db
      .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(conversationId, aroundSeq, half) as any[]
    before.reverse() // ASC
    const fromTarget = db
      .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?')
      .all(conversationId, aroundSeq, limit - before.length) as any[]
    rows = [...before, ...fromTarget]
  } else {
    // seq DESC + LIMIT selects most RECENT (or before cursor); reorder ASC on return.
    rows = (
      typeof beforeSeq === 'number'
        ? db
            .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
            .all(conversationId, beforeSeq, limit)
        : db
            .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
            .all(conversationId, limit)
    ) as any[]
    rows.reverse() // DESC → ASC (display order).
  }
  const earliestSeq = rows.length ? (rows[0].seq as number) : null
  const latestSeq = rows.length ? (rows[rows.length - 1].seq as number) : null
  // Older available? Any message with seq below this page's minimum.
  let hasMore = false
  if (earliestSeq != null) {
    hasMore = !!db
      .prepare('SELECT 1 FROM chat_messages WHERE conversation_id = ? AND seq < ? LIMIT 1')
      .get(conversationId, earliestSeq)
  }
  // Newer available? Any seq above page maximum (relevant for middle-anchored windows).
  let hasMoreAfter = false
  if (latestSeq != null) {
    hasMoreAfter = !!db
      .prepare('SELECT 1 FROM chat_messages WHERE conversation_id = ? AND seq > ? LIMIT 1')
      .get(conversationId, latestSeq)
  }
  return { messages: rows.map(rowToMessage), hasMore, earliestSeq, latestSeq, hasMoreAfter }
}

// ----------------------------------------------------------------------------
// Public boundary (IPC → renderer): strips providerFingerprint + usage.contextIdentity.
// ----------------------------------------------------------------------------

/** Removes `contextIdentity` from usage. Pure: does not mutate input. */
export function toPublicChatUsage(usage: StoredChatUsage | undefined): ChatUsage | undefined {
  if (!usage) return undefined
  const { contextIdentity: _private, ...publicUsage } = usage
  return publicUsage
}

/** Removes fingerprint + contextIdentity from message. Pure: does not mutate input. */
export function toPublicChatMessage(message: StoredChatMessage): ChatMessage {
  const { providerFingerprint: _fp, usage, ...rest } = message
  return {
    ...rest,
    ...(usage ? { usage: toPublicChatUsage(usage) } : {}),
  }
}

/** Projects an internal list — the only way to send messages to renderer without leaking identity. */
export const toPublicChatMessages = (messages: readonly StoredChatMessage[]): ChatMessage[] =>
  messages.map(toPublicChatMessage)

/**
 * History page ALREADY PROJECTED for renderer (only legitimate caller: `chat:history:page` handler).
 * Deliberately explicit name: internal `listChatMessagesPage` must not reach IPC without passing
 * here (projection cannot be forgotten).
 */
export function listPublicChatMessagesPage(
  conversationId: string,
  opts: { beforeSeq?: number; aroundSeq?: number; limit?: number } = {}
): ChatHistoryPage {
  const page = listChatMessagesPage(conversationId, opts)
  return { ...page, messages: toPublicChatMessages(page.messages) }
}

/** Removes `contextIdentity` from stats `lastUsage`. Pure: does not mutate input. */
export function toPublicChatHistoryStats(stats: StoredChatHistoryStats): ChatHistoryStats {
  return {
    ...stats,
    lastUsage: stats.lastUsage ? (toPublicChatUsage(stats.lastUsage) ?? null) : null,
  }
}

/**
 * Chat search (Cmd/Ctrl+F, #559). Scans ENTIRE conversation (not only renderer's paginated window):
 * prefilter with `parts_json LIKE` (fast; skips JSON.parse for nonmatches), then extract only
 * renderable TEXT from VISIBLE candidate parts (text/reasoning/compaction/context) to confirm match and build snippet —
 * avoids structural matches (IDs, image base64, tool JSON) and hidden internal instructions.
 * Returns `seq ASC` order.
 */
export function searchChatMessages(conversationId: string, query: string, limit = 500): ChatSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  // LIKE escapes %/_/\ to treat the term literally; prefilter before JSON.parse.
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  const rows = getDb()
    .prepare(
      `SELECT id, parts_json, meta_json, seq FROM chat_messages
       WHERE conversation_id = ? AND LOWER(parts_json) LIKE ? ESCAPE '\\'
       ORDER BY seq ASC`
    )
    .all(conversationId, like) as Array<{
    id: string
    parts_json: string | null
    meta_json: string | null
    seq: number
  }>
  const hits: ChatSearchHit[] = []
  for (const r of rows) {
    try {
      if (r.meta_json && JSON.parse(r.meta_json).internal) continue
    } catch {
      // Invalid legacy metadata must not make previously visible messages unsearchable.
    }
    const text = textOfParts(r.parts_json ?? '[]')
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) continue // Matched raw JSON (ID/base64/tool), not visible text → ignore.
    const start = Math.max(0, idx - 40)
    const end = Math.min(text.length, idx + q.length + 40)
    const snippet =
      (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
    hits.push({ messageId: r.id, seq: r.seq, snippet })
    if (hits.length >= limit) break
  }
  return hits
}

/** Concatenates only visible part TEXT (ignores IDs, tool I/O, image base64) for search/snippets. */
function textOfParts(partsJson: string): string {
  let parts: MessagePart[]
  try {
    parts = parseParts(partsJson)
  } catch {
    return ''
  }
  const out: string[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.checkpoint !== 'openai-native') out.push(p.text)
    } else if (p.type === 'reasoning' || p.type === 'compaction' || p.type === 'context') out.push(p.text)
    else if (p.type === 'file') out.push(p.name)
    // Generated image: name + revised prompt are visible card text (artifact itself is not searchable).
    else if (p.type === 'generated-image') out.push([p.name, p.revisedPrompt ?? ''].join(' ').trim())
    // Search finds invocation by what users SAW (chip), not skill body.
    else if (p.type === 'skill-invocation') out.push(`/${p.name}${p.args ? ` ${p.args}` : ''}`)
  }
  return out.join('\n')
}

/**
 * FULL history summary for context/cost meter (#559). Reads only `meta_json` (no
 * `parts_json`), cheap even in huge conversations. Aggregates usage by provider+model — linear cost means
 * sum tokens per pair and price once == price each turn and sum.
 */
export function chatHistoryStats(
  conversationId: string,
  opts: { isNativeCompactionActive?: (messageId: string) => boolean } = {}
): StoredChatHistoryStats {
  // is_comp via raw JSON LIKE (cheap — does NOT parse parts_json, potentially MBs of tool output).
  // Patterns occur only as part keys (user-quoted text is ESCAPED \" by JSON.stringify
  // and cannot match). New native checkpoint deliberately uses `text`: older versions preserve it without treating
  // it as a compaction boundary.
  // is_main_ctx: legacy without executionScope OR kind=conversation — only these affect lastUsage/compaction.
  // Billing (perModel) aggregates ALL messages (main + isolated review).
  const rows = getDb()
    .prepare(
      `SELECT id, seq, meta_json,
              CASE WHEN parts_json LIKE '%"type":"compaction"%'
                     OR parts_json LIKE '%"checkpoint":"openai-native"%' THEN 1 ELSE 0 END AS is_comp,
              CASE WHEN parts_json LIKE '%"strategy":"openai-native"%'
                     OR parts_json LIKE '%"strategy":"claude-native"%'
                     OR parts_json LIKE '%"checkpoint":"openai-native"%' THEN 1 ELSE 0 END AS is_native_comp,
              CASE WHEN json_valid(meta_json) <> 1
                     OR json_extract(meta_json, '$.executionScope.kind') IS NULL
                     OR json_extract(meta_json, '$.executionScope.kind') = 'conversation' THEN 1 ELSE 0 END AS is_main_ctx
       FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC`
    )
    .all(conversationId) as Array<{
    id: string
    seq: number
    meta_json: string | null
    is_comp: number
    is_native_comp: number
    is_main_ctx: number
  }>
  const byModel = new Map<string, ChatPerModelUsage>()
  let lastUsage: StoredChatUsage | null = null
  let lastModel: ChatModelRef | null = null
  let lastUsageSeq = -1
  let compSeq = -1 // LAST compaction milestone seq (main context only).
  let compSummaryTokens = 0 // Compaction-call output ≈ summary tokens.
  let compContextWindow = 0
  for (const r of rows) {
    let meta: MetaJson = {}
    try {
      meta = r.meta_json ? JSON.parse(r.meta_json) : {}
    } catch {
      meta = {}
    }
    const isMainCtx = r.is_main_ctx === 1
    // Provider-bound native markers reduce the window only after caller confirms sidecar against current
    // identity. Conservative default prevents stats/auto-compact underestimating context after account/model changes.
    // Isolated-round compaction does NOT affect main-context occupancy.
    const effectiveCompaction =
      isMainCtx && r.is_comp && (!r.is_native_comp || opts.isNativeCompactionActive?.(r.id) === true)
    if (effectiveCompaction) {
      compSeq = r.seq
      compSummaryTokens = meta.usage?.contextInput ?? meta.usage?.output ?? 0
      compContextWindow = meta.usage?.modelContextWindow ?? 0
    }
    const u = parseStoredUsage(meta.usage)
    if (!u) continue
    // lastUsage / context meter: MAIN context only (isolated rounds do not contaminate percentages).
    if (isMainCtx && !u.billingOnly) {
      lastUsage = u // Helper calls do not replace the latest actual context measurement.
      lastModel = meta.model ?? null
      lastUsageSeq = r.seq
    }
    // Billing: main + isolated review (each round counts as a real turn).
    addHistoryUsage(byModel, u, meta.model ?? { providerId: '', modelId: '' })
  }

  // Host-managed transcript anchors are intentionally deleted after execution. Their ledger rows retain the
  // conversation key (without an FK), so billing remains visible in this conversation's historical cost summary.
  const orphanLedgerRows = getDb()
    .prepare(
      `SELECT l.provider_id, l.model_id, l.usage_json
       FROM chat_usage_ledger l
       LEFT JOIN chat_messages m ON m.id = l.message_id
       WHERE l.conversation_id = ? AND m.id IS NULL`
    )
    .all(conversationId) as Array<{ provider_id: string; model_id: string; usage_json: string }>
  for (const row of orphanLedgerRows) {
    let rawUsage: unknown
    try {
      rawUsage = JSON.parse(row.usage_json)
    } catch {
      continue
    }
    const usage = parseStoredUsage(rawUsage)
    if (usage) addHistoryUsage(byModel, usage, { providerId: row.provider_id, modelId: row.model_id })
  }
  // Compaction is the NEWEST milestone (no real turn afterward): meter must reflect post-compaction context
  // IMMEDIATELY — otherwise it stayed at "100%" until the next turn, making compaction appear ineffective.
  // Estimate: SUMMARY tokens (compaction-call output ≈ next-turn summary input;
  // remaining history ends at the milestone). Without usage → ~4 text chars/token.
  if (compSeq > lastUsageSeq) {
    let est = compSummaryTokens
    if (!est) {
      try {
        const row = getDb()
          .prepare('SELECT parts_json FROM chat_messages WHERE conversation_id = ? AND seq = ?')
          .get(conversationId, compSeq) as { parts_json?: string } | undefined
        const parts = row?.parts_json ? (JSON.parse(row.parts_json) as Array<{ type?: string; text?: string }>) : []
        est = Math.ceil((parts.find((p) => p?.type === 'compaction')?.text?.length ?? 0) / 4)
      } catch {
        est = 0
      }
    }
    lastUsage = {
      usageVersion: 2,
      input: 0,
      output: 0,
      contextInput: est,
      contextOutput: 0,
      ...(compContextWindow ? { modelContextWindow: compContextWindow } : {}),
    }
    lastModel = null
  }
  return {
    lastUsage,
    ...(lastModel ? { lastModel } : {}),
    perModel: [...byModel.values()].map(persistedAggregate),
    modelIds: [...new Set([...byModel.values()].map((u) => u.modelId).filter((id): id is string => !!id))],
    bytesSaved: getChatBytesSaved(conversationId),
  }
}

// ---- Bash tool output-filter savings (bash-filters.ts). ----

/**
 * Ensures `chat_savings` exists at runtime (idempotent). `initStore` creates it at boot; this guards
 * existing DBs whose main process booted BEFORE this feature's schema (hot reload does not rerun
 * initStore) — otherwise first write fails "no such table" and counting never starts.
 */
function ensureSavingsTable(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS chat_savings (
       conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
       bytes_saved     INTEGER NOT NULL DEFAULT 0
     )`
  )
}

/** Accumulates conversation filter bytes saved (upsert +=). Caller handles best-effort. */
export function addChatBytesSaved(conversationId: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  ensureSavingsTable()
  getDb()
    .prepare(
      `INSERT INTO chat_savings (conversation_id, bytes_saved) VALUES (?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET bytes_saved = bytes_saved + excluded.bytes_saved`
    )
    .run(conversationId, Math.round(bytes))
}

/** Total conversation bytes saved (0 if never filtered). */
export function getChatBytesSaved(conversationId: string): number {
  try {
    const r = getDb().prepare('SELECT bytes_saved FROM chat_savings WHERE conversation_id = ?').get(conversationId) as
      | { bytes_saved?: number }
      | undefined
    return r?.bytes_saved ?? 0
  } catch {
    return 0 // Table absent (old DB predating feature boot) → no recorded savings.
  }
}

/**
 * Records a billable turn owned by a host surface without Conversation/Workspace.
 * Ledger deliberately lacks FK to outlive transcripts; the same boundary avoids
 * inventing an invisible conversation merely to account for Maestro Configurator.
 */
export function recordStandaloneChatUsage(args: {
  id: string
  model: ChatModelRef
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheCreate: number
  }
  runtimeEstimatedCostUsd?: number
  createdAt?: number
}): void {
  const count = (value: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const runtimeEstimatedCostUsd =
    typeof args.runtimeEstimatedCostUsd === 'number' &&
    Number.isFinite(args.runtimeEstimatedCostUsd) &&
    args.runtimeEstimatedCostUsd >= 0
      ? args.runtimeEstimatedCostUsd
      : undefined
  const usage: ChatUsage = {
    usageVersion: 2,
    input: count(args.usage.input),
    output: count(args.usage.output),
    cachedInput: count(args.usage.cacheRead),
    cacheCreate: count(args.usage.cacheCreate),
    ...(runtimeEstimatedCostUsd !== undefined ? { runtimeEstimatedCostUsd } : {}),
  }
  getDb()
    .prepare(
      `INSERT INTO chat_usage_ledger
         (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         model_id = excluded.model_id,
         usage_json = excluded.usage_json,
         created_at = excluded.created_at`
    )
    .run(args.id, args.model.providerId, args.model.modelId, JSON.stringify(usage), args.createdAt ?? Date.now())
}

/**
 * GLOBAL chat usage (all conversations) aggregated by provider+model. Subagents use effective models
 * with v2 breakdowns; legacy records stay on parent model. On demand (full ledger
 * scan); renderer calculates cost (requires models.dev per-model prices).
 */
export function aggregateChatUsage(opts: { since?: number; until?: number } = {}): ChatUsageStats {
  const where: string[] = []
  const params: number[] = []
  if (typeof opts.since === 'number') {
    where.push('created_at >= ?')
    params.push(opts.since)
  }
  if (typeof opts.until === 'number') {
    where.push('created_at <= ?')
    params.push(opts.until)
  }
  const rows = getDb()
    .prepare(
      `SELECT provider_id, model_id, usage_json, created_at
       FROM chat_usage_ledger${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
    )
    .all(...params) as Array<{
    provider_id: string
    model_id: string
    usage_json: string
    created_at: number
  }>
  const byModel = new Map<string, ChatModelUsage>()
  let totalTurns = 0
  let firstAt: number | null = null
  let lastAt: number | null = null
  for (const r of rows) {
    let rawUsage: unknown
    try {
      rawUsage = JSON.parse(r.usage_json)
    } catch {
      continue
    }
    const u = parseStoredUsage(rawUsage)
    if (!u) continue
    const parent = { providerId: r.provider_id, modelId: r.model_id }
    const slices = usageSlices(u, parent).filter((slice) => !!slice.modelId)
    if (slices.length === 0) continue
    if (parent.modelId && !u.billingOnly) totalTurns++
    const at = r.created_at
    firstAt = firstAt == null ? at : Math.min(firstAt, at)
    lastAt = lastAt == null ? at : Math.max(lastAt, at)
    for (const slice of slices) {
      const key = `${slice.providerId}\0${slice.modelId}`
      const agg =
        byModel.get(key) ??
        ({
          providerId: slice.providerId,
          modelId: slice.modelId,
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          catalogInput: 0,
          catalogOutput: 0,
          catalogCacheRead: 0,
          catalogCacheCreate: 0,
          firstAt: at,
          lastAt: at,
        } satisfies ChatModelUsage)
      // Turn belongs to main model; subagents contribute usage/cost, not extra interactions.
      if (!slice.subagent && !u.billingOnly) agg.turns++
      agg.input += slice.input
      agg.output += slice.output
      agg.cacheRead += slice.cacheRead
      agg.cacheCreate += slice.cacheCreate
      if (slice.runtimeEstimatedCostUsd != null) {
        agg.runtimeEstimatedCostUsd = (agg.runtimeEstimatedCostUsd ?? 0) + slice.runtimeEstimatedCostUsd
        agg.catalogInput = (agg.catalogInput ?? 0) + slice.catalogInput
        agg.catalogOutput = (agg.catalogOutput ?? 0) + slice.catalogOutput
        agg.catalogCacheRead = (agg.catalogCacheRead ?? 0) + slice.catalogCacheRead
        agg.catalogCacheCreate = (agg.catalogCacheCreate ?? 0) + slice.catalogCacheCreate
      } else {
        agg.catalogInput = (agg.catalogInput ?? 0) + slice.input
        agg.catalogOutput = (agg.catalogOutput ?? 0) + slice.output
        agg.catalogCacheRead = (agg.catalogCacheRead ?? 0) + slice.cacheRead
        agg.catalogCacheCreate = (agg.catalogCacheCreate ?? 0) + slice.cacheCreate
      }
      agg.firstAt = Math.min(agg.firstAt, at)
      agg.lastAt = Math.max(agg.lastAt, at)
      byModel.set(key, agg)
    }
  }
  const perModel = [...byModel.values()].map(persistedAggregate).sort((a, b) => totalTokensOf(b) - totalTokensOf(a))
  return { perModel, totalTurns, firstAt, lastAt }
}

/** Artifacts and ephemeral tool-image refs owned by rows that are about to be removed. */
interface ChatDeletionArtifacts {
  conversationId: string
  generatedImageIds: string[]
  attachmentImageIds: string[]
  toolImageRefs: Set<string>
  /** File-part attachment IDs from removed rows — clears negative description cache. */
  filePartIds: Set<string>
}

function chatDeletionArtifacts(sql: string, ...params: unknown[]): ChatDeletionArtifacts | null {
  const rows = getDb()
    .prepare(sql)
    .all(...(params as [])) as Array<{
    id: string
    conversation_id: string
    parts_json: string | null
  }>
  const ids: string[] = []
  const attachmentIds: string[] = []
  const toolImageRefs = toolImageRefsFromMessageRows(rows)
  const filePartIds = new Set<string>()
  // Conversation comes from the row ITSELF — description metadata cleanup must not depend on generated-image
  // parts (text messages also durably own cached descriptions).
  let conversationId = ''
  for (const row of rows) {
    conversationId = row.conversation_id
    const parts = parseParts(row.parts_json ?? '[]')
    for (const part of parts) {
      if (part.type === 'generated-image') ids.push(part.artifactId)
      if (part.type === 'file') {
        filePartIds.add(part.id)
        if (part.artifactId) attachmentIds.push(part.artifactId)
      }
    }
  }
  return rows.length
    ? { conversationId, generatedImageIds: ids, attachmentImageIds: attachmentIds, toolImageRefs, filePartIds }
    : null
}

/** IDs whose positive AND negative cached descriptions follow removed rows. */
function deletionDescriptionIds(artifacts: ChatDeletionArtifacts): Set<string> {
  if (artifacts.filePartIds.size === 0) return artifacts.toolImageRefs
  const ids = new Set(artifacts.toolImageRefs)
  for (const id of artifacts.filePartIds) ids.add(id)
  return ids
}

/** Tool-image refs owned by one conversation, captured before its row is deleted by the conversation store. */
export function collectChatToolImageRefs(conversationId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT id, parts_json FROM chat_messages WHERE conversation_id = ?')
    .all(conversationId) as Array<{ id: string; parts_json: string | null }>
  return toolImageRefsFromMessageRows(rows)
}

/** Releases refs captured before a conversation-level cascade/delete, using current persisted rows as ownership. */
export function releaseUnreferencedChatToolImages(refs: ReadonlySet<string>): void {
  releaseRemovedToolImageRefs(refs)
}

/**
 * Resolves a message's generated-image part. Renderer supplies conversation+message+part (never path or
 * bare artifactId): read only if the part ACTUALLY exists in that conversation, so leaked handles cannot
 * open artifacts from another conversation.
 */
export function findAttachmentImagePart(
  conversationId: string,
  messageId: string,
  partId: string
): Extract<MessagePart, { type: 'file' }> | null {
  const row = getDb()
    .prepare('SELECT parts_json FROM chat_messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId) as { parts_json?: string } | undefined
  if (!row) return null
  for (const part of parseParts(row.parts_json ?? '[]')) {
    if (part.type === 'file' && part.kind === 'image' && part.id === partId) return part
  }
  return null
}

export function findGeneratedImagePart(
  conversationId: string,
  messageId: string,
  partId: string
): Extract<MessagePart, { type: 'generated-image' }> | null {
  const row = getDb()
    .prepare('SELECT parts_json FROM chat_messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversationId) as { parts_json?: string } | undefined
  if (!row) return null
  for (const part of parseParts(row.parts_json ?? '[]')) {
    if (part.type === 'generated-image' && part.id === partId) return part
  }
  return null
}

/**
 * Deletes all conversation messages ("clear") + generated-image artifacts. Deliberately ASYNC and
 * awaitable: `chat:clear` may release the conversation reservation only AFTER directory rm
 * finishes — in-flight rm could delete an artifact just written by the next generation.
 */
export async function clearChatMessages(conversationId: string): Promise<void> {
  const pending = chatDeletionArtifacts(
    'SELECT id, conversation_id, parts_json FROM chat_messages WHERE conversation_id = ?',
    conversationId
  )
  getDb().prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(conversationId)
  if (pending) releaseRemovedToolImageRefs(pending.toolImageRefs)
  // Even without rows, conversation-scoped description metadata no longer has a durable owner.
  clearConversationToolImageMetadata(conversationId)
  await deleteConversationGeneratedImages(conversationId)
  await deleteConversationAttachmentImages(conversationId)
}

/** Deletes one message. */
export function deleteChatMessage(id: string): void {
  const pending = chatDeletionArtifacts('SELECT id, conversation_id, parts_json FROM chat_messages WHERE id = ?', id)
  getDb().prepare('DELETE FROM chat_messages WHERE id = ?').run(id)
  if (!pending) return
  releaseRemovedToolImageRefs(pending.toolImageRefs)
  releaseConversationToolImageMetadata(pending.conversationId, deletionDescriptionIds(pending))
  if (pending.generatedImageIds.length) void deleteGeneratedImages(pending.conversationId, pending.generatedImageIds)
  if (pending.attachmentImageIds.length) void deleteAttachmentImages(pending.conversationId, pending.attachmentImageIds)
}

/** Message seq (to truncate from here on edit+resend). null if absent. */
export function getMessageSeq(id: string): number | null {
  const r = getDb().prepare('SELECT seq FROM chat_messages WHERE id = ?').get(id) as { seq: number } | undefined
  return r ? r.seq : null
}

/** Deletes conversation messages with seq >= `fromSeq` (edit last message → rewrite from there). */
export function deleteChatMessagesFrom(conversationId: string, fromSeq: number): void {
  const pending = chatDeletionArtifacts(
    'SELECT id, conversation_id, parts_json FROM chat_messages WHERE conversation_id = ? AND seq >= ?',
    conversationId,
    fromSeq
  )
  getDb().prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND seq >= ?').run(conversationId, fromSeq)
  if (pending) {
    releaseRemovedToolImageRefs(pending.toolImageRefs)
    releaseConversationToolImageMetadata(pending.conversationId, deletionDescriptionIds(pending))
    if (pending.generatedImageIds.length) void deleteGeneratedImages(conversationId, pending.generatedImageIds)
    if (pending.attachmentImageIds.length) void deleteAttachmentImages(conversationId, pending.attachmentImageIds)
  }
}

/** Total chat messages (local-data summary / wipe). */
export function countChatMessages(): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }
  return r.n
}

/** Runner helper: builds a text part (stable ID). */
export function textPart(id: string, text: string): MessagePart {
  return { type: 'text', id, text }
}
