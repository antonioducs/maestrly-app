/**
 * BYOK chat agent loop. Conceptually ported from opencode `session/runner/llm.ts`, which manually
 * implements multi-step tools for durability. Here Vercel AI SDK `streamText` handles the loop
 * (tools + stopWhen), leaving the runner to load history → convert → stream → translate
 * `fullStream` parts into model events → fold into assistant message → persist (throttled) →
 * emit to renderer. Permissions are gated INSIDE each tool execute (see tools + permission.ts).
 */
import { createHash, randomUUID } from 'node:crypto'
import { streamText, stepCountIs, tool, jsonSchema, type ToolSet, type ModelMessage, type StopCondition } from 'ai'
import type { SharedV3ProviderOptions } from '@ai-sdk/provider'
import type { ChatBehavior } from '../../shared/conversation-experience'
import type { MaestroTurnSnapshotV1 } from '../../shared/maestro'
import {
  applyChatEvent,
  buildProviderOptions,
  CUT_FINISH_REASONS,
  frozenEffortReproducible,
  isMaestrlyUltraEffort,
  toolOutputImages,
  type ChatProviderKind,
} from '../../shared/chat'
import { responseDurationMs } from '../../shared/response-duration'
import type {
  ChatModelMeta,
  ChatModelRef,
  ChatStreamEvent,
  ChatSubagentUsage,
  SubagentRunMeta,
} from '../../shared/chat'
import { chatDiag } from './diag-log'
import { MEMORY_TOOL_GUIDANCE } from './memory-tool-guidance'
import { makeContextGuard } from './context-guard'
import {
  runnerContextHistory,
  toPublicChatUsage,
  upsertChatMessage,
  type StoredChatMessage,
  type StoredChatUsage,
} from './chat-store'
import { createDeltaCoalescer } from './delta-coalescer'
import { toModelMessages, type PersistedReplayStats } from './message'
import { resolveChatModel } from './provider'
import { getProvider, isAnthropicProvider, isClaudeSubscriptionProvider } from './catalog'
import type { QuestionBroker } from './question-broker'
import { buildAppTools, buildMcpTools } from './mcp'
import { buildOpenAIProjectContext, buildProjectContext } from './project-context'
import { renderSkillContext, skillCatalogLine } from './skills'
import { effectiveSkills, findEffectiveSkill } from './skill-state'
import { listEffectiveAgents } from './virtual-subagents'
import { catalogProviderForBaseURL, getProviderModelMetaWithStatus } from './model-meta'
import {
  resolveInterleavedReplayPolicy,
  wrapInterleavedReplayModel,
  type InterleavedReplayStats,
} from './reasoning-replay'
import {
  buildTools,
  builtinToolNamesForMode,
  isSubagentReadOnly,
  REVIEWER_READONLY_TOOL_NAMES,
  selectSubagentToolNames,
} from './tools'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  GENERATE_IMAGE_TOOL_NAME,
  normalizeGeneratedImageUsage,
} from './image-gen'
import type { GeneratedImageEmission, GeneratedImageUsage, ReviewerToolRuntime, ToolContext } from './tools/util'
import { getAppFlag, getConversation, getConvUiPrefs, patchConvUiPrefs } from '../store'
import {
  applyPersistedToolImageEnrichment,
  describeConversationImages,
  describeEphemeralToolImage,
  describePersistedToolImages,
  getImageInterpreter,
  hasConfiguredImageInterpreter,
} from './image-interpreter'
import { modelOutputToChatToolOutput, toolOutputAsText, toolOutputIsError } from './tool-output'
import { adaptToolSetForModel, supportsChatToolImages } from './tool-capabilities'
import { buildAndRenderSubagentDispatchCatalog } from './subagent-dispatch-catalog'
import { resolveSubagentExecutionProfile } from './subagent-execution-profile'
import { getSubagentProfileModelMeta } from './subagent-profile-model-meta'
import { executeSubagent } from './subagent-executor'
import type { SubagentSessionRecorder } from './subagent-session'
import { startMaestroDelegation } from './maestro-delegation-registry'
import { buildSubagentSupervisionTools } from './maestro-supervision-tools'
import {
  assertSubagentSelection,
  createExplicitSubagentTurnState,
  recordSubagentDispatch,
} from './subagent-selection-guard'
import { detectExplicitSubagentsForTurn } from './subagent-turn-request'
import { isOpenAINativeCompactionPart, namespaceSubagentToolSet } from './subagent-runner'
import { AI_SDK_MAX_RETRIES, classifyStreamRetry, shouldBlockHighUsageRetry } from './retry-policy'
import { SubagentCoordinator, type SubagentLease } from './subagent-coordinator'
import {
  MAESTRO_DELEGATE_TOOL_DESCRIPTION,
  MAESTRO_DELEGATE_TOOL_SCHEMA,
  maestroAgentsFromTurn,
  prepareMaestroDelegation,
  renderMaestroAgentCatalog,
} from './maestro-delegation'
import { MAESTRO_SYSTEM_SPEC, renderMaestroTurnPolicy } from './maestro-prompt'
import type { MaestroLiveRunPort } from './maestro-live'
import { recordModelCallUsage } from './usage-diagnostics'
import { applyFastModeServiceTier } from './fast-mode'
export {
  canReplayOpenAILedger,
  hasSubagentMutationInLedger,
  isNonReplayableSubagentMutation,
  isOpenAINativeCompactionPart,
  prepareOpenAISubagentRetryLedger,
  subagentPermissionAssertInput,
} from './subagent-runner'
export { isRetryableStreamError } from './retry-policy'
import { gitEnvInfo } from '../git-service'
import { stagePlan } from '../plan-broker'
import type { PermissionBroker } from './permission'
import { isOpenAIHarnessActive, OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE, openAIHarnessProviderOptions } from './harness'
import { compileOpenAIPrompt, openAINativeToolsPromptOverlay } from './openai/prompt'
import { compileOpenAIAstraPrompt } from './openai/astra-prompt'
import {
  isAstraHarnessProfile,
  OPENAI_GPT6_ASTRA_PROMPT_PROFILE,
} from './model-harness-profile'
import { buildOpenAIModelMessages } from './openai/history'
import {
  advanceOpenAICompactionLifecycle,
  commitOpenAICompactionLifecycle,
  createOpenAICompactionLifecycle,
  durableOpenAILedger,
  rollbackOpenAICompactionLifecycle,
  type OpenAICompactionLifecycle,
} from './openai/compaction-lifecycle'
import { createOpenAIResponsesLedger } from './openai/ledger'
import type { OpenAILedgerValue, OpenAIResponsesLedger, OpenAIStreamEventLike } from './openai/types'
import {
  canReplayOpenAIInferenceState,
  getOpenAIInferenceState,
  OPENAI_INFERENCE_STATE_VERSION,
  putChatMessageWithOpenAIInferenceState,
  putOpenAIInferenceState,
} from './openai/inference-store'
import { withOpenAIRawResponsesPrefix, withoutOpenAIRawResponsesPrefix } from './openai/raw-input'
import { optimizeOpenAITools } from './openai/tools'
import { reconcileOpenAIToolExecutions, wrapOpenAIToolExecutions } from './openai/execution'
import {
  buildOpenAINativeTools,
  isOpenAINativeFailedOutput,
  isOpenAINativePermissionDeniedOutput,
  OPENAI_APPLY_PATCH_TOOL_NAME,
  OPENAI_LOCAL_SHELL_TOOL_NAME,
  openAINativeOutputText,
} from './openai/native-tools'

const MAX_STEPS = 48
// ULTRA PARENT agent cap. Workers stay at 48 and share an aggregate per-turn coordinator budget.
const ULTRA_MAX_STEPS = 96
// CONSECUTIVE reinvocations for transparent CONTINUATION after truncated/cut streams
// (SSE without terminal, finish 'other'/'tool-calls'/'length'…). Stay in the SAME bubble, feeding
// partials back as history. Limits consecutive attempts WITHOUT PROGRESS — a continuation with real
// progress (≥ PROGRESS_RESET_STEPS) REARMS the counter (legitimate long tasks exceed MAX_STEPS repeatedly
// and must not die at 3×48; diagnostics showed eight 48-step overflows in two days). Global HARD cap
// (MAX_TOTAL_CONTINUES) still bounds cost → exhaustion produces the "interrupted" marker.
const MAX_CONTINUE = 2
const PROGRESS_RESET_STEPS = 8
const MAX_TOTAL_CONTINUES = 24
// INTRA-turn context guard (context-guard.ts): stop at a step boundary when occupancy
// crosses 90% of effective window → compact → continue in SAME bubble. 90% (human decision,
// aligned with send AUTO_COMPACT_RATIO) leaves room for (a) a large next step (tool output
// — actual 502 came from growth from 73% to 100% within one turn) and (b) the compaction call
// ITSELF (sends transcript to the same model — also overflows at 100%). If large steps cause
// mid-turn 502s again, lowering this takes one line.
export const IN_TURN_COMPACT_RATIO = 0.9
const MAX_IN_TURN_COMPACTS = 2

