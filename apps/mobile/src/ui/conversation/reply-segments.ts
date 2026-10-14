/**
 * Replies may hold interactive interfaces: ```inline-html blocks of HTML, CSS and JavaScript that Maestrly on a
 * computer renders live in an isolated frame. The phone shows each as a card instead of its source.
 */
export const INTERFACE_FENCE = 'inline-html'

export type ReplySegment =
  | { kind: 'markdown'; text: string }
  /** `complete` is false while the block's closing fence has not arrived. */
  | { kind: 'interface'; html: string; complete: boolean }

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const closes = (line: string, opener: string) => {
  const fence = FENCE_LINE.exec(line)
  return !!fence && fence[1][0] === opener[0] && fence[1].length >= opener.length && !fence[2].trim()
}

/** A reply as Markdown and the interfaces between it, in order. A fence inside another code block stays Markdown. */
export function replySegments(text: string): ReplySegment[] {
  if (!text.includes(INTERFACE_FENCE)) return [{ kind: 'markdown', text }]
  const segments: ReplySegment[] = []
  let markdown: string[] = []
  let code: string | null = null
  let block: { opener: string; lines: string[] } | null = null
  const flush = () => {
    if (markdown.join('').trim()) segments.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
  }
  for (const line of text.split('\n')) {
    if (block) {
      if (closes(line, block.opener)) {
        segments.push({ kind: 'interface', html: block.lines.join('\n'), complete: true })
        block = null
      } else block.lines.push(line)
      continue
    }
    if (code) {
      markdown.push(line)
      if (closes(line, code)) code = null
      continue
    }
    const fence = FENCE_LINE.exec(line)
    if (fence && fence[2].trim().split(/\s+/)[0] === INTERFACE_FENCE) {
      flush()
      block = { opener: fence[1], lines: [] }
      continue
    }
    if (fence) code = fence[1]
    markdown.push(line)
  }
  if (block) segments.push({ kind: 'interface', html: block.lines.join('\n'), complete: false })
  else flush()
  return segments.length ? segments : [{ kind: 'markdown', text }]
}
