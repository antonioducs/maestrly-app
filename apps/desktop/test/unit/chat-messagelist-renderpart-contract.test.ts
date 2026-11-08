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

describe('message error rendering', () => {
  it('prefers public error codes over raw internal codes', () => {
    // Translate public codes before falling back to raw errors.
    const interruptedBranch = messageListSource.indexOf("message.errorCode === 'process-interrupted'")
    expect(interruptedBranch).toBeGreaterThanOrEqual(0)
    const rawFallback = messageListSource.indexOf(': message.error}')
    expect(rawFallback).toBeGreaterThan(interruptedBranch)
    // Localized text belongs in the same code branch before raw fallback.
    const localized = messageListSource.indexOf("t('messages.processInterruptedError')")
    expect(localized).toBeGreaterThan(interruptedBranch)
    expect(localized).toBeLessThan(rawFallback)
  })

  it('renders messages of a retired review loop as ordinary messages, without round chrome', () => {
    expect(messageListSource).not.toContain('ReviewLoopRoundChrome')
    expect(messageListSource).not.toContain('review-loop')
    expect(messageListSource).not.toContain('chatgptWeb')
  })
})

describe('degraded compaction divider', () => {
  it('passes the part flag to the divider, which shows the localized notice', () => {
    expect(messageListSource).toContain('degraded={part.degraded === true}')
    expect(messageListSource).toContain("{t('messages.compactionDegraded')}")
  })
})

describe('automatic stop error rendering', () => {
  it('translates the automatic stop codes before falling back to the stored English text', async () => {
    const { default: en } = await import('../../src/shared/i18n/en/chat')
    const { default: ptBR } = await import('../../src/shared/i18n/pt-BR/chat')
    const rawFallback = messageListSource.indexOf(': message.error}')
    const branch = messageListSource.indexOf('? t(automaticStopMessageKey(message.errorCode)!)')
    expect(branch).toBeGreaterThanOrEqual(0)
    expect(branch).toBeLessThan(rawFallback)
    for (const [code, key] of [
      ['tool-loop-stopped', 'toolLoopStopped'],
      ['invalid-tool-calls-stopped', 'invalidToolCallsStopped'],
      ['repetitive-output-stopped', 'repetitiveOutputStopped'],
    ] as const) {
      expect(messageListSource).toContain(`errorCode === '${code}') return 'messages.${key}' as const`)
      expect(en.messages[key]).toMatch(/^Maestrly stopped this response/)
      expect(ptBR.messages[key]).toMatch(/^A Maestrly interrompeu esta resposta/)
    }
  })
})