// MODE-AWARE prompt: tool descriptions must match the ACTUAL toolset, otherwise models
// (e.g. MiMo) assume tools exist and try calling them (or emit tool calls as text). See runChat modes.
export const SYSTEM_PROMPT = (cwd: string, appToolsEnabled: boolean, mode: ChatBehavior, hasNotesTab: boolean) => {
  const base = `You are a coding assistant inside the Maestrly app, working with the user on the project at ${cwd}. Reply in the user's language, in Markdown.

# Style
Be concise, direct and objective — like a senior engineer pairing, not a tutorial. Lead with the answer or the result. No preamble ("Sure, here's…", "Let me…") and no postamble ("Let me know if…", "Hope this helps"); don't restate the question or narrate routine steps. Match the length to the request: a simple question gets a sentence or two; a real task gets the detail it needs and no more. What matters is the user understanding you without re-reading — clear beats merely short, so don't be terse to the point of being cryptic. Explain your reasoning only when it isn't obvious or the user asks; after a change, say what you did and the outcome in a line or two and don't re-explain code you just wrote. Stop once the question is answered — don't pad with caveats, recaps or repetition. No emojis unless the user uses them first. Reference code as \`file_path:line_number\` so the user can jump to it.

# Working on the project
Read a file before editing it or proposing changes to it — understand the existing code first. Match the conventions already in the file (naming, formatting, libraries, patterns); don't impose your own style. Prefer editing an existing file over creating a new one; create files only when truly necessary. Add a comment only when the WHY is non-obvious — don't narrate WHAT the code does. After a change, verify it actually works when you can (run the test/build/script) and report the result FAITHFULLY: if something fails or you didn't verify, say so plainly — never imply a success you didn't check. When something fails, diagnose the cause before retrying or switching tactics, and don't bypass safety checks (e.g. --no-verify) to make an error go away. You're a collaborator, not just an executor: if the request rests on a wrong assumption or you spot an adjacent bug, say so. Don't pad with flattery or time estimates. For non-trivial multi-step work, keep a running to-do list with the \`todo_write\` tool (one item in_progress at a time) so you stay organized and the user can follow along.

# Using your tools
Prefer the dedicated tools over the shell: \`read\` to read files (not cat/head/tail/sed), \`edit\`/\`write\` to change them (not sed/awk/echo redirection), \`grep\`/\`glob\` to search (not grep/find/ls) — they let the user review your work cleanly and are faster. Reserve \`bash\` for real shell/system work (build, tests, git, running scripts). When you decide to use a tool, call it in the SAME turn — don't announce "I'll read the file" and then stop and wait for the user. When several tool calls are independent (none needs another's result), make them in parallel in one response; only go sequential when a call genuinely depends on a previous result.`

  const restrictedCapabilities =
    'Besides read/search tools, you may receive external MCP tools explicitly declared read-only and permitted ' +
    'Maestrly app tools for notes, memory search/list/read, web navigation/read, and terminal output. ' +
    'Those catalogs remain permission-gated. Do NOT edit project files or run commands: code/file writes, shell ' +
    'execution, page interaction through click/type/drag/key/mouse/evaluate, debug, implementation delegation, ' +
    'Git/PR changes are unavailable.'
  const capability =
    mode === 'maestro'
      ? `\n\nMAESTRO EXPERIENCE: the parent is structurally read-only. You may inspect with read/search tools and coordinate through delegate, but you cannot edit, write, run shell commands, test, build, generate mutable artifacts, or invoke mutating MCP/app tools directly.\n\n${MAESTRO_SYSTEM_SPEC}`
      : mode === 'ask'
        ? `\n\nASK MODE (restricted tools): use the available read and safe-recording tools to ground your answer in real project context. ${restrictedCapabilities} If the task requires changing the project or running commands, tell the user to switch to Agent mode (they toggle it with Shift+Tab).`
        : mode === 'plan'
          ? `\n\nPLAN MODE (restricted tools): investigate with the available read and safe-recording tools. ${restrictedCapabilities} Record the final plan by calling review_plan ("plan" argument in Markdown + a short "title"): that submits it to the "Plan" tab in the drawer for the user to review, edit and approve or discard. Calling review_plan ENDS your turn — do NOT keep writing or call other tools after it. If the user approves, a new turn starts to implement the plan. Do NOT dump the plan in the text only: leave at most a 1-2 line summary and ALWAYS finish by calling review_plan.`
          : `\n\nYou have tools to read/search/edit files and run commands. Prefer small, verifiable actions. Before editing, read the relevant snippet. Dangerous actions (bash, writing/editing files, fetching URLs) ask for the user's approval — briefly explain why before calling them.`

  const render = `\n\nRendering: the chat supports full Markdown, including GFM tables and Mermaid DIAGRAMS. For any diagram (flow, architecture, sequence, etc.) use a \`\`\`mermaid block instead of drawing ASCII art — it renders as a real visual diagram.`

  const appToolGroups = hasNotesTab
    ? 'terminal, browser, notes, memory, debug'
    : 'terminal, browser, memory, debug'
  const appToolPrefixes = hasNotesTab
    ? 'terminal_*, browser_*, notes_*, memory_*, debug_*'
    : 'terminal_*, browser_*, memory_*, debug_*'
  const preferredDrawerTools = hasNotesTab ? 'terminal_*/memory_*/notes_*' : 'terminal_*/memory_*'
  const restrictedAppTools =
    mode === 'maestro'
      ? hasNotesTab
        ? 'notes list/read, memory search/list/read, browser inspection/read, and terminal read'
        : 'memory search/list/read, browser inspection/read, and terminal read'
      : hasNotesTab
        ? 'notes list/read/create/write/append, memory search/list/read, browser navigation/read, and terminal read'
        : 'memory search/list/read, browser navigation/read, and terminal read'
  const appTools = `\n\nMaestrly app tools (${appToolGroups}): ${
    appToolsEnabled
      ? mode === 'agent'
        ? `ON — you receive them NATIVELY in your tool set (${appToolPrefixes}). Use them directly. PREFER ${preferredDrawerTools} over your equivalent native tools (bash/read/edit and your own memory) when the user should see, follow or edit the result in the drawer — running a server, a long build, a script, recording a decision or a durable project rule: that way they follow along in the UI. A quick internal one-off (e.g. git status) can stay on the native tools.`
        : `ON with this mode's restricted catalog: ${restrictedAppTools}. Use only the tools actually exposed; mutating tools outside this list remain unavailable.`
      : 'OFF right now. If you need them, ASK the user to enable "Maestrly tools" in Settings › Maestrly Chat.'
  }\nNEVER try to reach the app via curl/HTTP or inspect legacy local credentials. The app tools, when on, already arrive ready in your toolset (no network, no token).`

  return base + capability + render + appTools + `\n\n${MEMORY_TOOL_GUIDANCE}`
}

const PERMISSION_ERROR_NAMES = new Set(['PermissionRejectedError', 'PermissionCorrectedError', 'PermissionDeniedError'])

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/**
 * Provider-error heuristic for rejected image/multimodal content. Combined with
 * `sentImages` (turn sent an image): both true → learn `imagesUnsupported`.
 */
export function isImageRelatedProviderError(message: string): boolean {
  return /\b(image|image_url|vision|multimodal|modalit)\w*/i.test(message)
}

/** Restores a cut reason when a gateway exposes it only through rawFinishReason. */
export function normalizeStreamFinishReason(finishReason: unknown, rawFinishReason?: unknown): string {
  const unified = typeof finishReason === 'string' ? finishReason : 'stop'
  if ((unified !== 'stop' && unified !== 'other') || typeof rawFinishReason !== 'string') return unified
  if (rawFinishReason === 'max_output_tokens' || rawFinishReason === 'max_tokens') return 'length'
  if (rawFinishReason === 'incomplete') return 'interrupted'
  return CUT_FINISH_REASONS.has(rawFinishReason) ? rawFinishReason : unified
}

/** Unified reasons normally suffice, but some gateways expose a cutoff only in rawFinishReason. */
export function isCutStreamFinish(finishReason: unknown, rawFinishReason?: unknown): boolean {
  return CUT_FINISH_REASONS.has(normalizeStreamFinishReason(finishReason, rawFinishReason))
}

export type StreamTermination = 'finished' | 'aborted' | 'error' | 'truncated'

/** Classifies a drained fullStream; absence of every terminal event is a raw transport cutoff. */
export function classifyStreamTermination(state: {
  finished: boolean
  aborted: boolean
  errored: boolean
}): StreamTermination {
  if (state.aborted) return 'aborted'
  if (state.errored) return 'error'
  return state.finished ? 'finished' : 'truncated'
}

export type AiUsageLike = {
  inputTokens?: unknown
  outputTokens?: unknown
  cachedInputTokens?: unknown
  inputTokenDetails?: { noCacheTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } | null
}

export interface NormalizedAiUsage {
  input: number // Uncached.
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Single AI SDK → disjoint-bucket boundary. `inputTokens` includes cache reads/writes. */
export function normalizeAiUsage(usage: AiUsageLike | null | undefined): NormalizedAiUsage {
  const reportedTotal = tokenCount(usage?.inputTokens)
  const output = tokenCount(usage?.outputTokens)
  const reportedRead = tokenCount(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens)
  const reportedCreate = tokenCount(usage?.inputTokenDetails?.cacheWriteTokens)
  if (reportedTotal > 0) {
    const cacheRead = Math.min(reportedRead, reportedTotal)
    const cacheCreate = Math.min(reportedCreate, reportedTotal - cacheRead)
    const input = reportedTotal - cacheRead - cacheCreate
    return { input, output, cacheRead, cacheCreate, totalInput: reportedTotal }
  }
  // Some adapters omit totals while supplying details.
  const input = tokenCount(usage?.inputTokenDetails?.noCacheTokens)
  return {
    input,
    output,
    cacheRead: reportedRead,
    cacheCreate: reportedCreate,
    totalInput: input + reportedRead + reportedCreate,
  }
}

export function addNormalizedUsage(
  target: NormalizedAiUsage,
  usage: AiUsageLike | null | undefined
): NormalizedAiUsage {
  const next = normalizeAiUsage(usage)
  target.input += next.input
  target.output += next.output
  target.cacheRead += next.cacheRead
  target.cacheCreate += next.cacheCreate
  target.totalInput += next.totalInput
  return target
}

/** Fills missing steps using `finish.totalUsage`; final totals also refine cache breakdown. */
export function reconcileNormalizedUsage(
  target: NormalizedAiUsage,
  observed: NormalizedAiUsage,
  totalUsage: AiUsageLike | null | undefined
): NormalizedAiUsage {
  const total = normalizeAiUsage(totalUsage)
  if (observed.totalInput <= total.totalInput) {
    target.input += total.input - observed.input
    target.cacheRead += total.cacheRead - observed.cacheRead
    target.cacheCreate += total.cacheCreate - observed.cacheCreate
    target.totalInput += total.totalInput - observed.totalInput
  }
  if (observed.output <= total.output) target.output += total.output - observed.output
  return target
}

/** Context estimate immediately after compaction, until next finish-step reports actual usage. */
export function compactedContextTokens(summary: string, usage?: NormalizedAiUsage): number {
  return usage?.output ? usage.output : Math.ceil(summary.length / 4)
}

export function buildPersistedUsage(
  main: NormalizedAiUsage,
  contextInput: number,
  contextOutput: number,
  hasContextUsage: boolean,
  sub: NormalizedAiUsage,
  subagentUsage: ChatSubagentUsage[],
  contextIdentity?: string
): StoredChatUsage | undefined {
  // Auxiliary calls can be the only measured work when the parent stream aborts before
  // its first usage event. Keep their detailed breakdown instead of dropping the envelope.
  if (!main.totalInput && !main.output && !sub.totalInput && !sub.output && !subagentUsage.length) return undefined
  return {
    usageVersion: 2,
    input: main.input,
    output: main.output,
    ...(hasContextUsage ? { contextInput, contextOutput } : {}),
    // INTERNAL backend identity — StoredChatUsage only; public event uses toPublicChatUsage.
    ...(contextIdentity ? { contextIdentity } : {}),
    ...(main.cacheRead ? { cachedInput: main.cacheRead } : {}),
    ...(main.cacheCreate ? { cacheCreate: main.cacheCreate } : {}),
    ...(sub.totalInput || sub.output || subagentUsage.length
      ? {
          subInput: sub.input,
          subOutput: sub.output,
          ...(sub.cacheRead ? { subCachedInput: sub.cacheRead } : {}),
          ...(sub.cacheCreate ? { subCacheCreate: sub.cacheCreate } : {}),
          ...(subagentUsage.length ? { subagentUsage: subagentUsage.map((u) => ({ ...u })) } : {}),
        }
      : {}),
  }
}

export interface RunChatArgs {
  conversationId: string
  /** workspaceId — key for saved permission rules. */
  projectId: string
  cwd: string
  selection: ChatModelRef
  broker: PermissionBroker
  questionBroker: QuestionBroker
  emit: (ev: ChatStreamEvent) => void
  signal: AbortSignal
  assistantMessageId: string
  assistantCreatedAt: number
  /** EFFECTIVE context window (provider/models.dev/manual limit, resolved in service) enables the
   * intra-turn guard. Absent → no guard (existing behavior). */
  contextWindow?: number
  /** Send acceptance timestamp, before automatic compaction, persistence, and runner setup. */
  responseStartedAt: number
  /** Summarizes active context without a separate milestone; runner inserts boundary into live bubble. */
  compactHistory?: () => Promise<{
    summary: string
    usage?: NormalizedAiUsage
    runtimeEstimatedCostUsd?: number
  } | null>
  /**
   * Frozen internal-turn selection (review-loop): runner does NOT reread ui_prefs. Service ALWAYS
   * sets an explicit loop value (`'off'` = no effort, materialized default); absence
   * means "no override" → runner rereads live prefs.
   */
  reasoningOverride?: string
  /** Frozen EFFECT (after resolving Ultra): LIVE resolution must produce the SAME value
   * in isolated execution (fail-closed). Absent = no effort ('off'/Default). */
  frozenReasoningEffort?: string
  modeOverride?: 'agent' | 'plan' | 'ask'
  behaviorOverride?: ChatBehavior
  /** Frozen at turn admission; settings changes cannot reinterpret an in-flight delegate call. */
  maestro?: MaestroTurnSnapshotV1
  /** Maestro run inbox delivered with the next root delegate result. */
  maestroLive?: MaestroLiveRunPort
  /** Frozen Fast Mode (review-loop); when defined, runner does NOT reread ui_prefs. */
  fastModeOverride?: boolean
  /** Isolated review-loop: transcript = execution; metadata centralized on bubble. */
  ephemeralSession?: boolean
  messageMeta?: {
    source?: import('../../shared/chat').ChatMessageSource
    internal?: boolean
    executionScope?: import('../../shared/chat').ChatExecutionScope
    reviewLoop?: import('../../shared/chat').ChatReviewLoopMeta
  }
  executionScope?: import('../../shared/chat').ChatExecutionScope
  /** Exact host-owned capability surface for an isolated read-only reviewer round. */
  reviewerRuntime?: ReviewerToolRuntime
}

export interface RunChatResult {
  /** Turn ended by `review_plan` submission; broker already emitted the dedicated plan alert. */
  planSubmitted: boolean
}

/**
 * EFFECTIVE turn Fast Mode: frozen `fastModeOverride` (review-loop) takes precedence; normal path
 * rereads ui_prefs. SINGLE source — service freezes profile, but this converts value to transport.
 */
export function resolveTurnFastMode(override: boolean | undefined, prefsFastMode: boolean): boolean {
  return typeof override === 'boolean' ? override : prefsFastMode
}

/**
 * EFFECTIVE BYOK turn effort: frozen `reasoningOverride` (review-loop, including explicit `'off'`)
 * takes precedence; normal path without override rereads ui_prefs. Mirrors resolveTurnFastMode.
 */
export function resolveTurnReasoning(
  override: string | undefined,
  prefsReasoning: string | undefined
): string | undefined {
  return override !== undefined ? override : prefsReasoning
}

/**
 * Isolated execution (review-loop) effort FAIL-CLOSED: frozen EFFECT (effective value resolved
 * at freeze) must be reproduced EXACTLY against LIVE metadata — unlisted level, empty list
 * (no evidence), offline metadata, or Ultra with changed list (different effective value) must never
 * run with degraded/substituted effort (throws `executor-unavailable` so loop ends with correct
 * reason). Manual turns pass no override and never enter here (still permissive).
 */
export function assertFrozenEffortReproducible(args: {
  ephemeralSession?: boolean
  reasoningOverride: string | undefined
  frozenReasoningEffort: string | undefined
  providerKind: ChatProviderKind
  meta: Pick<ChatModelMeta, 'reasoning' | 'reasoningEfforts'> | null | undefined
}): void {
  if (!args.ephemeralSession || args.reasoningOverride === undefined) return
  if (!frozenEffortReproducible(args.providerKind, args.reasoningOverride, args.frozenReasoningEffort, args.meta)) {
    throw new Error('executor-unavailable')
  }
}

/**
 * xAI Priority Processing: Fast enabled on Grok injects `service_tier: "priority"` into the
 * openai-compatible body (extra field accepted by @ai-sdk/openai-compatible outside typed schema).
 * Returns original options or a tier-bearing copy — testable without running a turn.
 */
// Kept as a stable import surface for callers/tests that historically imported this helper from runner.ts.
export { applyFastModeServiceTier } from './fast-mode'

/**
 * Runs a complete assistant turn (possibly multiple tool calls). Persists the resulting
 * assistant message. Throws only on configuration errors (missing key); stream errors become
 * 'error'/'aborted' events.
 */
export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    conversationId,
    projectId,
    cwd,
    selection,
    broker,
    questionBroker,
    emit,
    signal,
    assistantMessageId,
    assistantCreatedAt,
    responseStartedAt,
    contextWindow,
    compactHistory,
  } = args

  // Turn context: isolated review-loop → execution only; normal turn → MAIN context
  // (isolated rounds NEVER seed/replay into manual turns). UI/audit still use listChatMessages.
  const history = runnerContextHistory(conversationId, {
    ephemeralSession: args.ephemeralSession,
    executionScope: args.messageMeta?.executionScope,
  })
  // Resolve transport + profile once. Internal kill switch enables immediate rollback without changing
  // HTTP provider; unknown IDs/formats conservatively retain the legacy harness.
  const openAIHarnessEnabled = getAppFlag('chat.openAIHarness', true)
  const astraHarnessEnabled = getAppFlag('chat.astraHarness', true)
  const resolvedModel = resolveChatModel(selection.providerId, selection.modelId, { astraHarnessEnabled })
  const modelHarnessProfileId = resolvedModel.modelHarnessProfileId ?? 'openai-default-v1'
  const useOpenAIHarness = isOpenAIHarnessActive(openAIHarnessEnabled, resolvedModel.harnessProfile)
  const model = resolvedModel.model
  const assistantId = assistantMessageId
  const createdAt = assistantCreatedAt
  let msgs: StoredChatMessage[] = [
    {
      id: assistantId,
      conversationId,
      role: 'assistant',
      parts: [],
      model: selection,
      // Immutable during turn: persisted reasoning replay requires the SAME backend (URL/kind/key)
      // that produced the message — retries/continuations never recompute this identity.
      providerFingerprint: resolvedModel.providerFingerprint,
      ...(args.messageMeta ?? {}),
      createdAt,
    },
  ]
  let openAILifecycle: OpenAICompactionLifecycle | null = useOpenAIHarness
    ? createOpenAICompactionLifecycle(createOpenAIResponsesLedger())
    : null

  // Throttle persistence (fast text streaming; SQLite is synchronous, but do not write per token).
  let lastPersistAt = 0
  let dirty = false
  const persistNow = (ledgerOverride?: OpenAIResponsesLedger) => {
    lastPersistAt = Date.now()
    dirty = false
    if (openAILifecycle) {
      putChatMessageWithOpenAIInferenceState(msgs[0], {
        version: OPENAI_INFERENCE_STATE_VERSION,
        providerId: selection.providerId,
        modelId: selection.modelId,
        providerFingerprint: resolvedModel.providerFingerprint,
        modelHarnessProfileId,
        ledger: ledgerOverride ?? durableOpenAILedger(openAILifecycle),
      })
    } else upsertChatMessage(msgs[0])
  }
  // Streaming coalescer (#559): batches text-delta/reasoning-delta for RENDERER (~40 ms), preserving
  // order (drain before every non-delta) and folding. Persistence below still processes every event.
  const coalescer = createDeltaCoalescer(emit)
  /**
   * Folds event into internal bubble and publishes to renderer.
   * Optional `publicEv`: IPC version WITHOUT `contextIdentity`/`providerFingerprint` — for internal
   * usage events, caller supplies public projection here. Otherwise coalescer receives `ev`
   * (no usage or already public).
   */
  const apply = (ev: ChatStreamEvent, force = false, publicEv?: ChatStreamEvent) => {
    // Shared fold never creates/discards the bubble under construction (msgs[0] exists from start;
    // message-start finds it by ID → spread patch `...m`), so internal fingerprint + contextIdentity
    // survive intact; cast only supplies typing (public ChatMessage/ChatUsage omit them).
    msgs = applyChatEvent(msgs, ev) as StoredChatMessage[]
    coalescer.push(publicEv ?? ev)
    if (force) persistNow()
    else if (Date.now() - lastPersistAt > 300) persistNow()
    else dirty = true
  }

  /** Builds internal full-usage event + public event without contextIdentity. */
  const withStoredUsage = (
    base: ChatStreamEvent,
    usage: StoredChatUsage | undefined
  ): { stored: ChatStreamEvent; public: ChatStreamEvent } => {
    const stored = { ...base, ...(usage ? { usage } : {}) } as ChatStreamEvent
    const publicUsage = toPublicChatUsage(usage)
    const pub = { ...base, ...(publicUsage ? { usage: publicUsage } : {}) } as ChatStreamEvent
    return { stored, public: pub }
  }

  // Empty placeholder + renderer start signal.
  upsertChatMessage(msgs[0])
  coalescer.push({
    kind: 'message-start',
    messageId: assistantId,
    model: selection,
    createdAt,
    responseStartedAt,
    ...(args.messageMeta?.source ? { source: args.messageMeta.source } : {}),
    ...(args.messageMeta?.reviewLoop ? { reviewLoop: args.messageMeta.reviewLoop } : {}),
  })

  // Mode is a per-turn snapshot. Plan/ask receive read-only built-ins and filtered MCP/app catalogs;
  // plan adds review_plan + skills; ask omits these extra actions.
  const mode: ChatBehavior =
    args.behaviorOverride ?? args.modeOverride ?? getConvUiPrefs(conversationId).chat?.mode ?? 'agent'
  const conversation = getConversation(conversationId)
  const hasNotesTab = Boolean(conversation)
  const enabledNames = args.reviewerRuntime
    ? new Set(REVIEWER_READONLY_TOOL_NAMES)
    : builtinToolNamesForMode(mode)

  // Metadata must arrive before classifying `ultra`: GPT-5.6 treats it as REAL effort; older conversations
  // on models not advertising it used the same raw value as Maestrly's legacy sentinel.
  const reasoningEffort = resolveTurnReasoning(args.reasoningOverride, getConvUiPrefs(conversationId).chat?.reasoning)
  // Same dynamic metadata as selector: exact provider when present, otherwise canonical model ID.
  const selectedProvider = getProvider(selection.providerId)
  const selectedCatalogProviderId = selectedProvider ? catalogProviderForBaseURL(selectedProvider.baseURL) : null
  const metaResult = await getProviderModelMetaWithStatus(selection.modelId, selectedCatalogProviderId)
  const meta = metaResult.meta
  // Tool results obey the same capability decision as user attachments. The callback is only invoked for
  // image blocks and keeps the interpreter/cache entirely outside the persisted conversation.
  const imagesFlagged = getConvUiPrefs(conversationId).chat?.imagesUnsupported === true
  const dropImages = !supportsChatToolImages({ modelVision: meta?.vision, runtimeImageUnsupported: imagesFlagged })
  // Interleaved reasoning replay (DeepSeek/GLM/Kimi via chat/completions): enable for compatible
  // transport with catalog `interleaved.field = reasoning_content` (or known family ID with
  // unavailable catalog). Effort selection does NOT affect it: 'off'/Default only omits
  // effort override — provider may still emit reasoning and require replay.
  const replayPolicy = resolveInterleavedReplayPolicy({
    transport: resolvedModel.transport,
    providerId: selection.providerId,
    modelId: selection.modelId,
    providerFingerprint: resolvedModel.providerFingerprint,
    meta,
    catalogStatus: metaResult.status,
    reasoningEffort,
  })
  const replayStats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
  const persistedReplayStats: PersistedReplayStats = {
    replayedSteps: 0,
    degradedProviderMismatch: 0,
    degradedModelMismatch: 0,
    degradedFingerprintMissing: 0,
    degradedFingerprintMismatch: 0,
  }
  const streamModel = replayPolicy ? wrapInterleavedReplayModel(model, replayPolicy, replayStats) : model
  chatDiag({
    kind: 'interleaved-replay-policy',
    provider: selection.providerId,
    model: selection.modelId,
    transport: resolvedModel.transport,
    conv: conversationId,
    effort: reasoningEffort ?? undefined,
    active: replayPolicy != null,
    ...(replayPolicy
      ? { field: replayPolicy.field }
      : {
          reason:
            resolvedModel.transport !== 'openai'
              ? 'transport'
              : meta == null && metaResult.status === 'unavailable'
                ? 'catalog-miss'
                : 'no-capability',
        }),
  })
  const astraEfforts = resolvedModel.capabilities.serializableReasoningEfforts ?? []
  const effectiveReasoningEfforts = isAstraHarnessProfile(modelHarnessProfileId)
    ? astraEfforts.filter((effort) => !meta?.reasoningEfforts?.length || meta.reasoningEfforts.includes(effort))
    : (meta?.reasoningEfforts ?? [])
  const reasoningMeta = isAstraHarnessProfile(modelHarnessProfileId)
    ? { reasoning: effectiveReasoningEfforts.length > 0, reasoningEfforts: effectiveReasoningEfforts }
    : meta
  const ultra = isMaestrlyUltraEffort(reasoningEffort, effectiveReasoningEfforts)
  const turnMaxSteps = ultra ? ULTRA_MAX_STEPS : MAX_STEPS
  const subagentCoordinator = new SubagentCoordinator({
    onEvent: (event) =>
      chatDiag({ kind: 'subagent-coordinator', runtime: 'byok-ai-sdk', conv: conversationId, ...event }),
  })

  // Models come dynamically from /models (no capability flag) → enable tools by mode; if function calling
  // is unsupported, provider errors/ignores and turn degrades (see PORT-PLAN).
  // review_plan (submit & release): registers drawer plan and sets this flag; stopWhen cuts the
  // turn at the NEXT step boundary (no further model step). User decision starts a
  // new turn. Do NOT trust the model to stop — enforce the cut in the runner.
  let planSubmitted = false
  const makeMainToolContext = (toolCallId: string, toolSignal: AbortSignal): ToolContext => ({
    conversationId,
    projectId,
    messageId: assistantId,
    toolCallId,
    cwd,
    signal: toolSignal,
    ask: (action, resources, save) => {
      if (args.reviewerRuntime) {
        if (action === 'read' || action === 'grep' || action === 'glob') return Promise.resolve()
        return Promise.reject(new Error(`Reviewer capability denied: ${action}`))
      }
      return broker.assert({
        conversationId,
        projectId,
        action,
        resources,
        save,
        toolName: action,
        toolCallId,
        signal: toolSignal,
      })
    },
    // ask_question (mark X): blocks until user answers chat card (or dismisses → []).
    askQuestion: (questions) =>
      args.reviewerRuntime
        ? Promise.reject(new Error('Reviewer capability denied: ask_question'))
        : questionBroker.ask({ conversationId, messageId: assistantId, toolCallId, questions, signal: toolSignal }),
    ...(args.reviewerRuntime
      ? {
          reviewer: {
            ...args.reviewerRuntime,
            submitReview: (decision) => {
              const result = args.reviewerRuntime!.submitReview(decision)
              if (result.ok) planSubmitted = true
              return result
            },
          },
        }
      : {
          submitPlan: (plan: string, title?: string) => {
            const result = stagePlan({ agentId: conversationId, cwd, plan, title })
            planSubmitted = result.ok
            return result.ok
          },
          emitGeneratedImage: (image: GeneratedImageEmission) =>
            emitGeneratedImagePart(apply, assistantId, toolCallId, image),
          onGeneratedImageUsage: recordGeneratedImageUsage,
        }),
  })
  // generate_image is OPT-IN: requires global/conversation imagegen toggle and connected ChatGPT
  // subscription — it generates the image even when the conversation uses another provider.
  if (!args.reviewerRuntime && (await generateImageToolEnabled(conversationId, mode))) {
    enabledNames.add(GENERATE_IMAGE_TOOL_NAME)
  }
  const tools = buildTools({
    enabled: enabledNames,
    makeCtx: makeMainToolContext,
  })

  const mcpGate = (toolName: string, toolCallId: string, toolSignal?: AbortSignal) => {
    return broker.assert({
      conversationId,
      projectId,
      action: 'mcp',
      resources: [toolName],
      save: ['*'],
      toolName,
      toolCallId,
      signal: toolSignal,
    })
  }

  // PER-CONVERSATION tool overrides (ui_prefs.chat.tools): app-tools on/off + disabled MCP servers.
  const convTools = getConvUiPrefs(conversationId).chat?.tools
  const mcpDisabled = new Set(convTools?.mcpDisabled ?? [])
  const appToolsEnabled = convTools?.app ?? getAppFlag('chat.appTools', false)

  // MCP servers follow enabled + conversation override. Wrapper retains everything in Agent, filters
  // defensively by annotations in Plan/Ask; all calls remain gated under action 'mcp'.
  const mcp = args.reviewerRuntime
    ? { tools: {}, close: async () => {} }
    : await buildMcpTools({
        mode,
        signal,
        gate: mcpGate,
        disabledIds: mcpDisabled,
        supportsImages: true,
        describeImage: (image) => describeEphemeralToolImage({ image, conversationId, cwd, signal }),
      })

  // App-tools remain opt-in. Wrapper preserves Agent catalog and applies product allowlist in restricted
  // modes. Blocking MCP review_plan is always excluded; Plan uses built-in submit & release.
  const app =
    !args.reviewerRuntime && appToolsEnabled
      ? await buildAppTools({
          conversationId,
          mode,
          gate: mcpGate,
          exclude: new Set(['review_plan']),
          supportsImages: true,
          describeImage: (image) => describeEphemeralToolImage({ image, conversationId, cwd, signal }),
        })
      : { tools: {}, close: async () => {} }

  // Project skills (model-discovered SKILL.md folders): prompt catalog + use_skill tool to load
  // body + root + inventory on demand. In plan/agent; ask stays lean (read to answer, no
  // skill catalog). DISABLED skills (global/conversation) never enter or consume context.
  const skills =
    args.reviewerRuntime || mode === 'ask'
      ? []
      : (await effectiveSkills(cwd, conversationId)).filter((s) => s.modelInvocable)
  const skillTools: ToolSet = skills.length
    ? {
        use_skill: tool({
          description:
            'Loads the full instructions of a project SKILL (by name). Call this BEFORE performing a ' +
            'task covered by a skill listed in the system prompt; the return value is the instructions to follow.',
          inputSchema: jsonSchema<{ name: string }>({
            type: 'object',
            properties: { name: { type: 'string', description: 'skill name (as listed in the system prompt)' } },
            required: ['name'],
          }),
          execute: async ({ name }) => {
            const skill = await findEffectiveSkill(cwd, conversationId, name)
            // Disabled, absent, or `disable-model-invocation` = nonexistent to the model.
            return skill?.modelInvocable
              ? renderSkillContext(skill)
              : `Skill "${name}" not found. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`
          },
        }),
      }
    : {}

  // Subagents (.claude/agents + .agents/agents + global ~): full catalog only in agent mode. In ULTRA,
  // plan/ask also receive `task`, restricted to `explore` (parallel read-only investigation — preserves
  // these modes' read-only contract; runSubagent also clamps tools via readOnly). Model delegates
  // subtasks via `task` → ISOLATED sub-run (no nested `task` → no recursion). Catalog in prompt.
  const agents = args.reviewerRuntime
    ? []
    : mode === 'maestro' && args.maestro
      ? maestroAgentsFromTurn(args.maestro, await listEffectiveAgents({ cwd, conversationId, mode: 'agent' }))
      : mode === 'agent'
        ? await listEffectiveAgents({ cwd, conversationId, mode: 'agent' })
        : ultra
          ? (await listEffectiveAgents({ cwd, conversationId, mode: 'plan' })).filter((a) => a.name === 'explore')
          : []
  // Explicit user-named agents for this turn — host guard blocks silent substitution.
  const selectableAgentNames = agents.map((agent) => agent.name)
  const subagentTurnState = createExplicitSubagentTurnState(
    detectExplicitSubagentsForTurn(history, selectableAgentNames),
    selectableAgentNames
  )
  const subagentsReadOnly = mode === 'plan' || mode === 'ask'
  // SUBAGENT tokens consumed this turn (added to main turn cost — see finish). Excluded from
  // "context %" (isolated subagent context, not conversation window).
  const subUsage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  const subagentUsage: ChatSubagentUsage[] = []
  // PER-CALL `task` metrics (tokens+duration) attached to final part state in tool-result/tool-error
  // cases → persist with message and display in SubagentCard (including after reload).
  const subagentRunMeta = new Map<string, SubagentRunMeta>()
  const recordSubagentUsage = (
    model: ChatModelRef,
    usage?: NormalizedAiUsage,
    runtimeEstimatedCostUsd?: number
  ): void => {
    if (!usage && runtimeEstimatedCostUsd == null) return
    const existing = subagentUsage.find((u) => u.providerId === model.providerId && u.modelId === model.modelId)
    if (existing) {
      existing.input += usage?.input ?? 0
      existing.output += usage?.output ?? 0
      if (usage?.cacheRead) existing.cachedInput = (existing.cachedInput ?? 0) + usage.cacheRead
      if (usage?.cacheCreate) existing.cacheCreate = (existing.cacheCreate ?? 0) + usage.cacheCreate
      if (runtimeEstimatedCostUsd == null && usage) {
        existing.catalogInput = (existing.catalogInput ?? 0) + usage.input
        existing.catalogOutput = (existing.catalogOutput ?? 0) + usage.output
        existing.catalogCacheRead = (existing.catalogCacheRead ?? 0) + usage.cacheRead
        existing.catalogCacheCreate = (existing.catalogCacheCreate ?? 0) + usage.cacheCreate
      }
      if (runtimeEstimatedCostUsd != null) {
        existing.runtimeEstimatedCostUsd = (existing.runtimeEstimatedCostUsd ?? 0) + runtimeEstimatedCostUsd
      }
      return
    }
    subagentUsage.push({
      ...model,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      ...(usage?.cacheRead ? { cachedInput: usage.cacheRead } : {}),
      ...(usage?.cacheCreate ? { cacheCreate: usage.cacheCreate } : {}),
      ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
      ...(runtimeEstimatedCostUsd == null && usage
        ? {
            catalogInput: usage.input,
            catalogOutput: usage.output,
            catalogCacheRead: usage.cacheRead,
            catalogCacheCreate: usage.cacheCreate,
          }
        : {}),
    })
  }
  const recordGeneratedImageUsage = (imageUsage: GeneratedImageUsage): void => {
    const usage = normalizeGeneratedImageUsage(imageUsage)
    if (!usage.totalInput && !usage.output) return
    subUsage.input += usage.input
    subUsage.output += usage.output
    subUsage.cacheRead += usage.cacheRead
    subUsage.cacheCreate += usage.cacheCreate
    subUsage.totalInput += usage.totalInput
    recordSubagentUsage({ providerId: imageUsage.providerId, modelId: imageUsage.modelId }, usage)
  }
  const delegationToolName = mode === 'maestro' ? 'delegate' : 'task'
  const taskTools: ToolSet = agents.length
    ? {
        [delegationToolName]: tool({
          description:
            mode === 'maestro'
              ? MAESTRO_DELEGATE_TOOL_DESCRIPTION
              : 'Delegates a subtask to an isolated SUBAGENT (its own context/tools/prompt). Use it for focused ' +
                "subtasks; the return value is the subagent's result as text. Pick an agent from the catalog in the system prompt.",
          // Independent subagents may run in parallel but remain mutators/idempotent in the ledger.
          metadata: { parallelSafe: true, readOnly: false },
          inputSchema: jsonSchema(
            mode === 'maestro'
              ? MAESTRO_DELEGATE_TOOL_SCHEMA
              : {
                  type: 'object',
                  properties: {
                    agent: {
                      type: 'string',
                      enum: agents.map((item) => item.name),
                      description: 'subagent name (from the catalog in the system prompt)',
                    },
                    prompt: {
                      type: 'string',
                      description:
                        'the subtask, with ALL the context it needs (the subagent does NOT see this conversation)',
                    },
                  },
                  required: ['agent', 'prompt'],
                }
          ),
          execute: async (input: unknown, opts?: { toolCallId?: string }) => {
            const toolCallId = opts?.toolCallId
            const startedAt = Date.now()
            const lines: string[] = []
            const standard = input && typeof input === 'object' ? (input as { agent?: unknown; prompt?: unknown }) : {}
            let agent = typeof standard.agent === 'string' ? standard.agent : ''
            let prompt = typeof standard.prompt === 'string' ? standard.prompt : ''
            const maestroPrepared =
              mode === 'maestro' && args.maestro
                ? await prepareMaestroDelegation({
                    input,
                    turn: args.maestro,
                    parent: { ...selection, effort: reasoningEffort || 'off' },
                    parentFastMode: fastMode,
                    turnState: subagentTurnState,
                    delegationId: toolCallId,
                    owner: { conversationId, parentMessageId: assistantId },
                  })
                : undefined
            if (maestroPrepared) {
              agent = maestroPrepared.agentName
              prompt = maestroPrepared.task
            }
            // Agent selection is semantic and happens before execution-profile resolution.
            // Execution routing is host-managed and keyed by the selected agent name.
            // A role mentioned inside task.prompt must never alter profile resolution.
            if (!maestroPrepared) {
              assertSubagentSelection({
                state: subagentTurnState,
                selectedAgent: agent,
                availableAgents: agents.map((item) => item.name),
                runtime: 'byok',
                conversationId,
              })
              recordSubagentDispatch(subagentTurnState, agent)
            }
            const resolved = maestroPrepared
              ? {
                  definition: agents.find((item) => item.name === agent) ?? null,
                  profile: maestroPrepared.execution.profile,
                }
              : await resolveSubagentExecutionProfile({
                  agentName: agent,
                  agents,
                  conversationId,
                  parentFastMode: fastMode,
                  parent: {
                    ...selection,
                    effort: reasoningEffort || 'off',
                  },
                })
            const { definition, profile } = resolved
            // durationMs only in FINAL state: during running it would freeze the card.
            const finalMeta = (
              usage?: NormalizedAiUsage,
              runtimeEstimatedCostUsd?: number,
              sessionRecorder?: SubagentSessionRecorder
            ): SubagentRunMeta => ({
              profile,
              ...(maestroPrepared ? { maestro: maestroPrepared.execution.snapshot } : {}),
              startedAt,
              ...(sessionRecorder
                ? {
                    sessionId: sessionRecorder.id,
                    phase: sessionRecorder.summary()?.phase,
                    lastActivityAt: sessionRecorder.summary()?.lastActivityAt,
                  }
                : {}),
              ...(usage
                ? {
                    usage: {
                      input: usage.input,
                      output: usage.output,
                      cacheRead: usage.cacheRead,
                      cacheCreate: usage.cacheCreate,
                    },
                  }
                : {}),
              ...(runtimeEstimatedCostUsd != null ? { runtimeEstimatedCostUsd } : {}),
              durationMs: Date.now() - startedAt,
            })
            const account = (
              usage: NormalizedAiUsage | undefined,
              model: ChatModelRef | undefined,
              runtimeEstimatedCostUsd?: number
            ) => {
              if (usage) {
                subUsage.input += usage.input
                subUsage.output += usage.output
                subUsage.cacheRead += usage.cacheRead
                subUsage.cacheCreate += usage.cacheCreate
                subUsage.totalInput += usage.totalInput
              }
              if (model) recordSubagentUsage(model, usage, runtimeEstimatedCostUsd)
            }
            const initialMeta: SubagentRunMeta = {
              profile,
              ...(maestroPrepared ? { maestro: maestroPrepared.execution.snapshot } : {}),
              startedAt,
            }
            if (toolCallId) {
              subagentRunMeta.set(toolCallId, initialMeta)
              apply(
                {
                  kind: 'tool-state',
                  messageId: assistantId,
                  toolCallId,
                  state: { status: 'running', sub: initialMeta },
                },
                true
              )
            }
            if (!definition || !profile.effective) {
              if (toolCallId) subagentRunMeta.set(toolCallId, finalMeta())
              throw new Error(`Subagent "${agent}" has no runnable execution profile.`)
            }

            const executeResolved = async (
              workSignal: AbortSignal,
              sessionRecorder?: SubagentSessionRecorder,
              background = false
            ) => {
              const progress = (line: string) => {
                if (!toolCallId || background) return
                lines.push(line)
                apply({
                  kind: 'tool-state',
                  messageId: assistantId,
                  toolCallId,
                  state: {
                    status: 'running',
                    output: lines.slice(-12).join('\n'),
                    sub: subagentRunMeta.get(toolCallId),
                  },
                })
              }
              let lease: SubagentLease | null = null
              try {
                const nativeClaude = isClaudeSubscriptionProvider(profile.effective!.providerId)
                const childMeta = nativeClaude
                  ? { meta: { vision: true } }
                  : await getSubagentProfileModelMeta(profile.effective!.providerId, profile.effective!.modelId).catch(
                      () => ({ meta: null })
                    )
                const childTools = adaptToolSetForModel({
                  tools: { ...tools, ...mcp.tools, ...app.tools, ...skillTools },
                  supportsImages: supportsChatToolImages({
                    modelVision: childMeta.meta?.vision,
                    unknownVision: 'unsupported',
                    imageInterpreterConfigured: hasConfiguredImageInterpreter(),
                  }),
                  describeImage: (image) =>
                    describeEphemeralToolImage({ image, conversationId, cwd, signal: workSignal }),
                })
                const namespacedChildTools = namespaceSubagentToolSet(childTools, toolCallId ?? randomUUID())
                const readOnly = isSubagentReadOnly(mode, definition.tools, childTools)
                lease = await subagentCoordinator.acquire({ agent, signal: workSignal })
                const selectedToolNames = selectSubagentToolNames({
                  definition,
                  readOnly,
                  providedHostTools: namespacedChildTools,
                })
                const execute = () =>
                  executeSubagent({
                    conversationId,
                    projectId,
                    cwd,
                    parentMessageId: assistantId,
                    toolCallId,
                    delegationId: maestroPrepared?.execution.snapshot.delegationId,
                    delegationLabel: maestroPrepared?.execution.snapshot.resource.label,
                    maestroSnapshot: maestroPrepared?.execution.snapshot,
                    mode,
                    permMode: getConvUiPrefs(conversationId).chat?.permMode ?? 'ask',
                    profile,
                    definition,
                    agentName: agent,
                    task: prompt,
                    readOnly,
                    tools: namespacedChildTools,
                    allowedToolNames: selectedToolNames,
                    deferredToolNames: new Set([...Object.keys(mcp.tools), ...Object.keys(app.tools)]),
                    broker,
                    questionBroker,
                    signal: workSignal,
                    progress,
                    sessionRecorder,
                    emitGeneratedImage: (childToolCallId, image) =>
                      emitGeneratedImagePart(apply, assistantId, childToolCallId, image),
                    onGeneratedImageUsage: recordGeneratedImageUsage,
                  })
                const result = nativeClaude ? await execute() : await withoutOpenAIRawResponsesPrefix(execute)
                const runtimeEstimatedCostUsd = result.runtimeEstimatedCostUsd
                account(result.usage, result.model, runtimeEstimatedCostUsd)
                if (toolCallId && !background) {
                  subagentRunMeta.set(toolCallId, finalMeta(result.usage, runtimeEstimatedCostUsd, sessionRecorder))
                }
                return {
                  output: result.text,
                  ...(result.error ? { error: `Subagent "${agent}" failed: ${result.error}` } : {}),
                  sub: finalMeta(result.usage, runtimeEstimatedCostUsd, sessionRecorder),
                }
              } finally {
                lease?.release()
              }
            }

            if (maestroPrepared && toolCallId) {
              const handle = startMaestroDelegation({
                conversationId,
                parentMessageId: assistantId,
                toolCallId,
                agentName: agent,
                task: prompt,
                profile,
                maestro: maestroPrepared.execution.snapshot,
                parentSignal: signal,
                maestroLive: args.maestroLive,
                execute: (workSignal, sessionRecorder) => executeResolved(workSignal, sessionRecorder, true),
              })
              if (handle.sub) subagentRunMeta.set(toolCallId, handle.sub)
              return handle
            }

            try {
              const result = await executeResolved(signal)
              if (result.error) throw new Error(result.error)
              return result.output
            } catch (error) {
              const withUsage = error as Error & {
                subagentUsage?: NormalizedAiUsage
                subagentModel?: ChatModelRef
                subagentRuntimeEstimatedCostUsd?: number
              }
              if (args.maestroLive && toolCallId && withUsage instanceof Error) {
                withUsage.message = args.maestroLive.embedPending(toolCallId, withUsage.message).output
              }
              account(withUsage.subagentUsage, withUsage.subagentModel, withUsage.subagentRuntimeEstimatedCostUsd)
              if (toolCallId && signal.aborted) {
                const meta = finalMeta(withUsage.subagentUsage, withUsage.subagentRuntimeEstimatedCostUsd)
                subagentRunMeta.set(toolCallId, meta)
                apply(
                  {
                    kind: 'tool-state',
                    messageId: assistantId,
                    toolCallId,
                    state: { status: 'error', error: 'Aborted', sub: meta },
                  },
                  true
                )
              }
              throw error
            }
          },
        }),
      }
    : {}

  const supervisionTools = agents.length
    ? buildSubagentSupervisionTools({
        conversationId,
        parentMessageId: assistantId,
        maestro: mode === 'maestro',
        signal,
      })
    : {}
  let allTools: ToolSet = { ...tools, ...mcp.tools, ...app.tools, ...skillTools, ...taskTools, ...supervisionTools }
  if (useOpenAIHarness) {
    if (mode === 'agent' && !args.reviewerRuntime) {
      const nativeTools = buildOpenAINativeTools({
        cwd,
        capabilities: resolvedModel.capabilities,
        makeCtx: makeMainToolContext,
      })
      if (nativeTools[OPENAI_LOCAL_SHELL_TOOL_NAME]) delete allTools.bash
      if (nativeTools[OPENAI_APPLY_PATCH_TOOL_NAME]) {
        delete allTools.edit
        delete allTools.write
      }
      allTools = { ...allTools, ...nativeTools }
    }
    const deferredToolNames = [...Object.keys(mcp.tools), ...Object.keys(app.tools)]
    const optimized = await optimizeOpenAITools(allTools, {
      conversationId,
      enableToolSearch: resolvedModel.capabilities.toolSearch,
      deferredToolNames,
    })
    allTools = wrapOpenAIToolExecutions(optimized.tools, optimized.scheduler, {
      conversationId,
      messageId: assistantId,
    })
    chatDiag({
      kind: 'openai-tools-profile',
      model: selection.modelId,
      conv: conversationId,
      strict: optimized.strictToolNames.length,
      nonStrict: optimized.nonStrictToolNames,
      deferred: optimized.deferredToolNames.length,
      toolSearch: optimized.toolSearchEnabled,
      nativeShell: mode === 'agent' && !args.reviewerRuntime && resolvedModel.capabilities.nativeShell,
      nativeApplyPatch: mode === 'agent' && !args.reviewerRuntime && resolvedModel.capabilities.nativeApplyPatch,
    })
  }
  allTools = adaptToolSetForModel({
    tools: allTools,
    supportsImages: !dropImages,
    describeImage: (image) => describeEphemeralToolImage({ image, conversationId, cwd, signal }),
  })

  // Project context (cwd AGENTS.md/CLAUDE.md + workspace memory) → append to system prompt.
  const projectContext = useOpenAIHarness
    ? await buildOpenAIProjectContext(projectId, cwd)
    : await buildProjectContext(projectId, cwd)
  const skillsCatalog = skills.length
    ? '\n\nProject skills (specialized capabilities) — when the task matches one, call use_skill("<name>") ' +
      'to load the full instructions BEFORE acting:\n' +
      skills.map(skillCatalogLine).join('\n')
    : ''
  const agentsCatalog = agents.length
    ? mode === 'maestro'
      ? `\n\n${renderMaestroAgentCatalog(args.maestro!)}`
      : '\n\n# Subagents\nDelegate work to an isolated subagent with the `task` tool ' +
        '(agent="<name>", prompt="<the full task, with ALL context it needs — it does NOT see this conversation>"); ' +
        'it runs in its OWN context and returns just its result. Two ways to use it: (1) offload broad searches or ' +
        "deep investigation that would otherwise flood your context with file dumps you won't reuse; (2) for a LARGE " +
        'task, DECOMPOSE it into self-contained slices and delegate each to a worker agent — the slices run isolated ' +
        '(and independent ones can run in parallel: emit several `task` calls in one response). Keep the parent thread ' +
        'as the orchestrator: split the work, delegate, then integrate and verify the results. Give each subagent a ' +
        'precise, self-contained prompt (it sees nothing but what you pass). Skip delegation for trivial work you can ' +
        'do in a step or two.\n' +
        buildAndRenderSubagentDispatchCatalog({
          agents,
          conversationId,
          forceReadOnly: subagentsReadOnly,
        })
    : ''
  const maestroPolicyContext = mode === 'maestro' && args.maestro ? `\n\n${renderMaestroTurnPolicy(args.maestro)}` : ''

  // Reasoning/thinking: send only levels in the MODEL LIST (models.dev) — changing models will not send
  // invalid inherited levels (e.g. xhigh on gemini), avoiding errors. 'off'/Default and nonreasoning models → none.
  // Translate Maestrly Ultra to highest actual effort (resolveUltraEffort in buildProviderOptions);
  // raw `ultra` stays native when supported. Nonreasoning models receive no effort, though synthetic
  // orchestration still applies. Shared/testable buildProviderOptions resolves by KIND: anthropic → effort;
  // openai-responses → store:false + include (ALWAYS) + valid reasoningEffort/summary; compatible → reasoning_effort.
  const providerKind = resolvedModel.transport
  // Isolated execution (review-loop): reproduce frozen EFFECT EXACTLY against live metadata
  // — fail instead of silently omitting/substituting (fail-closed). Manual turns remain permissive.
  assertFrozenEffortReproducible({
    ephemeralSession: args.ephemeralSession,
    reasoningOverride: args.reasoningOverride,
    frozenReasoningEffort: args.frozenReasoningEffort,
    providerKind,
    meta: reasoningMeta,
  })
  let providerOptions: SharedV3ProviderOptions | undefined = buildProviderOptions(
    providerKind,
    reasoningEffort,
    reasoningMeta
  )

  // xAI Priority Processing: conversation Fast toggle becomes body `service_tier: "priority"`
  // (extra field accepted by @ai-sdk/openai-compatible outside typed schema). Internal
  // review-loop carries FROZEN `fastModeOverride` — never rereads live ui_prefs.
  const fastMode = resolveTurnFastMode(args.fastModeOverride, getConvUiPrefs(conversationId).chat?.fastMode === true)
  providerOptions = applyFastModeServiceTier(providerOptions, fastMode, selection.providerId)

  // Explicit max_tokens ONLY for anthropic transport: @ai-sdk/anthropic uses internal per-model limits;
  // unknown models (e.g. newly released claude-opus-5) default to 4096 → large writes repeatedly
  // cut with finishReason 'length' (continuation restarts tool input and cuts again).
  // Catalog (models.dev) knows actual limits; explicit values override the table, while KNOWN
  // models still clamp excess to their actual ceiling. openai/compatible omit absent fields (provider
  // uses its own maximum) — supplying them only risks proxy/limit mismatches.
  const maxOutputTokens = providerKind === 'anthropic' ? meta?.maxOutput : undefined

  // Vision: do not resend history image attachments to models rejecting them — otherwise providers reject
  // EVERY turn after an image enters. Two signals: (a) catalog (models.dev) vision === false; (b)
  // runtime fallback — model ALREADY rejected an image in this conversation (imagesUnsupported), covering
  // optimistic/wrong catalog data (observed MiMo: models.dev advertised vision; actual endpoint rejected it).
  // Learning rejection only makes sense if we actually SENT images this turn. MUTABLE signal:
  // starts with history attachments, but TOOL images projected during the turn also count —
  // otherwise rejection from browser_screenshot/MCP image output would never teach the flag.
  let sentImages = !dropImages && history.some((m) => m.parts.some((p) => p.type === 'file' && p.kind === 'image'))
  // Heuristic: provider image/vision error + image sent → mark conversation to stop resending
  // images (self-healing: NEXT turn avoids failure). Cleared on user model switch.
  const learnImageUnsupported = (message: string): void => {
    if (!sentImages) return
    if (!isImageRelatedProviderError(message)) return
    const cur = getConvUiPrefs(conversationId).chat ?? {}
    patchConvUiPrefs(conversationId, { chat: { ...cur, imagesUnsupported: true } })
    // Configured interpreter → PRE-DESCRIBE images in background: catalog was optimistic (unknown/wrong
    // vision) and turn already failed, but user resend finds ready cache instead of
    // paying vision latency then. Best-effort: failures enter module negative cache;
    // conversation serialization prevents races with next send.
    if (getImageInterpreter()) {
      void describeConversationImages({
        conversationId,
        cwd,
        pendingParts: [],
        signal: AbortSignal.timeout(10 * 60_000),
      }).catch(() => undefined)
      // Rejection-triggering TOOL images persisted WITHOUT descriptions (optimistic catalog skipped
      // interpretation). Enrich this bubble in background — current MESSAGE only, never other
      // conversations/review-loop scopes — while ephemeral bytes exist, so dropImages replay receives
      // text instead of "image omitted". Already stopped → do not start (turn ended).
      if (!signal.aborted) {
        void describePersistedToolImages({
          conversationId,
          cwd,
          message: msgs[0],
          signal: AbortSignal.timeout(10 * 60_000),
        })
          .then((enriched) => {
            if (enriched.length === 0) return
            // Conditional post-turn persistence: reread message (and OpenAI sidecar); patch ONLY outputs
            // still referencing described images — never insert or revert newer state
            // (clear/delete/truncate/edit during description). This turn's IN-MEMORY ledger
            // dies with invocation; patch only DURABLE sidecar.
            applyPersistedToolImageEnrichment({ conversationId, messageId: assistantId, enriched })
          })
          .catch(() => undefined)
      }
    }
  }

  // Environment grounding: OS + TODAY (stable all day → cache invalidates ≤once/day) + directory + git (branch
  // + uncommitted changes — one cheap call; sticky `dirty` rarely changes cache). Prevents guessing
  // date/OS/branch and conveys repository state without repeated `git status`.
  const plat = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
  const git = await gitEnvInfo(cwd).catch(() => null)
  const gitLine = git ? ` Git branch: ${git.branch} (${git.dirty ? 'uncommitted changes' : 'clean'}).` : ''
  const envDetails = `OS: ${plat}. Today's date: ${new Date().toISOString().slice(0, 10)}. Project directory: ${cwd}.${gitLine}`
  const envContext = `\n\n# Environment\n${envDetails}`
  // Mode-adapted ULTRA block: agent encourages full cycle (plan → decompose → delegate in
  // parallel → integrate → verify); plan/ask only parallel `explore` investigation (read-only).
  const ultraBlock = !ultra
    ? ''
    : mode === 'maestro'
      ? '\n\n# ULTRA ORCHESTRATOR\nUse maximum rigor while coordinating. Ultra applies only to the orchestrator profile; the frozen Strategy and Pool still govern every worker.'
      : mode === 'agent'
        ? '\n\n# ULTRA MODE\nThe user opted into maximum effort (and cost) for maximum quality on this conversation. ' +
          'Work accordingly: plan before executing (todo_write) and investigate deeply before concluding. For any ' +
          'non-trivial task, actively look for independent slices and DELEGATE them via the `task` tool — emit ' +
          'multiple `task` calls in one response so they run in parallel — using `explore` subagents for broad ' +
          'investigation and worker agents for self-contained implementation slices. Then integrate the results, ' +
          'VERIFY the work (run tests/build when possible) and finish with a critical review of your own changes ' +
          'looking for gaps or regressions. Delegation is encouraged, not mandatory: still do trivial work directly.'
        : '\n\n# ULTRA MODE\nThe user opted into maximum effort (and cost) for maximum quality on this conversation. ' +
          'Investigate deeply before answering: besides your read tools, you have the `task` tool with the read-only ' +
          '`explore` subagent — delegate broad or independent investigation lines to it (emit multiple `task` calls ' +
          'in one response so they run in parallel) and keep your own context for synthesis. Cross-check findings ' +
          'and be critical of your first conclusion before finishing.'
  let system =
    SYSTEM_PROMPT(cwd, appToolsEnabled, mode, hasNotesTab) +
    envContext +
    projectContext +
    skillsCatalog +
    agentsCatalog +
    maestroPolicyContext +
    ultraBlock
  if (useOpenAIHarness) {
    // Responses protocol and textual prompt are separate axes. Pinned Codex has templates per
    // slug; only exact gpt-5.6-sol binding receives its port. Others retain the generic
    // Maestrly prompt, with stable prefix/volatile environment and the entire new Responses harness.
    const nativeToolsPrompt = openAINativeToolsPromptOverlay(
      {
        localShell: allTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
        applyPatch: allTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
      },
      mode === 'maestro' ? 'ask' : mode
    )
    let promptStablePrefix =
      SYSTEM_PROMPT(cwd, appToolsEnabled, mode, hasNotesTab) +
      (nativeToolsPrompt ? `\n\n${nativeToolsPrompt}` : '') +
      projectContext +
      skillsCatalog +
      agentsCatalog +
      maestroPolicyContext +
      ultraBlock
    system = promptStablePrefix + envContext
    let sourceCommit: string | undefined
    if (resolvedModel.promptProfile === OPENAI_CODEX_GPT56_SOL_PROMPT_PROFILE) {
      const prompt = compileOpenAIPrompt({
        cwd,
        mode: mode === 'maestro' ? 'ask' : mode,
        appToolsEnabled,
        hasNotesTab,
        projectContext,
        skillsContext: skillsCatalog,
        agentsContext: `${agentsCatalog.replace(/^\s*# Subagents\s*/i, '')}${
          mode === 'maestro' ? `\n\n${MAESTRO_SYSTEM_SPEC}` : ''
        }${maestroPolicyContext}`,
        envContext: envDetails,
        ultraContext: ultraBlock.replace(/^\s*# ULTRA MODE\s*/i, ''),
        nativeTools: {
          localShell: allTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
          applyPatch: allTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
        },
      })
      system = prompt.instructions
      promptStablePrefix = prompt.stablePrefix
      sourceCommit = prompt.source.commit.slice(0, 12)
    } else if (resolvedModel.promptProfile === OPENAI_GPT6_ASTRA_PROMPT_PROFILE) {
      const prompt = compileOpenAIAstraPrompt({
        cwd,
        mode: mode === 'maestro' ? 'ask' : mode,
        appToolsEnabled,
        hasNotesTab,
        projectContext,
        skillsContext: skillsCatalog,
        agentsContext: `${agentsCatalog.replace(/^\s*# Subagents\s*/i, '')}${
          mode === 'maestro' ? `\n\n${MAESTRO_SYSTEM_SPEC}` : ''
        }${maestroPolicyContext}`,
        envContext: envDetails,
        // Astra's catalog publishes native ultra; never append the synthetic Maestrly overlay for it.
        ultraContext: ultra && reasoningEffort !== 'ultra' ? ultraBlock.replace(/^\s*# ULTRA MODE\s*/i, '') : null,
        nativeTools: {
          localShell: allTools[OPENAI_LOCAL_SHELL_TOOL_NAME] != null,
          applyPatch: allTools[OPENAI_APPLY_PATCH_TOOL_NAME] != null,
        },
      })
      system = prompt.instructions
      promptStablePrefix = prompt.stablePrefix
    }
    const promptCacheKey = `maestrly:${createHash('sha256')
      .update(promptStablePrefix)
      .update('\0')
      .update(Object.keys(allTools).sort().join('\0'))
      .digest('hex')}`
    const currentOpenAI = providerOptions?.openai ?? {}
    providerOptions = {
      ...providerOptions,
      openai: {
        ...currentOpenAI,
        ...openAIHarnessProviderOptions(
          { profile: resolvedModel.harnessProfile, capabilities: resolvedModel.capabilities },
          {
            promptCacheKey,
            // GPT reasoning models still reason at their provider default when no explicit effort was selected.
            reasoningEnabled: resolvedModel.capabilities.encryptedReasoning,
            compactionThreshold: contextWindow ? Math.floor(contextWindow * IN_TURN_COMPACT_RATIO) : undefined,
            ...(isAstraHarnessProfile(modelHarnessProfileId) ? { promptCacheTtl: '30m' } : {}),
          }
        ),
      },
    }
    chatDiag({
      kind: 'openai-harness-profile',
      profile: resolvedModel.harnessProfile,
      modelHarnessProfile: modelHarnessProfileId,
      model: selection.modelId,
      conv: conversationId,
      cacheKey: promptCacheKey.slice(-12),
      promptProfile: resolvedModel.promptProfile,
      capabilities: resolvedModel.capabilities,
      ...(sourceCommit ? { sourceCommit } : {}),
    })
  }
  // cacheControl only for NATIVE Anthropic: prompt-caching breakpoints (system+tools and history)
  // → resends each step/turn become cache_read (~10x cheaper), saving rate-limit budget.
  const msgOpts = {
    dropImages,
    cacheControl: isAnthropicProvider(selection.providerId),
    ...(replayPolicy ? { reasoningReplay: replayPolicy, replayStats: persistedReplayStats } : {}),
  }

  const baseModelMessagesFor = (
    source: StoredChatMessage[]
  ): { messages: ModelMessage[]; rawPrefix?: OpenAILedgerValue[] } => {
    if (!useOpenAIHarness) return { messages: toModelMessages(source, msgOpts) }
    const built = buildOpenAIModelMessages(
      source,
      (messageId) => {
        if (messageId === assistantId && openAILifecycle) {
          const reconciliation = reconcileOpenAIToolExecutions(openAILifecycle.working, {
            conversationId,
            messageId: assistantId,
          })
          if (reconciliation.recovered.length > 0) {
            openAILifecycle = { ...openAILifecycle, working: reconciliation.ledger }
            putOpenAIInferenceState(assistantId, {
              version: OPENAI_INFERENCE_STATE_VERSION,
              providerId: selection.providerId,
              modelId: selection.modelId,
              providerFingerprint: resolvedModel.providerFingerprint,
              modelHarnessProfileId,
              ledger: durableOpenAILedger(openAILifecycle),
            })
            chatDiag({
              kind: 'openai-tool-execution-recovered',
              model: selection.modelId,
              conv: conversationId,
              calls: reconciliation.recovered,
            })
          }
          return openAILifecycle.working
        }
        const state = getOpenAIInferenceState(messageId)
        if (!state) return null
        // Isolated: OpenAI sidecars only for execution messages (never main conversation ledger).
        if (args.ephemeralSession) {
          const owned = source.find((message) => message.id === messageId)
          if (owned?.executionScope?.kind !== 'review-loop') return null
        }
        // Encrypted reasoning may depend on model/backend/account. Any change degrades to visual
        // transcript; providerId alone is insufficient because custom providers can be repointed under the same ID.
        if (
          !canReplayOpenAIInferenceState(state, {
            providerId: selection.providerId,
            modelId: selection.modelId,
            providerFingerprint: resolvedModel.providerFingerprint,
            modelHarnessProfileId,
          })
        )
          return null
        const reconciliation = reconcileOpenAIToolExecutions(state.ledger, { conversationId, messageId })
        if (reconciliation.recovered.length > 0) {
          putOpenAIInferenceState(messageId, { ...state, ledger: reconciliation.ledger })
          chatDiag({
            kind: 'openai-tool-execution-recovered',
            model: selection.modelId,
            conv: conversationId,
            calls: reconciliation.recovered,
          })
        }
        return { ...state, ledger: reconciliation.ledger }
      },
      { dropImages, onLossyState: 'include' }
    )
    if (built.issues.length > 0) {
      chatDiag({
        kind: 'openai-ledger-replay-issues',
        count: built.issues.length,
        rawRequired: built.requiresRawResponsesInput,
        codes: [...new Set(built.issues.map((issue) => issue.code))],
        model: selection.modelId,
        conv: conversationId,
      })
    }
    return { messages: built.messages, ...(built.rawPrefix ? { rawPrefix: built.rawPrefix } : {}) }
  }

  const modelMessagesFor = (
    source: StoredChatMessage[]
  ): { messages: ModelMessage[]; rawPrefix?: OpenAILedgerValue[] } => {
    return baseModelMessagesFor(source)
  }

  // Every finish-step is billable. Accumulate here (including truncated attempts), not only
  // last invocation totalUsage; last-step input stays separate for context occupancy.
  const turnUsage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
  let lastStepInput = 0
  let lastStepOutput = 0
  let hasLastStepUsage = false
  let produced = false // Did current ATTEMPT generate content? (Prevents continuing an empty continuation.)
  let retryable = false // Attempt truncated by retryable ERROR (not cut SSE) → backoff before retry.
  let retryDelayMs = 0
  let canRetry = MAX_CONTINUE > 0 // Continuation still available? Otherwise retryable errors become NORMAL errors (do not swallow message).
  let steps = 0 // Current-attempt finish-step count — reset in streamOnce; real progress rearms retry.
  let attempt = 0

  const discardPendingOpenAICompaction = () => {
    if (openAILifecycle) openAILifecycle = rollbackOpenAICompactionLifecycle(openAILifecycle)
  }

  // Intra-turn guard requires known window AND compaction (stopping at threshold alone would not help).
  const guard =
    contextWindow &&
    contextWindow >= 20_000 &&
    compactHistory &&
    !(useOpenAIHarness && resolvedModel.capabilities.nativeCompaction)
      ? makeContextGuard(contextWindow, IN_TURN_COMPACT_RATIO)
      : null

  /** Runs ONE streamText invocation, folds fullStream into bubble, returns stream outcome. */
  const streamOnce = async (messages: ModelMessage[]): Promise<'finished' | 'aborted' | 'error' | 'truncated'> => {
    attempt++
    // review_plan (submit & release): once registered, stop at step boundary — no extra model step to
    // narrate/implement (user decision starts a new turn). If a retryable error occurs in the SAME
    // submission step, continuation opens streamText and this stopWhen cuts at step 0
    // (planSubmitted already true) → benign, no implementation.
    const planStop: StopCondition<typeof allTools> = () => planSubmitted
    // guard.condition is weaker than StopCondition<TOOLS> (usage only) — structurally compatible.
    const stopWhen = guard
      ? [stepCountIs(turnMaxSteps), guard.condition as never, planStop]
      : [stepCountIs(turnMaxSteps), planStop]
    const result = streamText({
      model: streamModel,
      system,
      messages,
      tools: allTools,
      stopWhen,
      maxRetries: AI_SDK_MAX_RETRIES,
      abortSignal: signal,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    })
    let finished = false
    let aborted = false
    let errored = false
    produced = false
    retryable = false
    retryDelayMs = 0
    let lastPart = '' // Diagnostics (chatDiag): last fullStream part before ending → WHERE cut occurred.
    const invocationUsage: NormalizedAiUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 }
    steps = 0 // Completed finish-steps in THIS attempt — diagnostics + progress rearms retry.
    const retryTransient = (error: unknown): boolean => {
      const decision = classifyStreamRetry(error)
      if (!decision.retryable) {
        if (decision.reason === 'quota') {
          chatDiag({
            kind: 'retry-quota-terminal',
            runtime: 'byok-ai-sdk',
            provider: selection.providerId,
            model: selection.modelId,
            conv: conversationId,
            attempt,
          })
        }
        return false
      }
      if (shouldBlockHighUsageRetry({ steps, totalInput: invocationUsage.totalInput, contextWindow })) {
        chatDiag({
          kind: 'retry-high-usage-blocked',
          runtime: 'byok-ai-sdk',
          provider: selection.providerId,
          model: selection.modelId,
          conv: conversationId,
          attempt,
          steps,
          totalInput: invocationUsage.totalInput,
          contextWindow,
        })
        return false
      }
      retryable = true
      retryDelayMs = decision.delayMs
      chatDiag({
        kind: 'retry-scheduled',
        runtime: 'byok-ai-sdk',
        provider: selection.providerId,
        model: selection.modelId,
        conv: conversationId,
        attempt,
        delayMs: retryDelayMs,
      })
      return true
    }
    try {
      for await (const part of result.fullStream) {
        const p = part as any
        if (openAILifecycle) {
          try {
            openAILifecycle = advanceOpenAICompactionLifecycle(openAILifecycle, p as OpenAIStreamEventLike)
          } catch (error) {
            // Future non-JSON metadata must neither contaminate sidecar nor crash conversation.
            chatDiag({
              kind: 'openai-ledger-capture-error',
              part: p.type,
              error: errMessage(error),
              model: selection.modelId,
              conv: conversationId,
            })
          }
        }
        lastPart = part.type
        switch (part.type) {
          case 'finish-step': {
            steps++
            const stepUsage = normalizeAiUsage(part.usage)
            addNormalizedUsage(turnUsage, part.usage)
            addNormalizedUsage(invocationUsage, part.usage)
            hasLastStepUsage = true
            lastStepInput = stepUsage.totalInput
            lastStepOutput = stepUsage.output
            recordModelCallUsage({
              runtime: 'byok-ai-sdk',
              providerId: selection.providerId,
              modelId: selection.modelId,
              conversationId,
              attempt,
              step: steps,
              usage: stepUsage,
            })
            if (openAILifecycle) persistNow()
            break
          }
          case 'text-start':
            apply({ kind: 'text-start', messageId: assistantId, partId: p.id })
            break
          case 'text-delta':
            produced = true
            apply({ kind: 'text-delta', messageId: assistantId, partId: p.id, delta: p.text })
            break
          case 'text-end':
            // itemId/phase/annotations arrive at item close; checkpoint before any retry.
            if (openAILifecycle) persistNow()
            break
          case 'reasoning-start':
            apply({ kind: 'reasoning-start', messageId: assistantId, partId: p.id })
            break
          case 'reasoning-delta':
            produced = true
            apply({ kind: 'reasoning-delta', messageId: assistantId, partId: p.id, delta: p.text })
            break
          case 'reasoning-end':
            // OpenAI adapter encrypted_content arrives here; without checkpoint the next turn loses it.
            if (openAILifecycle) persistNow()
            break
          case 'custom':
            if (isOpenAINativeCompactionPart(p)) {
              produced = true
            }
            if (openAILifecycle && isOpenAINativeCompactionPart(p)) {
              persistNow()
              chatDiag({
                kind: 'openai-native-compaction',
                model: selection.modelId,
                conv: conversationId,
                itemId: p.providerMetadata?.openai?.itemId,
              })
            }
            break
          case 'tool-input-start':
            apply({ kind: 'tool-input-start', messageId: assistantId, toolCallId: p.id, toolName: p.toolName }, true)
            break
          case 'tool-call':
            produced = true
            apply(
              {
                kind: 'tool-call',
                messageId: assistantId,
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                input: p.input,
              },
              true
            )
            apply(
              {
                kind: 'tool-state',
                messageId: assistantId,
                toolCallId: p.toolCallId,
                state: {
                  status: 'running',
                  ...(subagentRunMeta.get(p.toolCallId) ? { sub: subagentRunMeta.get(p.toolCallId) } : {}),
                },
              },
              true
            )
            break
          case 'tool-result': {
            const normalizedOutput = modelOutputToChatToolOutput(p.output)
            // Result carries images the NEXT model step will receive (dropImages=false) → turn sent
            // a tool image. tool-result precedes the invocation the provider may reject for multimodal
            // content, so enable the learning signal here.
            if (!dropImages && toolOutputImages(normalizedOutput).length > 0) sentImages = true
            const output = toolOutputAsText(normalizedOutput) || '(no output)'
            const sub = subagentRunMeta.get(p.toolCallId)
            const denied = isOpenAINativePermissionDeniedOutput(p.toolName, p.output)
            const failed = isOpenAINativeFailedOutput(p.toolName, p.output) || toolOutputIsError(normalizedOutput)
            apply(
              {
                kind: 'tool-state',
                messageId: assistantId,
                toolCallId: p.toolCallId,
                state: denied
                  ? { status: 'denied', reason: openAINativeOutputText(p.output) ?? output }
                  : failed
                    ? { status: 'error', error: openAINativeOutputText(p.output) ?? output, ...(sub ? { sub } : {}) }
                    : { status: 'completed', output: normalizedOutput, ...(sub ? { sub } : {}) },
              },
              true
            )
            break
          }
          case 'tool-error': {
            const name = (p.error as { name?: string } | undefined)?.name
            if (name && PERMISSION_ERROR_NAMES.has(name)) {
              apply(
                {
                  kind: 'tool-state',
                  messageId: assistantId,
                  toolCallId: p.toolCallId,
                  state: { status: 'denied', reason: errMessage(p.error) },
                },
                true
              )
            } else {
              const sub = subagentRunMeta.get(p.toolCallId)
              apply(
                {
                  kind: 'tool-state',
                  messageId: assistantId,
                  toolCallId: p.toolCallId,
                  state: { status: 'error', error: errMessage(p.error), ...(sub ? { sub } : {}) },
                },
                true
              )
            }
            break
          }
          case 'finish': {
            const finishUsage = normalizeAiUsage(part.totalUsage)
            reconcileNormalizedUsage(turnUsage, invocationUsage, part.totalUsage)
            if (
              !invocationUsage.totalInput &&
              !invocationUsage.output &&
              (finishUsage.totalInput || finishUsage.output)
            ) {
              hasLastStepUsage = true
              lastStepInput = finishUsage.totalInput
              lastStepOutput = finishUsage.output
            }
            // review_plan (submit & release): plan stopWhen ended with finishReason 'tool-calls'
            // (step ended with tool call) — CLEAN end, not cutoff. Normalize to 'stop'
            // BEFORE CUT_FINISH_REASONS check to avoid error/"interrupted" display or retry.
            const reason = planSubmitted ? 'stop' : normalizeStreamFinishReason(p.finishReason, p.rawFinishReason)
            const rawReason = planSubmitted ? undefined : p.rawFinishReason
            // GRACEFUL but INCOMPLETE finish (actual Codex "interrupted" cause, July 2026): provider ends
            // SSE with finish chunk, but reason indicates cutoff — e.g. codex-proxy sends nonstandard
            // finish_reason when upstream ChatGPT websocket dies → adapter maps
            // default→'other'; exhausted MAX_STEPS → 'tool-calls'; max_tokens → 'length'. Previously classified
            // `finished`, so transparent retry NEVER ran (straight to banner). Now: with continuation
            // budget, treat as truncated → resume partial. Exhausted → apply normal finish
            // (banner + error status). Leave `produced` unchanged: no partial means nothing to continue.
            if (isCutStreamFinish(reason, rawReason) && !signal.aborted) {
              if (canRetry) {
                chatDiag({
                  kind: 'finish-cut-retry',
                  reason,
                  steps,
                  lastPart,
                  produced,
                  model: selection.modelId,
                  conv: conversationId,
                })
                discardPendingOpenAICompaction()
                return 'truncated'
              }
              // Retry exhausted → cut finish proceeds normally (banner + error status). Log for complete post-mortem
              // evidence (previously invisible path inferred only from DB).
              chatDiag({
                kind: 'finish-cut-final',
                reason,
                steps,
                lastPart,
                model: selection.modelId,
                conv: conversationId,
              })
              // response.incomplete/length/other never confirms checkpoints, even with exhausted retry
              // budget. Bubble receives visible terminal; next turn restarts from last safe prefix.
              discardPendingOpenAICompaction()
            }
            finished = true
            {
              const pair = withStoredUsage(
                {
                  kind: 'finish' as const,
                  messageId: assistantId,
                  finishReason: reason,
                  responseDurationMs: responseDurationMs(responseStartedAt),
                },
                buildPersistedUsage(
                  turnUsage,
                  lastStepInput,
                  lastStepOutput,
                  hasLastStepUsage,
                  subUsage,
                  subagentUsage,
                  resolvedModel.providerFingerprint
                )
              )
              // Still persist fallback. Promote candidate only after entire iterator drains without throwing:
              // some transports send finish chunks before connection actually ends.
              apply(pair.stored, true, pair.public)
            }
            break
          }
          case 'abort':
            aborted = true
            break
          case 'error': {
            // Transient error (overload/rate-limit/reset) WITH retry budget → reuse MAX_CONTINUE path
            // (force produced to pass gate even without content). Without retries,
            // emit ACTUAL error (otherwise user sees only "interrupted" without cause).
            if (canRetry && retryTransient(p.error)) {
              chatDiag({
                kind: 'retryable-error-part',
                error: errMessage(p.error),
                lastPart,
                steps,
                produced,
                model: selection.modelId,
                conv: conversationId,
              })
              produced = true
              discardPendingOpenAICompaction()
              return 'truncated'
            }
            const message = errMessage(p.error)
            learnImageUnsupported(message)
            {
              const pair = withStoredUsage(
                {
                  kind: 'error' as const,
                  messageId: assistantId,
                  message,
                  responseDurationMs: responseDurationMs(responseStartedAt),
                },
                buildPersistedUsage(
                  turnUsage,
                  lastStepInput,
                  lastStepOutput,
                  hasLastStepUsage,
                  subUsage,
                  subagentUsage,
                  resolvedModel.providerFingerprint
                )
              )
              apply(pair.stored, true, pair.public)
            }
            errored = true
            break
          }
          default:
            break
        }
      }
    } catch (e) {
      if (signal.aborted) {
        discardPendingOpenAICompaction()
        return 'aborted'
      }
      if (canRetry && retryTransient(e)) {
        chatDiag({
          kind: 'retryable-thrown',
          error: errMessage(e),
          lastPart,
          steps,
          produced,
          model: selection.modelId,
          conv: conversationId,
        })
        produced = true
        discardPendingOpenAICompaction()
        return 'truncated'
      }
      const message = errMessage(e)
      learnImageUnsupported(message)
      {
        const pair = withStoredUsage(
          {
            kind: 'error' as const,
            messageId: assistantId,
            message,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          buildPersistedUsage(
            turnUsage,
            lastStepInput,
            lastStepOutput,
            hasLastStepUsage,
            subUsage,
            subagentUsage,
            resolvedModel.providerFingerprint
          )
        )
        apply(pair.stored, true, pair.public)
      }
      discardPendingOpenAICompaction()
      return 'error'
    }
    const terminal = classifyStreamTermination({ finished, errored, aborted: aborted || signal.aborted })
    if (terminal === 'finished' && openAILifecycle?.fallback) {
      const pending = openAILifecycle
      try {
        // Same transactional upsert replaces message+sidecar; discard in-memory fallback only afterward.
        persistNow(pending.working)
        openAILifecycle = commitOpenAICompactionLifecycle(pending)
      } catch (error) {
        openAILifecycle = rollbackOpenAICompactionLifecycle(pending)
        throw error
      }
    }
    if (terminal !== 'finished') discardPendingOpenAICompaction()
    if (terminal !== 'truncated') return terminal
    // ABRUPT cut: fullStream ended without finish/error/abort (connection died without finish chunk).
    chatDiag({ kind: 'no-finish-truncated', lastPart, steps, produced, model: selection.modelId, conv: conversationId })
    return terminal
  }

  const streamHistory = (requestHistory: ReturnType<typeof modelMessagesFor>) =>
    withOpenAIRawResponsesPrefix(requestHistory.rawPrefix, () => streamOnce(requestHistory.messages))

  let outcome: 'finished' | 'aborted' | 'error' | 'truncated'
  try {
    // First invocation uses history; continuations feed PARTIAL (msgs[0]) as assistant message.
    outcome = await streamHistory(modelMessagesFor(history))
    let continues = 0 // Consecutive NO-PROGRESS attempts (rearmed by real continuation progress).
    let totalContinues = 0 // Global turn HARD cap (bounds cost even with progress rearming).
    let inTurnCompacts = 0 // Mid-turn compactions performed (cap: resent PARTIAL also consumes context).
    while (
      outcome === 'truncated' &&
      produced &&
      continues < MAX_CONTINUE &&
      totalContinues < MAX_TOTAL_CONTINUES &&
      !signal.aborted
    ) {
      continues++
      totalContinues++
      canRetry = continues < MAX_CONTINUE && totalContinues < MAX_TOTAL_CONTINUES
      // Overloaded/rate-limited provider: IMMEDIATE reinvocation likely fails again — short backoff.
      if (retryable) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      if (signal.aborted) break
      persistNow() // Ensure durable partial before rereading/continuing.
      // Context guard fired: summarize prefix and put milestone INSIDE bubble. Prefix is neither
      // resent nor lost next turn; only summary + post-milestone parts remain active.
      if (guard?.tripped()) {
        guard.reset()
        const compacted =
          inTurnCompacts < MAX_IN_TURN_COMPACTS ? await withoutOpenAIRawResponsesPrefix(() => compactHistory!()) : null
        if (!compacted) {
          if (!signal.aborted) {
            chatDiag({
              kind: 'in-turn-compact-failed',
              compacts: inTurnCompacts,
              model: selection.modelId,
              conv: conversationId,
            })
          }
          break // No room and no way to free it → end with marker (preferable to repeated 502s).
        }
        if (compacted.usage) {
          turnUsage.input += compacted.usage.input
          turnUsage.output += compacted.usage.output
          turnUsage.cacheRead += compacted.usage.cacheRead
          turnUsage.cacheCreate += compacted.usage.cacheCreate
          turnUsage.totalInput += compacted.usage.totalInput
        }
        inTurnCompacts++
        const preCompactOccupancy = lastStepInput + lastStepOutput
        lastStepInput = compactedContextTokens(compacted.summary, compacted.usage)
        lastStepOutput = 0
        hasLastStepUsage = true
        {
          const pair = withStoredUsage(
            {
              kind: 'compaction' as const,
              messageId: assistantId,
              partId: randomUUID(),
              text: compacted.summary,
              strategy: 'summary' as const,
            },
            buildPersistedUsage(
              turnUsage,
              lastStepInput,
              lastStepOutput,
              hasLastStepUsage,
              subUsage,
              subagentUsage,
              resolvedModel.providerFingerprint
            )
          )
          apply(pair.stored, true, pair.public)
        }
        chatDiag({
          kind: 'in-turn-compact',
          compacts: inTurnCompacts,
          occupancy: preCompactOccupancy,
          window: contextWindow,
          model: selection.modelId,
          conv: conversationId,
        })
        continues = 0 // Compaction unblocked real progress → rearm continuation budget.
        if (signal.aborted) break
      }
      outcome = await streamHistory(modelMessagesFor([...history, msgs[0]]))
      // PRODUCTIVE continuation (≥ N steps) rearms budget: legitimate long tasks exceed 3×48 steps;
      // an immediately failing continuation (failure burst) does not rearm and exhausts consecutive MAX_CONTINUE.
      if (steps >= PROGRESS_RESET_STEPS) continues = 0
    }
    // 'finished'/'error' already emitted terminal inside streamOnce; handle only unemitted cases here:
    if (outcome === 'aborted' || signal.aborted) {
      {
        const pair = withStoredUsage(
          {
            kind: 'aborted' as const,
            messageId: assistantId,
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          buildPersistedUsage(
            turnUsage,
            lastStepInput,
            lastStepOutput,
            hasLastStepUsage,
            subUsage,
            subagentUsage,
            resolvedModel.providerFingerprint
          )
        )
        apply(pair.stored, true, pair.public)
      }
    } else if (outcome === 'truncated') {
      // Continuation exhausted (or empty partial) → mark 'interrupted' (UI suggests requesting continuation).
      chatDiag({ kind: 'interrupted-final', continues, model: selection.modelId, conv: conversationId })
      {
        const pair = withStoredUsage(
          {
            kind: 'finish' as const,
            messageId: assistantId,
            finishReason: 'interrupted',
            responseDurationMs: responseDurationMs(responseStartedAt),
          },
          buildPersistedUsage(
            turnUsage,
            lastStepInput,
            lastStepOutput,
            hasLastStepUsage,
            subUsage,
            subagentUsage,
            resolvedModel.providerFingerprint
          )
        )
        apply(pair.stored, true, pair.public)
      }
    }
  } finally {
    coalescer.flush() // Ensure final buffered text-delta reaches renderer before 'done'.
    coalescer.dispose() // Clear timer for background turns without a renderer too.
    if (dirty) persistNow()
    await mcp.close() // Close turn MCP connections.
    await app.close() // Close in-memory app-tool bridge.
  }
  if (replayPolicy) {
    chatDiag({
      kind: 'interleaved-replay-stats',
      path: 'intra-step',
      provider: selection.providerId,
      model: selection.modelId,
      conv: conversationId,
      normalizedSteps: replayStats.normalizedSteps,
      emptyFallbacks: replayStats.emptyFallbacks,
      // Persisted replay (toModelMessages-rehydrated history) — CUMULATIVE counters: every
      // continuation reprocesses all history. No message content.
      persistedReplayedSteps: persistedReplayStats.replayedSteps,
      persistedDegraded: {
        providerMismatch: persistedReplayStats.degradedProviderMismatch,
        modelMismatch: persistedReplayStats.degradedModelMismatch,
        fingerprintMissing: persistedReplayStats.degradedFingerprintMissing,
        fingerprintMismatch: persistedReplayStats.degradedFingerprintMismatch,
      },
    })
  }
  return { planSubmitted }
}
