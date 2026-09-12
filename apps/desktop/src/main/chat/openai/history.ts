import type { ModelMessage } from 'ai'
import type { ChatMessage } from '../../../shared/chat'
import { activeChatContext, isOpenAINativeCompactionMarker, toModelMessages } from '../message'
import { latestOpenAICompactionIndex, parseOpenAIResponsesLedger, replayOpenAIResponsesLedger } from './ledger'
import type {
  OpenAICanonicalCompactionWindow,
  OpenAILedgerReplayIssue,
  OpenAILedgerValue,
  OpenAIResponsesLedger,
} from './types'

export type OpenAIHistoryReplayIssue =
  | (OpenAILedgerReplayIssue & { messageId: string })
  | {
      messageId: string
      entryIndex: -1
      code: 'invalid-inference-state'
      message: string
    }

export interface OpenAIHistoryBuildResult {
  messages: ModelMessage[]
  /** Prefix from /responses/compact; fetch injects these ResponseItems without reconversion. */
  rawPrefix?: OpenAILedgerValue[]
  issues: OpenAIHistoryReplayIssue[]
  lossless: boolean
  requiresRawResponsesInput: boolean
}

export interface OpenAIHistoryBuildOptions {
  dropImages?: boolean
  /**
   * `fallback` keeps chat usable through the legacy visual codec when a sidecar is incomplete/corrupt. `include`
   * returns representable messages even with issues; useful only for diagnostics/raw transport.
   */
  onLossyState?: 'fallback' | 'include'
}

export interface OpenAIHistoryInferenceState {
  ledger: OpenAIResponsesLedger
  canonicalWindow?: OpenAICanonicalCompactionWindow
}

export type OpenAIInferenceStateLookup = (
  messageId: string,
  message: ChatMessage
) => OpenAIResponsesLedger | OpenAIHistoryInferenceState | string | null | undefined

function readState(value: ReturnType<OpenAIInferenceStateLookup>): OpenAIHistoryInferenceState | null {
  if (value == null) return null
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (parsed && typeof parsed === 'object' && 'ledger' in parsed) {
    const state = parsed as OpenAIHistoryInferenceState
    const canonicalWindow = state.canonicalWindow
    if (canonicalWindow) {
      const output = canonicalWindow.response?.output
      if (canonicalWindow.kind !== 'responses.compact' || !Array.isArray(output)) {
        throw new TypeError('Invalid OpenAI canonical compaction window')
      }
    }
    return {
      ledger: parseOpenAIResponsesLedger(state.ledger),
      ...(canonicalWindow ? { canonicalWindow } : {}),
    }
  }
  return { ledger: parseOpenAIResponsesLedger(parsed) }
}

/**
 * Compose visual history with provider-native sidecars. Each assistant with a valid ledger replaces only its
 * legacy conversion; users, imported context, attachments, and compaction retain the existing rules.
 */
export function buildOpenAIModelMessages(
  history: readonly ChatMessage[],
  lookupState: OpenAIInferenceStateLookup,
  opts: OpenAIHistoryBuildOptions = {}
): OpenAIHistoryBuildResult {
  const messages: ModelMessage[] = []
  const issues: OpenAIHistoryReplayIssue[] = []
  let requiresRawResponsesInput = false
  const active = activeChatContext([...history])
  // activeChatContext keeps the checkpoint message id but trims its parts to the suffix.
  // That message's sidecar still represents the ENTIRE turn; using it here would reintroduce the compacted prefix.
  const textualCompactionMessageIds = new Set(
    history
      .filter((message) =>
        message.parts.some((part) => part.type === 'compaction' && part.strategy !== 'openai-native')
      )
      .map((message) => message.id)
  )

  const stateCache = new Map<string, OpenAIHistoryInferenceState | null>()
  const loadState = (message: ChatMessage): OpenAIHistoryInferenceState | null => {
    if (stateCache.has(message.id)) return stateCache.get(message.id) ?? null
    let state: OpenAIHistoryInferenceState | null = null
    if (message.role === 'assistant' && !textualCompactionMessageIds.has(message.id)) {
      try {
        state = readState(lookupState(message.id, message))
      } catch (error) {
        // Invalid state must not contaminate the request; the validated visual message is the safe fallback.
        issues.push({
          messageId: message.id,
          entryIndex: -1,
          code: 'invalid-inference-state',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    stateCache.set(message.id, state)
    return state
  }

  const canUseReplay = (replay: ReturnType<typeof replayOpenAIResponsesLedger>): boolean =>
    replay.lossless ||
    (opts.onLossyState === 'include' &&
      !replay.requiresRawResponsesInput &&
      !replay.issues.some((issue) => issue.requiresFallback === true))

  // Server-side compaction is an opaque canonical checkpoint only while its suffix can actually cross the
  // current ModelMessage transport. If a later opaque item requires raw Responses input, pruning first and then
  // falling back to the visual message would silently discard the entire prefix the checkpoint represented.
  let startMessageIndex = 0
  let startEntryIndex = -1
  let rawPrefix: OpenAILedgerValue[] | undefined
  for (let index = active.messages.length - 1; index >= 0; index--) {
    const state = loadState(active.messages[index])
    if (!state) continue
    const nativeMarker = active.messages[index].parts.some(isOpenAINativeCompactionMarker)
    const canonicalOutput = state.canonicalWindow?.response.output
    if (nativeMarker && Array.isArray(canonicalOutput)) {
      rawPrefix = canonicalOutput
      startMessageIndex = index + 1
      break
    }
    const compactionIndex = latestOpenAICompactionIndex(state.ledger)
    if (compactionIndex >= 0) {
      const suffixReplay = replayOpenAIResponsesLedger(
        {
          ...state.ledger,
          entries: state.ledger.entries.slice(compactionIndex),
        },
        { dropImages: opts.dropImages }
      )
      if (!canUseReplay(suffixReplay)) continue
      startMessageIndex = index
      startEntryIndex = compactionIndex
      break
    }
  }

  if (active.summary && startEntryIndex < 0 && !rawPrefix) {
    messages.push({
      role: 'assistant',
      content: `Summary of the conversation so far (compacted context):\n\n${active.summary}`,
    })
  }

  for (let index = startMessageIndex; index < active.messages.length; index++) {
    const message = active.messages[index]
    let state = loadState(message)
    if (state && index === startMessageIndex && startEntryIndex >= 0) {
      state = { ...state, ledger: { ...state.ledger, entries: state.ledger.entries.slice(startEntryIndex) } }
    }

    if (state) {
      const replay = replayOpenAIResponsesLedger(state.ledger, { dropImages: opts.dropImages })
      const messageIssues = replay.issues.map((issue) => ({ ...issue, messageId: message.id }))
      issues.push(...messageIssues)
      requiresRawResponsesInput ||= replay.requiresRawResponsesInput
      if (canUseReplay(replay)) {
        messages.push(...replay.messages)
        continue
      }
    }

    messages.push(...toModelMessages([message], { dropImages: opts.dropImages }))
  }

  return {
    messages,
    ...(rawPrefix ? { rawPrefix } : {}),
    issues,
    lossless: issues.length === 0,
    requiresRawResponsesInput,
  }
}
