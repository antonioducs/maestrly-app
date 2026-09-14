import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { BotEvent } from '@maestrly/host-protocol'
import { mergeBotEvents } from '../src/renderer/features/chat/events'
import { sanitizeMarkdown, safeHttpsUrl } from '../src/renderer/features/chat/markdown'
import { Markdown } from '../src/renderer/features/chat/MessageList'
const event = (seq: number): BotEvent => ({
  seq,
  botId: 'bot-1',
  kind: 'turn.status',
  summary: 'Working',
  createdAt: '2026-09-13T12:00:00.000Z',
})
describe('bot event cursor', () => {
  it('deduplicates overlapping pages and keeps sequence order', () => {
    const merged = mergeBotEvents(
      { events: [event(1), event(3)], cursor: 3 },
      { events: [event(3), event(2), event(7)], cursor: 8, hasMore: true }
    )
    expect(merged.events.map((value) => value.seq)).toEqual([1, 2, 3, 7])
    expect(merged.cursor).toBe(8)
  })
  it('retains only the last 500 events and advances across gaps', () => {
    const merged = mergeBotEvents(
      { events: [], cursor: 0 },
      { events: Array.from({ length: 700 }, (_, index) => event(index * 2 + 1)), cursor: 1400, hasMore: false }
    )
    expect(merged.events).toHaveLength(500)
    expect(merged.events[0].seq).toBe(401)
    expect(merged.cursor).toBe(1400)
  })
  it('never moves backwards on an empty or stale response', () => {
    expect(mergeBotEvents({ events: [event(9)], cursor: 20 }, { events: [], cursor: 4, hasMore: false }).cursor).toBe(
      20
    )
    expect(mergeBotEvents({ events: [], cursor: 20 }, { events: [], cursor: 70, hasMore: false }).cursor).toBe(70)
  })
})
describe('safe markdown', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://example.com',
    'https://user:secret@example.com',
  ])('neutralizes %s links', (url) => {
    expect(safeHttpsUrl(url)).toBeUndefined()
    const html = renderToStaticMarkup(createElement(Markdown, { text: `[click](${url})` }))
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<button')
  })
  it('escapes script elements rather than creating executable HTML', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert("x")</script>' }))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('allows https links as explicit external actions without remote images', () => {
    expect(safeHttpsUrl('https://example.com/report')).toBe('https://example.com/report')
    expect(sanitizeMarkdown('[report](https://example.com/report)')[0].inline?.[0]).toEqual({
      kind: 'link',
      text: 'report',
      href: 'https://example.com/report',
    })
    const html = renderToStaticMarkup(createElement(Markdown, { text: '![image](https://example.com/image.png)' }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<button')
  })
  it('preserves fenced code verbatim and does not parse links in code', () => {
    const text = '<script>\n[unsafe](javascript:alert(1))'
    expect(sanitizeMarkdown(`\`\`\`js\n${text}\n\`\`\``)).toEqual([{ kind: 'code', text }])
  })
  it('handles lists and formatted text using a text-only AST', () => {
    expect(sanitizeMarkdown('- **bold**\n- *italic*\n\nInline `code`')).toMatchObject([
      { kind: 'list', items: [[{ kind: 'bold', text: 'bold' }], [{ kind: 'italic', text: 'italic' }]] },
      { kind: 'paragraph' },
    ])
  })
})
