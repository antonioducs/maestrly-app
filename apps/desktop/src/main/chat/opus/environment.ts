import type { ModelMessage } from 'ai'

/** Keep volatile environment data out of the cached system prompt and persisted transcript. */
export function withOpusEnvironment(messages: ModelMessage[], environment: string): ModelMessage[] {
  const context = { type: 'text' as const, text: `# Current environment\n${environment}` }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const content =
      typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
    return messages.map((entry, position) =>
      position === index ? { ...message, content: [context, ...content] } : entry
    )
  }
  return [{ role: 'user', content: [context] }, ...messages]
}
