/**
 * Converts our persisted message model → Vercel AI SDK messages and validates
 * parts with zod when loading from SQLite.
 *
 * Ported from opencode `session/runner/to-llm-message.ts`: there, V2 → `@opencode-ai/llm`
 * messages; here, `ChatMessage[]` (shared/chat.ts) → `ai` `ModelMessage[]`.
 * Core protocol rule: EVERY assistant tool-call requires a matching tool-result in the next
 * `tool` message, otherwise providers reject. Pending/interrupted tools become synthetic
 * results to keep history valid.
 */

import { z } from 'zod'
import type { ModelMessage } from 'ai'
import {
  toolOutputImages,
  toolOutputText,
  type ChatMessage,
  type MessagePart,
  type ToolOutput,
} from '../../shared/chat'
import type { StoredChatMessage } from './chat-store'
import type { InterleavedReplayPolicy } from './reasoning-replay'
import { chatToolOutputToAiSdkOutput } from './tool-output'
import { resolveFileImageBytesSync } from './attachment-artifacts'

// ---- zod: defensive part parsing on DB reads (legacy/corrupt rows become []). ----

const zSubagentProfileSource = z.enum([
  'maestro-resource',
  'conversation-agent',
  'conversation-category',
  'conversation-default',
  'global-agent',
  'global-category',
  'global-default',
  'frontmatter',
  'parent',
])
const zSubagentProfileDiagnostic = z.object({
  code: z.enum([
    'config-corrupt',
    'invalid-structure',
    'incomplete-frontmatter',
    'provider-missing',
    'provider-unsupported',
    'provider-disconnected',
    'no-key',
    'model-not-found',
    'model-unavailable',
    'catalog-unavailable',
    'invalid-effort',
    'effort-unverified',
    'fast-mode-unsupported',
    'fast-mode-unverified',
    'fallback-selected',
    'parent-profile-invalid',
    'agent-not-found',
  ]),
  message: z.string(),
  severity: z.enum(['warning', 'error']),
})
const zSubagentProfileCandidate = z.object({
  providerId: z.string(),
  modelId: z.string(),
  effort: z.string(),
  fastMode: z.boolean().optional(),
})
const zSubagentExecutionSnapshot = z.object({
  version: z.literal(1),
  agentName: z.string(),
  category: z.string().optional(),
  effective: z
    .object({
      providerId: z.string(),
      modelId: z.string(),
      configuredEffort: z.string(),
      sentEffort: z.string().nullable(),
      fastMode: z.boolean().optional(),
      source: zSubagentProfileSource,
      ruleKey: z.string().optional(),
      candidateIndex: z.number(),
    })
    .nullable(),
  attempts: z.array(
    z.object({
      source: zSubagentProfileSource,
      ruleKey: z.string().optional(),
      candidateIndex: z.number(),
      candidate: zSubagentProfileCandidate,
      outcome: z.enum(['selected', 'rejected']),
      diagnostics: z.array(zSubagentProfileDiagnostic),
    })
  ),
  diagnostics: z.array(zSubagentProfileDiagnostic).optional(),
})

const zSubagentRunMeta = z
  .object({
    profile: zSubagentExecutionSnapshot.optional().catch(undefined),
    usage: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheCreate: z.number(),
      })
      .optional(),
    runtimeEstimatedCostUsd: z.number().optional(),
    startedAt: z.number().optional(),
    durationMs: z.number().optional(),
    sessionId: z.string().optional(),
    phase: z.string().optional(),
    lastActivityAt: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
  })
  .passthrough()

