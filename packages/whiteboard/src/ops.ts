import { generateKeyBetween } from 'fractional-indexing'
import { z } from 'zod'
import type { Board, StoredElement } from './board.js'
import {
  type BoardElement,
  bump,
  COLORS,
  type ColorName,
  DEFAULT_FONT_SIZE,
  isBindable,
  isBoundText,
  isFrame,
  isShape,
  newArrow,
  newFrame,
  newShape,
  newText,
  randomId,
  type ShapeType,
  TEXT_PADDING,
  withMaestrlyData,
} from './elements.js'
import {
  ARROW_GAP,
  type Box,
  boxOf,
  center,
  contains,
  intersection,
  midpoint,
  routeBetween,
  union,
} from './geometry.js'
import { arrange, type LayoutEdge } from './layout.js'
import { measureText } from './text.js'

export const MAX_OPS = 200
export const MAX_TEXT_CHARS = 2000
export const MAX_TITLE_CHARS = 200
/** IDs the agent picks, such as `api` or `retro-went-well`; the canvas's own IDs fit too. */
export const ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/

const id = z.string().regex(ELEMENT_ID)
const coordinate = z.number().min(-1_000_000).max(1_000_000)
const color = z.enum(Object.keys(COLORS) as [ColorName, ...ColorName[]])
const shape = z.enum(['rectangle', 'ellipse', 'diamond'])
const length = z.number().min(20).max(5000)
const place = z.union([
  z.strictObject({ x: coordinate, y: coordinate }),
  z.strictObject({
    near: id,
    side: z.enum(['right', 'below', 'left', 'above']).optional(),
    gap: z.number().min(0).max(2000).optional(),
  }),
])
export type Place = z.infer<typeof place>

export const opSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('card'),
    id,
    text: z.string().max(MAX_TEXT_CHARS),
    shape: shape.optional(),
    color: color.optional(),
    at: place.optional(),
    in: id.optional(),
    width: length.optional(),
    suggested: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal('text'),
    id,
    text: z.string().min(1).max(MAX_TEXT_CHARS),
    size: z.enum(['s', 'm', 'l', 'xl']).optional(),
    at: place.optional(),
    in: id.optional(),
  }),
  z.strictObject({
    op: z.literal('section'),
    id,
    title: z.string().max(MAX_TITLE_CHARS),
    at: place.optional(),
    width: length.optional(),
    height: length.optional(),
  }),
  z.strictObject({
    op: z.literal('connect'),
    id: id.optional(),
    from: id,
    to: id,
    label: z.string().max(MAX_TEXT_CHARS).optional(),
    dashed: z.boolean().optional(),
    head: z.boolean().optional(),
    suggested: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal('update'),
    id,
    text: z.string().max(MAX_TEXT_CHARS).optional(),
    title: z.string().max(MAX_TITLE_CHARS).optional(),
    color: color.optional(),
    shape: shape.optional(),
    suggested: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal('move'), id, to: place.optional(), in: id.nullable().optional() }),
  z.strictObject({ op: z.literal('delete'), id, keepContents: z.boolean().optional() }),
  z.strictObject({
    op: z.literal('layout'),
    as: z.enum(['grid', 'row', 'column', 'flow']),
    in: id.optional(),
    ids: z.array(id).min(1).max(500).optional(),
    gap: z.number().min(0).max(1000).optional(),
  }),
])
export type Op = z.infer<typeof opSchema>
export const opsSchema = z.array(opSchema).min(1).max(MAX_OPS)

export type OpErrorCode =
  | 'invalid_base'
  | 'exists'
  | 'unknown_element'
  | 'not_a_section'
  | 'not_connectable'
  | 'wrong_kind'
  | 'nothing_to_do'

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** An op that was not applied because a person changed or deleted what it targets after the agent's base revision. */
export interface Conflict {
  op: number
  id: string
  reason: 'changed' | 'deleted'
}

