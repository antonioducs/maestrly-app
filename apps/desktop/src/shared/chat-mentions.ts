export interface MentionMatch {
  /** Raw matched text including '@' and the range (e.g. '@src/store.ts:L3-9'). */
  raw: string

  path: string
  startLine?: number
  endLine?: number

  index: number
}

const MENTION_RE = /(?<!\w)@([\w./\-]+(?::L\d+(?:-\d+)?)?)/g

export function findMentions(text: string): MentionMatch[] {
  if (typeof text !== 'string' || !text.includes('@')) return []
  const out: MentionMatch[] = []
  for (const m of text.matchAll(MENTION_RE)) {
    let token = m[1]
    let startLine: number | undefined
    let endLine: number | undefined
    const lm = /:L(\d+)(?:-(\d+))?$/.exec(token)
    if (lm) {
      startLine = Number(lm[1])
      endLine = lm[2] ? Number(lm[2]) : undefined
      token = token.slice(0, token.length - lm[0].length)
    }
    if (!token || (!token.includes('/') && !token.includes('.'))) continue
    out.push({ raw: m[0], path: token, startLine, endLine, index: m.index ?? 0 })
  }
  return out
}
