import type { JSONObject, JSONValue, SharedV3ProviderOptions } from '@ai-sdk/provider'
import type { SubagentExecutionSnapshotV1 } from './subagent-profiles'
import type { MaestroDelegationSnapshotV1 } from './maestro'
import type { MaestroLiveState } from './maestro-live'

export type ChatRole = 'user' | 'assistant'

export type ChatPermMode = 'full' | 'ask' | 'auto'

export type ChatMode = 'agent' | 'plan' | 'ask'

export interface ChatConvTools {
  app: boolean

  mcpDisabled: string[]

  imageGen: boolean
}

export interface ChatModelRef {
  providerId: string
  modelId: string
}

export interface ChatSubagentUsage {
  providerId: string
  modelId: string
  input: number
  output: number
  cachedInput?: number
  cacheCreate?: number

  runtimeEstimatedCostUsd?: number

  catalogInput?: number
  catalogOutput?: number
  catalogCacheRead?: number
  catalogCacheCreate?: number
}

export interface ChatUsage {
  usageVersion?: 2

  input: number
  output: number

  contextInput?: number

  contextOutput?: number

  modelContextWindow?: number

  cachedInput?: number

  cacheCreate?: number

  subInput?: number
  subOutput?: number
  subCachedInput?: number
  subCacheCreate?: number

  subagentUsage?: ChatSubagentUsage[]

  billingOnly?: boolean

  runtimeEstimatedCostUsd?: number

  catalogInput?: number
  catalogOutput?: number
  catalogCacheRead?: number
  catalogCacheCreate?: number
}

export interface ChatModelUsage {
  providerId: string
  modelId: string
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  runtimeEstimatedCostUsd?: number

  catalogInput?: number
  catalogOutput?: number
  catalogCacheRead?: number
  catalogCacheCreate?: number
  firstAt: number
  lastAt: number
}

export interface ChatUsageStats {
  perModel: ChatModelUsage[]
  totalTurns: number
  firstAt: number | null
  lastAt: number | null
}

export function totalTokensOf(u: { input: number; output: number; cacheRead?: number; cacheCreate?: number }): number {
  return Math.max(0, u.input) + Math.max(0, u.output) + Math.max(0, u.cacheRead ?? 0) + Math.max(0, u.cacheCreate ?? 0)
}

type UsagePricing = {
  inputPer1M?: number
  outputPer1M?: number
  cacheReadPer1M?: number
  cacheWritePer1M?: number
}

export function hasUsagePricing(meta: UsagePricing | null | undefined): boolean {
  return !!meta && [meta.inputPer1M, meta.outputPer1M, meta.cacheReadPer1M, meta.cacheWritePer1M].some(Number.isFinite)
}

export function costOfUsage(
  t: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  meta: UsagePricing | null | undefined
): number {
  const inRate = meta?.inputPer1M ?? 0
  const outRate = meta?.outputPer1M ?? 0
  const cacheReadRate = meta?.cacheReadPer1M ?? inRate
  const cacheWriteRate = meta?.cacheWritePer1M ?? inRate * 1.25
  const input = Math.max(0, t.input)
  const output = Math.max(0, t.output)
  const cacheRead = Math.max(0, t.cacheRead ?? 0)
  const cacheCreate = Math.max(0, t.cacheCreate ?? 0)
  return (input * inRate + cacheRead * cacheReadRate + cacheCreate * cacheWriteRate + output * outRate) / 1e6
}

function hasUsagePricingFor(
  usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  meta: UsagePricing | null | undefined
): boolean {
  const hasInput = Number.isFinite(meta?.inputPer1M)
  const hasOutput = Number.isFinite(meta?.outputPer1M)
  const hasCacheRead = Number.isFinite(meta?.cacheReadPer1M) || hasInput
  const hasCacheWrite = Number.isFinite(meta?.cacheWritePer1M) || hasInput
  return (
    (Math.max(0, usage.input) === 0 || hasInput) &&
    (Math.max(0, usage.output) === 0 || hasOutput) &&
    (Math.max(0, usage.cacheRead ?? 0) === 0 || hasCacheRead) &&
    (Math.max(0, usage.cacheCreate ?? 0) === 0 || hasCacheWrite)
  )
}

export function estimatedCostOfUsage(
  usage: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
  meta: UsagePricing | null | undefined,
  runtimeEstimatedCostUsd?: number | null,
  catalogUsage: { input: number; output: number; cacheRead?: number; cacheCreate?: number } = {
    input: 0,
    output: 0,
  }
): number | null {
  const runtimeCost =
    typeof runtimeEstimatedCostUsd === 'number' &&
    Number.isFinite(runtimeEstimatedCostUsd) &&
    runtimeEstimatedCostUsd >= 0
      ? runtimeEstimatedCostUsd
      : null
  if (runtimeCost == null) return hasUsagePricingFor(usage, meta) ? costOfUsage(usage, meta) : null
  if (totalTokensOf(catalogUsage) === 0) return runtimeCost
  return hasUsagePricingFor(catalogUsage, meta) ? runtimeCost + costOfUsage(catalogUsage, meta) : null
}

export function estimatedCostOfUsageWithSubagents(
  usage: Pick<
    ChatUsage,
    | 'input'
    | 'output'
    | 'cachedInput'
    | 'cacheCreate'
    | 'subInput'
    | 'subOutput'
    | 'subCachedInput'
    | 'subCacheCreate'
    | 'subagentUsage'
    | 'runtimeEstimatedCostUsd'
    | 'catalogInput'
    | 'catalogOutput'
    | 'catalogCacheRead'
    | 'catalogCacheCreate'
  >,
  parent: ChatModelRef | null | undefined,
  resolveMeta: (providerId: string, modelId: string) => UsagePricing | null | undefined
): number | null {
  const zeroCatalog = { input: 0, output: 0 }
  let total = 0

  const add = (
    tokens: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
    runtime: number | null | undefined,
    catalog: { input: number; output: number; cacheRead?: number; cacheCreate?: number },
    meta: () => UsagePricing | null | undefined
  ): boolean => {
    const cost = estimatedCostOfUsage(
      tokens,
      runtime == null || totalTokensOf(catalog) > 0 ? meta() : null,
      runtime,
      catalog
    )
    if (cost == null) return false
    total += cost
    return true
  }

  const parentTokens = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cachedInput ?? 0,
    cacheCreate: usage.cacheCreate ?? 0,
  }
  const parentCatalog = {
    input: usage.catalogInput ?? 0,
    output: usage.catalogOutput ?? 0,
    cacheRead: usage.catalogCacheRead ?? 0,
    cacheCreate: usage.catalogCacheCreate ?? 0,
  }
  if (usage.runtimeEstimatedCostUsd != null || totalTokensOf(parentTokens) > 0) {
    if (!parent) return null
    if (
      !add(parentTokens, usage.runtimeEstimatedCostUsd, parentCatalog, () =>
        resolveMeta(parent.providerId, parent.modelId)
      )
    )
      return null
  }

  let subInput = 0
  let subOutput = 0
  let subCacheRead = 0
  let subCacheCreate = 0
  for (const s of usage.subagentUsage ?? []) {
    if (!s.providerId || !s.modelId) continue
    subInput += s.input
    subOutput += s.output
    subCacheRead += s.cachedInput ?? 0
    subCacheCreate += s.cacheCreate ?? 0
    if (
      !add(
        { input: s.input, output: s.output, cacheRead: s.cachedInput ?? 0, cacheCreate: s.cacheCreate ?? 0 },
        s.runtimeEstimatedCostUsd,
        {
          input: s.catalogInput ?? 0,
          output: s.catalogOutput ?? 0,
          cacheRead: s.catalogCacheRead ?? 0,
          cacheCreate: s.catalogCacheCreate ?? 0,
        },
        () => resolveMeta(s.providerId, s.modelId)
      )
    )
      return null
  }

  const residual = {
    input: (usage.subInput ?? 0) - subInput,
    output: (usage.subOutput ?? 0) - subOutput,
    cacheRead: (usage.subCachedInput ?? 0) - subCacheRead,
    cacheCreate: (usage.subCacheCreate ?? 0) - subCacheCreate,
  }
  if (totalTokensOf(residual) > 0) {
    if (!parent) return null
    if (!add(residual, undefined, zeroCatalog, () => resolveMeta(parent.providerId, parent.modelId))) return null
  }
  return total
}

