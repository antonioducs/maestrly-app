// Guards for model-written programs, which run in the renderer that holds the preload API. Not in OpenUI: its
// evaluator read fields with `obj[field]` (so `"".constructor` reached Function) and built objects with `o[k] = v`
// (so a `__proto__` key replaced the prototype).

const BLOCKED_FIELDS = new Set(['__proto__', 'constructor', 'prototype'])

/** A field a program may read: own data of a plain value, never anything reached through a prototype. */
export function readField(value: unknown, field: string): unknown {
  if (value == null || BLOCKED_FIELDS.has(field)) return null
  if (typeof value === 'string') {
    if (field === 'length') return value.length
    return /^\d+$/.test(field) ? (value[Number(field)] ?? null) : null
  }
  if (typeof value !== 'object') return null
  if (Array.isArray(value) && field === 'length') return value.length
  if (!Object.hasOwn(value, field)) return null
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  return descriptor && 'value' in descriptor ? (descriptor.value ?? null) : null
}

/** `a.b.c` read with readField at every step. */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return null
  let current = value
  for (const field of path.split('.')) {
    if (current == null) return null
    current = readField(current, field)
  }
  return current
}

/** Sets an own data field: a `__proto__` key becomes plain data instead of the prototype. */
export function writeField(target: Record<string, unknown>, field: string, value: unknown): void {
  Object.defineProperty(target, field, { value, enumerable: true, writable: true, configurable: true })
}

/** Text of a value for concatenation; an object never runs its own conversion. */
export function toText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return ''
    }
  }
  return String(value)
}

/** Thrown when a program needs more work than any interface should: nested refs or loops that grow exponentially. */
export class GenUiLimitError extends Error {
  constructor(what: string) {
    super(`The interface ${what} exceeds the work limit`)
    this.name = 'GenUiLimitError'
  }
}

/** Steps one parse or one render may take before it stops with GenUiLimitError. */
export interface Budget {
  left: number
  readonly what: string
}

export const PARSE_STEPS = 50_000
export const RENDER_STEPS = 200_000

export function createBudget(steps: number, what: string): Budget {
  return { left: steps, what }
}

export function spend(budget: Budget | undefined): void {
  if (budget && --budget.left < 0) throw new GenUiLimitError(budget.what)
}
