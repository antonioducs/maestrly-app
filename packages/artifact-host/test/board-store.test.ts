import { applyOps, type Board, type BoardElement, emptyBoard } from '@maestrly/whiteboard'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BoardStore } from '../src/store/board-store.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir } from './helpers.js'

const ID = 'B'.repeat(22)
let cleanup: () => void
let artifacts: ArtifactStore
let boards: BoardStore

beforeEach(() => {
  const temp = tempDir()
  cleanup = temp.cleanup
  artifacts = new ArtifactStore(openDatabase(`${temp.dir}/artifacts.sqlite`))
  boards = new BoardStore(artifacts.db)
  artifacts.createArtifact(
    {
      id: ID,
      kind: 'whiteboard',
      title: 'Board',
      description: '',
      ownerKind: 'bot',
      ownerId: 'bot1',
      workspaceId: null,
      conversationId: 'c1',
      conversationTitle: null,
      createdAt: 1000,
    },
    { entry: 'index.html', summary: '', createdBy: 'agent', createdAt: 1000, files: [] }
  )
})
afterEach(() => {
  artifacts.db.close()
  cleanup()
})

/** A board of revision 3 with a live card and a deleted one. */
function sample(): Board {
  const result = applyOps(emptyBoard(), {
    baseRevision: 0,
    ops: [
      { op: 'card', id: 'a', text: '' },
      { op: 'card', id: 'b', text: '' },
    ],
    now: 1000,
  })
  if (!result.ok) throw new Error(result.error.message)
  const elements = new Map(result.board.elements)
  const b = elements.get('b')!
  elements.set('a', { ...elements.get('a')!, rev: 2 })
  elements.set('b', { element: { ...b.element, isDeleted: true } as BoardElement, rev: 3, by: 'person' })
  return { revision: 3, elements }
}

describe('BoardStore', () => {
  it('loads what it saved, tombstones included', () => {
    const board = sample()
    boards.save(ID, board, [...board.elements.keys()], 2000)
    const loaded = boards.load(ID)
    expect(loaded.revision).toBe(3)
    expect(loaded.elements).toEqual(board.elements)
    expect(loaded.elements.get('b')?.element.isDeleted).toBe(true)
    expect(loaded.elements.get('b')?.by).toBe('person')
    expect(artifacts.getArtifact(ID)?.updatedAt).toBe(2000)
  })

  it('writes only the elements it is given and keeps the others', () => {
    const board = sample()
    boards.save(ID, board, ['a'], 2000)
    expect([...boards.load(ID).elements.keys()]).toEqual(['a'])
    boards.save(ID, board, ['b'], 3000)
    expect(new Set(boards.load(ID).elements.keys())).toEqual(new Set(['a', 'b']))
  })

  it('counts the bytes of the stored elements', () => {
    const board = sample()
    boards.save(ID, board, [...board.elements.keys()], 2000)
    const expected = [...board.elements.values()].reduce(
      (sum, s) => sum + Buffer.byteLength(JSON.stringify(s.element)),
      0
    )
    expect(boards.bytes(ID)).toBe(expected)
    expect(boards.totalBytes()).toBe(expected)
  })

  it('starts empty and forgets the elements of a deleted artifact', () => {
    expect(boards.load(ID)).toEqual({ revision: 0, elements: new Map() })
    const board = sample()
    boards.save(ID, board, [...board.elements.keys()], 2000)
    artifacts.db.prepare('DELETE FROM artifacts WHERE id = ?').run(ID)
    expect((artifacts.db.prepare('SELECT COUNT(*) AS n FROM board_elements').get() as { n: number }).n).toBe(0)
  })

  it('records the kind of an artifact, pages by default', () => {
    expect(artifacts.getArtifact(ID)?.kind).toBe('whiteboard')
  })
})
