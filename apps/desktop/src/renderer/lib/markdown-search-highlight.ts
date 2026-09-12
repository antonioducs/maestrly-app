import { findMentions, type MentionMatch } from '../../shared/chat-mentions'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export interface SearchTextRange {
  start: number
  end: number
}

interface TextSegment {
  parent: HastNode
  index: number
  node: HastNode
  start: number
  end: number
}

interface SearchHighlightOptions {
  query?: string
  current?: boolean
}

const TEXT_SCOPES = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'th', 'td'])

export function findCaseInsensitiveRanges(text: string, query: string): SearchTextRange[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const haystack = text.toLowerCase()
  const lowerStarts: number[] = []
  const lowerEnds: number[] = []
  let lowerOffset = 0

  for (let originalStart = 0; originalStart < text.length; ) {
    const codePoint = text.codePointAt(originalStart)
    if (codePoint == null) break
    const char = String.fromCodePoint(codePoint)
    const originalEnd = originalStart + char.length
    const lowerLength = char.toLowerCase().length
    for (let i = 0; i < lowerLength; i++) {
      lowerStarts[lowerOffset + i] = originalStart
      lowerEnds[lowerOffset + i] = originalEnd
    }
    lowerOffset += lowerLength
    originalStart = originalEnd
  }

  const ranges: SearchTextRange[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    const start = lowerStarts[index] ?? index
    const end = lowerEnds[index + needle.length - 1] ?? index + needle.length
    if (end > start && ranges[ranges.length - 1]?.end !== end) ranges.push({ start, end })
    from = index + needle.length
  }
  return ranges
}

function collectText(node: HastNode, segments: TextSegment[], value: { text: string }): void {
  if (!node.children) return
  node.children.forEach((child, index) => {
    if (child.type === 'text' && typeof child.value === 'string') {
      const start = value.text.length
      value.text += child.value
      segments.push({ parent: node, index, node: child, start, end: value.text.length })
      return
    }
    if (child.type === 'element' && child.tagName === 'br') {
      value.text += '\n'
      return
    }

    if (child.type === 'element' && (child.tagName === 'ul' || child.tagName === 'ol')) return
    collectText(child, segments, value)
  })
}

function markNode(value: string, current: boolean): HastNode {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: current ? ['chat-search-match', 'chat-search-match--current'] : ['chat-search-match'],
    },
    children: [{ type: 'text', value }],
  }
}

function highlightScope(scope: HastNode, query: string, current: boolean): void {
  const segments: TextSegment[] = []
  const value = { text: '' }
  collectText(scope, segments, value)
  const ranges = findCaseInsensitiveRanges(value.text, query)
  if (!ranges.length) return

  for (let s = segments.length - 1; s >= 0; s--) {
    const segment = segments[s]
    const text = segment.node.value ?? ''
    const local = ranges
      .filter((range) => range.start < segment.end && range.end > segment.start)
      .map((range) => ({
        start: Math.max(range.start, segment.start) - segment.start,
        end: Math.min(range.end, segment.end) - segment.start,
      }))
    if (!local.length || !segment.parent.children) continue

    const replacement: HastNode[] = []
    let cursor = 0
    for (const range of local) {
      const start = Math.max(cursor, range.start)
      if (start > cursor) replacement.push({ type: 'text', value: text.slice(cursor, start) })
      if (range.end > start) replacement.push(markNode(text.slice(start, range.end), current))
      cursor = Math.max(cursor, range.end)
    }
    if (cursor < text.length) replacement.push({ type: 'text', value: text.slice(cursor) })
    segment.parent.children.splice(segment.index, 1, ...replacement)
  }
}

function hasNestedTextScope(node: HastNode): boolean {
  return !!node.children?.some(
    (child) =>
      (child.type === 'element' && !!child.tagName && TEXT_SCOPES.has(child.tagName)) || hasNestedTextScope(child)
  )
}

function visitScopes(node: HastNode, query: string, current: boolean): void {
  if (node.type === 'element' && node.tagName && TEXT_SCOPES.has(node.tagName)) {
    highlightScope(node, query, current)
    return
  }

  if (node.type === 'element' && node.tagName === 'li' && !hasNestedTextScope(node)) {
    highlightScope(node, query, current)
    node.children
      ?.filter((child) => child.type === 'element' && (child.tagName === 'ul' || child.tagName === 'ol'))
      .forEach((child) => visitScopes(child, query, current))
    return
  }
  node.children?.forEach((child) => visitScopes(child, query, current))
}

function mentionNode(match: MentionMatch): HastNode {
  return {
    type: 'element',
    tagName: 'button',
    properties: {
      type: 'button',
      className: ['chat-mention-chip'],
      dataMentionPath: match.path.replace(/\/+$/, ''),
      dataMentionDirectory: match.path.endsWith('/'),
      ...(match.startLine ? { dataMentionStartLine: match.startLine } : {}),
      ...(match.endLine ? { dataMentionEndLine: match.endLine } : {}),
    },
    children: [{ type: 'text', value: match.raw }],
  }
}

function transformMentions(node: HastNode): void {
  if (!node.children || node.tagName === 'code' || node.tagName === 'a' || node.tagName === 'button') return
  for (let index = node.children.length - 1; index >= 0; index--) {
    const child = node.children[index]
    if (child.type !== 'text' || typeof child.value !== 'string') {
      transformMentions(child)
      continue
    }
    const mentions = findMentions(child.value)
    if (!mentions.length) continue
    const replacement: HastNode[] = []
    let cursor = 0
    for (const mention of mentions) {
      if (mention.index > cursor) replacement.push({ type: 'text', value: child.value.slice(cursor, mention.index) })
      replacement.push(mentionNode(mention))
      cursor = mention.index + mention.raw.length
    }
    if (cursor < child.value.length) replacement.push({ type: 'text', value: child.value.slice(cursor) })
    node.children.splice(index, 1, ...replacement)
  }
}

export function rehypeChatMentions() {
  return (tree: HastNode): void => transformMentions(tree)
}

export function rehypeMarkdownSearchHighlight(options: SearchHighlightOptions = {}) {
  return (tree: HastNode): void => {
    const query = options.query?.trim() ?? ''
    if (query) visitScopes(tree, query, !!options.current)
  }
}
