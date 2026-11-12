import {
  applyOps,
  type Board,
  type BoardElement,
  type Conflict,
  MAX_BOARD_ELEMENTS,
  mergeElements,
  type Op,
  orderedElements,
} from '@maestrly/whiteboard'
import { ArtifactHostError } from './errors.js'
import { MAX_BOARD_BYTES } from './limits.js'
import type { BoardStore } from './store/board-store.js'

/** What changed on a board after a revision: elements as they are now, deleted ones as tombstones. */
export interface BoardChange {
  revision: number
  elements: BoardElement[]
}

export interface BoardService {
  board(artifactId: string): Board
  /** The first ops of a new board, from revision 0. */
  init(artifactId: string, ops: readonly Op[], now: number): { revision: number; created: string[] }
  applyAgent(
    artifactId: string,
    input: { baseRevision: number; ops: readonly Op[] },
    now: number
  ): { revision: number; applied: number[]; conflicts: Conflict[]; created: string[] }
  /** Elements a person's canvas sent, already validated. `kept` holds the board's copy of those it refused. */
  mergePerson(
    artifactId: string,
    elements: readonly BoardElement[],
    now: number
  ): { revision: number; kept: BoardElement[] }
  changesSince(artifactId: string, since: number): BoardChange
  /** Calls `listener` once, at the next accepted change. Returns the unsubscribe. */
  wait(artifactId: string, listener: (change: BoardChange) => void): () => void
  waiting(artifactId: string): number
  /** Drops what is kept of a deleted or replaced board; its waiters get an empty change. */
  forget(artifactId: string): void
  /** Answers every waiter with an empty change, so no request outlives the host. */
  close(): void
  totalBytes(): number
}

const bytesOf = (element: BoardElement | undefined): number =>
  element ? Buffer.byteLength(JSON.stringify(element)) : 0

/**
 * Every write to a whiteboard goes through here, the agent's ops and people's canvases alike: one merge rule, one size
 * limit, and the waiters of each board told of what changed. The host is the only writer of its database, so boards
 * are kept in memory once read.
 */
export function createBoardService(deps: {
  store: BoardStore
  maxBoardBytes?: number
  /** Whether `extraBytes` more fit in the host's storage. */
  fits?: (extraBytes: number) => boolean
}): BoardService {
  const maxBytes = deps.maxBoardBytes ?? MAX_BOARD_BYTES
  const boards = new Map<string, Board>()
  const sizes = new Map<string, number>()
  const waiters = new Map<string, Set<(change: BoardChange) => void>>()

  function board(artifactId: string): Board {
    let found = boards.get(artifactId)
    if (!found) {
      found = deps.store.load(artifactId)
      boards.set(artifactId, found)
    }
    return found
  }

  const size = (artifactId: string): number => {
    let found = sizes.get(artifactId)
    if (found === undefined) {
      found = deps.store.bytes(artifactId)
      sizes.set(artifactId, found)
    }
    return found
  }

  function changesSince(artifactId: string, since: number): BoardChange {
    const current = board(artifactId)
    const elements = orderedElements(current, { deleted: true }).filter(
      (element) => (current.elements.get(element.id)?.rev ?? 0) > since
    )
    return { revision: current.revision, elements }
  }

  function notify(artifactId: string, since: number): void {
    const listeners = waiters.get(artifactId)
    if (!listeners?.size) return
    waiters.delete(artifactId)
    const change = changesSince(artifactId, since)
    for (const listener of listeners) listener(change)
  }

  function flush(artifactId: string, revision: number): void {
    const listeners = waiters.get(artifactId)
    waiters.delete(artifactId)
    for (const listener of listeners ?? []) listener({ revision, elements: [] })
  }

  /** Stores `next` when it fits, then tells the board's waiters. */
  function commit(artifactId: string, previous: Board, next: Board, changedIds: readonly string[], now: number): void {
    let bytes = size(artifactId)
    for (const id of changedIds)
      bytes += bytesOf(next.elements.get(id)?.element) - bytesOf(previous.elements.get(id)?.element)
    if (bytes > maxBytes || next.elements.size > MAX_BOARD_ELEMENTS)
      throw new ArtifactHostError('limit_reached', 'The whiteboard is full', {
        limit: bytes > maxBytes ? 'board_bytes' : 'board_elements',
      })
    const growth = bytes - size(artifactId)
    if (growth > 0 && deps.fits && !deps.fits(growth))
      throw new ArtifactHostError('quota_exceeded', 'The artifact storage limit was reached')
    deps.store.save(artifactId, next, changedIds, now)
    boards.set(artifactId, next)
    sizes.set(artifactId, bytes)
    notify(artifactId, previous.revision)
  }

  function apply(artifactId: string, baseRevision: number, ops: readonly Op[], now: number) {
    const previous = board(artifactId)
    const result = applyOps(previous, { baseRevision, ops, now })
    if (!result.ok)
      throw new ArtifactHostError('invalid_input', result.error.message, {
        op: result.error.op,
        code: result.error.code,
      })
    if (result.board !== previous)
      commit(
        artifactId,
        previous,
        result.board,
        result.changed.map((element) => element.id),
        now
      )
    return {
      revision: result.board.revision,
      applied: result.applied,
      conflicts: result.conflicts,
      created: result.created,
    }
  }

  return {
    board,
    changesSince,

    init(artifactId, ops, now) {
      const { revision, created } = apply(artifactId, 0, ops, now)
      return { revision, created }
    },

    applyAgent(artifactId, input, now) {
      return apply(artifactId, input.baseRevision, input.ops, now)
    },

    mergePerson(artifactId, elements, now) {
      const previous = board(artifactId)
      const result = mergeElements(previous, elements, 'person')
      if (result.board !== previous) commit(artifactId, previous, result.board, result.accepted, now)
      return {
        revision: result.board.revision,
        kept: result.kept.flatMap((id) => {
          const stored = result.board.elements.get(id)
          return stored ? [stored.element] : []
        }),
      }
    },

    wait(artifactId, listener) {
      let listeners = waiters.get(artifactId)
      if (!listeners) {
        listeners = new Set()
        waiters.set(artifactId, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size && waiters.get(artifactId) === listeners) waiters.delete(artifactId)
      }
    },

    waiting(artifactId) {
      return waiters.get(artifactId)?.size ?? 0
    },

    forget(artifactId) {
      const revision = boards.get(artifactId)?.revision ?? 0
      boards.delete(artifactId)
      sizes.delete(artifactId)
      flush(artifactId, revision)
    },

    close() {
      for (const artifactId of [...waiters.keys()]) flush(artifactId, boards.get(artifactId)?.revision ?? 0)
    },

    totalBytes() {
      return deps.store.totalBytes()
    },
  }
}
