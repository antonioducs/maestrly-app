import { type Board, orderedElements } from './board.js'
import { type BoardElement, DEFAULT_FONT_SIZE, isBoundText, isFrame, isShape, TEXT_PADDING } from './elements.js'
import { boxOf, contains, intersection, segmentHitsBox } from './geometry.js'
import { measureText } from './text.js'

export type WarningKind = 'overlap' | 'crossing' | 'outside_section' | 'text_overflow' | 'dangling_link'

export interface Warning {
  kind: WarningKind
  ids: string[]
}

/** Pairs are compared only on boards up to this size; beyond it the check would cost more than it tells. */
const MAX_OVERLAP_ITEMS = 1500
/** Overlaps smaller than this share of the smaller box are an arrow's worth of touching, not a pile. */
const OVERLAP_SHARE = 0.15
/** How far inside a box an arrow must pass to cross it, so one that grazes a corner does not count. */
const CROSSING_MARGIN = 6

/**
 * What reads badly on the board: things piled on each other, arrows running through cards that are not their ends,
 * things out of their section, text spilling out, links to nothing.
 */
export function checkBoard(board: Board): Warning[] {
  const elements = orderedElements(board)
  const byId = new Map(elements.map((element) => [element.id, element]))
  const warnings: Warning[] = []

  const solid = elements.filter(
    (element) => isShape(element) || element.type === 'image' || (element.type === 'text' && !isBoundText(element))
  )
  if (solid.length <= MAX_OVERLAP_ITEMS)
    for (let i = 0; i < solid.length; i++)
      for (let j = i + 1; j < solid.length; j++) {
        const a = boxOf(solid[i]!)
        const b = boxOf(solid[j]!)
        const smaller = Math.min(a.width * a.height, b.width * b.height)
        if (smaller > 0 && intersection(a, b) > smaller * OVERLAP_SHARE)
          warnings.push({ kind: 'overlap', ids: [solid[i]!.id, solid[j]!.id] })
      }

  const arrows = elements.filter((element) => element.type === 'arrow' && element.points && element.points.length >= 2)
  if (arrows.length * solid.length <= MAX_OVERLAP_ITEMS * MAX_OVERLAP_ITEMS)
    for (const arrow of arrows) {
      const ends = new Set([arrow.startBinding?.elementId, arrow.endBinding?.elementId])
      const points = arrow.points!
      for (const element of solid) {
        if (ends.has(element.id)) continue
        const box = boxOf(element)
        const inner = {
          x: box.x + CROSSING_MARGIN,
          y: box.y + CROSSING_MARGIN,
          width: box.width - CROSSING_MARGIN * 2,
          height: box.height - CROSSING_MARGIN * 2,
        }
        if (inner.width <= 0 || inner.height <= 0) continue
        for (let i = 1; i < points.length; i++) {
          const a = [arrow.x + points[i - 1]![0], arrow.y + points[i - 1]![1]] as const
          const b = [arrow.x + points[i]![0], arrow.y + points[i]![1]] as const
          if (segmentHitsBox(a, b, inner)) {
            warnings.push({ kind: 'crossing', ids: [arrow.id, element.id] })
            break
          }
        }
      }
    }

  for (const element of elements) {
    if (isBoundText(element)) {
      const container = byId.get(element.containerId!)
      if (container && isShape(container) && overflows(container, element))
        warnings.push({ kind: 'text_overflow', ids: [container.id] })
      continue
    }
    if (element.frameId) {
      const section = byId.get(element.frameId)
      if (section && isFrame(section) && !contains(boxOf(section), boxOf(element)))
        warnings.push({ kind: 'outside_section', ids: [element.id, section.id] })
    }
    if (element.type === 'arrow')
      for (const binding of [element.startBinding, element.endBinding])
        if (binding && !byId.has(binding.elementId)) warnings.push({ kind: 'dangling_link', ids: [element.id] })
  }
  return warnings
}

function overflows(container: BoardElement, text: BoardElement): boolean {
  const width =
    container.type === 'rectangle'
      ? container.width
      : container.width * (container.type === 'ellipse' ? Math.SQRT1_2 : 0.5)
  const height =
    container.type === 'rectangle'
      ? container.height
      : container.height * (container.type === 'ellipse' ? Math.SQRT1_2 : 0.5)
  const measured = measureText(
    text.originalText ?? text.text ?? '',
    text.fontSize ?? DEFAULT_FONT_SIZE,
    width - TEXT_PADDING * 2
  )
  return measured.height > height - TEXT_PADDING * 2 + 1
}