export const CUT_FINISH_REASONS: ReadonlySet<string> = new Set([
  'interrupted',
  'length',
  'other',
  'tool-calls',
  'unknown',
])

export function contextOccupancy(u: ChatUsage): number {
  if (u.contextInput != null) return u.contextInput + (u.contextOutput ?? 0)
  return u.usageVersion === 2 ? u.input + (u.cachedInput ?? 0) + (u.cacheCreate ?? 0) + u.output : u.input + u.output
}

export interface SubagentRunMeta {
  profile?: SubagentExecutionSnapshotV1

  maestro?: MaestroDelegationSnapshotV1
  /** Wall-clock origin of this run. Persisted so the live timer survives renderer remounts and reloads. */
  startedAt?: number
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number }

  runtimeEstimatedCostUsd?: number
  durationMs?: number

  sessionId?: string

  phase?: string

  lastActivityAt?: number

  inputTokens?: number

  outputTokens?: number
}

export type SubagentSessionOrigin = 'task' | 'delegate'

export type SubagentSessionStatus = 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface SubagentSessionUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export type SubagentResumeStatus = 'resumed' | 'recreated'

export type SubagentRuntimeHandle =
  | { kind: 'codex-thread'; threadId: string; accountId: string | null; toolSignature: string }
  | {
      kind: 'claude-session'
      sessionId: string
      cwd: string
      accountId: string | null
      /** Optional only for persisted handles created before the versioned behavior contract. */
      modelId?: string
      behaviorProfileId?: string | null
      runtimeSignature?: string
    }

export interface SubagentSessionSummary {
  id: string
  conversationId: string
  parentMessageId: string
  toolCallId: string
  origin: SubagentSessionOrigin
  agentName: string
  task: string
  status: SubagentSessionStatus
  phase?: string
  currentTool?: string
  profile?: SubagentExecutionSnapshotV1
  maestro?: MaestroDelegationSnapshotV1
  startedAt: number
  lastActivityAt: number
  finishedAt?: number
  durationMs?: number
  usage?: SubagentSessionUsage
  runtimeEstimatedCostUsd?: number
  revision: number
  toolNames: string[]
  files: string[]
  commands: string[]
  tests: string[]
  error?: string

  resumedFrom?: string
  resumeStatus?: SubagentResumeStatus

  resumeReason?: string
}

export interface SubagentTranscriptPage {
  session: SubagentSessionSummary
  messages: ChatMessage[]
  cursor: number
  hasMore: boolean
}

export interface SubagentTranscriptChange {
  cursor: number
  messageId: string
  role: ChatRole
  part: MessagePart
  createdAt: number
  updatedAt: number
}

export interface SubagentWaitResult {
  session: SubagentSessionSummary
  cursor: number
  changes: SubagentTranscriptChange[]
  timedOut: boolean
}

export interface SubagentSessionChangedEvent {
  conversationId: string
  sessionId: string
  revision: number
}

export interface ChatToolImage {
  id: string
  mediaType: string
  name?: string
  byteSize?: number

  description?: string
  descriptionModel?: string
}

export interface ChatToolOutput {
  text: string
  images?: ChatToolImage[]
  structuredContent?: JSONValue
  isError?: boolean
}

export type ToolOutput = string | ChatToolOutput

export function toolOutputText(output: ToolOutput | undefined): string {
  if (typeof output === 'string') return output
  return output?.text ?? ''
}

export function toolOutputImages(output: ToolOutput | undefined): readonly ChatToolImage[] {
  return typeof output === 'object' && output !== null && Array.isArray(output.images) ? output.images : []
}

export type ToolState =
  | { status: 'pending' } // Call announced; arguments are still streaming.
  | { status: 'awaiting-permission'; title?: string }
  | { status: 'running'; output?: ToolOutput; sub?: SubagentRunMeta } // Running; optional output shows incremental progress.
  | { status: 'completed'; output: ToolOutput; title?: string; sub?: SubagentRunMeta }
  | { status: 'error'; error: string; sub?: SubagentRunMeta } // Failed.
  | { status: 'denied'; reason?: string }

export interface ChatQuestionOption {
  label: string
  description?: string
}

export interface ChatQuestion {
  header: string
  question: string
  multiSelect?: boolean

  isSecret?: boolean
  options: ChatQuestionOption[]
}

export interface ChatTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type MessagePart =
  | {
      type: 'text'
      id: string
      text: string

      checkpoint?: 'openai-native'
    }
  | { type: 'reasoning'; id: string; text: string }
  | {
      type: 'tool'
      id: string // == toolCallId
      toolCallId: string
      toolName: string
      input: unknown
      state: ToolState
    }
  | {
      type: 'file'
      id: string
      name: string
      mediaType: string
      kind: 'image' | 'text'

      data?: string

      previewUrl?: string

      artifactId?: string
      byteSize?: number

      hidden?: boolean

      description?: string

      descriptionModel?: string
    }
  | {
      type: 'compaction'
      id: string
      text: string
      strategy?: 'summary' | 'openai-native' | 'claude-native' | 'codex-native'
    }
  | {
      type: 'skill-invocation'
      id: string
      name: string
      args?: string
      body: string

      dir?: string
    }
  | {
      type: 'context'
      id: string
      text: string
      source?: string
    }
  | {
      type: 'agent-mention'
      id: string

      name: string

      start: number

      end: number
    }
  | {
      type: 'generated-image'
      id: string

      artifactId: string
      name: string
      mediaType: string

      revisedPrompt?: string

      byteSize?: number
    }

