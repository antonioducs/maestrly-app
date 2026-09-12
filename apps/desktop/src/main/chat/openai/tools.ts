import type { JSONSchema7, JSONSchema7Definition, JSONObject } from '@ai-sdk/provider'
import { openai } from '@ai-sdk/openai'
import { asSchema } from '@ai-sdk/provider-utils'
import { jsonSchema, type Tool, type ToolExecutionOptions, type ToolSet } from 'ai'

export interface OptimizeOpenAIToolsOptions {
  deferredToolNames?: Iterable<string>
  enableToolSearch?: boolean
  conversationId?: string
}

export interface OptimizedOpenAITools {
  tools: ToolSet
  scheduler: OpenAIToolScheduler
  strictToolNames: readonly string[]
  nonStrictToolNames: readonly string[]
  deferredToolNames: readonly string[]
  unknownDeferredToolNames: readonly string[]
  toolSearchEnabled: boolean
}

type GenericTool = Tool<any, any>

interface NormalizationPlan {
  properties?: Record<string, PropertyNormalizationPlan>
  items?: NormalizationPlan
}

interface PropertyNormalizationPlan {
  dropSyntheticNull: boolean
  nested?: NormalizationPlan
}

interface StrictSchemaResult {
  schema: JSONSchema7
  normalization: NormalizationPlan
}

type SchemaNodeResult =
  | { compatible: true; schema: JSONSchema7; normalization: NormalizationPlan }
  | { compatible: false }

const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasNormalization = (plan: NormalizationPlan): boolean =>
  plan.items != null || (plan.properties != null && Object.keys(plan.properties).length > 0)

const acceptsNull = (schema: JSONSchema7): boolean => {
  if (Object.hasOwn(schema, 'const') && schema.const !== null) return false
  if (schema.enum != null && !schema.enum.includes(null)) return false
  if (schema.type != null) {
    if (schema.type !== 'null' && !(Array.isArray(schema.type) && schema.type.includes('null'))) return false
  }
  if (schema.anyOf != null) {
    return schema.anyOf.some(
      (branch: JSONSchema7Definition) => branch === true || (branch !== false && acceptsNull(branch))
    )
  }
  if (schema.oneOf != null) {
    return (
      schema.oneOf.filter(
        (branch: JSONSchema7Definition) => branch === true || (branch !== false && acceptsNull(branch))
      ).length === 1
    )
  }
  if (schema.allOf != null) {
    return schema.allOf.every(
      (branch: JSONSchema7Definition) => branch === true || (branch !== false && acceptsNull(branch))
    )
  }
  return true
}

const nullableSchema = (schema: JSONSchema7): JSONSchema7 | null => {
  if (acceptsNull(schema)) return schema

  if (typeof schema.type === 'string') {
    return {
      ...schema,
      type: [schema.type, 'null'],
      ...(schema.enum != null ? { enum: [...schema.enum, null] } : {}),
    }
  }
  if (Array.isArray(schema.type)) {
    return {
      ...schema,
      type: [...schema.type, 'null'],
      ...(schema.enum != null ? { enum: [...schema.enum, null] } : {}),
    }
  }
  if (schema.enum != null) {
    return { ...schema, enum: [...schema.enum, null] }
  }

  // Producing `anyOf` here would make an unknown schema appear strict. If optionality cannot be expressed
  // with the simple subset accepted by function tools, preserve the non-strict contract.
  return null
}

/**
 * Strict function calling accepts only a subset of JSON Schema. Zod/Ajv annotations do not change local
 * validation; notably, the wire schema does not support `default`. Keep `description`, which is essential to
 * model-visible semantics; discard other metadata only from the provider-bound copy. The original schema remains
 * the source for validation and defaults.
 */
