/**
 * Repairs the two ways models most often break tool arguments: malformed JSON text and values of the wrong JSON type.
 *
 * Both repairs are conservative. JSON is repaired only after `JSON.parse` fails, and a text that ends inside a string
 * (a cut-off call) is never completed. Coercion only touches a value the schema does not accept at that position, so
 * a value that is already valid is returned as the same reference.
 *
 * The rules are adapted from the designs of Hermes Agent (`tools/arg_coercion.py`, `message_sanitization.py`),
 * OpenCode (`tool-input-repair.ts`) and OpenClaw (`llm-core` validation); no code is copied.
 */
import {
  acceptsShallow,
  declaredTypes,
  deepEqual,
  derefSchema,
  isRecord,
  MAX_SCHEMA_DEPTH,
  typeAcceptsValue,
  unionBranches,
  type JsonSchema,
} from './json-schema-utils'

// ---- JSON text repair ----

export type ParsedToolArguments =
  | { ok: true; value: unknown; repaired: boolean }
  | { ok: false; reason: 'truncated' | 'multiple' | 'invalid'; message: string }

const FENCE = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/
const WORD = /[A-Za-z_]/
const WORD_CHAR = /[A-Za-z0-9_]/
const WHITESPACE = /\s/
const PYTHON_LITERALS: Record<string, string> = { True: 'true', False: 'false', None: 'null' }
/** Characters after which a missing closer can be added without inventing a value. */
const VALUE_END = /["\d}\]el]$/

interface ScanResult {
  text: string
  inString: boolean
  open: string[]
  last: string
  extraValue: boolean
}

function escapeControl(ch: string): string {
  if (ch === '\n') return '\\n'
  if (ch === '\r') return '\\r'
  if (ch === '\t') return '\\t'
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
}

/**
 * One pass that fixes what does not change meaning: raw control characters inside strings, Python literals outside
 * them, trailing commas, stray or excess closers, and closers missing inside the text (`{"a":[1}`).
 */
function scan(source: string): ScanResult {
  let text = ''
  const open: string[] = []
  let inString = false
  let escaped = false
  let done = false
  let extraValue = false
  let last = ''
  for (let index = 0; index < source.length; index++) {
    const ch = source[index]
    if (inString) {
      if (escaped) {
        text += ch
        escaped = false
      } else if (ch === '\\') {
        text += ch
        escaped = true
      } else if (ch === '"') {
        text += ch
        inString = false
        last = '"'
      } else {
        text += ch.charCodeAt(0) < 0x20 ? escapeControl(ch) : ch
      }
      continue
    }
    if (done) {
      if (WHITESPACE.test(ch) || ch === '}' || ch === ']') continue
      extraValue = true
      break
    }
    if (ch === '"') {
      inString = true
      text += ch
      continue
    }
    if (ch === '{' || ch === '[') {
      open.push(ch === '{' ? '}' : ']')
      text += ch
      last = ch
      continue
    }
    if (ch === '}' || ch === ']') {
      const level = open.lastIndexOf(ch)
      if (level === -1) continue
      text = text.replace(/,\s*$/, '')
      while (open.length > level) text += open.pop()
      last = ch
      if (open.length === 0) done = true
      continue
    }
    if (WORD.test(ch)) {
      let end = index
      while (end < source.length && WORD_CHAR.test(source[end])) end++
      const word = source.slice(index, end)
      const mapped = PYTHON_LITERALS[word] ?? word
      text += mapped
      last = mapped[mapped.length - 1]
      index = end - 1
      if (open.length === 0) done = true
      continue
    }
    text += ch
    if (!WHITESPACE.test(ch)) last = ch
  }
  return { text, inString, open, last, extraValue }
}

function excerpt(text: string, tail = true): string {
  const limit = 160
  if (text.length <= limit) return JSON.stringify(text)
  return tail ? `…${JSON.stringify(text.slice(-limit))}` : `${JSON.stringify(text.slice(0, limit))}…`
}

function truncatedMessage(text: string): string {
  return (
    'The arguments of this tool call were cut off before they were complete, so the call was not executed. ' +
    `Received ${text.length} characters ending with ${excerpt(text)}. If the content is large, split it into ` +
    'smaller pieces and call the tool again with complete arguments.'
  )
}

/**
 * Parses tool-call arguments, repairing common malformations. An empty text is an empty object. The result says
 * whether a repair was needed; a failure carries a message written for the model.
 */
export function parseToolArguments(text: string): ParsedToolArguments {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: {}, repaired: true }
  try {
    return { ok: true, value: JSON.parse(text), repaired: false }
  } catch {
    // Repaired below.
  }
  const fence = FENCE.exec(trimmed)
  const body = fence ? fence[1].trim() : trimmed
  if (body === '') return { ok: true, value: {}, repaired: true }
  const scanned = scan(body)
  if (scanned.extraValue) {
    return {
      ok: false,
      reason: 'multiple',
      message:
        'The arguments of this tool call hold several JSON values, so the call was not executed. ' +
        'Call the tool once for each set of arguments, each with a single JSON object.',
    }
  }
  if (scanned.inString) return { ok: false, reason: 'truncated', message: truncatedMessage(body) }
  let candidate = scanned.text
  if (scanned.open.length > 0) {
    if (!VALUE_END.test(scanned.last)) return { ok: false, reason: 'truncated', message: truncatedMessage(body) }
    candidate += [...scanned.open].reverse().join('')
  }
  try {
    return { ok: true, value: JSON.parse(candidate), repaired: true }
  } catch (error) {
    if (scanned.open.length > 0) return { ok: false, reason: 'truncated', message: truncatedMessage(body) }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: 'invalid',
      message:
        `The arguments of this tool call are not valid JSON (${detail}), so the call was not executed. ` +
        `Received ${excerpt(body, false)}. Call the tool again with a single valid JSON object.`,
    }
  }
}