export type ChatGeneratedImageResult =
  | { ok: true; bytes: Uint8Array; mediaType: string; byteSize: number }
  | { ok: false; error: 'not-found' | 'unreadable' | 'invalid' }

export type ChatToolImageResult =
  | { ok: true; bytes: Uint8Array; mediaType: string; byteSize: number }
  | { ok: false; error: 'not-found' | 'unreadable' | 'invalid' }

export type ChatAttachmentImageResult = ChatGeneratedImageResult

export interface ChatAttachmentInput {
  name: string
  mediaType: string
  kind: 'image' | 'text'

  data?: string
  artifactId?: string
  byteSize?: number
  bytes?: Uint8Array

  description?: string
  descriptionModel?: string
}

export interface ChatImageInterpreter {
  providerId: string
  modelId: string

  effort?: string
}

export interface ChatFileHit {
  path: string
  name: string
  kind: 'file' | 'dir'
}

export interface ChatModelMeta extends UsagePricing {
  contextWindow?: number
  maxOutput?: number
  inputPer1M?: number
  outputPer1M?: number
  cacheReadPer1M?: number
  cacheWritePer1M?: number
  reasoning?: boolean

  reasoningEfforts?: string[]

  interleavedReasoning?: { field: string; format: 'text' }
  vision?: boolean

  chatCapable?: boolean
  /** The model advertises Fast/Priority support (Codex service tiers, Claude supportsFastMode, xAI Priority Processing). */
  fastModeCapability?: boolean

  nativeUltraMode?: boolean

  contextLimitEditable?: boolean
}

export function usageMetaForModel(
  metaByModel: Record<string, ChatModelMeta | null> | undefined,
  target: { providerId: string | null; modelId: string | null },
  current: { providerId?: string | null; modelId?: string | null; meta: ChatModelMeta | null }
): ChatModelMeta | null {
  const providerId = target.providerId ?? ''
  const modelId = target.modelId ?? ''
  const key = `${providerId}\0${modelId}`
  if (metaByModel && Object.hasOwn(metaByModel, key)) return metaByModel[key]

  if (modelId && metaByModel && Object.hasOwn(metaByModel, modelId)) return metaByModel[modelId]
  if (providerId === (current.providerId ?? '') && modelId === (current.modelId ?? '')) return current.meta
  return null
}

export type ChatReasoningEffort =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'none'
  | (string & {})

export const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'] as const

export const MAESTRLY_ULTRA_EFFORT = 'maestrly-ultra'

export function reasoningPickerUltraState(
  supportedEfforts: readonly string[],
  nativeUltraMode: boolean
): { regularEfforts: string[]; ultraValue: ChatReasoningEffort; unifiedNativeUltra: boolean } {
  const unifiedNativeUltra = nativeUltraMode && supportedEfforts.includes('ultra')
  return {
    regularEfforts: unifiedNativeUltra
      ? supportedEfforts.filter((effort) => effort !== 'ultra')
      : [...supportedEfforts],
    ultraValue: unifiedNativeUltra ? 'ultra' : MAESTRLY_ULTRA_EFFORT,
    unifiedNativeUltra,
  }
}

export function nextQuickReasoningEffort(
  current: string | undefined,
  supportedEfforts: readonly string[],
  nativeUltraMode: boolean
): ChatReasoningEffort {
  const regularEfforts = reasoningPickerUltraState(supportedEfforts, nativeUltraMode).regularEfforts
  const order = ['off', ...regularEfforts]
  const currentIndex = order.indexOf(current ?? '')
  if (currentIndex < 0) return 'off'
  return order[(currentIndex + 1) % order.length] ?? 'off'
}

export function isMaestrlyUltraEffort(reasoning: string | undefined, supportedEfforts: readonly string[]): boolean {
  return reasoning === MAESTRLY_ULTRA_EFFORT || (reasoning === 'ultra' && !supportedEfforts.includes('ultra'))
}

const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export function resolveUltraEffort(efforts: string[]): string {
  let best: string | null = null
  let bestRank = -1
  for (const e of efforts) {
    const rank = EFFORT_RANK.indexOf(e as (typeof EFFORT_RANK)[number])
    if (rank > bestRank) {
      best = e
      bestRank = rank
    }
  }
  if (best && bestRank >= 0) return best
  return efforts.length ? efforts[efforts.length - 1] : DEFAULT_REASONING_EFFORTS[DEFAULT_REASONING_EFFORTS.length - 1]
}

export function buildProviderOptions(
  kind: ChatProviderKind,
  reasoning: string | undefined,
  meta: Pick<ChatModelMeta, 'reasoning' | 'reasoningEfforts'> | null | undefined
): SharedV3ProviderOptions | undefined {
  if (kind === 'codex-subscription' || kind === 'github-copilot-subscription' || kind === 'claude-subscription') {
    return undefined
  }

  let effort: string | null = null
  if (reasoning && reasoning !== 'off' && meta?.reasoning) {
    const validEfforts = meta.reasoningEfforts?.length ? meta.reasoningEfforts : [...DEFAULT_REASONING_EFFORTS]
    const effective = isMaestrlyUltraEffort(reasoning, validEfforts) ? resolveUltraEffort(validEfforts) : reasoning
    if (validEfforts.includes(effective)) effort = effective
  }
  return buildProviderOptionsForSentEffort(kind, effort)
}

export function buildProviderOptionsForSentEffort(
  kind: ChatProviderKind,
  sentEffort: string | null
): SharedV3ProviderOptions | undefined {
  if (kind === 'openai-responses') {
    const openai: JSONObject = { store: false, include: ['reasoning.encrypted_content'] }
    if (sentEffort) {
      openai.reasoningEffort = sentEffort
      openai.reasoningSummary = 'auto'
    }
    return { openai }
  }

  if (!sentEffort) return undefined
  if (kind === 'anthropic') return { anthropic: { effort: sentEffort } }
  // OpenAI, Grok subscriptions, and other OpenAI-compatible providers.
  return { 'openai-compatible': { reasoningEffort: sentEffort } }
}