const stripStrictAnnotations = (input: JSONSchema7): JSONSchema7 => {
  const {
    $schema: _schema,
    $id: _id,
    $comment: _comment,
    title: _title,
    default: _default,
    examples: _examples,
    deprecated: _deprecated,
    readOnly: _readOnly,
    writeOnly: _writeOnly,
    const: constant,
    ...schema
  } = input
  // `enum` belongs to the documented Structured Outputs subset; `const` varies across validators/adapters.
  // A single-value enum preserves exactly the same semantics without relying on that wire keyword.
  return Object.hasOwn(input, 'const') ? { ...schema, enum: [constant] } : schema
}

const STRICT_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
])

const strictifyNode = (input: JSONSchema7): SchemaNodeResult => {
  if (Object.hasOwn(input, 'const') && input.enum != null && !input.enum.includes(input.const)) {
    return { compatible: false }
  }
  const sanitized = stripStrictAnnotations(input)
  // Refs, combinators, and keywords outside the conservative subset remain non-strict. This is preferable to
  // advertising `strict: true` and discovering incompatibility as an HTTP 400 only at runtime.
  if (Object.keys(sanitized).some((keyword) => !STRICT_SCHEMA_KEYS.has(keyword))) return { compatible: false }
  if (sanitized.additionalProperties != null && sanitized.additionalProperties !== false) {
    return { compatible: false }
  }
  if (sanitized.items === true || sanitized.items === false || Array.isArray(sanitized.items)) {
    return { compatible: false }
  }
  if (sanitized.type == null && sanitized.properties == null) return { compatible: false }
  const declaredTypes = sanitized.type == null ? [] : Array.isArray(sanitized.type) ? sanitized.type : [sanitized.type]
  const distinctTypes = [...new Set(declaredTypes)]
  if (
    distinctTypes.length !== declaredTypes.length ||
    (distinctTypes.length > 1 &&
      (distinctTypes.length !== 2 ||
        !distinctTypes.includes('null') ||
        distinctTypes.filter((type) => type !== 'null').length !== 1))
  ) {
    return { compatible: false }
  }
  if (sanitized.properties != null && distinctTypes.length > 0 && !distinctTypes.includes('object')) {
    return { compatible: false }
  }
  if (sanitized.items != null && !distinctTypes.includes('array')) return { compatible: false }
  if (distinctTypes.includes('array') && sanitized.items == null) return { compatible: false }

  const schema: JSONSchema7 = { ...sanitized }
  const normalization: NormalizationPlan = {}

  if (sanitized.properties != null || sanitized.type === 'object') {
    const properties = sanitized.properties ?? {}
    const originallyRequired = new Set(sanitized.required ?? [])
    const strictProperties: Record<string, JSONSchema7Definition> = {}
    const propertyPlans: Record<string, PropertyNormalizationPlan> = {}

    for (const name of Object.keys(properties).sort(compareNames)) {
      const property = properties[name]
      if (property === true || property === false) return { compatible: false }
      const converted = strictifyNode(property)
      if (!converted.compatible) return converted

      const required = originallyRequired.has(name)
      const wireSchema = required ? converted.schema : nullableSchema(converted.schema)
      if (wireSchema == null) return { compatible: false }
      strictProperties[name] = wireSchema
      if (!required || hasNormalization(converted.normalization)) {
        propertyPlans[name] = {
          dropSyntheticNull: !required && !acceptsNull(property),
          ...(hasNormalization(converted.normalization) ? { nested: converted.normalization } : {}),
        }
      }
    }

    schema.type ??= 'object'
    schema.properties = strictProperties
    schema.required = Object.keys(strictProperties).sort(compareNames)
    schema.additionalProperties = false
    if (Object.keys(propertyPlans).length > 0) normalization.properties = propertyPlans
  }

  if (sanitized.items != null) {
    const convertedItems = strictifyNode(sanitized.items)
    if (!convertedItems.compatible) return convertedItems
    schema.items = convertedItems.schema
    if (hasNormalization(convertedItems.normalization)) normalization.items = convertedItems.normalization
  }

  return { compatible: true, schema, normalization }
}