export type ApplyResult =
  | {
      ok: true
      board: Board
      /** The elements this apply changed, for the canvases showing the board. */
      changed: BoardElement[]
      applied: number[]
      conflicts: Conflict[]
      /** IDs of the elements the ops created, in order, including the ones the host named. */
      created: string[]
    }
  | { ok: false; error: { op: number; code: OpErrorCode; message: string } }

const SECTION_PADDING = 40
const SECTION_WIDTH = 400
const SECTION_HEIGHT = 300
const GAP = 40
const NEAR_GAP = 60
const CARD_MIN = { rectangle: [160, 80], ellipse: [180, 110], diamond: [200, 130] } as const
const CARD_MAX_WIDTH = 360
const FREE_TEXT_WIDTH = 600
const LABEL_FONT_SIZE = 16
const TEXT_SIZES = { s: 16, m: 20, l: 28, xl: 36 } as const

/** The part of a container its text may fill, as Excalidraw computes it. */
function textArea(type: string, width: number, height: number): [number, number] {
  const pad = TEXT_PADDING * 2
  if (type === 'ellipse')
    return [Math.round((width / 2) * Math.SQRT2) - pad, Math.round((height / 2) * Math.SQRT2) - pad]
  if (type === 'diamond') return [Math.round(width / 2) - pad, Math.round(height / 2) - pad]
  return [width - pad, height - pad]
}

/** The container side that gives text of `size` room, with some air around it. */
function sideFor(type: string, size: number): number {
  const needed = size + TEXT_PADDING * 2 + 16
  if (type === 'ellipse') return Math.ceil(needed * Math.SQRT2)
  if (type === 'diamond') return Math.ceil(needed * 2)
  return needed
}

function cardSize(type: ShapeType, text: string, width?: number): { width: number; height: number } {
  const [minWidth, minHeight] = CARD_MIN[type]
  const natural = measureText(text, DEFAULT_FONT_SIZE)
  const chosen =
    width ??
    Math.min(Math.max(minWidth, sideFor(type, natural.width)), CARD_MAX_WIDTH * (type === 'rectangle' ? 1 : 1.4))
  const [areaWidth] = textArea(type, chosen, 0)
  const wrapped = measureText(text, DEFAULT_FONT_SIZE, areaWidth)
  return { width: chosen, height: Math.max(minHeight, sideFor(type, wrapped.height)) }
}

/** Applies ops atomically; one invalid op cancels them all, an op that meets a person's change is skipped. */
class Draft {
  private readonly changed = new Map<string, BoardElement>()
  private readonly fresh = new Set<string>()
  /** Arrows whose ends moved: rerouted once, after every op. */
  readonly dirtyArrows = new Set<string>()
  private autoCursor: Box | null = null

  constructor(
    private readonly board: Board,
    private readonly baseRevision: number,
    readonly now: number
  ) {}

  get(elementId: string): BoardElement | undefined {
    return this.changed.get(elementId) ?? this.board.elements.get(elementId)?.element
  }

  live(elementId: string): BoardElement | undefined {
    const element = this.get(elementId)
    return element && !element.isDeleted ? element : undefined
  }

  require(elementId: string): BoardElement {
    const element = this.live(elementId)
    if (!element) throw new OpError('unknown_element', `No element "${elementId}" on the board`)
    return element
  }

  requireSection(elementId: string): BoardElement {
    const element = this.require(elementId)
    if (!isFrame(element)) throw new OpError('not_a_section', `"${elementId}" is not a section`)
    return element
  }

  ensureFree(elementId: string): void {
    if (this.live(elementId)) throw new OpError('exists', `"${elementId}" already exists; use update or move`)
  }

  /** Whether a person (or another agent) changed the element after the base revision this agent read. */
  conflict(elementId: string): Conflict['reason'] | null {
    if (this.fresh.has(elementId)) return null
    const stored: StoredElement | undefined = this.board.elements.get(elementId)
    if (!stored || stored.rev <= this.baseRevision) return null
    return stored.element.isDeleted ? 'deleted' : 'changed'
  }

  all(): BoardElement[] {
    const elements = new Map<string, BoardElement>()
    for (const [key, stored] of this.board.elements) elements.set(key, stored.element)
    for (const [key, element] of this.changed) elements.set(key, element)
    return [...elements.values()]
  }

