export type Arrangement = 'grid' | 'row' | 'column' | 'flow'

export interface LayoutItem {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEdge {
  from: string
  to: string
}

type Position = { x: number; y: number }

/**
 * Top-left positions for items arranged from `origin`, in the order given. `flow` puts each item one column to the
 * right of what points to it, following the edges; cycles are cut where they close.
 */
export function arrange(
  items: readonly LayoutItem[],
  as: Arrangement,
  origin: Position,
  gap: number,
  edges: readonly LayoutEdge[] = []
): Map<string, Position> {
  const positions = new Map<string, Position>()
  if (!items.length) return positions
  const maxWidth = Math.max(...items.map((item) => item.width))
  const maxHeight = Math.max(...items.map((item) => item.height))

  if (as === 'row' || as === 'column') {
    let offset = 0
    for (const item of items) {
      positions.set(
        item.id,
        as === 'row'
          ? { x: origin.x + offset, y: origin.y + (maxHeight - item.height) / 2 }
          : { x: origin.x + (maxWidth - item.width) / 2, y: origin.y + offset }
      )
      offset += (as === 'row' ? item.width : item.height) + gap
    }
    return positions
  }

  if (as === 'grid') {
    const columns = Math.ceil(Math.sqrt(items.length))
    items.forEach((item, i) => {
      const column = i % columns
      const row = Math.floor(i / columns)
      positions.set(item.id, {
        x: origin.x + column * (maxWidth + gap) + (maxWidth - item.width) / 2,
        y: origin.y + row * (maxHeight + gap) + (maxHeight - item.height) / 2,
      })
    })
    return positions
  }

  const layers = layer(items, edges)
  const columns: LayoutItem[][] = []
  for (const item of items) (columns[layers.get(item.id)!] ??= []).push(item)
  const placed = columns.filter(Boolean)
  // Each column follows the order of what points into it, so arrows cross less.
  const rank = new Map<string, number>()
  for (const column of placed) {
    const score = (item: LayoutItem) => {
      const sources = edges.filter((edge) => edge.to === item.id && rank.has(edge.from))
      return sources.length ? sources.reduce((sum, edge) => sum + rank.get(edge.from)!, 0) / sources.length : item.y
    }
    const scores = new Map(column.map((item) => [item.id, score(item)]))
    column.sort((a, b) => scores.get(a.id)! - scores.get(b.id)!)
    column.forEach((item, i) => rank.set(item.id, i))
  }
  const heights = placed.map((column) => column.reduce((sum, item) => sum + item.height, 0) + gap * (column.length - 1))
  const tallest = Math.max(...heights)
  let x = origin.x
  placed.forEach((column, c) => {
    const width = Math.max(...column.map((item) => item.width))
    let y = origin.y + (tallest - heights[c]!) / 2
    for (const item of column) {
      positions.set(item.id, { x: x + (width - item.width) / 2, y })
      y += item.height + gap
    }
    // Columns sit further apart than rows: arrows run between them.
    x += width + gap * 2
  })
  return positions
}

/** The longest path to each item from one with nothing pointing to it. */
function layer(items: readonly LayoutItem[], edges: readonly LayoutEdge[]): Map<string, number> {
  const ids = new Set(items.map((item) => item.id))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges)
    if (ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])

  const kept: LayoutEdge[] = []
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string) => {
    state.set(id, 'open')
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next)
      if (seen === 'open') continue
      kept.push({ from: id, to: next })
      if (!seen) visit(next)
    }
    state.set(id, 'done')
  }
  for (const item of items) if (!state.has(item.id)) visit(item.id)

  const depth = new Map(items.map((item) => [item.id, 0]))
  // Kept edges form a DAG over at most `items.length` nodes, so this many passes settle every depth.
  for (let pass = 0; pass < items.length; pass++) {
    let moved = false
    for (const edge of kept) {
      const candidate = depth.get(edge.from)! + 1
      if (candidate > depth.get(edge.to)!) {
        depth.set(edge.to, candidate)
        moved = true
      }
    }
    if (!moved) break
  }
  return depth
}