export function makeOpenAIFunctionSchemaStrict(schema: JSONSchema7): StrictSchemaResult | null {
  const rootIsObject = schema.type === 'object' || schema.properties != null
  if (!rootIsObject) return null
  const converted = strictifyNode(schema)
  return converted.compatible ? { schema: converted.schema, normalization: converted.normalization } : null
}

const normalizeValue = (value: unknown, plan: NormalizationPlan): unknown => {
  if (Array.isArray(value)) {
    return plan.items == null ? value : value.map((item) => normalizeValue(item, plan.items!))
  }
  if (!isRecord(value) || plan.properties == null) return value

  let output: Record<string, unknown> | undefined
  for (const [name, propertyPlan] of Object.entries(plan.properties)) {
    if (!Object.hasOwn(value, name)) continue
    const current = value[name]
    if (current === null && propertyPlan.dropSyntheticNull) {
      output ??= { ...value }
      delete output[name]
      continue
    }
    if (propertyPlan.nested != null) {
      const normalized = normalizeValue(current, propertyPlan.nested)
      if (normalized !== current) {
        output ??= { ...value }
        output[name] = normalized
      }
    }
  }
  return output ?? value
}

const openAIOptions = (tool: GenericTool): Record<string, unknown> => {
  const options = tool.providerOptions?.openai
  return isRecord(options) ? options : {}
}

const namespaceForTool = (name: string): { name: string; description: string } => {
  const rawGroup = name.includes('__') ? name.split('__', 1)[0] : name.split('_', 1)[0]
  const group = (rawGroup || 'deferred').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 44)
  return {
    name: `maestrly_${group}`,
    description: `Maestrly ${group} tools available on demand.`,
  }
}

const withDeferredOptions = (tool: GenericTool, name: string): GenericTool => {
  const currentOpenAI = openAIOptions(tool)
  const namespace = isRecord(currentOpenAI.namespace) ? currentOpenAI.namespace : namespaceForTool(name)
  return {
    ...tool,
    providerOptions: {
      ...tool.providerOptions,
      openai: {
        ...currentOpenAI,
        deferLoading: true,
        namespace: namespace as JSONObject,
      },
    },
  } as GenericTool
}

const adaptFunctionTool = async (tool: GenericTool): Promise<{ tool: GenericTool; strict: boolean }> => {
  const originalSchema = asSchema(tool.inputSchema)
  const rawSchema = await originalSchema.jsonSchema
  const strict = makeOpenAIFunctionSchemaStrict(rawSchema)
  if (strict == null) return { tool: { ...tool, strict: false } as GenericTool, strict: false }

  const normalize = (input: unknown): unknown => normalizeValue(input, strict.normalization)
  const inputSchema = jsonSchema(strict.schema, {
    validate: async (input) => {
      const normalized = normalize(input)
      return originalSchema.validate == null
        ? { success: true, value: normalized }
        : await originalSchema.validate(normalized)
    },
  })
  const execute = tool.execute

  return {
    tool: {
      ...tool,
      inputSchema,
      strict: true,
      ...(execute == null
        ? {}
        : {
            execute: (input: unknown, options: ToolExecutionOptions<unknown>) => execute(normalize(input), options),
          }),
    } as GenericTool,
    strict: true,
  }
}

const PARALLEL_SAFE_NAMES = new Set(['glob', 'grep', 'read', 'use_skill', 'webfetch'])

export function isOpenAIReadOnlyTool(name: string, tool?: GenericTool): boolean {
  if (tool?.metadata?.readOnly === true) return true
  if (tool?.metadata?.readOnly === false) return false
  return PARALLEL_SAFE_NAMES.has(name)
}