const zToolState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('awaiting-permission'), title: z.string().optional() }),
  z.object({
    status: z.literal('running'),
    output: z
      .union([
        z.string(),
        z.object({
          text: z.string(),
          images: z
            .array(
              z.object({
                id: z.string(),
                mediaType: z.string(),
                name: z.string().optional(),
                byteSize: z.number().optional(),
                description: z.string().optional(),
                descriptionModel: z.string().optional(),
              })
            )
            .optional(),
          structuredContent: z.unknown().optional(),
          isError: z.boolean().optional(),
        }),
      ])
      .optional(),
    sub: zSubagentRunMeta.optional(),
  }),
  z.object({
    status: z.literal('completed'),
    output: z.union([
      z.string(),
      z.object({
        text: z.string(),
        images: z
          .array(
            z.object({
              id: z.string(),
              mediaType: z.string(),
              name: z.string().optional(),
              byteSize: z.number().optional(),
              description: z.string().optional(),
              descriptionModel: z.string().optional(),
            })
          )
          .optional(),
        structuredContent: z.unknown().optional(),
        isError: z.boolean().optional(),
      }),
    ]),
    title: z.string().optional(),
    sub: zSubagentRunMeta.optional(),
  }),
  z.object({ status: z.literal('error'), error: z.string(), sub: zSubagentRunMeta.optional() }),
  z.object({ status: z.literal('denied'), reason: z.string().optional() }),
])

const zPart = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    id: z.string(),
    text: z.string(),
    checkpoint: z.literal('openai-native').optional(),
  }),
  z.object({ type: z.literal('reasoning'), id: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    id: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    state: zToolState,
  }),
  z.object({
    type: z.literal('file'),
    id: z.string(),
    name: z.string(),
    mediaType: z.string(),
    kind: z.enum(['image', 'text']),
    data: z.string().optional(),
    artifactId: z.string().optional(),
    byteSize: z.number().optional(),
    hidden: z.boolean().optional(),
    description: z.string().optional(),
    descriptionModel: z.string().optional(),
  }),
  z.object({
    type: z.literal('compaction'),
    id: z.string(),
    text: z.string(),
    strategy: z.enum(['summary', 'openai-native', 'claude-native']).optional(),
  }),
  z.object({ type: z.literal('context'), id: z.string(), text: z.string(), source: z.string().optional() }),
  // OPTIONAL start/end parsing: legacy parts without ranges still load — semantic validation
  // (in-text range, #name-compatible slice, catalog membership, no overlap) belongs to
  // validateStructuredAgentMentions in chat-agent-mentions.ts, not the schema.
  z.object({
    type: z.literal('agent-mention'),
    id: z.string(),
    name: z.string(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('generated-image'),
    id: z.string(),
    artifactId: z.string(),
    name: z.string(),
    mediaType: z.string(),
    revisedPrompt: z.string().optional(),
    byteSize: z.number().optional(),
  }),
  z.object({
    type: z.literal('skill-invocation'),
    id: z.string(),
    name: z.string(),
    args: z.string().optional(),
    body: z.string(),
    dir: z.string().optional(),
  }),
])

export const zParts = z.array(zPart)

/** Parses DB parts (JSON string). Returns [] on any error (never breaks loading). */
export function parseParts(json: string): MessagePart[] {
  try {
    const raw = JSON.parse(json)
    const result = zParts.safeParse(raw)
    return result.success ? (result.data as MessagePart[]) : []
  } catch {
    return []
  }
}

// ---- ChatMessage[] → ModelMessage[] (history sent to model). ----

/**
 * TEXTUAL generated-image reference. Used in model history and portable transcripts:
 * neither resends bytes (artifact lives on disk; see generated-images.ts).
 */
export function generatedImageReference(part: Extract<MessagePart, { type: 'generated-image' }>): string {
  const prompt = part.revisedPrompt?.trim()
  return `[generated image: ${part.name}]${prompt ? `\nrevised prompt: ${prompt}` : ''}`
}

/**
 * Text REPLACING images rejected by the conversation model: interpreter description
 * (`chat.imageInterpreter`, cached on the part) if present, otherwise the existing omission note.
 * Same string in AI SDK history and portable transcript — identical model view of the image.
 */
export function droppedImageText(part: Extract<MessagePart, { type: 'file' }>): string {
  const description = part.description?.trim()
  if (!description) return `[image "${part.name}" omitted: the selected model does not accept images]`
  const by = part.descriptionModel ? ` by ${part.descriptionModel}` : ''
  return `[image "${part.name}" — the selected model cannot see images, so here is a description${by}]\n${description}`
}