  liveElements(): BoardElement[] {
    return this.all().filter((element) => !element.isDeleted)
  }

  add(element: BoardElement): BoardElement {
    // A deleted element's ID can be reused; the new one outranks its tombstone on every canvas.
    const previous = this.get(element.id)
    const placed = { ...element, version: previous ? previous.version + 1 : 1 }
    this.changed.set(element.id, placed)
    this.fresh.add(element.id)
    return placed
  }

  set(elementId: string, changes: Partial<BoardElement>): BoardElement {
    const current = this.get(elementId)!
    // One apply is one new version, however many ops touch the element.
    const next = this.changed.has(elementId)
      ? { ...current, ...changes, updated: this.now }
      : bump(current, changes, this.now)
    this.changed.set(elementId, next)
    return next
  }

  remove(elementId: string): void {
    if (this.live(elementId)) this.set(elementId, { isDeleted: true })
  }

  indexAtTop(): string {
    let top: string | null = null
    for (const element of this.all()) if (element.index && (!top || element.index > top)) top = element.index
    return generateKeyBetween(top, null)
  }

  /** An index right above the element's, where Excalidraw expects its text. */
  indexAfter(elementId: string): string {
    const own = this.get(elementId)?.index ?? null
    if (own === null) return this.indexAtTop()
    let next: string | null = null
    for (const element of this.all())
      if (element.index && element.index > own && (!next || element.index < next)) next = element.index
    return generateKeyBetween(own, next)
  }

  boundText(container: BoardElement): BoardElement | undefined {
    const entry = container.boundElements?.find((bound) => bound.type === 'text')
    const text = entry ? this.live(entry.id) : undefined
    return text?.containerId === container.id ? text : undefined
  }

  arrowsOf(element: BoardElement): BoardElement[] {
    return (element.boundElements ?? [])
      .filter((bound) => bound.type === 'arrow')
      .map((bound) => this.live(bound.id))
      .filter((arrow): arrow is BoardElement => !!arrow)
  }

  childrenOf(section: BoardElement): BoardElement[] {
    return this.liveElements().filter((element) => element.frameId === section.id && !isBoundText(element))
  }

  changes(): BoardElement[] {
    return [...this.changed.values()]
  }

  // Placement

  resolve(place: Place | undefined, size: { width: number; height: number }, section: BoardElement | null) {
    if (place && 'x' in place) return { x: place.x, y: place.y }
    if (place) {
      const box = boxOf(this.require(place.near))
      const gap = place.gap ?? NEAR_GAP
      const centerX = box.x + box.width / 2 - size.width / 2
      const centerY = box.y + box.height / 2 - size.height / 2
      switch (place.side ?? 'right') {
        case 'right':
          return { x: box.x + box.width + gap, y: centerY }
        case 'left':
          return { x: box.x - gap - size.width, y: centerY }
        case 'below':
          return { x: centerX, y: box.y + box.height + gap }
        case 'above':
          return { x: centerX, y: box.y - gap - size.height }
      }
    }
    return section ? this.slotIn(section) : this.slotOnBoard()
  }

  /**
   * The next free place in a section: below what it holds, in one column. Sections sit side by side, so arrows between
   * them run across columns instead of through the cards next to their ends.
   */
  private slotIn(section: BoardElement) {
    const boxes = this.childrenOf(section)
      .filter((element) => element.type !== 'arrow' && element.type !== 'line')
      .map(boxOf)
    const x = section.x + SECTION_PADDING
    if (!boxes.length) return { x, y: section.y + SECTION_PADDING }
    return { x, y: Math.max(...boxes.map((box) => box.y + box.height)) + GAP }
  }

  /** The topmost section under a point, as the canvas decides where a dropped element belongs. */
  sectionAt([x, y]: readonly [number, number], except: string): BoardElement | null {
    let found: BoardElement | null = null
    for (const element of this.liveElements()) {
      if (!isFrame(element) || element.id === except) continue
      if (x < element.x || y < element.y || x > element.x + element.width || y > element.y + element.height) continue
      if (!found || (element.index ?? '') > (found.index ?? '')) found = element
    }
    return found
  }

