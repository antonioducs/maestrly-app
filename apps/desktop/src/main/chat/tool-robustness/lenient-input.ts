/**
 * Lenient tool input: the tool's own validator runs first and decides for every valid call, which therefore reaches
 * the tool unchanged. Only a call it rejects is coerced to the published JSON Schema and validated again. The JSON
 * Schema the model sees is the original one, so tool signatures and OpenAI strict schemas do not change.
 *
 * Every runtime validates through `asSchema(tool.inputSchema).validate` (the AI SDK, and the Claude, Codex, Copilot,
 * Antigravity and Cursor bridges), so one wrapper repairs arguments for all of them.
 */
import { asSchema, jsonSchema, type FlexibleSchema, type Schema, type ValidationResult } from '@ai-sdk/provider-utils'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { coerceToolInput } from './arg-repair'

const LENIENT = Symbol.for('maestrly.lenientToolInput')
const MAX_LISTED_ISSUES = 8

type Validate = NonNullable<Schema<unknown>['validate']>

export interface LenientInputOptions {
  toolName: string
  /** Called when a call the validator rejected was accepted after coercion. */
  onCoerced?: (toolName: string) => void
}

/** A validation failure rewritten as a short list the model can act on; the original stays as `cause`. */
export class ToolInputValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[], cause: unknown) {
    const listed = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `- ${issue}`)
    if (issues.length > MAX_LISTED_ISSUES) listed.push(`- …and ${issues.length - MAX_LISTED_ISSUES} more`)
    super(
      `The arguments do not match the tool's input schema:\n${listed.join('\n')}\n` +
        'Fix the arguments to match the schema and call the tool again.',
      { cause }
    )
    this.name = 'ToolInputValidationError'
    this.issues = issues
  }
}

function issuePath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return '(arguments)'
  return path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : String(segment))).join('.')
}

/** Lists the issues of a Zod, Standard Schema or plain error; never throws. */
export function validationIssues(error: unknown): string[] {
  const issues = (error as { issues?: unknown } | null)?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => {
      const record = issue as { path?: unknown; message?: unknown }
      const message = typeof record.message === 'string' ? record.message : 'invalid value'
      return `${issuePath(record.path)}: ${message}`
    })
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return [message.trim() || 'invalid arguments']
}

let ajv: AjvJsonSchemaValidator | undefined

/** Structural validator for schemas whose tool validates inside execute (external MCP tools). */
function compileJsonSchemaCheck(schema: unknown): ((value: unknown) => boolean) | null {
  if (!schema || typeof schema !== 'object') return null
  try {
    ajv ??= new AjvJsonSchemaValidator()
    const validator = ajv.getValidator(schema as Parameters<AjvJsonSchemaValidator['getValidator']>[0])
    return (value) => validator(value).valid
  } catch {
    return null
  }
}

export function isLenientInputSchema(schema: unknown): boolean {
  return Boolean(schema && typeof schema === 'object' && (schema as Record<symbol, unknown>)[LENIENT])
}

export function lenientInputSchema(original: FlexibleSchema<unknown>, options: LenientInputOptions): Schema<unknown> {
  if (isLenientInputSchema(original)) return original as Schema<unknown>
  const base = asSchema(original)
  let published: Promise<unknown> | undefined
  const publishedSchema = () => (published ??= Promise.resolve(base.jsonSchema))
  let check: Promise<((value: unknown) => boolean) | null> | undefined

  const validateWithBase: Validate = async (value) => {
    const validateBase = base.validate!
    const first = await validateBase(value)
    if (first.success) return first
    const coerced = coerceToolInput(await publishedSchema(), value)
    if (coerced !== value) {
      const second = await validateBase(coerced)
      if (second.success) {
        options.onCoerced?.(options.toolName)
        return second
      }
    }
    return { success: false, error: new ToolInputValidationError(validationIssues(first.error), first.error) }
  }

  // Without a validator every value was accepted, and still is: coercion only replaces a value the published schema
  // rejects with one it accepts, so a tool that validates inside execute receives arguments it can take.
  const validateWithoutBase: Validate = async (value): Promise<ValidationResult<unknown>> => {
    check ??= publishedSchema().then(compileJsonSchemaCheck)
    const accepts = await check
    if (!accepts || accepts(value)) return { success: true, value }
    const coerced = coerceToolInput(await publishedSchema(), value)
    if (coerced !== value && accepts(coerced)) {
      options.onCoerced?.(options.toolName)
      return { success: true, value: coerced }
    }
    return { success: true, value }
  }

  const lenient = jsonSchema(() => base.jsonSchema as Parameters<typeof jsonSchema>[0], {
    validate: base.validate ? validateWithBase : validateWithoutBase,
  })
  Object.defineProperty(lenient, LENIENT, { value: true })
  return lenient
}
