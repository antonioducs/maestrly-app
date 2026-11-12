import { generateNKeysBetween } from 'fractional-indexing'
import type { BoardElement } from './elements.js'

export type Author = 'agent' | 'person'

/** An element with the board revision that last changed it and who changed it. */
export interface StoredElement {
  element: BoardElement
  rev: number
  by: Author
}

/**
 * A board: every element ever placed on it, deleted ones included as tombstones so a late copy of an old version cannot
 * bring them back. `revision` grows by one with each accepted change, from a person or the agent.
 */
export interface Board {
  revision: number
  elements: ReadonlyMap<string, StoredElement>
}

export function emptyBoard(): Board {
  return { revision: 0, elements: new Map() }
}

/** Excalidraw orders by fractional index, then by ID; elements without an index go last. */
function compareOrder(a: BoardElement, b: BoardElement): number {
  if (a.index !== b.index) {
    if (a.index === null) return 1
    if (b.index === null) return -1
    return a.index < b.index ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function orderedElements(board: Board, options: { deleted?: boolean } = {}): BoardElement[] {
  const elements: BoardElement[] = []
  for (const { element } of board.elements.values()) if (options.deleted || !element.isDeleted) elements.push(element)
  return elements.sort(compareOrder)
}

/** Indices for `count` elements placed above everything on the board. */
export function indicesAtTop(board: Board, count: number): string[] {
  let top: string | null = null
  for (const { element } of board.elements.values())
    if (element.index && (!top || element.index > top)) top = element.index
  return generateNKeysBetween(top, null, count)
}

/**
 * Whether the board keeps its copy over an incoming one, by Excalidraw's own rule so every canvas agrees with the
 * host: the higher version wins and, between equal versions, the lower nonce. An identical copy changes nothing.
 */
export function keepsCurrent(current: BoardElement, incoming: BoardElement): boolean {
  if (current.version !== incoming.version) return current.version > incoming.version
  return current.versionNonce <= incoming.versionNonce
}

export interface MergeResult {
  board: Board
  /** IDs whose incoming copy replaced the board's. */
  accepted: string[]
  /** IDs where the board's copy won. */
  kept: string[]
}

/** Merges elements sent by a canvas or produced by the agent. Accepted changes share one new revision. */
export function mergeElements(board: Board, incoming: readonly BoardElement[], by: Author): MergeResult {
  const accepted: string[] = []
  const kept: string[] = []
  const next = new Map(board.elements)
  const revision = board.revision + 1
  const unindexed: BoardElement[] = []
  for (const element of incoming) {
    const current = next.get(element.id)
    if (current && keepsCurrent(current.element, element)) {
      kept.push(element.id)
      continue
    }
    accepted.push(element.id)
    if (element.index === null && !element.isDeleted) unindexed.push(element)
    else next.set(element.id, { element, rev: revision, by })
  }
  if (unindexed.length) {
    const indices = indicesAtTop({ revision, elements: next }, unindexed.length)
    unindexed.forEach((element, i) =>
      next.set(element.id, { element: { ...element, index: indices[i]! }, rev: revision, by })
    )
  }
  if (!accepted.length) return { board, accepted, kept }
  return { board: { revision, elements: next }, accepted, kept }
}

/** What changed after `revision`: live elements as they are now, and the IDs deleted since. */
export function changesSince(board: Board, revision: number) {
  const changed: StoredElement[] = []
  const deleted: string[] = []
  for (const stored of board.elements.values()) {
    if (stored.rev <= revision) continue
    if (stored.element.isDeleted) deleted.push(stored.element.id)
    else changed.push(stored)
  }
  return { changed, deleted }
}