  /** Outside any section: after what this apply placed last, otherwise to the right of everything. */
  private slotOnBoard() {
    const after = this.autoCursor ?? union(this.topLevelBoxes())
    return after ? { x: after.x + after.width + GAP * 2, y: after.y } : { x: 0, y: 0 }
  }

  placed(box: Box, auto: boolean): void {
    if (auto) this.autoCursor = box
  }

  topLevelBoxes(): Box[] {
    return this.liveElements()
      .filter((element) => !element.frameId && !isBoundText(element))
      .map(boxOf)
  }

  /** Sections line up left to right, like the columns of a retro; the first goes below what is on the board. */
  sectionSlot() {
    const sections = this.liveElements().filter(isFrame)
    if (sections.length) {
      const right = Math.max(...sections.map((section) => section.x + section.width))
      return { x: right + GAP * 2, y: Math.min(...sections.map((section) => section.y)) }
    }
    const content = union(this.topLevelBoxes())
    return content ? { x: content.x, y: content.y + content.height + GAP * 3 } : { x: 0, y: 0 }
  }

  /** Grows a section so the box fits inside it with padding. */
  fit(section: BoardElement | null, box: Box): void {
    if (!section) return
    const current = this.get(section.id)!
    const padded = {
      x: box.x - SECTION_PADDING,
      y: box.y - SECTION_PADDING,
      width: box.width + SECTION_PADDING * 2,
      height: box.height + SECTION_PADDING * 2,
    }
    if (contains(boxOf(current), padded)) return
    const grown = union([boxOf(current), padded])!
    this.set(section.id, { ...grown })
    this.grown.add(section.id)
  }

  /** Sections that grew in this apply, which may now cover their neighbors. */
  readonly grown = new Set<string>()

  /**
   * Pushes the sections a grown one now covers out of its way, toward the side they were on before this apply, so a
   * row of sections stays a row; a pushed section may push the next. Sections that already overlapped, as a person
   * may lay them on purpose, are left alone.
   */
  separate(): void {
    const queue = [...this.grown]
    const limit = this.liveElements().filter(isFrame).length ** 2
    const space = GAP * 2
    const before = (element: BoardElement) => boxOf(this.board.elements.get(element.id)?.element ?? element)
    for (let step = 0; queue.length && step < limit; step++) {
      const section = this.live(queue.shift()!)
      if (!section) continue
      const box = boxOf(section)
      const was = before(section)
      for (const other of this.liveElements()) {
        if (!isFrame(other) || other.id === section.id) continue
        const theirs = boxOf(other)
        if (intersection(box, theirs) === 0) continue
        const stood = before(other)
        if (stood.x >= was.x + was.width) this.moveBy(other, box.x + box.width + space - theirs.x, 0)
        else if (stood.x + stood.width <= was.x) this.moveBy(other, box.x - space - (theirs.x + theirs.width), 0)
        else if (stood.y >= was.y + was.height) this.moveBy(other, 0, box.y + box.height + space - theirs.y)
        else if (stood.y + stood.height <= was.y) this.moveBy(other, 0, box.y - space - (theirs.y + theirs.height))
        else continue
        queue.push(other.id)
      }
    }
  }

  // Text

