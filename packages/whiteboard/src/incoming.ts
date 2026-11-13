import { z } from 'zod'
import { type BoardElement, ELEMENT_TYPES } from './elements.js'
import { ELEMENT_ID } from './ops.js'

export const MAX_BOARD_ELEMENTS = 10_000
/** A long freehand stroke is the largest element a person draws. */
export const MAX_ELEMENT_BYTES = 192 * 1024
export const MAX_BATCH_ELEMENTS = 1000

const coordinate = z.number().min(-10_000_000).max(10_000_000)
const elementId = z.string().regex(ELEMENT_ID)
const binding = z.looseObject({ elementId, focus: z.number().min(-2).max(2), gap: z.number().min(-1000).max(1000) })
const point = z.tuple([coordinate, coordinate])
/** Links the canvas opens: web pages, mail, and links to other elements on the board. */
const SAFE_LINK = /^(?:https?:\/\/|mailto:|#)/i

/**
 * An element as a canvas sends it. Canvases are untrusted, guests' included: the fields the host and the agent read
 * are checked and bounded, and fields this version does not know pass through for the canvas to keep.
 */
const elementSchema = z.looseObject({
  id: elementId,
  type: z.enum(ELEMENT_TYPES),
  x: coordinate,
  y: coordinate,
  width: coordinate,
  height: coordinate,
  angle: z.number().min(-10).max(10),
  strokeColor: z.string().max(64),
  backgroundColor: z.string().max(64),
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']),
  strokeWidth: z.number().min(0).max(100),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']),
  roughness: z.number().min(0).max(10),
  opacity: z.number().min(0).max(100),
  roundness: z.looseObject({ type: z.number().int(), value: z.number().optional() }).nullable(),
  seed: z.number().int(),
  updated: z.number(),
  locked: z.boolean(),
  version: z
    .number()
    .int()
    .min(1)
    .max(2 ** 31),
  versionNonce: z
    .number()
    .int()
    .min(-(2 ** 31))
    .max(2 ** 32),
  index: z
    .string()
    .regex(/^[0-9A-Za-z]{1,64}$/)
    .nullable(),
  isDeleted: z.boolean(),
  groupIds: z.array(z.string().max(64)).max(32),
  frameId: elementId.nullable(),
  boundElements: z
    .array(z.looseObject({ id: elementId, type: z.enum(['arrow', 'text']) }))
    .max(500)
    .nullable(),
  link: z.string().max(2048).regex(SAFE_LINK).nullable(),
  text: z.string().max(20_000).optional(),
  originalText: z.string().max(20_000).optional(),
  containerId: elementId.nullable().optional(),
  name: z.string().max(500).nullable().optional(),
  points: z.array(point).max(20_000).optional(),
  startBinding: binding.nullable().optional(),
  endBinding: binding.nullable().optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
})

export type IncomingResult = { ok: true; elements: BoardElement[] } | { ok: false; reason: 'invalid' | 'too_large' }

// Both Node and browsers have it; the package is typed without either's library.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }
const encoder = new TextEncoder()

export function parseIncoming(value: unknown): IncomingResult {
  if (!Array.isArray(value) || value.length > MAX_BATCH_ELEMENTS) return { ok: false, reason: 'too_large' }
  const elements: BoardElement[] = []
  for (const item of value) {
    const parsed = elementSchema.safeParse(item)
    if (!parsed.success) return { ok: false, reason: 'invalid' }
    if (encoder.encode(JSON.stringify(parsed.data)).byteLength > MAX_ELEMENT_BYTES)
      return { ok: false, reason: 'too_large' }
    // Checked above for every field the host reads; the rest is the canvas's own.
    elements.push(parsed.data as unknown as BoardElement)
  }
  return { ok: true, elements }
}
