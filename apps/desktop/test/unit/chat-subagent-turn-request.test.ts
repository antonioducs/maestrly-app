import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import { detectExplicitSubagentsForTurn, latestUserMessageText } from '../../src/main/chat/subagent-turn-request'

const AVAILABLE = ['general-purpose', 'testing', 'explore', 'myalias']

function textPart(text: string): MessagePart {
  return { type: 'text', id: 't', text }
}
function mentionPart(name: string, start = 0, end = 8): MessagePart {
  return { type: 'agent-mention', id: 'm', name, start, end }
}
function userMessage(parts: MessagePart[]): ChatMessage {
  return { id: 'm1', conversationId: 'c1', role: 'user', parts, createdAt: 1 }
}

describe('structured subagent parts take precedence over heuristics', () => {
  it('forces agents explicitly selected by structured parts', () => {
    const history = [userMessage([textPart('run the analysis'), mentionPart('testing')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['testing'])
  })

  it('does not force agents from manual questions', () => {
    const history = [userMessage([textPart('Por que o #testing falhou?')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })

  it('negated manual testing mention does NOT impose a requirement', () => {
    const history = [userMessage([textPart('Não use #testing; use general-purpose.')])]
    const result = detectExplicitSubagentsForTurn(history, AVAILABLE)
    expect(result).not.toContain('testing')
  })

  it('does not force agents from neutral manual text', () => {
    const history = [userMessage([textPart('faça #testing agora')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })

  it('recognizes Portuguese imperative delegation heuristics', () => {
    const history = [userMessage([textPart('chame o testing para isso')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['testing'])
  })

  it('deduplicates structured and heuristic requests', () => {
    const history = [userMessage([textPart('chame o testing'), mentionPart('testing')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['testing'])
  })

  it('ignores agents outside the catalog', () => {
    const history = [userMessage([textPart('hi'), mentionPart('ghost')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })

  it('accepts virtual aliases through structured parts', () => {
    const history = [userMessage([textPart('go'), mentionPart('myalias')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['myalias'])
  })

  it('preserves chip order and deduplicates heuristic requests', () => {
    const history = [userMessage([textPart('use explore'), mentionPart('testing'), mentionPart('explore')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['testing', 'explore'])
  })

  it('uses heuristics alone after chip removal', () => {
    const history = [userMessage([textPart('run the analysis')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })

  it('normalizes part names and separators', () => {
    const history = [userMessage([mentionPart('Testing-Foo')])]
    expect(detectExplicitSubagentsForTurn(history, [...AVAILABLE, 'testing-foo'])).toEqual(['testing-foo'])
  })

  it('considers only the latest user message', () => {
    const history = [userMessage([textPart('old'), mentionPart('testing')]), userMessage([textPart('new message')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })

  it('ignores non-text parts in latestUserMessageText', () => {
    const history = [
      userMessage([
        textPart('visible text'),
        { type: 'file', id: 'f', name: 'x.ts', mediaType: 'text/plain', kind: 'text', data: 'x' },
        mentionPart('testing'),
      ]),
    ]
    expect(latestUserMessageText(history)).toBe('visible text')
  })
})

describe('resend guard regressions', () => {
  it('returns requested agents from the latest structured user message', () => {
    const history = [
      userMessage([textPart('old version'), mentionPart('testing')]),
      userMessage([textPart('test #testing'), mentionPart('testing')]),
    ]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual(['testing'])
  })

  it('does not force agents for unstructured questions or documentation', () => {
    const history = [userMessage([textPart('Peça ao #testing para explicar isso?')])]
    expect(detectExplicitSubagentsForTurn(history, AVAILABLE)).toEqual([])
  })
})
