/**
 * The scene is a list of Excalidraw elements: the same JSON the canvas reads and writes, so a person's edits and the
 * agent's meet in one format. This module knows the fields it creates and reads, and keeps every other field of an
 * element it did not create untouched.
 */

declare const crypto: { getRandomValues<T extends Uint32Array>(array: T): T }

export const ELEMENT_TYPES = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'image',
  'frame',
  'magicframe',
  'embeddable',
  'iframe',
] as const
export type ElementType = (typeof ELEMENT_TYPES)[number]

export type ShapeType = 'rectangle' | 'ellipse' | 'diamond'
export const SHAPE_TYPES: readonly ShapeType[] = ['rectangle', 'ellipse', 'diamond']

export type Point = readonly [number, number]

export interface Binding {
  elementId: string
  focus: number
  gap: number
}

export interface BoundElement {
  id: string
  type: 'arrow' | 'text'
}

/** Who made or last changed an element, as the agent sees it. Kept in `customData.maestrly`. */
export interface MaestrlyData {
  by?: 'agent' | 'person'
  /** Added by the agent for the person to accept or discard. */
  suggested?: boolean
}

export interface BoardElement {
  id: string
  type: ElementType
  x: number
  y: number
  width: number
  height: number
  angle: number
  strokeColor: string
  backgroundColor: string
  fillStyle: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag'
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  roughness: number
  opacity: number
  roundness: { type: number; value?: number } | null
  seed: number
  version: number
  versionNonce: number
  /** Fractional index: the element's place in the stacking order. */
  index: string | null
  isDeleted: boolean
  groupIds: readonly string[]
  frameId: string | null
  boundElements: readonly BoundElement[] | null
  updated: number
  link: string | null
  locked: boolean
  customData?: Record<string, unknown>
  // Text
  text?: string
  originalText?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  containerId?: string | null
  autoResize?: boolean
  lineHeight?: number
  // Arrows and lines
  points?: readonly Point[]
  lastCommittedPoint?: Point | null
  startBinding?: Binding | null
  endBinding?: Binding | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  elbowed?: boolean
  // Frames
  name?: string | null
  /** Fields this module does not know, from elements a person drew. */
  [field: string]: unknown
}

/** Excalidraw's own values, so boards look the same however they were made. */
export const FONT_EXCALIFONT = 5
export const DEFAULT_FONT_SIZE = 20
export const LINE_HEIGHT = 1.25
export const STROKE = '#1e1e1e'
/** Between a container's edge and its text. */
export const TEXT_PADDING = 5
const ROUNDNESS_ADAPTIVE = 3
const ROUNDNESS_PROPORTIONAL = 2

/** The backgrounds the agent names, from Excalidraw's palette. */
export const COLORS = {
  none: 'transparent',
  yellow: '#ffec99',
  green: '#b2f2bb',
  blue: '#a5d8ff',
  red: '#ffc9c9',
  violet: '#d0bfff',
  orange: '#ffd8a8',
  gray: '#e9ecef',
} as const
export type ColorName = keyof typeof COLORS

export function colorName(background: string): string {
  for (const [name, value] of Object.entries(COLORS)) if (value === background.toLowerCase()) return name
  return background
}

export function randomInt(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** An ID for elements the agent does not name, such as a card's text; as long as the canvas's own. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(21)), (n) => ID_ALPHABET[n % ID_ALPHABET.length]).join('')
}

export function maestrlyData(element: BoardElement): MaestrlyData {
  const data = element.customData?.maestrly
  return typeof data === 'object' && data !== null ? (data as MaestrlyData) : {}
}

export function withMaestrlyData(element: BoardElement, data: MaestrlyData): Record<string, unknown> {
  return { ...element.customData, maestrly: { ...maestrlyData(element), ...data } }
}

export const isShape = (element: BoardElement): boolean => (SHAPE_TYPES as readonly string[]).includes(element.type)
export const isFrame = (element: BoardElement): boolean => element.type === 'frame' || element.type === 'magicframe'
export const isBoundText = (element: BoardElement): boolean => element.type === 'text' && !!element.containerId
/** What an arrow may start or end at. */
export const isBindable = (element: BoardElement): boolean =>
  isShape(element) || isFrame(element) || element.type === 'image' || (element.type === 'text' && !element.containerId)

interface Common {
  id: string
  x: number
  y: number
  width: number
  height: number
  index: string | null
  now: number
  frameId?: string | null
}

function base(type: ElementType, common: Common): BoardElement {
  return {
    id: common.id,
    type,
    x: common.x,
    y: common.y,
    width: common.width,
    height: common.height,
    angle: 0,
    strokeColor: STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    index: common.index,
    isDeleted: false,
    groupIds: [],
    frameId: common.frameId ?? null,
    boundElements: null,
    updated: common.now,
    link: null,
    locked: false,
    customData: { maestrly: { by: 'agent' } satisfies MaestrlyData },
  }
}

export function newShape(type: ShapeType, common: Common, background: string): BoardElement {
  return {
    ...base(type, common),
    backgroundColor: background,
    roundness: { type: type === 'rectangle' ? ROUNDNESS_ADAPTIVE : ROUNDNESS_PROPORTIONAL },
  }
}

export function newFrame(common: Common, name: string): BoardElement {
  return { ...base('frame', common), name, strokeWidth: 2, roughness: 0, frameId: null }
}

export function newText(
  common: Common,
  text: string,
  options: { containerId?: string; fontSize?: number; align?: 'left' | 'center' } = {}
): BoardElement {
  return {
    ...base('text', common),
    text,
    originalText: text,
    fontSize: options.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: FONT_EXCALIFONT,
    textAlign: options.align ?? (options.containerId ? 'center' : 'left'),
    verticalAlign: options.containerId ? 'middle' : 'top',
    containerId: options.containerId ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  }
}

export function newArrow(
  common: Common,
  points: readonly Point[],
  options: { start: Binding | null; end: Binding | null; dashed: boolean; head: boolean }
): BoardElement {
  return {
    ...base('arrow', common),
    points,
    lastCommittedPoint: null,
    startBinding: options.start,
    endBinding: options.end,
    startArrowhead: null,
    endArrowhead: options.head ? 'arrow' : null,
    elbowed: false,
    strokeStyle: options.dashed ? 'dashed' : 'solid',
    roundness: { type: ROUNDNESS_PROPORTIONAL },
  }
}

/** A changed copy of an element: a new version with a fresh nonce, as Excalidraw's own edits make. */
export function bump(element: BoardElement, changes: Partial<BoardElement>, now: number): BoardElement {
  return { ...element, ...changes, version: element.version + 1, versionNonce: randomInt(), updated: now }
}
