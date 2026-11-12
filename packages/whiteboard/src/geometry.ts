import type { BoardElement, Point } from './elements.js'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export function boxOf(element: BoardElement): Box {
  if (element.points?.length) {
    const xs = element.points.map((point) => element.x + point[0])
    const ys = element.points.map((point) => element.y + point[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
  return { x: element.x, y: element.y, width: element.width, height: element.height }
}

export function center(box: Box): Point {
  return [box.x + box.width / 2, box.y + box.height / 2]
}

export function union(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

export function intersection(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** Where the line from an element's center toward `[dx, dy]` leaves its outline. */
function edgeFactor(element: BoardElement, dx: number, dy: number): number {
  const a = element.width / 2
  const b = element.height / 2
  if (a <= 0 || b <= 0 || (dx === 0 && dy === 0)) return 0
  if (element.type === 'ellipse') return 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2)
  if (element.type === 'diamond') return 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
  return Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : a / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : b / Math.abs(dy)
  )
}

export const ARROW_GAP = 8

/**
 * A straight arrow between two elements, from edge to edge along the line between their centers, like the one a
 * person draws by dragging from one to the other.
 */
export function routeBetween(from: BoardElement, to: BoardElement): { x: number; y: number; points: Point[] } {
  const [ax, ay] = center(boxOf(from))
  const [bx, by] = center(boxOf(to))
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const fs = edgeFactor(from, dx, dy)
  const ft = edgeFactor(to, -dx, -dy)
  const start: Point = [ax + dx * fs + ux * ARROW_GAP, ay + dy * fs + uy * ARROW_GAP]
  const end: Point = [bx - dx * ft - ux * ARROW_GAP, by - dy * ft - uy * ARROW_GAP]
  return {
    x: start[0],
    y: start[1],
    points: [
      [0, 0],
      [end[0] - start[0], end[1] - start[1]],
    ],
  }
}

/** Whether the segment from `a` to `b` passes through the box (Liang–Barsky clipping). */
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let enter = 0
  let leave = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > leave) return false
      if (r > enter) enter = r
    } else {
      if (r < enter) return false
      if (r < leave) leave = r
    }
    return true
  }
  return (
    clip(-dx, a[0] - box.x) &&
    clip(dx, box.x + box.width - a[0]) &&
    clip(-dy, a[1] - box.y) &&
    clip(dy, box.y + box.height - a[1])
  )
}

export function midpoint(arrow: BoardElement): Point {
  const points = arrow.points ?? [[0, 0]]
  const first = points[0]!
  const last = points[points.length - 1]!
  return [arrow.x + (first[0] + last[0]) / 2, arrow.y + (first[1] + last[1]) / 2]
}
