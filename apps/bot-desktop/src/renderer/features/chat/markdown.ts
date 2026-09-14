// A deliberately small AST: all raw text is rendered through React text nodes.
// There is no HTML parser, remote image support, or executable URL scheme.
export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code' | 'link'; text: string; href?: string }
export type MarkdownBlock = { kind: 'paragraph' | 'code' | 'list'; text: string; inline?: Inline[]; items?: Inline[][] }
export function safeHttpsUrl(value: string): string | undefined {
  if (!/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}
export function inlineMarkdown(source: string): Inline[] {
  const tokens: Inline[] = []
  const pattern = /(!?\[[^\]\n]*\]\([^)\n]*\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ kind: 'text', text: source.slice(cursor, match.index) })
    const value = match[0]
    if (value.startsWith('!')) tokens.push({ kind: 'text', text: value })
    else if (value.startsWith('[')) {
      const divider = value.indexOf('](')
      const href = safeHttpsUrl(value.slice(divider + 2, -1))
      tokens.push(href ? { kind: 'link', text: value.slice(1, divider), href } : { kind: 'text', text: value })
    } else if (value.startsWith('**')) tokens.push({ kind: 'bold', text: value.slice(2, -2) })
    else if (value.startsWith('*')) tokens.push({ kind: 'italic', text: value.slice(1, -1) })
    else tokens.push({ kind: 'code', text: value.slice(1, -1) })
    cursor = match.index + value.length
  }
  if (cursor < source.length) tokens.push({ kind: 'text', text: source.slice(cursor) })
  return tokens
}
export function sanitizeMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) {
      const text = paragraph.join('\n')
      blocks.push({ kind: 'paragraph', text, inline: inlineMarkdown(text) })
      paragraph = []
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.startsWith('```')) {
      flush()
      const code: string[] = []
      while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index])
      blocks.push({ kind: 'code', text: code.join('\n') })
    } else if (/^\s*[-*] /.test(line)) {
      flush()
      const items: Inline[][] = []
      do {
        items.push(inlineMarkdown(lines[index].replace(/^\s*[-*] /, '')))
        index++
      } while (index < lines.length && /^\s*[-*] /.test(lines[index]))
      index--
      blocks.push({ kind: 'list', text: '', items })
    } else if (!line.trim()) flush()
    else paragraph.push(line)
  }
  flush()
  return blocks
}