function looksLikeJsonContainer(value: string): boolean {
  const start = value.trimStart()[0]
  return start === '{' || start === '['
}

/** Parses a string that should hold an array or object, unwrapping one level of double encoding. */
function parseJsonContainer(value: string): unknown {
  let text = value
  if (text.trimStart().startsWith('"')) {
    try {
      const inner: unknown = JSON.parse(text)
      if (typeof inner !== 'string') return undefined
      text = inner
    } catch {
      return undefined
    }
  }
  if (!looksLikeJsonContainer(text)) return undefined
  const parsed = parseToolArguments(text)
  if (!parsed.ok) return undefined
  if (typeof parsed.value === 'string' && looksLikeJsonContainer(parsed.value)) {
    const inner = parseToolArguments(parsed.value)
    return inner.ok ? inner.value : undefined
  }
  return parsed.value
}

// ---- Schema-guided coercion ----

const NONE = Symbol('no-conversion')
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function parseNumber(value: string, integer: boolean): number | typeof NONE {
  const trimmed = value.trim()
  if (!NUMERIC.test(trimmed)) return NONE
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return NONE
  if (integer && !Number.isSafeInteger(parsed)) return NONE
  return parsed
}

function parseBoolean(value: string): boolean | typeof NONE {
  const lowered = value.trim().toLowerCase()
  return lowered === 'true' ? true : lowered === 'false' ? false : NONE
}

/** Maps a value onto an enum/const set: case-insensitive strings and the string form of numbers and booleans. */
function coerceLiteral(values: readonly unknown[], value: unknown, nullable: boolean): unknown {
  if (values.some((entry) => deepEqual(entry, value)) || (nullable && value === null)) return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    const matches = values.filter((entry) => typeof entry === 'string' && entry.toLowerCase() === lowered)
    if (matches.length === 1) return matches[0]
    if (lowered === 'null' && values.includes(null)) return null
    const number = parseNumber(value, false)
    if (number !== NONE && values.includes(number)) return number
    const boolean = parseBoolean(value)
    if (boolean !== NONE && values.includes(boolean)) return boolean
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value)
    if (values.includes(text)) return text
  }
  return value
}

function itemSchemaAt(node: JsonSchema, index: number): unknown {
  if (Array.isArray(node.prefixItems)) {
    return index < node.prefixItems.length ? node.prefixItems[index] : node.items
  }
  if (Array.isArray(node.items)) return index < node.items.length ? node.items[index] : node.additionalItems
  return node.items
}

/** Converts a value the node's types reject into one they accept, or returns NONE. */
function convertKind(
  value: unknown,
  types: ReadonlySet<string>,
  node: JsonSchema,
  root: unknown,
  depth: number
): unknown {
  if (typeof value === 'string') {
    if (types.has('null') && value.trim().toLowerCase() === 'null') return null
    if (types.has('integer') || types.has('number')) {
      const number = parseNumber(value, !types.has('number'))
      if (number !== NONE && typeAcceptsValue(types, number)) return number
    }
    if (types.has('boolean')) {
      const boolean = parseBoolean(value)
      if (boolean !== NONE) return boolean
    }
    if (types.has('array') || types.has('object')) {
      const parsed = parseJsonContainer(value)
      if (parsed !== undefined && typeAcceptsValue(types, parsed)) return parsed
      if (looksLikeJsonContainer(value)) return NONE
    }
  }
  if ((typeof value === 'number' || typeof value === 'boolean') && types.has('string')) return String(value)
  if (types.has('array') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    const items = itemSchemaAt(node, 0)
    const item = coerceNode(items, value, root, depth + 1)
    if (acceptsShallow(items, item, root)) return [item]
  }
  return NONE
}

