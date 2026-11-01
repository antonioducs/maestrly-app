/**
 * Small JSON Schema readers shared by the tool-call robustness layer. They understand the structural vocabulary that
 * tool schemas use (types, enum/const, properties/items, unions, nullable and same-document `$ref`) and ignore the
 * rest. They never validate deeply: the tool's own validator stays the authority.
 */

export type JsonSchema = Record<string, unknown>
export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

/** Bound for every recursive walk over a schema or a value. */
export const MAX_SCHEMA_DEPTH = 64

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonKind(value: unknown): JsonKind | null {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const kind = typeof value
  if (kind === 'number') return Number.isFinite(value) ? 'number' : null
  return kind === 'string' || kind === 'boolean' || kind === 'object' ? kind : null
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((entry, index) => deepEqual(entry, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** Resolves a same-document reference such as `#`, `#/$defs/Node` or `#/properties/a/items`. */
export function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    const segment = decodePointerSegment(decodeURIComponent(raw))
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isRecord(current)) current = Object.hasOwn(current, segment) ? current[segment] : undefined
    else return undefined
    if (current === undefined) return undefined
  }
  return current
}

/**
 * Follows a chain of local `$ref`s. Sibling keywords of the reference are kept where the target does not define them.
 * An unresolvable or cyclic chain returns `undefined`, which callers read as "unconstrained".
 */
export function derefSchema(schema: unknown, root: unknown): JsonSchema | boolean | undefined {
  let current = schema
  const seen = new Set<unknown>()
  for (let hops = 0; hops < MAX_SCHEMA_DEPTH; hops++) {
    if (typeof current === 'boolean') return current
    if (!isRecord(current)) return undefined
    const ref = current.$ref
    if (typeof ref !== 'string') return current
    if (seen.has(current)) return undefined
    seen.add(current)
    const target = resolveLocalRef(root, ref)
    if (target === undefined) return undefined
    const { $ref: _ref, ...siblings } = current
    if (typeof target === 'boolean') return Object.keys(siblings).length ? siblings : target
    current = Object.keys(siblings).length ? { ...siblings, ...target } : target
  }
  return undefined
}

/** Union branches of a schema node (`anyOf` wins over `oneOf`, as most validators read them). */
export function unionBranches(schema: JsonSchema): unknown[] | null {
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return schema.anyOf
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return schema.oneOf
  return null
}

/**
 * Declared types of a node, with `integer` kept apart from `number`. A node without `type` that only describes an
 * object or an array is read as that type. `null` means the node does not constrain the type.
 */
export function declaredTypes(schema: JsonSchema): Set<string> | null {
  const types = new Set<string>()
  if (typeof schema.type === 'string') types.add(schema.type)
  else if (Array.isArray(schema.type)) for (const type of schema.type) if (typeof type === 'string') types.add(type)
  if (types.size === 0) {
    if (isRecord(schema.properties) || isRecord(schema.additionalProperties)) types.add('object')
    else if (schema.items !== undefined || Array.isArray(schema.prefixItems)) types.add('array')
  }
  if (types.size === 0) return null
  if (schema.nullable === true) types.add('null')
  return types
}

export function typeAcceptsValue(types: ReadonlySet<string>, value: unknown): boolean {
  const kind = jsonKind(value)
  if (kind === null) return false
  if (kind === 'number') return types.has('number') || (types.has('integer') && Number.isInteger(value))
  return types.has(kind)
}

/**
 * Whether a node accepts the value's kind at this level: type, enum/const and unions. Children are not inspected, so
 * `{ type: 'object' }` accepts any object. Unknown or unconstrained nodes accept everything.
 */
export function acceptsShallow(schema: unknown, value: unknown, root: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return true
  const node = derefSchema(schema, root)
  if (node === undefined || node === true) return true
  if (node === false) return false
  if (Object.hasOwn(node, 'const')) return deepEqual(node.const, value)
  if (Array.isArray(node.enum)) {
    if (node.enum.some((entry) => deepEqual(entry, value))) return true
    return node.nullable === true && value === null
  }
  const branches = unionBranches(node)
  if (branches && !branches.some((branch) => acceptsShallow(branch, value, root, depth + 1))) return false
  if (Array.isArray(node.allOf) && !node.allOf.every((branch) => acceptsShallow(branch, value, root, depth + 1))) {
    return false
  }
  const types = declaredTypes(node)
  return types === null || typeAcceptsValue(types, value)
}

/** Whether a node could accept `null` (used to tell a placeholder null from a meaningful one). */
export function acceptsNull(schema: unknown, root: unknown): boolean {
  return acceptsShallow(schema, null, root)
}
