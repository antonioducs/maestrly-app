import { type Board, emptyBoard, orderedElements } from '../src/board.js'
import type { BoardElement } from '../src/elements.js'
import { type ApplyResult, applyOps, type Op } from '../src/ops.js'

export const NOW = 1_700_000_000_000

export function applied(result: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!result.ok) throw new Error(`apply failed: ${result.error.code} ${result.error.message}`)
  return result
}

/** A board built by the agent from ops, starting empty. */
export function build(ops: Op[], board: Board = emptyBoard()): Board {
  return applied(applyOps(board, { baseRevision: board.revision, ops, now: NOW })).board
}

export function get(board: Board, id: string): BoardElement {
  const element = board.elements.get(id)?.element
  if (!element) throw new Error(`no element ${id}`)
  return element
}

export function textOf(board: Board, id: string): BoardElement | undefined {
  const entry = get(board, id).boundElements?.find((bound) => bound.type === 'text')
  return entry ? get(board, entry.id) : undefined
}

/** What a canvas sends after a person edits an element: a new version with a fresh nonce. */
export function personEdit(element: BoardElement, changes: Partial<BoardElement>, nonce = 7): BoardElement {
  return { ...element, ...changes, version: element.version + 1, versionNonce: nonce, updated: NOW + 1 }
}

/** Every reference between elements points at a live element that points back. */
export function expectConsistent(board: Board): void {
  const live = new Map(orderedElements(board).map((element) => [element.id, element]))
  const indices = new Set<string>()
  for (const element of live.values()) {
    if (element.index === null) throw new Error(`${element.id} has no index`)
    if (indices.has(element.index)) throw new Error(`index ${element.index} is used twice`)
    indices.add(element.index)
    for (const bound of element.boundElements ?? []) {
      const other = live.get(bound.id)
      if (!other) throw new Error(`${element.id} lists missing ${bound.id}`)
      if (bound.type === 'text' && other.containerId !== element.id)
        throw new Error(`${bound.id} is not in ${element.id}`)
      if (
        bound.type === 'arrow' &&
        other.startBinding?.elementId !== element.id &&
        other.endBinding?.elementId !== element.id
      )
        throw new Error(`${bound.id} is not bound to ${element.id}`)
      if (bound.type === 'text' && other.index! <= element.index!) throw new Error(`${bound.id} is below ${element.id}`)
    }
    if (element.containerId && !live.get(element.containerId)?.boundElements?.some((bound) => bound.id === element.id))
      throw new Error(`${element.containerId} does not list ${element.id}`)
    for (const binding of [element.startBinding, element.endBinding])
      if (binding && !live.get(binding.elementId)?.boundElements?.some((bound) => bound.id === element.id))
        throw new Error(`${binding.elementId} does not list arrow ${element.id}`)
    if (element.frameId && !live.has(element.frameId)) throw new Error(`${element.id} is in missing ${element.frameId}`)
  }
}