function snakeToCamel(key: string): string {
  return key.replace(/[_-]+([a-zA-Z0-9])/g, (_match, ch: string) => ch.toUpperCase())
}

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function matchesPatternProperty(node: JsonSchema, key: string): boolean {
  if (!isRecord(node.patternProperties)) return false
  return Object.keys(node.patternProperties).some((pattern) => {
    try {
      return new RegExp(pattern, 'u').test(key)
    } catch {
      return false
    }
  })
}

function coerceObject(
  node: JsonSchema,
  value: Record<string, unknown>,
  root: unknown,
  depth: number
): Record<string, unknown> {
  const properties = isRecord(node.properties) ? node.properties : {}
  const required = new Set(Array.isArray(node.required) ? node.required.filter((key) => typeof key === 'string') : [])
  let out: Record<string, unknown> | undefined
  const write = () => (out ??= { ...value })

  // `old_string` for `oldString`: the most common slip of models trained on other harnesses.
  if (Object.keys(properties).length > 0) {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key) || matchesPatternProperty(node, key)) continue
      const targets = [...new Set([snakeToCamel(key), camelToSnake(key)])].filter(
        (target) => target !== key && Object.hasOwn(properties, target) && !Object.hasOwn(out ?? value, target)
      )
      if (targets.length !== 1) continue
      const target = write()
      target[targets[0]] = target[key]
      delete target[key]
    }
  }

  const source = out ?? value
  for (const key of Object.keys(source)) {
    const entry = source[key]
    const declared = Object.hasOwn(properties, key)
    const schema = declared
      ? properties[key]
      : isRecord(node.additionalProperties)
        ? node.additionalProperties
        : undefined
    if (schema === undefined) continue
    // `null` or `""` for an optional parameter the model did not mean to set.
    if (
      declared &&
      (entry === null || entry === '') &&
      !required.has(key) &&
      !acceptsShallow(schema, entry, root, depth + 1)
    ) {
      delete write()[key]
      continue
    }
    const coerced = coerceNode(schema, entry, root, depth + 1)
    if (coerced !== entry) write()[key] = coerced
  }
  return out ?? value
}

function coerceArray(node: JsonSchema, value: unknown[], root: unknown, depth: number): unknown[] {
  let out: unknown[] | undefined
  value.forEach((entry, index) => {
    const schema = itemSchemaAt(node, index)
    if (schema === undefined) return
    const coerced = coerceNode(schema, entry, root, depth + 1)
    if (coerced !== entry) (out ??= [...value])[index] = coerced
  })
  return out ?? value
}

function coerceNode(raw: unknown, value: unknown, root: unknown, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return value
  const node = derefSchema(raw, root)
  if (!isRecord(node)) return value
  let current = value
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) current = coerceNode(branch, current, root, depth + 1)
  }
  if (Object.hasOwn(node, 'const')) return coerceLiteral([node.const], current, false)
  if (Array.isArray(node.enum)) return coerceLiteral(node.enum, current, node.nullable === true)
  const branches = unionBranches(node)
  if (branches) {
    const accepting = branches.find((branch) => acceptsShallow(branch, current, root, depth + 1))
    if (accepting !== undefined) {
      current = coerceNode(accepting, current, root, depth + 1)
    } else {
      for (const branch of branches) {
        const coerced = coerceNode(branch, current, root, depth + 1)
        if (coerced !== current && acceptsShallow(branch, coerced, root, depth + 1)) {
          current = coerced
          break
        }
      }
    }
    if (declaredTypes(node) === null) return current
  }
  const types = declaredTypes(node)
  if (types === null) return current
  if (!typeAcceptsValue(types, current)) {
    const converted = convertKind(current, types, node, root, depth)
    if (converted === NONE) return current
    current = converted
  }
  if (Array.isArray(current)) return coerceArray(node, current, root, depth)
  if (isRecord(current)) return coerceObject(node, current, root, depth)
  return current
}

/**
 * Restores the JSON types a schema asks for. Models, and runtimes that pass arguments through untyped layers, send
 * `"limit": "50"`, `"tags": "[\"a\"]"`, a whole argument object encoded as a string, or `old_string` for `oldString`.
 * A value the schema already accepts stays as it is, and one that cannot be converted is left for the validator to
 * reject. Returns the same reference when nothing changed.
 */
export function coerceToolInput(schema: unknown, value: unknown): unknown {
  return coerceNode(schema, value, schema, 0)
}
