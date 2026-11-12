import { type BoardElement, readBoard } from '@maestrly/whiteboard'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BoardChange, type BoardService, createBoardService } from '../src/boards.js'
import { ArtifactHostError } from '../src/errors.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BoardStore } from '../src/store/board-store.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir } from './helpers.js'

const ID = 'W'.repeat(22)
const NOW = 1_800_000_000_000
let cleanup: () => void
let artifacts: ArtifactStore
let store: BoardStore
let boards: BoardService

function open(maxBoardBytes?: number): BoardService {
  return createBoardService({ store, maxBoardBytes })
}

beforeEach(() => {
  const temp = tempDir()
  cleanup = temp.cleanup
  artifacts = new ArtifactStore(openDatabase(`${temp.dir}/artifacts.sqlite`))
  store = new BoardStore(artifacts.db)
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
      createdAt: NOW,
    },
    { entry: 'index.html', summary: '', createdBy: 'agent', createdAt: NOW, files: [] }
  )
  boards = open()
})
afterEach(() => {
  artifacts.db.close()
  cleanup()
})

const element = (id: string): BoardElement => boards.board(ID).elements.get(id)!.element
/** What a canvas sends after a person moves an element. */
const moved = (base: BoardElement, dx: number): BoardElement => ({
  ...base,
  x: base.x + dx,
  version: base.version + 1,
  versionNonce: base.versionNonce + 1,
})

function seed(): number {
  return boards.init(
    ID,
    [
      { op: 'section', id: 'api', title: 'API' },
      { op: 'card', id: 'a', text: 'Gateway', in: 'api' },
      { op: 'card', id: 'b', text: 'Auth', in: 'api' },
      { op: 'connect', from: 'a', to: 'b' },
    ],
    NOW
  ).revision
}

describe('BoardService', () => {
  it('builds a board from the agent ops and stores it', () => {
    const revision = seed()
    const outline = readBoard(boards.board(ID))
    expect(outline.cards).toHaveLength(2)
    expect(outline.links).toHaveLength(1)
    expect(store.load(ID).revision).toBe(revision)
    expect(open().board(ID).elements.size).toBe(boards.board(ID).elements.size)
  })

  it('keeps what a person changed after the revision the agent read', () => {
    const base = seed()
    const personX = element('a').x + 200
    const merged = boards.mergePerson(ID, [moved(element('a'), 200)], NOW + 1)
    expect(merged.revision).toBe(base + 1)
    const result = boards.applyAgent(
      ID,
      { baseRevision: base, ops: [{ op: 'move', id: 'a', to: { x: 0, y: 0 } }] },
      NOW + 2
    )
    expect(result.conflicts).toEqual([{ op: 0, id: 'a', reason: 'changed' }])
    expect(element('a').x).toBe(personX)
    expect(store.load(ID).elements.get('a')?.by).toBe('person')
  })

  it('sends back the board copy of an element a canvas sent out of date', () => {
    seed()
    const old = element('a')
    boards.mergePerson(ID, [moved(old, 50)], NOW + 1)
    const revision = boards.board(ID).revision
    const result = boards.mergePerson(ID, [old], NOW + 2)
    expect(result.kept.map((kept) => kept.id)).toEqual(['a'])
    expect(result.kept[0]?.x).toBe(old.x + 50)
    expect(result.revision).toBe(revision)
  })

  it('calls a waiter once at the next change, and flushes the waiting ones on close', () => {
    const base = seed()
    const changes: BoardChange[] = []
    boards.wait(ID, (change) => changes.push(change))
    expect(boards.waiting(ID)).toBe(1)
    boards.applyAgent(ID, { baseRevision: base, ops: [{ op: 'move', id: 'b', to: { x: 900, y: 900 } }] }, NOW + 1)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.revision).toBe(base + 1)
    expect(changes[0]?.elements.map((e) => e.id)).toContain('b')
    expect(boards.waiting(ID)).toBe(0)

    const later: BoardChange[] = []
    const stop = boards.wait(ID, (change) => later.push(change))
    stop()
    boards.mergePerson(ID, [moved(element('a'), 10)], NOW + 2)
    expect(later).toEqual([])

    const closing: BoardChange[] = []
    boards.wait(ID, (change) => closing.push(change))
    boards.close()
    expect(closing).toEqual([{ revision: base + 2, elements: [] }])
  })

  it('lists what changed after a revision, deleted elements included', () => {
    const base = seed()
    boards.applyAgent(ID, { baseRevision: base, ops: [{ op: 'delete', id: 'b' }] }, NOW + 1)
    const change = boards.changesSince(ID, base)
    expect(change.revision).toBe(base + 1)
    expect(change.elements.find((e) => e.id === 'b')?.isDeleted).toBe(true)
    expect(boards.changesSince(ID, base + 1).elements).toEqual([])
  })

  it('refuses a write that would make the board larger than its limit', () => {
    boards = open(2000)
    const ops = Array.from({ length: 40 }, (_, i) => ({ op: 'card' as const, id: `c${i}`, text: `Card ${i}` }))
    let error: unknown
    try {
      boards.init(ID, ops, NOW)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ArtifactHostError)
    expect((error as ArtifactHostError).code).toBe('limit_reached')
    expect((error as ArtifactHostError).details).toEqual({ limit: 'board_bytes' })
    expect(store.load(ID).elements.size).toBe(0)
  })

  it('turns an op the core refuses into invalid input', () => {
    seed()
    let error: unknown
    try {
      boards.applyAgent(ID, { baseRevision: 0, ops: [{ op: 'move', id: 'nope', to: { x: 0, y: 0 } }] }, NOW)
    } catch (caught) {
      error = caught
    }
    expect((error as ArtifactHostError).code).toBe('invalid_input')
    expect((error as ArtifactHostError).details).toMatchObject({ op: 0 })
  })
})