export function resolveFrozenSentEffort(input: {
  reasoning: string
  supportedEfforts: readonly string[]
  serializableEfforts?: readonly string[]
}): string | null {
  if (input.supportedEfforts.length === 0) return null
  const effective = isMaestrlyUltraEffort(input.reasoning, input.supportedEfforts)
    ? resolveUltraEffort([...input.supportedEfforts])
    : input.reasoning
  if (!input.supportedEfforts.includes(effective)) return null
  if (
    input.serializableEfforts &&
    !input.serializableEfforts.includes(effective as (typeof input.serializableEfforts)[number])
  ) {
    return null
  }
  return effective
}

export function frozenEffortReproducible(
  kind: ChatProviderKind,
  reasoning: string | undefined,
  frozenSentEffort: string | undefined,
  meta: Pick<ChatModelMeta, 'reasoning' | 'reasoningEfforts'> | null | undefined
): boolean {
  if (kind === 'codex-subscription' || kind === 'github-copilot-subscription' || kind === 'claude-subscription') {
    return true
  }
  if (!reasoning || reasoning === 'off') return true
  if (!meta?.reasoning) return false
  const liveSent = resolveFrozenSentEffort({ reasoning, supportedEfforts: meta.reasoningEfforts ?? [] })
  return liveSent !== null && liveSent === frozenSentEffort
}

export interface ChatUserPrompt {
  id: string
  name: string
  description?: string
  content: string
}

export interface ChatProjectCommand {
  name: string
  description?: string
  content: string
  source: string // e.g. '.agents/commands/review.md'
}

export interface ChatSkillCommand {
  name: string
  description?: string
  /** Argument hint from frontmatter, e.g. `[env]`. */
  argumentHint?: string
  source: string // e.g. '.agents/skills/deploy/SKILL.md'
}

export interface ChatSlashCommand {
  name: string
  description?: string
  kind: 'action' | 'prompt' | 'project' | 'skill'

  action?: string
  content?: string
  /** Argument hint for skills. */
  argumentHint?: string
}

export function parseSlashInvocation(text: string): { name: string; args: string } | null {
  const m = /^\s*\/([A-Za-z0-9_:-]+)(?:[ \t\r\n]+([\s\S]*))?$/.exec(text ?? '')
  if (!m) return null
  const name = m[1].replace(/[^\w-]/g, '').toLowerCase()
  return name ? { name, args: (m[2] ?? '').trim() } : null
}

export type ChatSkillOverride = 'on' | 'off'

export interface ChatSkillGroup {
  id: string
  name: string
  description?: string
  skills: string[]
}

export type ChatSkillSelection = { kind: 'all' } | { kind: 'none' } | { kind: 'group'; groupId: string }

export interface ChatSkillInfo {
  name: string
  description: string
  source: string

  dir: string
  scope: 'project' | 'global'
  argumentHint?: string
  license?: string
  modelInvocable: boolean
  userInvocable: boolean

  resources: { scripts: number; references: number; assets: number }

  enabled: boolean

  baseEnabled: boolean

  enabledGlobally: boolean

  override?: ChatSkillOverride

  groupIds: string[]

  inSelectedGroup: boolean

  installedFrom?: string
}

export interface ChatSkillsState {
  skills: ChatSkillInfo[]
  groups: ChatSkillGroup[]
  selection: ChatSkillSelection

  selectedGroupMissing: boolean

  hasOverrides: boolean
}

export interface ChatSkillDetail extends ChatSkillInfo {
  body: string
  files: string[]
}

export interface ChatSkillSearchHit {
  /** Full ID, e.g. `vercel-labs/agent-skills/vercel-react-best-practices`. */
  id: string
  name: string

  source: string
  installs: number

  slug: string
  url: string

  installed: boolean
}

export type ChatExecutionScope =
  | { kind: 'conversation' }
  | {
      kind: 'review-loop'
      executionId: string
      loopId: string
      iteration: number
      maxIterations: number
      /** Present for the neutral paired driver; absent means the legacy Web executor round. */
      role?: 'executor' | 'reviewer'
      executorConversationId?: string
      reviewerConversationId?: string
    }
  | { kind: 'host'; executionId: string }
  | {
      kind: 'review-summary'
      loopId: string
      role?: 'executor' | 'reviewer'
      executorConversationId?: string
      reviewerConversationId?: string
    }

export interface ChatReviewLoopMeta {
  loopId: string
  executionId: string
  iteration: number
  maxIterations: number
  role?: 'executor' | 'reviewer'
  executorConversationId?: string
  reviewerConversationId?: string
}

export type ChatMessageSource = 'chatgpt-web' | 'chatgpt-web-review-loop' | 'maestrly-review-loop'

export interface ChatMessage {
  id: string
  conversationId: string
  role: ChatRole
  parts: MessagePart[]
  model?: ChatModelRef

  source?: ChatMessageSource
  createdAt: number

  finishReason?: string
  usage?: ChatUsage
  error?: string
  errorCode?: ChatErrorCode

  responseStartedAt?: number

  responseDurationMs?: number

  internal?: boolean

  executionScope?: ChatExecutionScope

  reviewLoop?: ChatReviewLoopMeta

  memoryContext?: import('./memory').MemoryContextMeta

  /** User input accepted into an already-running Astra turn. */
  steering?: { status: 'queued' | 'failed' }
}

export interface PendingChatQuestion {
  messageId: string
  toolCallId: string
  questions: ChatQuestion[]
}

export function findPendingChatQuestion(messages: readonly ChatMessage[]): PendingChatQuestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]
      if (part.type !== 'tool') continue
      if (part.toolName !== 'ask_question') continue
      if (part.state.status !== 'running' && part.state.status !== 'pending') continue
      const rawQuestions =
        typeof part.input === 'object' && part.input !== null
          ? (part.input as { questions?: unknown }).questions
          : undefined
      const questions = Array.isArray(rawQuestions)
        ? rawQuestions.filter(
            (question): question is ChatQuestion =>
              !!question && typeof question === 'object' && Array.isArray((question as { options?: unknown }).options)
          )
        : []
      if (questions.length > 0) return { messageId: message.id, toolCallId: part.toolCallId, questions }
    }
    break
  }
  return null
}

export function mergePendingChatQuestions(
  messages: readonly ChatMessage[],
  conversationId: string,
  pendingQuestions: readonly PendingChatQuestion[]
): ChatMessage[] {
  if (pendingQuestions.length === 0) return messages.slice()
  const next = messages.slice()

  for (const pending of pendingQuestions) {
    const toolPart: Extract<MessagePart, { type: 'tool' }> = {
      type: 'tool',
      id: pending.toolCallId,
      toolCallId: pending.toolCallId,
      toolName: 'ask_question',
      input: { questions: pending.questions },
      state: { status: 'running' },
    }
    const messageIndex = next.findIndex((message) => message.id === pending.messageId && message.role === 'assistant')
    if (messageIndex < 0) {
      next.push({
        id: pending.messageId,
        conversationId,
        role: 'assistant',
        parts: [toolPart],
        createdAt: Date.now(),
      })
      continue
    }

    const message = next[messageIndex]
    const parts = message.parts.slice()
    const partIndex = parts.findIndex((part) => part.type === 'tool' && part.toolCallId === pending.toolCallId)
    if (partIndex < 0) parts.push(toolPart)
    else parts[partIndex] = toolPart
    next[messageIndex] = { ...message, parts }
  }

  return next
}

