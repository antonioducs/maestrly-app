import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../src/shared/chat'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { TodoCard } from '../../src/renderer/components/chat/TodoCard'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

function renderTodos(input: unknown, status: 'running' | 'error' = 'running'): string {
  const part: ToolPart = {
    type: 'tool',
    id: 'todo-call',
    toolCallId: 'todo-call',
    toolName: 'todo_write',
    input,
    state: status === 'error' ? { status, error: 'Tool unavailable' } : { status },
  }
  return renderToStaticMarkup(createElement(TodoCard, { part }))
}

describe('TodoCard unvalidated tool input', () => {
  it('does not crash on a serialized task list, including failed tool calls', () => {
    const input = { todos: JSON.stringify([{ content: 'Inspect files', status: 'in_progress' }]) }
    expect(renderTodos(input)).toBe('')
    expect(renderTodos(input, 'error')).toBe('')
  })

  it.each([
    undefined,
    null,
    '',
    42,
    [],
    {},
    { todos: null },
    { todos: 42 },
    { todos: true },
    { todos: {} },
    { todos: '[{"content":' },
    { todos: [] },
  ])('ignores incomplete or non-array input: %j', (input) => {
    expect(renderTodos(input)).toBe('')
  })

  it('renders valid tasks and progress while omitting malformed entries', () => {
    const html = renderTodos({
      todos: [
        null,
        false,
        42,
        'task',
        {},
        { content: 42, status: 'pending' },
        { content: 'Missing status' },
        { content: 'Unknown status', status: 'invalid' },
        { content: 'Inspect files', status: 'completed' },
        { content: 'Fix rendering', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
      ],
    })
    expect(html).toContain('1/3')
    expect(html).toContain('Inspect files')
    expect(html).toContain('Fix rendering')
    expect(html).toContain('Run tests')
    expect(html).not.toContain('Missing status')
    expect(html).not.toContain('Unknown status')
    expect(html.match(/<li\b/g)).toHaveLength(3)
  })

  it('renders a valid update after malformed streamed input', () => {
    expect(renderTodos({ todos: '[]' })).toBe('')
    const html = renderTodos({ todos: [{ content: 'Recovered task', status: 'completed' }] })
    expect(html).toContain('Recovered task')
    expect(html).toContain('1/1')
  })
})