  setBoundText(container: BoardElement, text: string, fontSize = DEFAULT_FONT_SIZE): void {
    const existing = this.boundText(container)
    if (!text) {
      if (existing) {
        this.remove(existing.id)
        this.set(container.id, {
          boundElements: (container.boundElements ?? []).filter((bound) => bound.id !== existing.id),
        })
      }
      return
    }
    const size = existing?.fontSize ?? fontSize
    if (container.type === 'arrow') return this.setLabel(container, existing, text, size)

    const [areaWidth, areaHeight] = textArea(container.type, container.width, container.height)
    const measured = measureText(text, size, areaWidth)
    if (measured.height > areaHeight)
      container = this.set(container.id, { height: sideFor(container.type, measured.height) })
    const frame = {
      x: container.x + container.width / 2 - measured.width / 2,
      y: container.y + container.height / 2 - measured.height / 2,
      width: measured.width,
      height: measured.height,
    }
    if (existing) {
      this.set(existing.id, { ...frame, text, originalText: text })
      return
    }
    const element = this.add(
      newText(
        { id: randomId(), ...frame, index: this.indexAfter(container.id), now: this.now, frameId: container.frameId },
        text,
        {
          containerId: container.id,
          fontSize: size,
        }
      )
    )
    this.set(container.id, { boundElements: [...(container.boundElements ?? []), { id: element.id, type: 'text' }] })
  }

  private setLabel(arrow: BoardElement, existing: BoardElement | undefined, text: string, size: number): void {
    const measured = measureText(text, size, Math.max(arrow.width * 0.7, size * 11))
    const [mx, my] = midpoint(arrow)
    const frame = {
      x: mx - measured.width / 2,
      y: my - measured.height / 2,
      width: measured.width,
      height: measured.height,
    }
    if (existing) {
      this.set(existing.id, { ...frame, text, originalText: text })
      return
    }
    const element = this.add(
      newText(
        { id: randomId(), ...frame, index: this.indexAfter(arrow.id), now: this.now, frameId: arrow.frameId },
        text,
        {
          containerId: arrow.id,
          fontSize: size,
        }
      )
    )
    this.set(arrow.id, { boundElements: [...(arrow.boundElements ?? []), { id: element.id, type: 'text' }] })
  }

  // Moving

  /** Moves an element with its text, and a section with everything in it. */
  moveBy(element: BoardElement, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    const moving = [element, ...(isFrame(element) ? this.childrenOf(element) : [])]
    for (const item of moving) {
      const current = this.get(item.id)!
      this.set(item.id, { x: current.x + dx, y: current.y + dy })
      const text = this.boundText(current)
      if (text && current.type !== 'arrow') this.set(text.id, { x: text.x + dx, y: text.y + dy })
      for (const arrow of this.arrowsOf(current)) this.dirtyArrows.add(arrow.id)
      if (current.type === 'arrow') this.dirtyArrows.add(current.id)
    }
  }

  setSection(element: BoardElement, section: BoardElement | null): void {
    const frameId = section?.id ?? null
    if (element.frameId === frameId) return
    this.set(element.id, { frameId })
    const text = this.boundText(element)
    if (text) this.set(text.id, { frameId })
  }

  /** Straightens every arrow whose ends moved, and keeps its label on it. */
  reroute(): void {
    for (const arrowId of this.dirtyArrows) {
      const arrow = this.live(arrowId)
      const from = arrow?.startBinding ? this.live(arrow.startBinding.elementId) : undefined
      const to = arrow?.endBinding ? this.live(arrow.endBinding.elementId) : undefined
      if (!arrow || !from || !to) continue
      const route = routeBetween(from, to)
      // An arrow belongs to a section only while both its ends do.
      const frameId = from.frameId && from.frameId === to.frameId ? from.frameId : null
      const next = this.set(arrow.id, {
        ...route,
        width: Math.abs(route.points[1]![0]),
        height: Math.abs(route.points[1]![1]),
        frameId,
      })
      const label = this.boundText(next)
      if (label) {
        const [mx, my] = midpoint(next)
        this.set(label.id, { x: mx - label.width / 2, y: my - label.height / 2, frameId })
      }
    }
    this.dirtyArrows.clear()
  }

  // Deleting

  deleteElement(element: BoardElement, keepContents: boolean): void {
    if (isFrame(element))
      for (const child of this.childrenOf(element)) {
        if (keepContents) this.setSection(child, null)
        else this.deleteElement(child, false)
      }
    const text = this.boundText(element)
    if (text) this.remove(text.id)
    for (const arrow of this.arrowsOf(element)) this.deleteElement(arrow, false)
    if (element.type === 'arrow')
      for (const binding of [element.startBinding, element.endBinding]) {
        const end = binding ? this.live(binding.elementId) : undefined
        if (end)
          this.set(end.id, { boundElements: (end.boundElements ?? []).filter((bound) => bound.id !== element.id) })
      }
    this.remove(element.id)
  }
}

