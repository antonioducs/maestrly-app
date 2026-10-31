import { generateText, type LanguageModel, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai'
import type { SharedV3ProviderOptions } from '@ai-sdk/provider'
import { estimateTextTokens } from '../portable-context'

/** The request a turn last sent, as the runner captured it in `prepareStep`. */
export interface LiveRequest {
  model: LanguageModel
  system: string
  messages: readonly ModelMessage[]
  tools: ToolSet
  providerOptions?: SharedV3ProviderOptions
  maxOutputTokens?: number
}

/**
 * Supplied by a runner that can repeat its last request: returns the summary that request produced for `instruction`,
 * with its usage, or null when it cannot try (the request would not fit, or there is none).
 */
export type LiveSummarizer = (
  instruction: string
) => Promise<{
  text: string
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number; totalInput: number }
} | null>

export interface LiveSummaryResult {
  text: string
  usage: LanguageModelUsage
  /** False when the model called a tool or ran out of output tokens instead of finishing the summary. */
  complete: boolean
}

/** Output a summary (and the thinking before it) needs at least; with less room, map-reduce is cheaper than failing. */
export const LIVE_SUMMARY_MIN_OUTPUT_TOKENS = 8_000
/** Output cap when the turn sets none. */
const DEFAULT_LIVE_SUMMARY_OUTPUT_TOKENS = 32_000

/** The same tool definitions, without anything that could run: a call is detected and the summary discarded. */
export function toolsWithoutExecution(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const { execute: _execute, ...declaration } = definition as typeof definition & { execute?: unknown }
      return [name, declaration]
    })
  ) as ToolSet
}

/**
 * Output tokens the repeated request can ask for: the room left in the window (providers reject input plus output
 * above it), up to the turn's own cap, or null below the minimum. `contextTokens` is the occupancy the provider
 * measured for that request. The output cap is not part of the cached prefix.
 */
export function liveSummaryOutputTokens(
  request: LiveRequest,
  instruction: string,
  fit: { contextTokens: number; contextWindow: number }
): number | null {
  const room = fit.contextWindow - fit.contextTokens - estimateTextTokens(instruction) - 256
  const output = Math.min(request.maxOutputTokens ?? DEFAULT_LIVE_SUMMARY_OUTPUT_TOKENS, room)
  return output >= LIVE_SUMMARY_MIN_OUTPUT_TOKENS ? output : null
}

/**
 * Asks for the summary by repeating the turn's last request, byte for byte (system, tools, provider options, effort,
 * messages and their cache breakpoints), with one more user message. The provider's prompt cache then covers the
 * whole conversation. `toolChoice` is left alone because changing it invalidates Anthropic's cache; a tool call
 * comes back as an incomplete result instead.
 */
export async function summarizeFromLiveRequest(
  request: LiveRequest,
  instruction: string,
  maxOutputTokens: number,
  signal: AbortSignal
): Promise<LiveSummaryResult> {
  const result = await generateText({
    model: request.model,
    system: request.system,
    messages: [
      ...request.messages,
      {
        role: 'user',
        content: `${instruction}\n\nWrite that summary now for the conversation above. Do not call any tool.`,
      },
    ],
    tools: toolsWithoutExecution(request.tools),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    maxOutputTokens,
    maxRetries: 1,
    abortSignal: signal,
  })
  return {
    text: result.text.trim(),
    usage: result.totalUsage,
    complete: result.toolCalls.length === 0 && result.finishReason !== 'length',
  }
}