function joinText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text' && p.checkpoint !== 'openai-native')
    .map((p) => p.text)
    .join('')
}

/** User-invoked skill blocks (`/name`) — already expanded in main during turn setup. */
function skillBlocks(parts: MessagePart[]): string[] {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'skill-invocation' }> => p.type === 'skill-invocation')
    .map((p) => p.body)
    .filter(Boolean)
}

/** Recognizes current downgrade-safe marker and older experimental format without converting them to textual summaries. */
export function isOpenAINativeCompactionMarker(part: MessagePart): boolean {
  return (
    (part.type === 'text' && part.checkpoint === 'openai-native') ||
    (part.type === 'compaction' && part.strategy === 'openai-native')
  )
}

export function isProviderNativeCompactionMarker(part: MessagePart): boolean {
  return isOpenAINativeCompactionMarker(part) || (part.type === 'compaction' && part.strategy === 'claude-native')
}

export function isPortableCompactionMarker(
  part: MessagePart
): part is Extract<MessagePart, { type: 'compaction' }> {
  return part.type === 'compaction' && !isProviderNativeCompactionMarker(part)
}

/**
 * Marker persisted as empty text for safe downgrade: older parsers drop `checkpoint`, create no
 * compaction boundary, and send no artificial content back to the model.
 */
export function openAINativeCompactionMarkerPart(id: string): Extract<MessagePart, { type: 'text' }> {
  return { type: 'text', id, text: '', checkpoint: 'openai-native' }
}

/** Context remaining active after the LAST milestone, including mid-message milestones. */
export function activeChatContext(messages: ChatMessage[]): { summary: string; messages: ChatMessage[] } {
  let messageIndex = -1
  let partIndex = -1
  let summary = ''
  for (let mi = 0; mi < messages.length; mi++) {
    for (let pi = 0; pi < messages[mi].parts.length; pi++) {
      const part = messages[mi].parts[pi]
      if (part.type !== 'compaction') continue
      // Native checkpoints are provider-bound. Without compatible sidecar, ignoring them retains the entire visual
      // transcript as fallback; only buildOpenAIModelMessages may establish this opaque boundary.
      if (!isPortableCompactionMarker(part)) continue
      messageIndex = mi
      partIndex = pi
      summary = part.text
    }
  }
  if (messageIndex < 0) return { summary: '', messages }

  const active = messages.slice(messageIndex + 1)
  const markerMessage = messages[messageIndex]
  const suffix = markerMessage.parts.slice(partIndex + 1)
  if (suffix.length > 0) active.unshift({ ...markerMessage, parts: suffix })
  return { summary, messages: active }
}

/** Projects persisted canonical results for the current execution model. */
export function toolResultOutput(
  state: Extract<MessagePart, { type: 'tool' }>['state'],
  opts: { dropImages?: boolean } = {}
) {
  switch (state.status) {
    case 'completed':
      return typeof state.output === 'string'
        ? { type: 'text' as const, value: state.output || '(no output)' }
        : chatToolOutputToAiSdkOutput(state.output as ToolOutput, { dropImages: opts.dropImages })
    case 'error':
      return { type: 'error-text' as const, value: state.error }
    case 'denied':
      return { type: 'execution-denied' as const, reason: state.reason }
    default:
      // Persisted pending/running/awaiting-permission = interrupted turn; synthetic result.
      return { type: 'text' as const, value: '(the tool did not finish)' }
  }
}

type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
type ToolResultContentPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: ReturnType<typeof toolResultOutput>
}

