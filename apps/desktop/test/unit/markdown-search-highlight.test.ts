import { describe, expect, it } from 'vitest'
import {
  findCaseInsensitiveRanges,
  rehypeChatMentions,
  rehypeMarkdownSearchHighlight,
} from '../../src/renderer/lib/markdown-search-highlight'

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

function text(value: string): Node {
  return { type: 'text', value }
}

function element(tagName: string, children: Node[]): Node {
  return { type: 'element', tagName, properties: {}, children }
}

function markedText(node: Node): string[] {
  const out: string[] = []
  const visit = (current: Node) => {
    if (current.tagName === 'mark') out.push(current.children?.map((child) => child.value ?? '').join('') ?? '')
    current.children?.forEach(visit)
  }
  visit(node)
  return out
}

describe('rehypeMarkdownSearchHighlight', () => {
  it('highlights all literal occurrences case-insensitively', () => {
    const tree = element('root', [element('p', [text('Banana, BANANA e banana.')])])

    rehypeMarkdownSearchHighlight({ query: 'banana' })(tree)

    expect(markedText(tree)).toEqual(['Banana', 'BANANA', 'banana'])
  })

  it('preserves Markdown elements and finds text spanning inline marks', () => {
    const link = element('a', [text('na')])
    const strong = element('strong', [text('na')])
    const paragraph = element('p', [text('ba'), link, strong, text(' e fim')])
    const tree = element('root', [paragraph])

    rehypeMarkdownSearchHighlight({ query: 'banana', current: true })(tree)

    expect(paragraph.children?.[1]).toBe(link)
    expect(paragraph.children?.[2]).toBe(strong)
    expect(markedText(tree)).toEqual(['ba', 'na', 'na'])
    expect(
      paragraph.children
        ?.flatMap((child) => (child.tagName === 'mark' ? [child] : (child.children ?? [])))
        .filter((child) => child.tagName === 'mark')
        .every((mark) => (mark.properties?.className as string[]).includes('chat-search-match--current'))
    ).toBe(true)
  })

  it('prevents matches from crossing nested list items', () => {
    const childItem = element('li', [text('na')])
    const parentItem = element('li', [text('bana'), element('ul', [childItem])])
    const tree = element('root', [element('ul', [parentItem])])

    rehypeMarkdownSearchHighlight({ query: 'banana' })(tree)

    expect(markedText(tree)).toEqual([])
  })

  it('keeps highlighted code, tables, and Mermaid structurally intact', () => {
    const keyword = element('span', [text('const')])
    keyword.properties = { className: ['hljs-keyword'] }
    const code = element('code', [keyword, text(' alvo = "ALVO"')])
    code.properties = { className: ['hljs', 'language-ts'] }
    const pre = element('pre', [code])
    const table = element('table', [element('tbody', [element('tr', [element('td', [text('alvo')])])])])
    const mermaidCode = element('code', [text('graph TD; alvo-->B')])
    mermaidCode.properties = { className: ['language-mermaid'] }
    const mermaidPre = element('pre', [mermaidCode])
    const tree = element('root', [pre, table, mermaidPre])

    rehypeMarkdownSearchHighlight({ query: 'alvo' })(tree)

    expect(tree.children?.map((child) => child.tagName)).toEqual(['pre', 'table', 'pre'])
    expect(code.children?.[0]).toBe(keyword)
    expect(keyword.properties?.className).toEqual(['hljs-keyword'])
    expect(markedText(tree)).toEqual(['alvo', 'ALVO', 'alvo', 'alvo'])
  })

  it('preserves @file mentions as clickable nodes before highlighting', () => {
    const paragraph = element('p', [text('Veja @src/chat.ts:L3-7 e `@ignorado.ts`.')])
    const inlineCode = element('code', [text('@ignorado.ts')])
    paragraph.children = [text('Veja @src/chat.ts:L3-7 e '), inlineCode, text('.')]
    const tree = element('root', [paragraph])

    rehypeChatMentions()(tree)
    rehypeMarkdownSearchHighlight({ query: 'chat.ts' })(tree)

    const chip = paragraph.children?.find((child) => child.tagName === 'button')
    expect(chip?.properties).toMatchObject({
      dataMentionPath: 'src/chat.ts',
      dataMentionDirectory: false,
      dataMentionStartLine: 3,
      dataMentionEndLine: 7,
    })
    const directoryTree = element('root', [element('p', [text('Veja @src/chat/')])])
    rehypeChatMentions()(directoryTree)
    expect(directoryTree.children?.[0]?.children?.[1]?.properties?.dataMentionDirectory).toBe(true)

    expect(inlineCode.children?.[0]?.tagName).toBeUndefined()
    expect(markedText(tree)).toEqual(['chat.ts'])
  })

  it('ignores empty queries and correctly maps characters that expand when lowercased', () => {
    const tree = element('root', [element('p', [text('İstanbul')])])
    rehypeMarkdownSearchHighlight({ query: '   ' })(tree)
    expect(markedText(tree)).toEqual([])

    expect(findCaseInsensitiveRanges('İstanbul', 'i̇s')).toEqual([{ start: 0, end: 2 }])
  })
})
