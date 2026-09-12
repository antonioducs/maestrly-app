import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface GatedClaudeUserPrompt {
  prompt: AsyncIterable<SDKUserMessage>
  release: () => void
  reject: (error: unknown) => void
}

/**
 * Streams human-authored content through the structured SDK input channel.
 * Unlike `prompt: string`, this cannot be interpreted as a Claude Code slash
 * command. The gate also lets the caller verify the initialized account before
 * the first byte of untrusted input reaches the runtime.
 */
export function gatedClaudeHumanPrompt(
  content: SDKUserMessage['message']['content']
): GatedClaudeUserPrompt {
  let release!: () => void
  let reject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, rejectReady) => {
    release = resolve
    reject = rejectReady
  })
  // A test double or an initialization failure may close the query before the
  // SDK starts iterating the prompt. Keep the gate rejection observed.
  void ready.catch(() => undefined)
  return {
    prompt: (async function* () {
      await ready
      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
      }
    })(),
    release,
    reject,
  }
}

export function gatedClaudeHumanText(text: string): GatedClaudeUserPrompt {
  return gatedClaudeHumanPrompt([{ type: 'text', text }])
}