/**
 * Converts persisted history to AI SDK messages.
 *
 * An assistant ChatMessage may contain MULTIPLE linear steps (text → tool → text → …). The
 * protocol requires assistant{text+tool-call} → tool{result} → assistant{text}. Walk
 * parts in order, flushing an (assistant, tool) pair whenever text appears
 * AFTER accumulated tool calls — reconstructing step structure from the array.
 *
 * `reasoningReplay` (interleaved policy, see reasoning-replay.ts): rehydrates persisted reasoning in
 * the correct step — `reasoning` part returns in content AND `openaiCompatible[field]` carries
 * text (or explicit `""` for tool-call steps without reasoning), which the adapter
 * materializes as body `reasoning_content`. Replay NONEMPTY reasoning only when
 * provenance matches on THREE AXES: `msg.model.providerId/modelId` AND `msg.providerFingerprint`
 * (opaque backend identity: URL + transport + credential) must EXACTLY match current selection
 * (canReplayPersistedReasoning). Foreign provider/model/backend, legacy (no `model`), or fingerprint-less
 * messages carry no reasoning content — tool-call steps receive only empty fallback,
 * preserving backend structure. Without policy, reasoning remains display-only.
 */

/** Provenance classification for ONE persisted message under current policy (aggregate diagnostics). */
export type PersistedReplayOrigin =
  | 'match'
  | 'provider-mismatch'
  | 'model-mismatch'
  | 'fingerprint-missing'
  | 'fingerprint-mismatch'

/** Aggregated persisted replay counters (no content) — consumed by turn chatDiag. */
export interface PersistedReplayStats {
  /** Assistant reasoning/tool steps with full provenance → rehydrated reasoning. */
  replayedSteps: number
  /** Steps degraded to empty fallback: message provider ≠ selection. */
  degradedProviderMismatch: number
  /** Degraded steps: message model ≠ selection. */
  degradedModelMismatch: number
  /** Degraded steps: legacy message without fingerprint — untrusted origin. */
  degradedFingerprintMissing: number
  /** Degraded steps: message fingerprint ≠ current backend (changed endpoint/kind/key). */
  degradedFingerprintMismatch: number
}

/** Classifies persisted origin; `null` with inactive policy (nothing rehydrated). */
export function classifyPersistedReasoningOrigin(
  message: Pick<StoredChatMessage, 'model' | 'providerFingerprint'>,
  policy: Pick<InterleavedReplayPolicy, 'providerId' | 'modelId' | 'providerFingerprint'>
): PersistedReplayOrigin {
  if (message.model?.providerId !== policy.providerId) return 'provider-mismatch'
  if (message.model?.modelId !== policy.modelId) return 'model-mismatch'
  const fp = message.providerFingerprint
  if (typeof fp !== 'string' || fp.length === 0) return 'fingerprint-missing'
  if (fp !== policy.providerFingerprint) return 'fingerprint-mismatch'
  return 'match'
}

/**
 * Persisted replay provenance. `true` ONLY for triple equality (providerId, modelId, fingerprint).
 * Missing/empty fingerprint → `false` (legacy/non-BYOK messages are untrusted origins). EXACT
 * comparison without normalization; never reuse `contextIdentity` or URL as fallback.
 */
export function canReplayPersistedReasoning(
  message: Pick<StoredChatMessage, 'model' | 'providerFingerprint'>,
  policy: Pick<InterleavedReplayPolicy, 'providerId' | 'modelId' | 'providerFingerprint'>
): boolean {
  return classifyPersistedReasoningOrigin(message, policy) === 'match'
}