function suggestedStyle(element: BoardElement, suggested: boolean): Partial<BoardElement> {
  return {
    customData: withMaestrlyData(element, { suggested }),
    strokeStyle: suggested ? 'dashed' : 'solid',
  }
}

function runOp(draft: Draft, op: Op, index: number, created: string[]): Conflict | null {
  const now = draft.now
  switch (op.op) {
    case 'card': {
      draft.ensureFree(op.id)
      const section = op.in ? draft.requireSection(op.in) : null
      const type = op.shape ?? 'rectangle'
      const size = cardSize(type, op.text, op.width)
      const at = draft.resolve(op.at, size, section)
      let card = newShape(
        type,
        { id: op.id, ...at, ...size, index: draft.indexAtTop(), now, frameId: section?.id },
        COLORS[op.color ?? 'none']
      )
      if (op.suggested) card = { ...card, ...suggestedStyle(card, true) }
      const placed = draft.add(card)
      draft.setBoundText(placed, op.text)
      draft.placed(boxOf(draft.get(op.id)!), !op.at)
      draft.fit(section, boxOf(draft.get(op.id)!))
      created.push(op.id)
      return null
    }
    case 'text': {
      draft.ensureFree(op.id)
      const section = op.in ? draft.requireSection(op.in) : null
      const fontSize = TEXT_SIZES[op.size ?? 'm']
      const measured = measureText(op.text, fontSize, FREE_TEXT_WIDTH)
      const text = measured.lines.join('\n')
      const at = draft.resolve(op.at, measured, section)
      draft.add(
        newText(
          {
            id: op.id,
            ...at,
            width: measured.width,
            height: measured.height,
            index: draft.indexAtTop(),
            now,
            frameId: section?.id,
          },
          text,
          { fontSize }
        )
      )
      const box = { ...at, width: measured.width, height: measured.height }
      draft.placed(box, !op.at)
      draft.fit(section, box)
      created.push(op.id)
      return null
    }
    case 'section': {
      draft.ensureFree(op.id)
      const width = op.width ?? SECTION_WIDTH
      const height = op.height ?? SECTION_HEIGHT
      const at = op.at ? draft.resolve(op.at, { width, height }, null) : draft.sectionSlot()
      draft.add(newFrame({ id: op.id, ...at, width, height, index: draft.indexAtTop(), now }, op.title))
      created.push(op.id)
      return null
    }
    case 'connect': {
      const from = draft.require(op.from)
      const to = draft.require(op.to)
      for (const end of [from, to])
        if (!isBindable(end))
          throw new OpError(
            'not_connectable',
            `"${end.id}" cannot be connected; connect cards, texts, images or sections`
          )
      if (from.id === to.id) throw new OpError('not_connectable', 'An arrow needs two different ends')
      const named = op.id ?? `${from.id}-${to.id}`
      const arrowId = op.id ?? (ELEMENT_ID.test(named) && !draft.live(named) ? named : randomId())
      draft.ensureFree(arrowId)
      const route = routeBetween(from, to)
      const binding = (elementId: string) => ({ elementId, focus: 0, gap: ARROW_GAP })
      let arrow = newArrow(
        {
          id: arrowId,
          x: route.x,
          y: route.y,
          width: Math.abs(route.points[1]![0]),
          height: Math.abs(route.points[1]![1]),
          index: draft.indexAtTop(),
          now,
          frameId: from.frameId && from.frameId === to.frameId ? from.frameId : null,
        },
        route.points,
        { start: binding(from.id), end: binding(to.id), dashed: !!op.dashed, head: op.head ?? true }
      )
      if (op.suggested) arrow = { ...arrow, ...suggestedStyle(arrow, true) }
      const placed = draft.add(arrow)
      for (const end of [from, to]) {
        const current = draft.get(end.id)!
        draft.set(end.id, { boundElements: [...(current.boundElements ?? []), { id: arrowId, type: 'arrow' }] })
      }
      if (op.label) draft.setBoundText(placed, op.label, LABEL_FONT_SIZE)
      created.push(arrowId)
      return null
    }
    case 'update': {
      const conflict = conflictOf(draft, op.id, index)
      if (conflict) return conflict
      let element = draft.require(op.id)
      if (op.text !== undefined) {
        if (isFrame(element)) throw new OpError('wrong_kind', `"${op.id}" is a section; change its title instead`)
        if (element.type === 'text' && !element.containerId) {
          const measured = measureText(op.text, element.fontSize ?? DEFAULT_FONT_SIZE, FREE_TEXT_WIDTH)
          if (!op.text) draft.deleteElement(element, false)
          else
            draft.set(element.id, {
              text: measured.lines.join('\n'),
              originalText: op.text,
              width: measured.width,
              height: measured.height,
            })
        } else if (isShape(element) || element.type === 'arrow') {
          const text = draft.boundText(element)
          const textConflict = text ? conflictOf(draft, text.id, index) : null
          if (textConflict) return textConflict
          draft.setBoundText(element, op.text, element.type === 'arrow' ? LABEL_FONT_SIZE : DEFAULT_FONT_SIZE)
        } else throw new OpError('wrong_kind', `"${op.id}" is a ${element.type} and holds no text`)
        element = draft.get(op.id)!
      }
      if (op.title !== undefined) {
        if (!isFrame(element)) throw new OpError('wrong_kind', `"${op.id}" is not a section and has no title`)
        element = draft.set(element.id, { name: op.title })
      }
      if (op.color !== undefined) {
        if (!isShape(element))
          throw new OpError('wrong_kind', `Only cards have a color; "${op.id}" is a ${element.type}`)
        element = draft.set(element.id, { backgroundColor: COLORS[op.color] })
      }
      if (op.shape !== undefined && op.shape !== element.type) {
        if (!isShape(element)) throw new OpError('wrong_kind', `"${op.id}" is a ${element.type}, not a card`)
        element = draft.set(element.id, { type: op.shape })
        const text = draft.boundText(element)
        if (text) draft.setBoundText(element, text.originalText ?? text.text ?? '')
        for (const arrow of draft.arrowsOf(element)) draft.dirtyArrows.add(arrow.id)
      }
      if (op.suggested !== undefined) {
        element = draft.set(element.id, suggestedStyle(element, op.suggested))
      }
      return null
    }
    case 'move': {
      const conflict = conflictOf(draft, op.id, index)
      if (conflict) return conflict
      const element = draft.require(op.id)
      if (element.type === 'arrow' || isBoundText(element))
        throw new OpError('wrong_kind', `"${op.id}" follows what it is attached to; move that instead`)
      if (op.to === undefined && op.in === undefined)
        throw new OpError('nothing_to_do', 'move needs "to", "in", or both')
      const explicit = op.in !== undefined
      const section = op.in ? draft.requireSection(op.in) : null
      if (section && isFrame(element)) throw new OpError('wrong_kind', 'Sections cannot be put inside other sections')
      const box = boxOf(element)
      // Into a section without a place: its next free slot, worked out before the element counts as inside it.
      const target = op.to !== undefined || section ? draft.resolve(op.to, box, section) : null
      if (target) draft.moveBy(element, target.x - box.x, target.y - box.y)
      const moved = draft.get(element.id)!
      if (explicit) {
        draft.setSection(moved, section)
        draft.fit(section, boxOf(moved))
      } else if (!isFrame(moved)) {
        // Like a drop on the canvas: it belongs to the section it lands in, and the section it left keeps its size.
        draft.setSection(moved, draft.sectionAt(center(boxOf(moved)), moved.id))
      }
      return null
    }
    case 'delete': {
      const conflict = conflictOf(draft, op.id, index)
      if (conflict) return conflict
      const element = draft.require(op.id)
      if (isBoundText(element))
        throw new OpError('wrong_kind', `"${op.id}" is the text of "${element.containerId}"; update it instead`)
      draft.deleteElement(element, !!op.keepContents)
      return null
    }
    case 'layout': {
      const section = op.in ? draft.requireSection(op.in) : null
      const items = op.ids
        ? op.ids.map((itemId) => draft.require(itemId))
        : section
          ? draft.childrenOf(section).filter((element) => element.type !== 'arrow' && element.type !== 'line')
          : draft
              .liveElements()
              .filter(
                (element) =>
                  !element.frameId && !isBoundText(element) && element.type !== 'arrow' && element.type !== 'line'
              )
      for (const item of items)
        if (item.type === 'arrow' || isBoundText(item))
          throw new OpError('wrong_kind', `"${item.id}" follows what it is attached to and is not laid out`)
      if (!items.length) throw new OpError('nothing_to_do', 'There is nothing to lay out there')
      const ids = new Set(items.map((item) => item.id))
      const edges: LayoutEdge[] = draft
        .liveElements()
        .filter((element) => element.type === 'arrow' && element.startBinding && element.endBinding)
        .map((arrow) => ({ from: arrow.startBinding!.elementId, to: arrow.endBinding!.elementId }))
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      const boxes = items.map((item) => ({ id: item.id, ...boxOf(item) }))
      // Without an explicit order, items keep the reading order they already have.
      const ordered =
        op.ids || op.as === 'flow'
          ? boxes
          : [...boxes].sort((a, b) => (op.as === 'row' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x))
      const origin = section
        ? { x: section.x + SECTION_PADDING, y: section.y + SECTION_PADDING }
        : (({ x, y }) => ({ x, y }))(union(boxes)!)
      const positions = arrange(ordered, op.as, origin, op.gap ?? (op.as === 'flow' ? GAP * 1.5 : GAP), edges)
      for (const item of items) {
        const position = positions.get(item.id)!
        const current = draft.get(item.id)!
        draft.moveBy(current, position.x - current.x, position.y - current.y)
      }
      if (section) {
        const content = union(draft.childrenOf(section).map(boxOf))
        if (content) {
          draft.set(section.id, {
            width: Math.max(SECTION_WIDTH / 2, content.x + content.width + SECTION_PADDING - section.x),
            height: Math.max(SECTION_HEIGHT / 2, content.y + content.height + SECTION_PADDING - section.y),
          })
          draft.grown.add(section.id)
        }
      }
      return null
    }
  }
}

