import { type Board, changesSince, orderedElements } from './board.js'
import { type BoardElement, colorName, isBoundText, isFrame, isShape, maestrlyData } from './elements.js'
import { type Box, boxOf, intersection } from './geometry.js'

/** `[x, y, width, height]`, rounded: enough to place things relative to each other. */
type Rect = [number, number, number, number]

/**
 * The board as the agent reads it: what each thing says and how things connect, without the canvas's styling fields.
 * Cards are shapes with their text; links are arrows between two things; sketches are what a person drew by hand.
 */
export interface Outline {
  revision: number
  sections: { id: string; title: string; box: Rect; by?: 'person' }[]
  cards: {
    id: string
    text: string
    shape: string
    color?: string
    box: Rect
    in?: string
    by?: 'person'
    suggested?: true
  }[]
  texts: { id: string; text: string; box: Rect; in?: string; by?: 'person' }[]
  links: {
    id: string
    from: string | null
    to: string | null
    label?: string
    dashed?: true
    by?: 'person'
    suggested?: true
  }[]
  sketches: { id: string; kind: string; box: Rect; in?: string; by?: 'person' }[]
  /** Present when asked for changes after a revision. */
  changes?: { since: number; changed: string[]; deleted: string[]; byPerson: string[] }
}

const rect = (box: Box): Rect => [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]

export function readBoard(board: Board, options: { since?: number; region?: Box; section?: string } = {}): Outline {
  const elements = orderedElements(board)
  const byId = new Map(elements.map((element) => [element.id, element]))
  const lastBy = (element: BoardElement) =>
    board.elements.get(element.id)?.by === 'person' ? ({ by: 'person' } as const) : {}
  const textOf = (container: BoardElement): string | undefined => {
    const entry = container.boundElements?.find((bound) => bound.type === 'text')
    const text = entry ? byId.get(entry.id) : undefined
    return text?.containerId === container.id ? (text.originalText ?? text.text) : undefined
  }
  const inside = (element: BoardElement) =>
    element.frameId && byId.has(element.frameId) ? { in: element.frameId } : {}
  const wanted = (element: BoardElement) => {
    if (options.section && element.frameId !== options.section && element.id !== options.section) return false
    return !options.region || intersection(boxOf(element), options.region) > 0
  }

  const outline: Outline = { revision: board.revision, sections: [], cards: [], texts: [], links: [], sketches: [] }
  for (const element of elements) {
    if (isBoundText(element) || !wanted(element)) continue
    const box = rect(boxOf(element))
    if (isFrame(element)) outline.sections.push({ id: element.id, title: element.name ?? '', box, ...lastBy(element) })
    else if (isShape(element)) {
      const color = colorName(element.backgroundColor)
      outline.cards.push({
        id: element.id,
        text: textOf(element) ?? '',
        shape: element.type,
        ...(color !== 'none' ? { color } : {}),
        box,
        ...inside(element),
        ...lastBy(element),
        ...(maestrlyData(element).suggested ? { suggested: true as const } : {}),
      })
    } else if (element.type === 'text')
      outline.texts.push({
        id: element.id,
        text: element.originalText ?? element.text ?? '',
        box,
        ...inside(element),
        ...lastBy(element),
      })
    else if (element.type === 'arrow' && (element.startBinding || element.endBinding)) {
      const label = textOf(element)
      outline.links.push({
        id: element.id,
        from: element.startBinding?.elementId ?? null,
        to: element.endBinding?.elementId ?? null,
        ...(label ? { label } : {}),
        ...(element.strokeStyle === 'dashed' ? { dashed: true as const } : {}),
        ...lastBy(element),
        ...(maestrlyData(element).suggested ? { suggested: true as const } : {}),
      })
    } else outline.sketches.push({ id: element.id, kind: element.type, box, ...inside(element), ...lastBy(element) })
  }

  if (options.since !== undefined) {
    const { changed, deleted } = changesSince(board, options.since)
    // The agent knows cards, not their text elements: a change to a card's text is a change to the card.
    const visible = (element: BoardElement) => (isBoundText(element) ? element.containerId! : element.id)
    const unique = (ids: string[]) => [...new Set(ids)]
    outline.changes = {
      since: options.since,
      changed: unique(changed.map((stored) => visible(stored.element))),
      deleted: unique(deleted.filter((id) => !isBoundText(board.elements.get(id)!.element))),
      byPerson: unique(changed.filter((stored) => stored.by === 'person').map((stored) => visible(stored.element))),
    }
  }
  return outline
}