export function toModelMessages(
  messages: StoredChatMessage[],
  opts: {
    dropImages?: boolean
    cacheControl?: boolean
    reasoningReplay?: InterleavedReplayPolicy
    /** Aggregated persisted-replay provenance counters (no content) — active policy only. */
    replayStats?: PersistedReplayStats
  } = {}
): ModelMessage[] {
  const out: ModelMessage[] = []
  const active = activeChatContext(messages)
  if (active.summary) {
    out.push({
      role: 'assistant',
      content: `Summary of the conversation so far (compacted context):\n\n${active.summary}`,
    })
  }
  for (const msg of active.messages) {
    // Imported external context: ADDITIVE (does not reset) — sent as conversation context.
    const ctx = msg.parts.find((p): p is Extract<MessagePart, { type: 'context' }> => p.type === 'context')
    if (ctx) {
      out.push({
        role: 'assistant',
        content: `Context imported from ${ctx.source ?? 'another tool'} (continue from here):\n\n${ctx.text}`,
      })
      continue
    }
    if (msg.role === 'user') {
      // `/skill` invocation: UI shows only the chip; model receives the expanded BLOCK (instructions + folder
      // root + inventory) before user text.
      const text = [...skillBlocks(msg.parts), joinText(msg.parts)].filter(Boolean).join('\n\n')
      const files = msg.parts.filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file')
      if (files.length === 0) {
        if (text) out.push({ role: 'user', content: text })
        continue
      }
      // Multimodal user: text + images (image parts) + text files (inline text).
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string | Uint8Array }> = []
      if (text) content.push({ type: 'text', text })
      for (const f of files) {
        // dropImages: selected model rejects images (models.dev) → do not resend attachments (otherwise provider
        // rejects EVERY later turn). Replace with interpreter description or omission note.
        if (f.kind === 'image') {
          if (opts.dropImages) content.push({ type: 'text', text: droppedImageText(f) })
          else {
            const image = resolveFileImageBytesSync(msg.conversationId, f)
            if (image) content.push({ type: 'image', image: image.bytes })
            else if (f.data) content.push({ type: 'image', image: f.data })
          }
        }
        // hidden = injected inline @ mention (f.name already starts with @); otherwise an actual attachment.
        else if (f.hidden) content.push({ type: 'text', text: `Content referenced by ${f.name}:\n\n${f.data}` })
        else content.push({ type: 'text', text: `Attached file "${f.name}":\n\n${f.data}` })
      }
      // Even if only the note remains, send it as text — content is never empty here.
      out.push({ role: 'user', content } as ModelMessage)
      continue
    }
    // Assistant: traverse parts in order, splitting into steps.
    let content: AssistantContentPart[] = []
    let results: ToolResultContentPart[] = []
    // Persisted replay provenance: foreign reasoning (provider/model/fingerprint ≠ current selection,
    // or legacy message without `model`/fingerprint) does NOT return to the model — only empty fallback
    // in tool steps. `origin` also feeds aggregate chatDiag counters (per reasoning MESSAGE,
    // before discarding parts — CUMULATIVE: each modelMessagesFor reprocesses
    // all history, same convention as the intra-step wrapper).
    const origin = opts.reasoningReplay != null ? classifyPersistedReasoningOrigin(msg, opts.reasoningReplay) : null
    const canReplay = origin === 'match'
    if (opts.replayStats && origin && msg.parts.some((p) => p.type === 'reasoning')) {
      // Tool-only gets structural "" — neither degradation nor replay; not counted.
      if (origin === 'match') opts.replayStats.replayedSteps += 1
      else if (origin === 'provider-mismatch') opts.replayStats.degradedProviderMismatch += 1
      else if (origin === 'model-mismatch') opts.replayStats.degradedModelMismatch += 1
      else if (origin === 'fingerprint-missing') opts.replayStats.degradedFingerprintMissing += 1
      else opts.replayStats.degradedFingerprintMismatch += 1
    }
    const flush = () => {
      if (content.length === 0 && results.length === 0) return
      if (content.length) {
        const hasTool = content.some((c) => c.type === 'tool-call')
        const hasReasoning = content.some((c) => c.type === 'reasoning')
        if (hasTool || hasReasoning) {
          // Tool call and/or reasoning → parts array (idiomatic string would lose reasoning).
          const message: Record<string, unknown> = { role: 'assistant', content }
          if (opts.reasoningReplay) {
            const reasoning = content
              .filter((c): c is Extract<AssistantContentPart, { type: 'reasoning' }> => c.type === 'reasoning')
              .map((c) => c.text)
              .join('')
            // openai-compatible serializes `providerOptions.openaiCompatible` in the message body
            // (getOpenAIMetadata) — explicit field guarantees PRESENT `reasoning_content`, even "".
            message.providerOptions = {
              openaiCompatible: { [opts.reasoningReplay.field]: hasReasoning ? reasoning : '' },
            }
          }
          out.push(message as ModelMessage)
        } else {
          // Plain text → string (idiomatic form).
          out.push({
            role: 'assistant',
            content: content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
          } as ModelMessage)
        }
      }
      if (results.length) out.push({ role: 'tool', content: results } as ModelMessage)
      content = []
      results = []
    }
    for (const p of msg.parts) {
      if (p.type === 'text') {
        if (p.checkpoint === 'openai-native') continue
        if (results.length > 0) flush() // Text after tool result = new step.
        if (p.text) content.push({ type: 'text', text: p.text })
      } else if (p.type === 'reasoning') {
        // Reasoning returns only with active interleaved policy AND matching provenance
        // (otherwise display-only). Start a new step if tool results already accumulated — otherwise
        // reasoning1/tool1/reasoning2/tool2 would mix values in one step.
        if (!canReplay) continue
        if (results.length > 0) flush()
        content.push({ type: 'reasoning', text: p.text })
      } else if (p.type === 'tool') {
        content.push({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input ?? {} })
        results.push({
          type: 'tool-result',
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          output: toolResultOutput(p.state, { dropImages: opts.dropImages }),
        })
      } else if (p.type === 'generated-image') {
        // Only the textual REFERENCE: resending generated bytes costs image tokens every turn; the
        // artifact already lives on disk. Model remembers producing it (and its effective prompt).
        if (results.length > 0) flush()
        content.push({ type: 'text', text: generatedImageReference(p) })
      }
    }
    flush()
  }
  // PROMPT CACHING (Anthropic): mark cache_control breakpoints. Each caches EVERYTHING preceding it in
  // render order (tools → system → messages). Aligned with opencode (provider/transform.ts):
  // ANCHOR first message (caches stable preceding tools+system) + LAST TWO messages
  // (history). Their cache-policy.ts explains the last two: the last user message remains
  // FIXED while a turn expands into assistant/tool steps, so caching there lets every
  // intra-turn call hit the prefix. ≤3 breakpoints (Anthropic limit = 4). Only @ai-sdk/anthropic.
  return opts.cacheControl ? withAnthropicCacheControl(out) : out
}

