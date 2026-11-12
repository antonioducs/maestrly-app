import { describe, expect, it } from 'vitest'
import { keepsCurrent, mergeElements } from '../src/board.js'
import { applyOps, type Op } from '../src/ops.js'
import { readBoard } from '../src/outline.js'
import { applied, build, expectConsistent, get, NOW, personEdit, textOf } from './helpers.js'

const plan: Op[] = [
  { op: 'card', id: 'api', text: 'API', at: { x: 0, y: 0 } },
  { op: 'card', id: 'db', text: 'Database', at: { x: 400, y: 0 } },
  { op: 'connect', from: 'api', to: 'db' },
]

describe('a person and the agent on the same board', () => {
  it('keeps the person’s edits, applies the agent’s additions, and reports what met a person’s change', () => {
    const base = build(plan)
    expect(base.revision).toBe(1)
    const seen = base.revision

    // While the agent thinks, a person drags the API card and rewrites the database card's text on the canvas.
    const api = personEdit(get(base, 'api'), { x: -300, y: 200 })
    const dbText = textOf(base, 'db')!
    const edited = personEdit(dbText, { text: 'Postgres', originalText: 'Postgres' })
    const afterPerson = mergeElements(base, [api, edited], 'person')
    expect(afterPerson.accepted).toEqual(['api', dbText.id])
    expect(afterPerson.board.revision).toBe(2)

    // The agent answers from what it saw at revision 1.
    const result = applied(
      applyOps(afterPerson.board, {
        baseRevision: seen,
        ops: [
          { op: 'move', id: 'api', to: { x: 0, y: 0 } },
          { op: 'update', id: 'db', text: 'Database (primary)' },
          { op: 'card', id: 'cache', text: 'Cache', at: { near: 'api', side: 'below' } },
          { op: 'connect', from: 'api', to: 'cache', label: 'reads' },
        ],
        now: NOW + 2,
      })
    )
    expect(result.conflicts).toEqual([
      { op: 0, id: 'api', reason: 'changed' },
      { op: 1, id: dbText.id, reason: 'changed' },
    ])
    expect(result.applied).toEqual([2, 3])
    const board = result.board
    expectConsistent(board)

    // The person's position and text stand; the agent's card went where the card is now.
    expect([get(board, 'api').x, get(board, 'api').y]).toEqual([-300, 200])
    expect(textOf(board, 'db')!.text).toBe('Postgres')
    expect(get(board, 'cache').y).toBeGreaterThan(200 + get(board, 'api').height)
    // Hooking the new arrow to the card bumped it from the person's copy, so nothing of theirs was lost.
    expect(get(board, 'api').boundElements?.map((bound) => bound.id)).toEqual([
      textOf(base, 'api')!.id,
      'api-db',
      'api-cache',
    ])
    expect(get(board, 'api').version).toBe(api.version + 1)

    // Reading again, the agent sees what the person changed since revision 1.
    const outline = readBoard(board, { since: seen })
    expect(outline.changes?.byPerson.sort()).toEqual(['db'])
    expect(outline.changes?.changed).toEqual(expect.arrayContaining(['api', 'db', 'cache', 'api-cache']))
  })

  it('ignores a canvas’s stale copy and an echo of what the board already has', () => {
    const base = build(plan)
    const current = get(base, 'api')
    const stale = { ...current, version: current.version - 1, x: 999 }
    expect(mergeElements(base, [stale, current], 'person')).toEqual({ board: base, accepted: [], kept: ['api', 'api'] })
  })

  it('keeps a deletion against an older copy that still has the element', () => {
    const base = build(plan)
    const deleted = build([{ op: 'delete', id: 'db' }], base)
    const old = personEdit(get(base, 'db'), { x: 50 })
    // The person's copy is one version past the one they saw; the deletion bumped it just as far.
    expect(old.version).toBe(get(deleted, 'db').version)
    const merged = mergeElements(deleted, [{ ...old, versionNonce: 2 ** 31 }], 'person')
    expect(merged.kept).toEqual(['db'])
    expect(get(merged.board, 'db').isDeleted).toBe(true)
  })

  it('settles two edits of the same version the same way whatever order they arrive in', () => {
    const base = build(plan)
    const a = personEdit(get(base, 'api'), { x: 10 }, 100)
    const b = personEdit(get(base, 'api'), { x: 20 }, 50)
    const ab = mergeElements(mergeElements(base, [a], 'person').board, [b], 'person').board
    const ba = mergeElements(mergeElements(base, [b], 'person').board, [a], 'person').board
    expect(get(ab, 'api').x).toBe(20)
    expect(get(ba, 'api').x).toBe(20)
    expect(keepsCurrent(b, a)).toBe(true)
    expect(keepsCurrent(a, b)).toBe(false)
  })

  it('places an element a canvas sent without an index above the others', () => {
    const base = build(plan)
    const drawn = {
      ...get(base, 'api'),
      id: 'sketch',
      type: 'freedraw' as const,
      index: null,
      points: [
        [0, 0],
        [5, 5],
      ] as const,
    }
    const merged = mergeElements(base, [drawn], 'person').board
    expect(get(merged, 'sketch').index! > get(merged, 'api-db').index!).toBe(true)
  })
})
