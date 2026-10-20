import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { chatQuestionsFromInput, type ChatMessage, type MessagePart } from '../../src/shared/chat'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { QuestionCard } from '../../src/renderer/components/chat/QuestionCard'
import { projectChatMessages } from '../../src/main/fleet/instance/transcript'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

const valid = { question: 'Which one?', header: 'Pick', options: [{ label: 'A' }] }

// A model can send every argument as a string; the MCP layer rejects the call, but the part keeps that input.
const stringified: ToolPart = {
  type: 'tool',
  id: 'q1',
  toolCallId: 'q1',
  toolName: 'ask_question',
  input: { questions: JSON.stringify([valid]) },
  state: { status: 'error', error: 'MCP error -32602: Input validation error' },
}

describe('ask_question input', () => {
  it('keeps only well-formed questions', () => {
    expect(chatQuestionsFromInput({ questions: [valid, null, 'x', { question: 'No options' }] })).toEqual([valid])
    expect(chatQuestionsFromInput(stringified.input)).toEqual([])
    expect(chatQuestionsFromInput(null)).toEqual([])
    expect(chatQuestionsFromInput('questions')).toEqual([])
  })

  it('renders nothing for a rejected call whose questions are a string', () => {
    expect(() => renderToStaticMarkup(createElement(QuestionCard, { part: stringified }))).not.toThrow()
    expect(renderToStaticMarkup(createElement(QuestionCard, { part: stringified }))).toBe('')
  })

  it('projects a bot transcript with a rejected call whose questions are a string', () => {
    const message: ChatMessage = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      parts: [stringified],
      createdAt: Date.UTC(2026, 9, 20),
      finishReason: 'end_turn',
    }
    expect(projectChatMessages([message])).toEqual([])
    const asked = { ...message, parts: [{ ...stringified, input: { questions: [valid] } }] }
    expect(projectChatMessages([asked])).toMatchObject([{ kind: 'question', toolCallId: 'q1' }])
  })
})
