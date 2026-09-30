import { describe, expect, it } from 'vitest'
import { commentAuthor, draftFromComments, threadsOf } from '../../src/renderer/components/artifacts/comments-view'
import type { TFn } from '../../src/renderer/components/settings/shared'
import type { ArtifactCommentView } from '../../src/shared/artifacts'

/** Shows the key and its values, so the tests check what is said without depending on a language. */
const t = ((key: string, values: Record<string, unknown> = {}) =>
  `${key.replace('artifacts.comments.', '')}${Object.keys(values).length ? JSON.stringify(values) : ''}`) as unknown as TFn

let sequence = 0

function comment(overrides: Partial<ArtifactCommentView> = {}): ArtifactCommentView {
  sequence++
  return {
    id: `c${sequence}`,
    version: 2,
    parentId: null,
    author: { kind: 'invited', name: 'Maria', verified: true },
    body: `Comment ${sequence}`,
    place: 'page',
    quote: null,
    status: 'open',
    createdAt: sequence,
    ...overrides,
  }
}

describe('threadsOf', () => {
  it('nests replies under their thread and puts open threads first', () => {
    const resolved = comment({ status: 'resolved', createdAt: 1 })
    const later = comment({ createdAt: 30 })
    const earlier = comment({ createdAt: 20 })
    const secondReply = comment({ parentId: later.id, createdAt: 50 })
    const firstReply = comment({ parentId: later.id, createdAt: 40 })
    const orphan = comment({ parentId: 'gone' })
    const threads = threadsOf([secondReply, resolved, later, firstReply, earlier, orphan])
    expect(threads.map((thread) => thread.comment.id)).toEqual([earlier.id, later.id, resolved.id])
    expect(threads[1]!.replies.map((reply) => reply.id)).toEqual([firstReply.id, secondReply.id])
    expect(threads[0]!.replies).toEqual([])
  })
})

describe('commentAuthor', () => {
  it('says who wrote a comment and whether anyone confirmed the name', () => {
    expect(commentAuthor(t, comment().author)).toBe('Maria')
    expect(commentAuthor(t, { kind: 'approved', name: 'João', verified: true })).toBe('João')
    expect(commentAuthor(t, { kind: 'guest', name: 'Ana', verified: false })).toBe('unverified{"name":"Ana"}')
    expect(commentAuthor(t, { kind: 'owner', name: 'Antonio', verified: true })).toBe('you')
    expect(commentAuthor(t, { kind: 'agent', name: 'Antonio', verified: true })).toBe('agent{"name":"Antonio"}')
    expect(commentAuthor(t, { kind: 'agent', name: '', verified: true })).toBe('agentUnnamed')
  })
})

describe('draftFromComments', () => {
  it('quotes each open thread with its author, verification, version and passage', () => {
    const anchored = comment({ place: 'passage', quote: 'Total: 40', body: 'The total looks wrong.' })
    const reply = comment({
      parentId: anchored.id,
      author: { kind: 'guest', name: 'Ana', verified: false },
      body: 'I see it too.',
    })
    const plain = comment({ author: { kind: 'guest', name: 'Rui', verified: false }, version: 1, body: 'Two\nlines.' })
    const spot = comment({ place: 'spot', version: 2, body: 'Split this chart by region?' })
    const resolved = comment({ status: 'resolved', body: 'Already handled.' })
    const resolvedReply = comment({ parentId: resolved.id, body: 'Thanks.' })
    const draft = draftFromComments(t, 'Quarterly report', [anchored, reply, plain, spot, resolved, resolvedReply])
    expect(draft).toBe(
      [
        'draft.intro{"title":"Quarterly report"}',
        '',
        '1. draft.threadQuoted{"author":"Maria","version":2,"quote":"Total: 40"}',
        '   The total looks wrong.',
        '   - draft.reply{"author":"unverified{\\"name\\":\\"Ana\\"}"}',
        '     I see it too.',
        '',
        '2. draft.thread{"author":"unverified{\\"name\\":\\"Rui\\"}","version":1}',
        '   Two',
        '   lines.',
        '',
        '3. draft.threadSpot{"author":"Maria","version":2}',
        '   Split this chart by region?',
        '',
        'draft.outro',
      ].join('\n')
    )
    expect(draft).not.toContain('Already handled.')
    expect(draft).not.toContain('Thanks.')
  })

  it('is empty when nothing is open', () => {
    expect(draftFromComments(t, 'Report', [comment({ status: 'resolved' })])).toBe('')
    expect(draftFromComments(t, 'Report', [])).toBe('')
  })
})
