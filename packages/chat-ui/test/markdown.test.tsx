import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, Markdown } from '../src'
import { labels } from './labels'

function Wrap({ children }: { children: ReactNode }) {
  return (
    <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>{children}</ChatUiProvider>
  )
}

describe('Markdown', () => {
  it('renders GFM tables, code with highlight classes and routes links through the host application', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <Markdown text={'| a |\n|---|\n| 1 |\n\n```ts\nconst x = 1\n```\n[site](https://example.org)'} />
      </Wrap>
    )
    expect(html).toContain('<table')
    expect(html).toContain('hljs')
    expect(html).toContain('href="https://example.org"')
  })
  it('turns a mermaid fence into a MermaidBlock instead of a code block', () => {
    // Server rendering never reaches the browser-only renderer, so the block is in its "rendering" state.
    const html = renderToStaticMarkup(
      <Wrap>
        <Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />
      </Wrap>
    )
    expect(html).toContain('data-mermaid')
    expect(html).not.toContain('<pre')
  })
})
