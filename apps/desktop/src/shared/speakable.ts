/**
 * What a voice reads of an answer: plain sentences, with code, diagrams, tables and links left for the chat, and the
 * Markdown marks and emojis gone. `SentenceChunker` cuts streaming text into sentences a voice can start reading
 * while the rest still arrives.
 */
import { tFor } from './i18n'
import type { SupportedLocale } from './locale'

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0E|\uFE0F|\u20E3/gu
// Not named URL: the bundler injects `new URL(...)` for asset imports, and a module-level `URL` would shadow it.
const URL_PATTERN = /\bhttps?:\/\/[^\s)<>]*[^\s)<>.,;:!?'"]/gi

function inline(text: string, link: string): string {
  return (
    text
      // Images go; links keep their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(URL_PATTERN, link)
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(EMOJI, '')
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
}

/** The answer as plain spoken text: one block (paragraph, heading, item) per paragraph. */
export function toSpeakable(markdown: string, locale: SupportedLocale): string {
  const t = tFor(locale, 'ui')
  const said = {
    code: t('assistant.spoken.code'),
    diagram: t('assistant.spoken.diagram'),
    table: t('assistant.spoken.table'),
    link: t('assistant.spoken.link'),
  }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  const endParagraph = () => {
    const text = inline(paragraph.join(' '), said.link)
    if (text) blocks.push(text)
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      endParagraph()
      const marker = fence[1]
      const lang = fence[2].toLowerCase()
      // An unclosed fence (a streaming answer) runs to the end, as Markdown renders it.
      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith(marker)) j++
      i = j
      blocks.push(lang === 'mermaid' || lang === 'inline-html' ? said.diagram : said.code)
      continue
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      endParagraph()
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) j++
      i = j - 1
      blocks.push(said.table)
      continue
    }
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endParagraph()
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (heading || item) {
      endParagraph()
      paragraph.push((heading ?? item)![1])
      endParagraph()
      continue
    }
    paragraph.push(quote ? quote[1] : line)
  }
  endParagraph()
  // Placeholders that follow each other ("(code) (code)") are said once.
  const placeholders = new Set(Object.values(said))
  return blocks.filter((block, index) => !(placeholders.has(block) && block === blocks[index - 1])).join('\n\n')
}

const ABBREVIATIONS = new Set([
  'sr',
  'sra',
  'srta',
  'dr',
  'dra',
  'prof',
  'profa',
  'ex',
  'etc',
  'vs',
  'obs',
  'pág',
  'pag',
  'mr',
  'mrs',
  'st',
  'nº',
  'approx',
  'aprox',
])
const CLOSERS = new Set([')', ']', '"', "'", '”', '’', '»'])
const ENDERS = new Set(['.', '!', '?', '…'])

/** Whether the "." at `index` ends an abbreviation such as "Dr." or "e.g." rather than a sentence. */
function abbreviationAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index + 1)
  if (/(?:^|[^\p{L}])(?:e\.g|i\.e|p\.ex|a\.c|d\.c)\.$/iu.test(before)) return true
  const word = /([\p{L}º]+)\.$/u.exec(before)?.[1]
  return !!word && ABBREVIATIONS.has(word.toLowerCase())
}

export class SentenceChunker {
  private buffer = ''
  private readonly minChars: number
  private readonly maxChars: number

  constructor(opts: { minChars?: number; maxChars?: number } = {}) {
    this.minChars = opts.minChars ?? 12
    this.maxChars = opts.maxChars ?? 400
  }

  /** Adds streamed text and returns the sentences it completed. */
  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    let from = 0
    for (;;) {
      const end = this.boundary(from)
      if (end < 0) break
      const sentence = this.buffer.slice(0, end)
      if (sentence.trim().length < this.minChars) {
        from = end
        continue
      }
      out.push(...this.split(sentence))
      this.buffer = this.buffer.slice(end)
      from = 0
    }
    while (this.buffer.length > this.maxChars) {
      const cut = this.cutAt(this.buffer)
      out.push(...clean(this.buffer.slice(0, cut)))
      this.buffer = this.buffer.slice(cut)
    }
    return out
  }

  /** The rest, sentence or not, once the text is complete. */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    return this.split(rest)
  }

  /** The end (exclusive) of the first sentence that closes at or after `from`, or -1. */
  private boundary(from: number): number {
    const text = this.buffer
    for (let i = from; i < text.length; i++) {
      if (text[i] === '\n' && text[i + 1] === '\n') return i + 2
      if (!ENDERS.has(text[i])) continue
      let j = i + 1
      while (j < text.length && (ENDERS.has(text[j]) || CLOSERS.has(text[j]))) j++
      // What follows decides: a space ends the sentence, anything else ("1.5", "a.b.ts") does not, and the end of
      // the text so far cannot tell yet.
      if (j >= text.length) return -1
      if (!/\s/.test(text[j])) continue
      if (text[i] === '.' && j === i + 1 && abbreviationAt(text, i)) continue
      return j
    }
    return -1
  }

  /** Where to cut text longer than `maxChars`: the comma nearest the limit, else a space. */
  private cutAt(text: string): number {
    const limit = this.maxChars
    const before = text.lastIndexOf(',', limit - 1)
    const after = text.indexOf(',', limit)
    const comma =
      before > 0 && (after < 0 || limit - before <= after - limit)
        ? before
        : after > 0 && after < text.length - 1
          ? after
          : before
    if (comma > 0) return comma + 1
    const space = text.lastIndexOf(' ', limit)
    return space > 0 ? space + 1 : limit
  }

  private split(sentence: string): string[] {
    const out: string[] = []
    let rest = sentence
    while (rest.length > this.maxChars) {
      const cut = this.cutAt(rest)
      out.push(...clean(rest.slice(0, cut)))
      rest = rest.slice(cut)
    }
    out.push(...clean(rest))
    return out
  }
}

function clean(text: string): string[] {
  const value = text.replace(/\s+/g, ' ').trim()
  return value ? [value] : []
}
