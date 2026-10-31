import type { AcpContentBlock } from '../acp/protocol'
import { AntigravityPromptTooLargeError } from './errors'

/**
 * Antigravity keeps only the first 192,000 bytes of a prompt's text and silently drops the rest, so the end of an
 * oversized prompt (where the user's request goes) never reaches the model. Prompts stay below that, leaving room for
 * the envelope the runtime wraps around the text (`<USER_REQUEST>` and its metadata).
 */
export const ANTIGRAVITY_RUNTIME_PROMPT_MAX_BYTES = 192_000
export const ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES = ANTIGRAVITY_RUNTIME_PROMPT_MAX_BYTES - 2_048

/** Room for the stage label and output limit the portable summarizer puts before each chunk. */
const SUMMARY_STAGE_LABEL_BYTES = 512

export function antigravityPromptTextBytes(blocks: readonly AcpContentBlock[]): number {
  return blocks.reduce((total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
}

export function assertAntigravityPromptFits(blocks: readonly AcpContentBlock[]): void {
  const bytes = antigravityPromptTextBytes(blocks)
  if (bytes > ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES) throw new AntigravityPromptTooLargeError(bytes)
}

/** One tool-less prompt (summaries, one-shot text, image descriptions): the system text travels with the prompt. */
export function antigravityIsolatedPromptText(system: string, prompt: string): string {
  return `<system>\n${system}\n</system>\n\n${prompt}`
}

/** Largest transcript chunk whose summary prompt still fits once wrapped with `system`. */
export function antigravitySummaryChunkBytes(system: string): number {
  return (
    ANTIGRAVITY_PROMPT_TEXT_MAX_BYTES -
    Buffer.byteLength(antigravityIsolatedPromptText(system, ''), 'utf8') -
    SUMMARY_STAGE_LABEL_BYTES
  )
}
