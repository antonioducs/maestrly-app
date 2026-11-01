/**
 * Provider dialects of JSON Schema. Only the copy of a tool schema sent to the provider changes: validation keeps
 * using the original schema, and the lenient input layer coerces whatever difference a dialect introduces.
 *
 * The transforms address documented rejections and follow OpenCode (`tool-schema.ts`, `gemini-json-schema.ts`) and
 * OpenClaw (`clean-for-gemini.ts`, provider compat families); no code is copied. Keep each dialect minimal: a new
 * transform needs evidence of a provider rejecting the schema.
 */
import { isRecord, MAX_SCHEMA_DEPTH, resolveLocalRef, type JsonSchema } from './json-schema-utils'

export type SchemaDialect = 'gemini' | 'moonshot' | 'xai' | 'llamacpp'

export interface SchemaDialectTarget {
  transport: string
  baseURL: string
  modelId: string
  /** Managed Grok subscription, which reaches xAI through its own endpoint. */
  grok?: boolean
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

function isPrivateHost(host: string): boolean {
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true
  if (host === 'host.docker.internal') return true
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  }
  const [a, b] = octets
  return (
    a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  )
}

/** Vertex AI: the global endpoint or a regional one (`us-central1-aiplatform.googleapis.com`). */
const VERTEX_AI_HOST = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?aiplatform\.googleapis\.com$/

/** Picks the dialect for one request; Anthropic and OpenAI Responses take the original schema. */
export function selectSchemaDialect(target: SchemaDialectTarget): SchemaDialect | null {
  if (target.transport === 'anthropic' || target.transport === 'openai-responses') return null
  const host = hostOf(target.baseURL)
  const model = target.modelId.toLowerCase()
  if (target.grok || host === 'api.x.ai' || host.endsWith('.x.ai')) return 'xai'
  if (host === 'generativelanguage.googleapis.com' || VERTEX_AI_HOST.test(host)) return 'gemini'
  if (/^api\.moonshot\./.test(host)) return 'moonshot'
  if (isPrivateHost(host)) return 'llamacpp'
  if (/(^|[/:])gemini/.test(model)) return 'gemini'
  if (/kimi|moonshot/.test(model)) return 'moonshot'
  return null
}

// ---- Generic walker ----

const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const
const SCHEMA_SINGLES = [
  'additionalProperties',
  'additionalItems',
  'unevaluatedItems',
  'unevaluatedProperties',
  'not',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
] as const
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const

/** Applies `fn` to the direct subschemas of a node; property names are never treated as keywords. */
function mapChildren(node: JsonSchema, fn: (child: unknown) => unknown, includeDefs = true): JsonSchema {
  let out: JsonSchema | undefined
  const set = (key: string, value: unknown) => {
    if (value === node[key]) return
    out ??= { ...node }
    out[key] = value
  }
  for (const key of SCHEMA_MAPS) {
    const map = node[key]
    if (!isRecord(map) || (!includeDefs && (key === '$defs' || key === 'definitions'))) continue
    let changed: JsonSchema | undefined
    for (const [name, child] of Object.entries(map)) {
      const mapped = fn(child)
      if (mapped !== child) (changed ??= { ...map })[name] = mapped
    }
    if (changed) set(key, changed)
  }
  for (const key of SCHEMA_SINGLES) if (isRecord(node[key])) set(key, fn(node[key]))
  for (const key of [...SCHEMA_LISTS, 'items'] as const) {
    const list = node[key]
    if (key === 'items' && isRecord(list)) {
      set(key, fn(list))
      continue
    }
    if (!Array.isArray(list)) continue
    const mapped = list.map(fn)
    if (mapped.some((child, index) => child !== list[index])) set(key, mapped)
  }
  return out ?? node
}

/** Rewrites every subschema bottom-up. Never mutates the input; untouched nodes keep their references. */
function mapSchema(node: unknown, visit: (schema: JsonSchema) => JsonSchema, depth = 0): unknown {
  if (!isRecord(node) || depth > MAX_SCHEMA_DEPTH) return node
  return visit(mapChildren(node, (child) => mapSchema(child, visit, depth + 1)))
}

function withoutKeys(schema: JsonSchema, keys: readonly string[]): JsonSchema {
  if (!keys.some((key) => Object.hasOwn(schema, key))) return schema
  const out = { ...schema }
  for (const key of keys) delete out[key]
  return out
}

// ---- Shared transforms ----

const MAX_INLINE_DEPTH = 24

/**
 * Replaces same-document `$ref`s with their targets and drops `$defs`/`definitions`. A reference back into the chain
 * being inlined (a recursive type) or past the depth bound becomes an unconstrained `{}`, keeping its description.
 */
export function inlineLocalRefs(root: unknown): unknown {
  if (!isRecord(root)) return root
  const expand = (node: unknown, stack: readonly string[], depth: number): unknown => {
    if (!isRecord(node) || depth > MAX_SCHEMA_DEPTH) return node
    if (typeof node.$ref === 'string') {
      const { $ref: ref, ...siblings } = node as JsonSchema & { $ref: string }
      const target = ref.startsWith('#') ? resolveLocalRef(root, ref) : undefined
      if (!isRecord(target) || stack.includes(ref) || stack.length >= MAX_INLINE_DEPTH) {
        // External, unresolved or recursive: keep what describes the parameter, drop the reference.
        return withoutKeys(siblings, ['$defs', 'definitions'])
      }
      const expanded = expand(target, [...stack, ref], depth + 1) as JsonSchema
      return { ...withoutKeys(expanded, ['$defs', 'definitions']), ...siblings }
    }
    return mapChildren(node, (child) => expand(child, stack, depth + 1), false)
  }
  return withoutKeys(expand(root, [], 0) as JsonSchema, ['$defs', 'definitions'])
}