/**
 * Returns a copy with at most three Anthropic breakpoints. Removes old breakpoints before recalculating
 * positions so growing continuation arrays do not accumulate `cache_control` beyond the limit.
 */
export function withAnthropicCacheControl(messages: readonly ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return []
  const breakpoints = new Set([0, messages.length - 2, messages.length - 1].filter((index) => index >= 0))
  return messages.map((message, index) => {
    const providerOptions = { ...(message.providerOptions ?? {}) } as Record<string, Record<string, unknown>>
    const anthropic = { ...(providerOptions.anthropic ?? {}) }
    delete anthropic.cacheControl
    if (breakpoints.has(index)) anthropic.cacheControl = { type: 'ephemeral' as const }
    if (Object.keys(anthropic).length > 0) providerOptions.anthropic = anthropic
    else delete providerOptions.anthropic
    return {
      ...message,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : { providerOptions: undefined }),
    } as ModelMessage
  })
}

export function clipMiddle(text: string, maxChars: number, marker: string): string {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text
  const budget = Math.max(0, Math.floor(maxChars) - marker.length)
  const head = Math.floor(budget / 4)
  return text.slice(0, head) + marker + text.slice(text.length - (budget - head))
}

/**
 * Cap on tool outputs persisted by native runners (Codex/Copilot). Without it, one server-side exec
 * (e.g. pytest with 1 MB stderr) inflates parts_json and future transcript reseeds
 * overflow the API character limit. Same intent as host bash MAX_OUTPUT_BYTES.
 */
export const MAX_PERSISTED_TOOL_OUTPUT_CHARS = 50_000

export function clipPersistedToolOutput(text: string): string {
  return clipMiddle(text, MAX_PERSISTED_TOOL_OUTPUT_CHARS, '\n\n… output truncated …\n\n')
}

function toolStateText(state: Extract<MessagePart, { type: 'tool' }>['state']): string {
  switch (state.status) {
    case 'completed':
      return toolOutputText(state.output)
    case 'running':
      return toolOutputText(state.output)
    case 'error':
      return state.error
    case 'denied':
      return state.reason ?? ''
    default:
      return ''
  }
}