export type ChatErrorCode =
  | 'claude-authentication-required'
  | 'codex-accounts-exhausted'
  | 'review-loop-process-interrupted'

export type ChatStreamEvent =
  | {
      kind: 'runtime-capabilities'
      midTurnSteering: boolean
      liveReasoningUpdate: boolean
      activeHarnessProfile: ChatActiveHarnessProfile | null
    }
  | { kind: 'steering-accepted'; message: ChatMessage }
  | {
      kind: 'message-start'
      messageId: string
      model?: ChatModelRef
      createdAt: number
      responseStartedAt: number

      source?: ChatMessage['source']
      reviewLoop?: ChatReviewLoopMeta
    }
  | { kind: 'text-start'; messageId: string; partId: string }
  | { kind: 'text-delta'; messageId: string; partId: string; delta: string }
  | { kind: 'reasoning-start'; messageId: string; partId: string }
  | { kind: 'reasoning-delta'; messageId: string; partId: string; delta: string }
  | { kind: 'tool-input-start'; messageId: string; toolCallId: string; toolName: string }
  | { kind: 'tool-call'; messageId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool-state'; messageId: string; toolCallId: string; state: ToolState }
  | {
      kind: 'generated-image'
      messageId: string
      partId: string
      artifactId: string
      name: string
      mediaType: string
      revisedPrompt?: string
      byteSize?: number
    }
  | {
      kind: 'compaction'
      messageId: string
      partId: string
      text: string
      strategy?: 'summary' | 'openai-native' | 'claude-native' | 'codex-native'
      usage?: ChatUsage
    }
  | { kind: 'finish'; messageId: string; finishReason: string; usage?: ChatUsage; responseDurationMs: number }
  | { kind: 'aborted'; messageId?: string; usage?: ChatUsage; responseDurationMs?: number }
  | {
      kind: 'error'
      messageId?: string
      message: string
      code?: ChatErrorCode
      removeAssistantText?: boolean
      usage?: ChatUsage
      responseDurationMs?: number
    }

export interface ChatPermissionRequest {
  id: string
  conversationId: string
  toolCallId?: string
  toolName: string
  action: string
  title: string
  resources: string[]

  allowAlways?: boolean
}

export type PermissionReply = 'once' | 'always' | 'reject'

export type ChatPermissionEvent =
  | { kind: 'request'; request: ChatPermissionRequest }
  | { kind: 'resolved'; requestId: string; toolCallId?: string; decision: 'allow' | 'deny' }

export interface ChatRuntimeState {
  streaming: boolean
  pendingPermissions: ChatPermissionRequest[]
  pendingQuestions: PendingChatQuestion[]

  maestroLive?: MaestroLiveState | null

  midTurnSteering: boolean
  liveReasoningUpdate: boolean
  activeHarnessProfile: ChatActiveHarnessProfile | null
}

export type ChatActiveHarnessProfile =
  | 'openai-default-v1'
  | 'openai-gpt-5.6-sol-v1'
  | 'openai-gpt-6-astra-v1'

export type ChatProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-responses'
  | 'codex-subscription'
  | 'github-copilot-subscription'
  | 'claude-subscription'
  | 'grok-subscription'

export type ChatSubscriptionProviderKind = Extract<
  ChatProviderKind,
  'codex-subscription' | 'github-copilot-subscription' | 'claude-subscription' | 'grok-subscription'
>

export const CHAT_SUBSCRIPTION_PROVIDER_KINDS: readonly ChatSubscriptionProviderKind[] = [
  'codex-subscription',
  'github-copilot-subscription',
  'claude-subscription',
  'grok-subscription',
]

export function isChatSubscriptionProviderKind(kind: string | null | undefined): kind is ChatSubscriptionProviderKind {
  return kind != null && (CHAT_SUBSCRIPTION_PROVIDER_KINDS as readonly string[]).includes(kind)
}

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

export const CHATGPT_WEB_PROVIDER_ID = 'builtin_chatgpt_web'

/** Access policy owned by one Maestrly conversation. External credentials remain in the main process. */
export type ChatGptWebCapabilityScope = 'off' | 'read' | 'write'
export type ChatGptWebBrowserCapability = 'off' | 'inspect' | 'interact'

export interface ChatGptWebCapabilities {
  git: 'off' | 'read'
  gh: 'off' | 'read'
  /** Read-only access to the visible main Maestrly conversation. Missing values fail closed to off. */
  conversation: 'off' | 'read'
  /** Local durable memory requires explicit Read; shared knowledge remains repository-jailed. */
  memory: 'off' | 'read'
  /** Browser access is fail-closed and may target an isolated preview or an attached embedded local tab. */
  browser: ChatGptWebBrowserCapability
  mcp: Record<string, ChatGptWebCapabilityScope>
}

/** Sanitized server entry used by the companion access UI. */
export interface ChatGptWebMcpCapabilityInfo {
  id: string
  name: string
  enabled: boolean
  scope: ChatGptWebCapabilityScope
}

export interface ChatGptWebCapabilitiesInfo {
  capabilities: ChatGptWebCapabilities
  mcpServers: ChatGptWebMcpCapabilityInfo[]
  editable: boolean
  fingerprint: string
}

/** `arming` waits for the first routed tool; `live` confirms manual pairing. */
export type ChatGptWebSessionState = 'arming' | 'live' | 'ended' | 'error'

export type ChatGptWebTunnelState = 'stopped' | 'starting' | 'ready' | 'error'

export interface ChatGptWebSessionDiagnostic {
  bridge: {
    lastEvent: string | null
    lastToolCallAt: number | null
    toolCalls: number
    deliveries: number
  }
}

export interface ChatGptWebSessionInfo {
  state: ChatGptWebSessionState

  pairingRequired: boolean

  conversationId: string
  cwd: string
  startedAt: number
  lastActivityAt: number | null
  toolCalls: number
  deliveries: number

  capabilities?: {
    fingerprint: string
    gitRead: boolean
    ghRead: boolean
    conversation: 'off' | 'read'
    memory: 'off' | 'read'
    browser: ChatGptWebBrowserCapability
    mcpRead: number
    mcpWrite: number
  }

  diagnostic?: ChatGptWebSessionDiagnostic

  reviewLoop?: ChatGptWebReviewLoopInfo
  error?: string
}

export interface ChatGptWebStatus {
  binaryAvailable: boolean

  configured: boolean
  tunnelId: string | null
  apiKeyPresent: boolean
  appName: string
  tunnelState: ChatGptWebTunnelState
  tunnelError?: string

  probeActive: boolean

  appRefreshRequired: boolean

  sessions: ChatGptWebSessionInfo[]
}

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

export type ChatGptWebReviewLoopStatus =
  | 'reviewing'
  | 'executing'
  | 'finishing'
  | 'cancelling'
  | 'finished'
  | 'cancelled'
  | 'interrupted'

export function isReviewLoopConversationReserved(status: ChatGptWebReviewLoopStatus | null | undefined): boolean {
  return (
    status === 'reviewing' ||
    status === 'executing' ||
    status === 'finishing' ||
    status === 'cancelling' ||
    status === 'finished' ||
    status === 'cancelled'
  )
}

export interface FrozenChatSelection {
  providerId: string
  modelId: string
  reasoning?: string

  reasoningEffort?: string
  fastMode: boolean

  serviceTier?: string

  resolvedModelId?: string

  /** Frozen behavioral contract. null/absent means the legacy prompt path. */
  behaviorProfileId?: string | null

  identityFingerprint?: string

  identityEpoch?: number

  providerFingerprint?: string
}

export type FrozenChatExecutionProfile = FrozenChatSelection

export type InternalTurnOutcome =
  | {
      status: 'success'
      assistantMessageId: string | null
      summaryText?: string
      reviewDecision?: {
        result: 'clean' | 'findings'
        summary: string
        findings?: Array<{
          id: string
          severity: 'blocking' | 'important' | 'optional'
          title: string
          details: string
          paths?: string[]
        }>
      }
    }
  | { status: 'error'; error: string; assistantMessageId: string | null }
  | { status: 'cancelled'; assistantMessageId: string | null }

export interface InternalTurnHandle {
  executionId: string
  conversationId: string
  assistantMessageId: () => string | null
  done: Promise<InternalTurnOutcome>
  cancel(): void
}

export interface ChatGptWebReviewLoopInfo {
  loopId: string
  status: ChatGptWebReviewLoopStatus
  iteration: number
  maxIterations: number
  startedAt: number
  jobStartedAt?: number
  finishReason?: string

  modelId?: string

  reasoning?: string
  /** Frozen Fast mode. */
  fastMode?: boolean

  contextPolicy?: 'isolated'

  roundsCompleted?: number
  roundsFailed?: number
  roundsCancelled?: number
  /** Review protocol axis; absent in older persisted/public payloads means code. */
  reviewScope?: 'code' | 'frontend'
  /** Sanitized visual runtime state. Never includes process/session/browser internals. */
  visual?: {
    state: 'starting' | 'ready' | 'inspecting' | 'error'
    url?: string
    managedPreview: boolean
  }
}

export type ReviewLoopDriver = 'chatgpt-web' | 'maestrly-pair'
export type ReviewLoopRole = 'executor' | 'reviewer'
export type ReviewLoopTurnPolicy = 'executor-agent' | 'reviewer-readonly'
export type ReviewLoopSource = 'chatgpt-web-review-loop' | 'maestrly-review-loop'
export type ReviewLoopSeverityThreshold = 'blocking' | 'important'

export interface ReviewLoopParticipantInfo {
  conversationId: string
  name: string
  modelId: string
  reasoning?: string
  fastMode: boolean
}

/** Sanitized neutral projection. It deliberately excludes prompts, fingerprints, findings and handles. */
export interface ReviewLoopInfo {
  loopId: string
  driver: ReviewLoopDriver
  status: ChatGptWebReviewLoopStatus
  iteration: number
  maxIterations: number
  activeRole?: ReviewLoopRole
  participants: {
    executor: ReviewLoopParticipantInfo
    reviewer?: ReviewLoopParticipantInfo
  }
  startedAt: number
  jobStartedAt?: number
  finishReason?: string
}

export interface ReviewLoopCompatibleCandidate extends ReviewLoopParticipantInfo {
  compatible: boolean
  unavailableReason?: string
}

export interface StartPairedReviewLoopInput {
  executorConversationId: string
  reviewerConversationId: string
  maxIterations?: number
  severityThreshold?: ReviewLoopSeverityThreshold
}

export type StartPairedReviewLoopResult = { ok: true; loop: ReviewLoopInfo } | { ok: false; error: string }

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

export interface ChatSubscriptionAccount {
  id: string
  kind: ChatSubscriptionProviderKind
  label: string
  createdAt: number
}

export interface ChatSubscriptionFailoverRoute {
  primaryProviderId: string
  enabled: boolean
  fallbackProviderIds: string[]
}

export interface ChatSubscriptionFailoverConfigV1 {
  version: 1
  routes: ChatSubscriptionFailoverRoute[]
}

export interface ChatSubscriptionFailoverEvent {
  scope: 'root' | 'subagent' | 'helper'
  fromProviderId: string
  toProviderId: string
  reason: string
  resetsAt?: number | null
}

export const SUBSCRIPTION_ACCOUNT_ID_SEPARATOR = '@'

export function subscriptionAccountId(providerId: string | null | undefined): string | null {
  if (!providerId) return null
  const idx = providerId.indexOf(SUBSCRIPTION_ACCOUNT_ID_SEPARATOR)
  return idx > 0 ? providerId.slice(idx + 1) || null : null
}

/** Removes the account suffix to return the base provider ID (`builtin_*`). */
export function subscriptionBaseProviderId(providerId: string): string {
  const idx = providerId.indexOf(SUBSCRIPTION_ACCOUNT_ID_SEPARATOR)
  return idx > 0 ? providerId.slice(0, idx) : providerId
}

/** Stable provider-family identities. Credentials and account labels always stay local. */
export const PORTABLE_EXECUTION_BUILTIN_PROVIDER_IDS = [
  'builtin_codex_subscription',
  'builtin_github_copilot_subscription',
  'builtin_claude_subscription',
  'builtin_grok_subscription',
] as const

/** Portable shared configs deliberately exclude random BYOK IDs and account-scoped built-in IDs. */
export function isPortableExecutionBuiltinProviderId(providerId: string | null | undefined): boolean {
  if (!providerId || providerId !== subscriptionBaseProviderId(providerId)) return false
  return (PORTABLE_EXECUTION_BUILTIN_PROVIDER_IDS as readonly string[]).includes(providerId)
}

const PORTABLE_EXECUTION_ACCOUNT_SLOT_ID =
  /^acc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isPortableExecutionProviderId(providerId: string | null | undefined): boolean {
  if (!providerId) return false
  const baseProviderId = subscriptionBaseProviderId(providerId)
  if (!isPortableExecutionBuiltinProviderId(baseProviderId)) return false
  if (providerId === baseProviderId) return true
  const accountId = subscriptionAccountId(providerId)
  return accountId !== null && PORTABLE_EXECUTION_ACCOUNT_SLOT_ID.test(accountId)
}

export function withSubscriptionAccount(baseProviderId: string, accountId: string | null): string {
  return accountId ? `${baseProviderId}${SUBSCRIPTION_ACCOUNT_ID_SEPARATOR}${accountId}` : baseProviderId
}

export type ChatSubscriptionAuthState = 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'

export interface ChatSubscriptionAuthStatus {
  state: ChatSubscriptionAuthState

  authenticated: boolean

  accountId?: string | null
  email?: string | null

  username?: string | null
  planType?: string | null

  enterpriseUrl?: string | null
  error?: string
  errorCode?: ChatErrorCode
}

export type ChatSubscriptionUsageWindowKind = 'five-hour' | 'weekly' | 'weekly-model' | 'other'

export interface ChatSubscriptionUsageWindow {
  id: string
  kind: ChatSubscriptionUsageWindowKind
  usedPercent: number

  resetsAt: number | null

  durationMins: number | null

  label?: string
}

export interface ChatSubscriptionUsageReady {
  state: 'ready'
  providerKind: ChatSubscriptionProviderKind
  accountId: string | null
  fetchedAt: number
  windows: ChatSubscriptionUsageWindow[]
}

export interface ChatSubscriptionUsageUnsupported {
  state: 'unsupported'
  providerKind: ChatSubscriptionProviderKind
  accountId: string | null
  reason?: 'provider' | 'excluded' | 'unavailable'
}

export interface ChatSubscriptionUsageError {
  state: 'error'
  providerKind: ChatSubscriptionProviderKind
  accountId: string | null
  error: string
}

export type ChatSubscriptionUsage =
  | ChatSubscriptionUsageReady
  | ChatSubscriptionUsageUnsupported
  | ChatSubscriptionUsageError

export interface ChatSubscriptionLoginResult {
  ok: boolean

  authUrl?: string

  verificationUrl?: string
  userCode?: string
  status?: ChatSubscriptionAuthStatus
  error?: string
}

export interface ChatSubscriptionLogoutResult {
  ok: boolean
  status?: ChatSubscriptionAuthStatus
  error?: string
}

export type CodexSubscriptionAuthState = ChatSubscriptionAuthState
export type CodexSubscriptionAuthStatus = ChatSubscriptionAuthStatus
export type CodexSubscriptionLoginResult = ChatSubscriptionLoginResult

export function isOfficialOpenAIProvider(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === 'api.openai.com'
  } catch {
    return false
  }
}