function conflictOf(draft: Draft, elementId: string, op: number): Conflict | null {
  const reason = draft.conflict(elementId)
  return reason ? { op, id: elementId, reason } : null
}

/**
 * Applies the agent's ops to the board as it is now. `baseRevision` is the revision the agent last read: an op that
 * changes, moves or deletes something a person changed after it is skipped and reported, so the person's edit wins.
 * Additions never conflict. Any invalid op cancels the whole batch.
 */
export function applyOps(board: Board, input: { baseRevision: number; ops: readonly Op[]; now: number }): ApplyResult {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision > board.revision)
    return {
      ok: false,
      error: { op: -1, code: 'invalid_base', message: `baseRevision must be between 0 and ${board.revision}` },
    }
  const draft = new Draft(board, input.baseRevision, input.now)
  const applied: number[] = []
  const conflicts: Conflict[] = []
  const created: string[] = []
  for (const [index, op] of input.ops.entries()) {
    try {
      const conflict = runOp(draft, op, index, created)
      if (conflict) conflicts.push(conflict)
      else applied.push(index)
    } catch (error) {
      if (error instanceof OpError) return { ok: false, error: { op: index, code: error.code, message: error.message } }
      throw error
    }
  }
  draft.separate()
  draft.reroute()
  const changed = draft.changes()
  if (!changed.length) return { ok: true, board, changed, applied, conflicts, created }
  const revision = board.revision + 1
  const elements = new Map(board.elements)
  for (const element of changed) elements.set(element.id, { element, rev: revision, by: 'agent' })
  return { ok: true, board: { revision, elements }, changed, applied, conflicts, created }
}