/**
 * Transcribes active portable context. Text reconstructed for another provider (including
 * mentions/attachments) must enter the summary; images stay textual references. Individual tool outputs
 * retain explicit caps with visible truncation markers.
 */
export function renderTranscript(
  messages: ChatMessage[],
  opts: { maxChars?: number; maxToolOutputChars?: number } = {}
): string {
  const active = activeChatContext(messages)
  const blocks: string[] = active.summary ? [`Previous summary:\n${active.summary}`] : []
  const maxToolOutputChars = opts.maxToolOutputChars ?? 16_000
  for (const m of active.messages) {
    const who = m.role === 'user' ? 'User' : 'Assistant'
    const parts: string[] = []
    for (const p of m.parts) {
      if (p.type === 'text') {
        if (p.checkpoint === 'openai-native') continue
        if (p.text.trim()) parts.push(p.text.trim())
      } else if (p.type === 'file') {
        // Interpreter description accompanies images in transcripts: destinations always receive
        // TEXT only (portable compaction, native thread/session seed).
        if (p.kind === 'image') parts.push(droppedImageText(p))
        else if (p.data?.trim()) {
          parts.push(
            `${p.hidden ? `[referenced content from ${p.name}]` : `[attached file: ${p.name}]`}\n${p.data.trim()}`
          )
        }
      } else if (p.type === 'context') {
        if (p.text.trim()) parts.push(`[imported context${p.source ? ` from ${p.source}` : ''}]\n${p.text.trim()}`)
      } else if (p.type === 'generated-image') {
        parts.push(generatedImageReference(p))
      } else if (p.type === 'skill-invocation') {
        // Only the REFERENCE: reinjecting skill bodies into compaction summaries would waste tokens.
        parts.push(`[invoked skill /${p.name}${p.args ? ` ${p.args}` : ''}]`)
      } else if (p.type === 'tool') {
        let input = ''
        try {
          input = JSON.stringify(p.input ?? {})
        } catch {
          input = String(p.input ?? '')
        }
        const output = toolStateText(p.state).trim()
        const images = toolOutputImages(
          p.state.status === 'completed' || p.state.status === 'running' ? p.state.output : undefined
        )
        const imageRefs = images.length
          ? `\nimages: ${images.map((image) => image.name ?? image.mediaType).join(', ')}`
          : ''
        const clipped = output
          ? clipMiddle(output, maxToolOutputChars, '\n… tool output truncated for compaction …\n')
          : ''
        parts.push(
          `[tool ${p.toolName} → ${p.state.status}]${input ? `\ninput: ${input}` : ''}${clipped ? `\noutput:\n${clipped}` : ''}${imageRefs}`
        )
      }
    }
    if (m.error) parts.push(`[error: ${m.error}]`)
    const body = parts.join('\n').trim()
    if (body) blocks.push(`${who}: ${body}`)
  }
  const transcript = blocks.join('\n\n')
  return opts.maxChars
    ? clipMiddle(transcript, opts.maxChars, '\n\n… transcript middle omitted for compaction …\n\n')
    : transcript
}

/**
 * Single native-runtime reseed contract. Meter/preflight must project exactly this payload;
 * centralized limits prevent estimates counting outputs Codex/Copilot/Claude never receive.
 */
export const NATIVE_SEED_MAX_TOOL_OUTPUT_CHARS = 16_000
export const NATIVE_SEED_MAX_TRANSCRIPT_CHARS = 800_000
export const NATIVE_SEED_CONTEXT_PREFIX =
  'Context imported from the existing Maestrly conversation. Treat it as prior dialogue and continue from it:\n\n'

export function renderNativeSeedTranscript(messages: readonly ChatMessage[]): string {
  return renderTranscript([...messages], {
    maxToolOutputChars: NATIVE_SEED_MAX_TOOL_OUTPUT_CHARS,
    maxChars: NATIVE_SEED_MAX_TRANSCRIPT_CHARS,
  })
}

export function nativeSeedContextText(transcript: string): string {
  return transcript ? NATIVE_SEED_CONTEXT_PREFIX + transcript : ''
}
