import { describe, expect, it } from 'vitest'
import { authorLabel, groupComments, quotesToHighlight } from '../src/shell/comments-model.js'
import type { PublicComment } from '../src/shell/contract.js'

let sequence = 0

function comment(overrides: Partial<PublicComment> = {}): PublicComment {
  sequence++
  return {
    id: `c${sequence}`.padEnd(22, '0'),
    version: 2,
    parentId: null,
    author: { kind: 'invited', name: 'Maria', verified: true, self: false },
    body: `Comment ${sequence}`,
    anchor: null,
    status: 'open',
    createdAt: sequence,
    canDelete: false,
    ...overrides,
  }
}

describe('groupComments', () => {
  it('separates the displayed version from the others and nests replies under their thread', () => {
    const current = comment({ createdAt: 30 })
    const older = comment({ version: 1, createdAt: 10 })
    const reply = comment({ parentId: current.id, createdAt: 50 })
    const earlierReply = comment({ parentId: current.id, createdAt: 40 })
    const oldReply = comment({ parentId: older.id, version: 1, createdAt: 60 })
    const another = comment({ createdAt: 20 })
    const grouped = groupComments([reply, current, oldReply, older, earlierReply, another], 2)
    expect(grouped.current.map((thread) => thread.comment.id)).toEqual([another.id, current.id])
    expect(grouped.current[1]!.replies.map((item) => item.id)).toEqual([earlierReply.id, reply.id])
    expect(grouped.earlier).toEqual([{ comment: older, replies: [oldReply] }])
  })

  it('puts open threads before resolved ones, and drops replies without a thread', () => {
    const resolved = comment({ status: 'resolved', createdAt: 1 })
    const open = comment({ createdAt: 2 })
    const orphan = comment({ parentId: 'gone'.padEnd(22, '0') })
    const grouped = groupComments([resolved, open, orphan], 2)
    expect(grouped.current.map((thread) => thread.comment.id)).toEqual([open.id, resolved.id])
    expect(grouped.earlier).toEqual([])
  })
})

describe('quotesToHighlight', () => {
  it('sends the page only the quotes of open threads on the displayed version', () => {
    const quote = { exact: 'quick brown fox', prefix: 'The ', suffix: ' jumps' }
    const anchored = comment({ anchor: { quote } })
    const threads = groupComments(
      [
        anchored,
        comment({ anchor: { quote }, status: 'resolved' }),
        comment({ anchor: { hint: { selector: 'p' } } }),
        comment({ anchor: { quote }, version: 1 }),
      ],
      2
    )
    const quotes = quotesToHighlight(threads.current)
    expect(quotes).toEqual([{ id: anchored.id, ...quote }])
    // Nothing a comment's author wrote travels to the page: only text the page already has.
    expect(JSON.stringify(quotes)).not.toContain('Comment')
    expect(JSON.stringify(quotes)).not.toContain('Maria')
  })
})

describe('authorLabel', () => {
  const t = (key: string, vars: Record<string, string | number> = {}) => `${key}:${Object.values(vars).join(',')}`

  it('names each kind of author', () => {
    const author = (kind: PublicComment['author']['kind'], name: string, self = false) => ({
      kind,
      name,
      verified: kind !== 'guest',
      self,
    })
    expect(authorLabel(t, author('invited', 'Maria'))).toBe('Maria')
    expect(authorLabel(t, author('invited', 'Maria', true))).toBe('commentYou:')
    expect(authorLabel(t, author('guest', 'Ana'))).toBe('unverified:Ana')
    expect(authorLabel(t, author('owner', 'Antonio'))).toBe('commentOwner:Antonio')
    expect(authorLabel(t, author('owner', ''))).toBe('commentOwnerUnnamed:')
    expect(authorLabel(t, author('owner', 'Antonio', true))).toBe('commentYou:')
    expect(authorLabel(t, author('agent', 'Antonio'))).toBe('commentAgent:Antonio')
    expect(authorLabel(t, author('agent', ''))).toBe('commentAgentUnnamed:')
  })
})