export function defaultProviderKind(baseURL: string): ChatProviderKind {
  try {
    const host = new URL(baseURL).host
    if (host === 'api.anthropic.com') return 'anthropic'
    if (host === 'api.openai.com') return 'openai-responses'
    return 'openai'
  } catch {
    return 'openai'
  }
}

export function effectiveProviderKind(baseURL: string, kind?: ChatProviderKind): ChatProviderKind {
  if (isOfficialOpenAIProvider(baseURL)) return 'openai-responses'
  return kind ?? defaultProviderKind(baseURL)
}

export interface ChatProviderInfo {
  id: string
  name: string
  baseURL: string
  apiKeyPresent: boolean

  builtIn?: boolean

  connected?: boolean

  kind?: ChatProviderKind

  accountId?: string | null

  accountLabel?: string
}

export function isChatProviderConnected(provider: ChatProviderInfo): boolean {
  return provider.connected ?? provider.apiKeyPresent
}

export interface ChatProviderPreset {
  name: string
  baseURL: string
  apiKeyUrl?: string

  kind?: ChatProviderKind
}

export interface McpServerInfo {
  id: string
  name: string
  transport: 'http' | 'stdio'
  enabled: boolean
  url?: string
  command?: string
}

export interface ChatConfig {
  providers: ChatProviderInfo[]