type LiteralKind = 'string' | 'number' | 'integer' | 'boolean' | 'null'

function literalKind(value: unknown): LiteralKind | null {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value as LiteralKind
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? 'integer' : 'number'
  return null
}

/** The single JSON type shared by a list of literals (`integer` widens to `number` when mixed), or null. */
function sharedLiteralType(values: readonly unknown[]): Exclude<LiteralKind, 'null'> | null {
  const kinds = new Set(values.map(literalKind))
  if (kinds.has(null) || kinds.has('null') || kinds.size === 0) return null
  if (kinds.size === 1) return [...kinds][0] as Exclude<LiteralKind, 'null'>
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('number')) return 'number'
  return null
}

// ---- Gemini ----

/** The literal values of a union branch (`{const}` or `{enum}`), or null for any other branch. */
function branchLiterals(branch: unknown): unknown[] | null {
  if (!isRecord(branch)) return null
  const keys = Object.keys(branch).filter((key) => key !== 'type' && key !== 'description' && key !== 'title')
  if (keys.length !== 1) return null
  if (keys[0] === 'const') return [branch.const]
  if (keys[0] === 'enum' && Array.isArray(branch.enum) && branch.enum.length) return branch.enum
  return null
}

function geminiNode(schema: JsonSchema): JsonSchema {
  let node = schema
  if (Object.hasOwn(node, 'const')) {
    const { const: value, ...rest } = node
    node = { ...rest, enum: [value] }
  }
  if (Array.isArray(node.items)) {
    const { items, additionalItems, ...rest } = node
    node = { ...rest, prefixItems: items }
    if (isRecord(additionalItems)) node.items = additionalItems
  }
  if (isRecord(node.properties) && Array.isArray(node.required)) {
    const properties = node.properties
    const required = node.required.filter((key) => typeof key === 'string' && Object.hasOwn(properties, key))
    if (required.length !== node.required.length) node = { ...node, required }
  } else if (Array.isArray(node.required) && !isRecord(node.properties)) {
    node = withoutKeys(node, ['required'])
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    const literals = branches.map(branchLiterals)
    if (literals.some((values) => values === null)) continue
    const values = literals.flat()
    const type = sharedLiteralType(values)
    if (!type) continue
    const { [key]: _union, ...rest } = node
    node = { ...rest, type, enum: [...new Set(values)] }
  }
  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (typeof node[flag] !== 'boolean') continue
    const { [flag]: exclusive, [bound]: limit, ...rest } = node
    node =
      exclusive && typeof limit === 'number'
        ? { ...rest, [flag]: limit }
        : { ...rest, ...(limit !== undefined ? { [bound]: limit } : {}) }
  }
  return node
}

function ensureObjectRoot(schema: unknown): JsonSchema {
  const root = isRecord(schema) ? schema : {}
  if (root.type !== undefined && root.type !== 'object') return root
  if (root.type === 'object' && isRecord(root.properties)) return root
  return { ...root, type: 'object', properties: isRecord(root.properties) ? root.properties : {} }
}

export function toGeminiSchema(schema: unknown): JsonSchema {
  return ensureObjectRoot(mapSchema(inlineLocalRefs(schema), geminiNode))
}

// ---- Moonshot (Kimi) ----

function moonshotNode(schema: JsonSchema): JsonSchema {
  let node = schema
  if (Array.isArray(node.enum) && node.type === undefined) {
    const type = sharedLiteralType(node.enum.filter((value) => value !== null))
    if (type) node = { ...node, type: node.enum.includes(null) ? [type, 'null'] : type }
  }
  const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : null
  if (tuple) {
    const rest = Array.isArray(node.prefixItems) ? node.items : node.additionalItems
    const options = [...tuple, ...(isRecord(rest) ? [rest] : [])]
    const { prefixItems: _prefix, additionalItems: _additional, items: _items, ...others } = node
    node = { ...others, items: options.length === 0 ? {} : options.length === 1 ? options[0] : { anyOf: options } }
  }
  return node
}

export function toMoonshotSchema(schema: unknown): JsonSchema {
  return ensureObjectRoot(mapSchema(inlineLocalRefs(schema), moonshotNode))
}

// ---- xAI and llama.cpp ----

export function toXaiSchema(schema: unknown): JsonSchema {
  return mapSchema(schema, (node) => withoutKeys(node, ['minContains', 'maxContains'])) as JsonSchema
}

/** Long string bounds and regex patterns overflow llama.cpp's GBNF grammar conversion. */
export const LLAMACPP_MAX_LENGTH_LIMIT = 2000

export function toLlamaCppSchema(schema: unknown): JsonSchema {
  return mapSchema(schema, (node) => {
    let out = withoutKeys(node, ['pattern'])
    if (typeof out.maxLength === 'number' && out.maxLength >= LLAMACPP_MAX_LENGTH_LIMIT) {
      out = withoutKeys(out, ['maxLength'])
    }
    return out
  }) as JsonSchema
}

export function applySchemaDialect(schema: unknown, dialect: SchemaDialect): unknown {
  switch (dialect) {
    case 'gemini':
      return toGeminiSchema(schema)
    case 'moonshot':
      return toMoonshotSchema(schema)
    case 'xai':
      return toXaiSchema(schema)
    case 'llamacpp':
      return toLlamaCppSchema(schema)
  }
}