export function isOpenAIParallelSafeTool(name: string, tool?: GenericTool): boolean {
  if (tool?.metadata?.parallelSafe === true) return true
  if (tool?.metadata?.parallelSafe === false) return false
  return PARALLEL_SAFE_NAMES.has(name)
}

interface SchedulerLease {
  ready: Promise<void>
  release: () => void
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Fair read/write scheduler: concurrent reads share an epoch; mutations form barriers. */
export class OpenAIToolScheduler {
  readonly conversationId?: string
  private mutationTail = Promise.resolve()
  private readonly activeReads = new Set<Promise<void>>()

  constructor(conversationId?: string) {
    this.conversationId = conversationId
  }

  private acquire(parallelSafe: boolean): SchedulerLease {
    const completion = deferred()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      completion.resolve()
      this.activeReads.delete(completion.promise)
    }

    if (parallelSafe) {
      const ready = this.mutationTail
      this.activeReads.add(completion.promise)
      return { ready, release }
    }

    const reads = [...this.activeReads]
    this.activeReads.clear()
    const ready = Promise.all([this.mutationTail, ...reads]).then(() => undefined)
    this.mutationTail = completion.promise
    return { ready, release }
  }

  async schedule<T>(toolName: string, operation: () => T | PromiseLike<T>, tool?: GenericTool): Promise<T> {
    return this.scheduleWithAccess(isOpenAIParallelSafeTool(toolName, tool), operation)
  }

  async scheduleRead<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return this.scheduleWithAccess(true, operation)
  }

  async scheduleMutation<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return this.scheduleWithAccess(false, operation)
  }

  private async scheduleWithAccess<T>(parallelSafe: boolean, operation: () => T | PromiseLike<T>): Promise<T> {
    const lease = this.acquire(parallelSafe)
    await lease.ready
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }
}

export async function optimizeOpenAITools(
  inputTools: ToolSet,
  options: OptimizeOpenAIToolsOptions = {}
): Promise<OptimizedOpenAITools> {
  const requestedDeferred = new Set(options.deferredToolNames ?? [])
  const outputEntries: Array<[string, GenericTool]> = []
  const strictToolNames: string[] = []
  const nonStrictToolNames: string[] = []
  const deferredToolNames: string[] = []
  const seenNames = new Set<string>()

  for (const name of Object.keys(inputTools).sort(compareNames)) {
    seenNames.add(name)
    const sourceTool = inputTools[name] as GenericTool
    let optimizedTool = sourceTool

    if (sourceTool.type !== 'provider') {
      const adapted = await adaptFunctionTool(sourceTool)
      optimizedTool = adapted.tool
      ;(adapted.strict ? strictToolNames : nonStrictToolNames).push(name)
    }

    if (options.enableToolSearch === true && requestedDeferred.has(name) && sourceTool.type !== 'provider') {
      optimizedTool = withDeferredOptions(optimizedTool, name)
      deferredToolNames.push(name)
    }
    outputEntries.push([name, optimizedTool])
  }

  const toolSearchEnabled = options.enableToolSearch === true && deferredToolNames.length > 0
  if (toolSearchEnabled) {
    const existing = inputTools.toolSearch as GenericTool | undefined
    if (existing != null && !(existing.type === 'provider' && existing.id === 'openai.tool_search')) {
      throw new Error('toolSearch is reserved for openai.tools.toolSearch()')
    }
    if (existing == null) outputEntries.push(['toolSearch', openai.tools.toolSearch() as GenericTool])
  }

  outputEntries.sort(([left], [right]) => compareNames(left, right))
  const tools = Object.fromEntries(outputEntries) as ToolSet
  const unknownDeferredToolNames = [...requestedDeferred].filter((name) => !seenNames.has(name)).sort(compareNames)

  return {
    tools,
    scheduler: new OpenAIToolScheduler(options.conversationId),
    strictToolNames,
    nonStrictToolNames,
    deferredToolNames,
    unknownDeferredToolNames,
    toolSearchEnabled,
  }
}
