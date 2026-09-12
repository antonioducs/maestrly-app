import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webfetchTool } from '../../src/main/chat/tools/webfetch'
import type { ToolContext } from '../../src/main/chat/tools/util'

afterEach(() => vi.restoreAllMocks())

async function fetchHtml(html: string, format: 'text' | 'markdown' | 'html' = 'text', mime = 'text/html') {
  const ask = vi.fn(async () => {})
  const ctx: ToolContext = {
    conversationId: 'webfetch-test',
    projectId: 'project',
    messageId: 'message',
    toolCallId: 'tool',
    cwd: '.',
    signal: new AbortController().signal,
    ask,
    askQuestion: async () => [],
  }
  vi.spyOn(net, 'fetch').mockImplementation(async () => new Response(html, { headers: { 'content-type': mime } }))
  const result = await webfetchTool.execute({ url: 'https://example.test/page', format }, ctx)
  expect(ask).toHaveBeenCalledWith('webfetch', ['https://example.test/page'], ['https://example.test/*'])
  return result.output
}

describe('webfetch HTML text extraction', () => {
  it('omits script/style/noscript bodies with legal whitespace in closing tags', async () => {
    expect(
      await fetchHtml(
        '<p>Before</p><script>hidden()</script ><style>secret{}</style ><noscript>hidden</noscript ><p>After</p>'
      )
    ).toBe('Before\nAfter')
  })

  it('decodes character references once and preserves text containing markup characters', async () => {
    expect(await fetchHtml('<p>&amp;lt;script&amp;gt; &lt;literal&gt; &#x1F600; &copy; &nbsp;</p>')).toBe(
      '&lt;script&gt; <literal> 😀 ©'
    )
  })

  it('parses quoted greater-than signs and comments without leaking attributes', async () => {
    expect(await fetchHtml('<div title="a > b">Hello<!-- > ignored --> world<br>Next</div>')).toBe('Hello world\nNext')
  })

  it('does not promote malformed nested markup into executable elements', async () => {
    expect(await fetchHtml('<p>safe</p><script><script>evil()</script ><p>visible</p>')).toBe('safe\nvisible')
  })

  it('handles case-insensitive HTML MIME values', async () => {
    expect(await fetchHtml('<p>visible</p>', 'markdown', 'Text/HTML; charset=UTF-8')).toBe('visible')
  })

  it('preserves explicitly requested raw HTML and non-HTML responses', async () => {
    const raw = '<script>raw text</script>'
    expect(await fetchHtml(raw, 'html')).toBe(raw)
    expect(await fetchHtml(raw, 'text', 'text/plain')).toBe(raw)
  })
})
