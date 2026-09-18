import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, TranscriptList, type TranscriptMessageLike } from '../src'
import { labels } from './labels'

function Wrap({ children, locale = 'en-US' }: { children: ReactNode; locale?: string }) {
  return <ChatUiProvider value={{ labels, openExternal: () => {}, locale }}>{children}</ChatUiProvider>
}
const at = '2026-09-17T14:05:00.000Z'
const user: TranscriptMessageLike = {
  id: 'u1',
  role: 'user',
  createdAt: at,
  parts: [{ type: 'text', id: 'u1:text', text: 'list files' }],
  streaming: false,
}
const card: TranscriptMessageLike = {
  id: 'turn:t1',
  role: 'assistant',
  createdAt: at,
  streaming: true,
  responseStartedAt: at,
  parts: [
    { type: 'reasoning', id: 'r', text: 'let me think' },
    { type: 'tool', id: 'tool:c1', callId: 'c1', toolName: 'bash', summary: 'Running a command', state: 'running' },
    { type: 'text', id: 't', text: '**done**' },
  ],
}

describe('TranscriptList', () => {
  it('renders a running tool card, folded reasoning and markdown text for a streaming card', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <TranscriptList messages={[user, card]} />
      </Wrap>
    )
    expect(html).toContain(labels.tool.running)
    expect(html).toContain('data-reasoning')
    expect(html).toContain('<strong>done</strong>')
    expect(html).toContain('data-streaming="true"')
    expect(html).toContain('class="message group user ')
  })
  it('formats the time of each message in the injected locale', () => {
    const en = renderToStaticMarkup(
      <Wrap>
        <TranscriptList messages={[user]} />
      </Wrap>
    )
    const pt = renderToStaticMarkup(
      <Wrap locale="pt-BR">
        <TranscriptList messages={[user]} />
      </Wrap>
    )
    expect(en).toContain(new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(at)))
    expect(pt).toContain(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(at)))
    expect(en).toMatch(new RegExp(`date[tT]ime="${at}"`))
  })
  it('hands files and system notices to the application through slots', () => {
    const system: TranscriptMessageLike = {
      id: 's',
      role: 'system',
      createdAt: at,
      parts: [{ type: 'text', id: 's:t', text: 'internal' }],
      streaming: false,
    }
    const withFile: TranscriptMessageLike = {
      ...card,
      streaming: false,
      parts: [{ type: 'file', id: 'f', path: 'a.md', name: 'a.md', size: 1 }],
    }
    const html = renderToStaticMarkup(
      <Wrap>
        <TranscriptList
          messages={[system, withFile]}
          slots={{ system: () => <em>notice</em>, file: (part) => <b>{part.name}!</b> }}
        />
      </Wrap>
    )
    expect(html).toContain('<em>notice</em>')
    expect(html).not.toContain('internal')
    expect(html).toContain('<b>a.md!</b>')
  })
})
