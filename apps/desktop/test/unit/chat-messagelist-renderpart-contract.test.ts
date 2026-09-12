import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const messageListSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatMessageList.tsx', import.meta.url),
  'utf8'
)

/**
 * Exhaustive rendering: agent-mention is metadata and never renders;
 * the final fallback accepts only tool parts so future variants cannot enter
 * ToolCallCard (which requires toolCallId/toolName and would fail at runtime).
 */
describe('ChatMessageList renderPart exhaustiveness', () => {
  it('returns null for mention metadata before rendering cards', () => {
    // The early return precedes specialized tool cards.
    const mentionReturn = messageListSource.indexOf("if (part.type === 'agent-mention') return null")
    expect(mentionReturn).toBeGreaterThanOrEqual(0)
    const firstToolCard = messageListSource.indexOf("toolPart.toolName === 'ask_question'")
    expect(firstToolCard).toBeGreaterThan(0)
    expect(mentionReturn).toBeLessThan(firstToolCard)
  })

  it('renders final ToolCallCard fallback only for tool parts', () => {
    expect(messageListSource).toContain("if (part.type === 'tool') {")
    expect(messageListSource).toContain(
      'return <ToolCallCard part={toolPart} conversationId={conversationId} messageId={messageId} />'
    )
    // The blind fallback without a type guard was removed.
    expect(messageListSource).not.toContain('return <ToolCallCard part={part} />\n}')
  })
})

describe('interrupted review-round error rendering', () => {
  it('prefers public error codes over raw internal codes', () => {
    // Translate public codes before falling back to raw errors.
    const interruptedBranch = messageListSource.indexOf("message.errorCode === 'review-loop-process-interrupted'")
    expect(interruptedBranch).toBeGreaterThanOrEqual(0)
    const rawFallback = messageListSource.indexOf(': message.error}')
    expect(rawFallback).toBeGreaterThan(interruptedBranch)
    // Localized text belongs in the same code branch before raw fallback.
    const localized = messageListSource.indexOf("t('chatgptWeb.reviewLoopProcessInterruptedError')")
    expect(localized).toBeGreaterThan(interruptedBranch)
    expect(localized).toBeLessThan(rawFallback)
  })

  it('classifies the round as interrupted, never failed, and uses translated status', () => {
    // Public codes precede generic message-error gates.
    const interruptedStatus = messageListSource.indexOf("message.errorCode === 'review-loop-process-interrupted'")
    const errorStatus = messageListSource.indexOf('if (message.error) return')
    expect(interruptedStatus).toBeGreaterThanOrEqual(0)
    expect(interruptedStatus).toBeLessThan(errorStatus)
    expect(messageListSource).toContain("'reviewLoopStatusInterrupted'")
    expect(messageListSource).toContain("'interrupted'")
  })
})