  presets: ChatProviderPreset[]

  mcpServers: McpServerInfo[]

  appToolsEnabled: boolean

  imageGenEnabled: boolean

  bashFiltersEnabled: boolean

  openAIHarnessEnabled: boolean

  astraHarnessEnabled: boolean

  storageMode: 'secure' | 'unavailable'

  defaultSelection: ChatModelRef | null

  defaultReasoning: string

  defaultFastMode?: boolean

  imageInterpreter: ChatImageInterpreter | null
  /** Failover between subscription accounts (currently Codex). */
  subscriptionFailover: {
    supportedKinds: ChatSubscriptionProviderKind[]
    routes: ChatSubscriptionFailoverRoute[]
  }
}

export interface ChatHistoryPage {
  messages: ChatMessage[]

  hasMore: boolean

  earliestSeq: number | null

  latestSeq?: number | null

  hasMoreAfter?: boolean
}

export interface ChatSearchHit {
  messageId: string

  seq: number

  snippet: string
}

export interface ChatPerModelUsage {
  providerId: string | null
  modelId: string | null
  input: number
  output: number
  cachedInput: number
  cacheCreate: number
  subInput: number
  subOutput: number
  subCachedInput: number
  subCacheCreate: number

  runtimeEstimatedCostUsd?: number

  catalogInput?: number
  catalogOutput?: number
  catalogCacheRead?: number
  catalogCacheCreate?: number
}

export interface ChatContextProjection {
  /** Occupancy that the currently selected provider/model will use for its next request. */
  usedTokens: number
  /** Native runtime/session usage, or the provider-neutral transcript reconstructed by Maestrly. */
  source: 'runtime-usage' | 'portable-transcript'
  /** Portable tokenization is conservative because providers tokenize text and images differently. */
  quality: 'measured' | 'estimated'
  /** Runtime-reported effective window when it belongs to this exact target. */
  modelContextWindow?: number
}

export interface ChatHistoryStats {
  lastUsage: ChatUsage | null

  lastModel?: ChatModelRef | null
  /** Target-specific next-request projection; unlike lastUsage, it never leaks usage from another runtime. */
  contextProjection?: ChatContextProjection

  perModel: ChatPerModelUsage[]
  /** Distinct model IDs used for compatibility and UI lookup. */
  modelIds: string[]

  bytesSaved: number
}

// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------

function patchMessage(
  messages: ChatMessage[],
  messageId: string,
  patch: (m: ChatMessage) => ChatMessage
): ChatMessage[] {
  let found = false
  const next = messages.map((m) => {
    if (m.id !== messageId) return m
    found = true
    return patch(m)
  })
  if (!found) return messages
  return next
}

function lastPart<T extends MessagePart['type']>(
  parts: MessagePart[],
  type: T,
  id: string
): Extract<MessagePart, { type: T }> | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === type && p.id === id) return p as Extract<MessagePart, { type: T }>
  }
  return undefined
}

export function applyChatEvent(messages: ChatMessage[], ev: ChatStreamEvent): ChatMessage[] {
  switch (ev.kind) {
    case 'runtime-capabilities':
      return messages
    case 'steering-accepted':
      return messages.some((message) => message.id === ev.message.id)
        ? messages.map((message) => (message.id === ev.message.id ? ev.message : message))
        : [...messages, ev.message]
    case 'message-start': {
      if (messages.some((m) => m.id === ev.messageId)) {
        return patchMessage(messages, ev.messageId, (m) => {
          const nextStarted =
            m.responseDurationMs == null && m.responseStartedAt == null
              ? { responseStartedAt: ev.responseStartedAt }
              : {}
          const nextSource = !m.source && ev.source ? { source: ev.source } : {}
          const nextLoop = !m.reviewLoop && ev.reviewLoop ? { reviewLoop: ev.reviewLoop } : {}
          if (!nextStarted.responseStartedAt && !nextSource.source && !nextLoop.reviewLoop) return m
          return { ...m, ...nextStarted, ...nextSource, ...nextLoop }
        })
      }
      const msg: ChatMessage = {
        id: ev.messageId,
        conversationId: messages[0]?.conversationId ?? '',
        role: 'assistant',
        parts: [],
        model: ev.model,
        createdAt: ev.createdAt,
        responseStartedAt: ev.responseStartedAt,
        ...(ev.source ? { source: ev.source } : {}),
        ...(ev.reviewLoop ? { reviewLoop: ev.reviewLoop } : {}),
      }
      return [...messages, msg]
    }
    case 'text-start':
      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        parts: [...m.parts, { type: 'text', id: ev.partId, text: '' }],
      }))
    case 'text-delta':
      return patchMessage(messages, ev.messageId, (m) => {
        const parts = m.parts.slice()
        const existing = lastPart(parts, 'text', ev.partId)
        if (existing) {
          const idx = parts.lastIndexOf(existing)
          parts[idx] = { ...existing, text: existing.text + ev.delta }
        } else {
          parts.push({ type: 'text', id: ev.partId, text: ev.delta })
        }
        return { ...m, parts }
      })
    case 'reasoning-start':
      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        parts: [...m.parts, { type: 'reasoning', id: ev.partId, text: '' }],
      }))
    case 'reasoning-delta':
      return patchMessage(messages, ev.messageId, (m) => {
        const parts = m.parts.slice()
        const existing = lastPart(parts, 'reasoning', ev.partId)
        if (existing) {
          const idx = parts.lastIndexOf(existing)
          parts[idx] = { ...existing, text: existing.text + ev.delta }
        } else {
          parts.push({ type: 'reasoning', id: ev.partId, text: ev.delta })
        }
        return { ...m, parts }
      })
    case 'tool-input-start':
      return patchMessage(messages, ev.messageId, (m) => {
        if (m.parts.some((p) => p.type === 'tool' && p.toolCallId === ev.toolCallId)) return m
        return {
          ...m,
          parts: [
            ...m.parts,
            {
              type: 'tool',
              id: ev.toolCallId,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              input: undefined,
              state: { status: 'pending' },
            },
          ],
        }
      })
    case 'tool-call':
      return patchMessage(messages, ev.messageId, (m) => {
        const parts = m.parts.slice()
        const idx = parts.findIndex((p) => p.type === 'tool' && p.toolCallId === ev.toolCallId)
        if (idx >= 0) {
          const prev = parts[idx] as Extract<MessagePart, { type: 'tool' }>
          parts[idx] = { ...prev, toolName: ev.toolName, input: ev.input }
        } else {
          parts.push({
            type: 'tool',
            id: ev.toolCallId,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            input: ev.input,
            state: { status: 'pending' },
          })
        }
        return { ...m, parts }
      })
    case 'tool-state':
      return patchMessage(messages, ev.messageId, (m) => {
        const parts = m.parts.slice()
        const idx = parts.findIndex((p) => p.type === 'tool' && p.toolCallId === ev.toolCallId)
        if (idx < 0) return m
        const prev = parts[idx] as Extract<MessagePart, { type: 'tool' }>
        parts[idx] = { ...prev, state: ev.state }
        return { ...m, parts }
      })
    case 'generated-image':
      return patchMessage(messages, ev.messageId, (m) => {
        const part: MessagePart = {
          type: 'generated-image',
          id: ev.partId,
          artifactId: ev.artifactId,
          name: ev.name,
          mediaType: ev.mediaType,
          ...(ev.revisedPrompt ? { revisedPrompt: ev.revisedPrompt } : {}),
          ...(typeof ev.byteSize === 'number' ? { byteSize: ev.byteSize } : {}),
        }
        const idx = m.parts.findIndex((p) => p.type === 'generated-image' && p.id === ev.partId)
        if (idx < 0) return { ...m, parts: [...m.parts, part] }
        const parts = m.parts.slice()
        parts[idx] = part
        return { ...m, parts }
      })
    case 'compaction':
      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        parts: m.parts.some((p) => p.type === 'compaction' && p.id === ev.partId)
          ? m.parts
          : [
              ...m.parts,
              {
                type: 'compaction',
                id: ev.partId,
                text: ev.text,
                ...(ev.strategy ? { strategy: ev.strategy } : {}),
              },
            ],
        usage: ev.usage ?? m.usage,
      }))
    case 'finish':
      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        finishReason: ev.finishReason,
        usage: ev.usage,
        responseStartedAt: undefined,
        responseDurationMs: ev.responseDurationMs,
      }))
    case 'aborted':
      if (!ev.messageId) return messages

      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        finishReason: m.finishReason ?? 'aborted',
        usage: ev.usage ?? m.usage,
        responseStartedAt: undefined,
        responseDurationMs: ev.responseDurationMs ?? m.responseDurationMs,
        parts: m.parts.map((p) =>
          p.type === 'tool' &&
          (p.state.status === 'running' || p.state.status === 'pending' || p.state.status === 'awaiting-permission')
            ? {
                ...p,
                state: {
                  status: 'error',
                  error: 'Aborted',
                  ...('sub' in p.state && p.state.sub ? { sub: p.state.sub } : {}),
                },
              }
            : p
        ),
      }))
    case 'error':
      if (!ev.messageId) return messages
      return patchMessage(messages, ev.messageId, (m) => ({
        ...m,
        error: ev.message,
        errorCode: ev.code,
        parts: ev.removeAssistantText ? m.parts.filter((part) => part.type !== 'text') : m.parts,
        usage: ev.usage ?? m.usage,
        responseStartedAt: undefined,
        responseDurationMs: ev.responseDurationMs ?? m.responseDurationMs,
      }))
    default:
      return messages
  }
}
