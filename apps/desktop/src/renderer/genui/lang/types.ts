// Adapted from OpenUI lang-core (packages/lang-core/src/parser/types.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt. Query, Mutation and custom-action shapes are gone.

import type { ASTNode } from './ast'
import type { Budget } from './safe'

export type JSONSchemaProperty = Record<string, unknown>
/** A JSON Schema object; keywords are added as libraries use them (anyOf: the ActionExpression union). */
export type JSONSchemaDef = {
  properties?: JSONSchemaProperty
  required?: string[]
  description?: string
  type?: string
  anyOf?: JSONSchemaProperty[]
}

/** A function's params and return value as JSON Schema. */
export interface FunctionSchema {
  description?: string
  /** JSON Schema object of the params. Property order is the positional order in programs. */
  params: JSONSchemaDef
  returns?: JSONSchemaProperty
}

/** `library.toJSONSchema()`: component schemas in `$defs` keyed by name, library functions in `functions`. */
export interface LibraryJSONSchema {
  $defs?: Record<string, JSONSchemaDef>
  /** Component names as keys. Other `$defs` are data shapes. */
  properties?: Record<string, unknown>
  functions?: Record<string, FunctionSchema>
}

/** Scalar JSON Schema types a positional literal can be checked against. */
export type ScalarParamType = 'string' | 'number' | 'boolean'

export interface ParamDef {
  name: string
  required: boolean
  /** JSON Schema default, used when a required field is missing or null. */
  defaultValue?: unknown
  schema?: unknown
}

/** `@Percent(part, total)` -> params [{name: "part"}, {name: "total"}], kept as AST. */
export interface CallDef {
  kind: 'function' | 'action'
  params: ParamDef[]
  /** Built-ins coerce their args: the runtime maps them by name, unvalidated. */
  builtin?: true
  /** Lazy built-ins (@Each, Action, @Set, @Reset) get their args unevaluated. */
  lazy?: true
}

/** "Card" -> its params; callDefs: "Sum" -> built-in CallDef, "Percent" -> library CallDef. */
export type ParamMap = Map<string, { params: ParamDef[] }> & {
  callDefs?: Map<string, CallDef>
}

/** One component call, with positional arguments mapped to named props by the schema's key order. */
export interface ElementNode {
  type: 'element'
  /** Statement that defined it (`header` of `header = Text(...)`); undefined when inline. */
  statementId?: string
  typeName: string
  props: Record<string, unknown>
  /** The source was cut mid-stream when this node was built. */
  partial: boolean
  /** False when every prop is a literal, so evaluation can be skipped. */
  hasDynamicProps?: boolean
}

export function isElementNode(value: unknown): value is ElementNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const node = value as Record<string, unknown>
  return (
    node.type === 'element' &&
    typeof node.typeName === 'string' &&
    typeof node.props === 'object' &&
    node.props !== null &&
    typeof node.partial === 'boolean'
  )
}

export type ValidationErrorCode =
  | 'missing-required'
  | 'null-required'
  | 'unknown-component'
  | 'excess-args'
  | 'type-mismatch'
  | 'unknown-function'
  | 'no-root'

/** A schema problem. A component missing a required prop is dropped from the tree and reported here. */
export interface ValidationError {
  code: ValidationErrorCode
  component: string
  /** JSON Pointer within the props, e.g. "/title". */
  path: string
  message: string
  statementId?: string
  /** "warning" when the program still renders (the `no-root` fallback); absent means error. */
  severity?: 'warning'
}

export interface MaterializeCtx {
  syms: Map<string, ASTNode>
  cat: ParamMap | undefined
  errors: ValidationError[]
  unres: string[]
  visited: Set<string>
  partial: boolean
  currentStatementId?: string
  /** Statements not reached yet; what remains is orphaned. */
  unreached?: Set<string>
  budget?: Budget
}

/** One step of the plan a button runs; the runtime decides what each one may do. */
export type ActionStep =
  | { type: 'continue_conversation'; message: string; context?: unknown }
  | { type: 'open_url'; url: string }
  | { type: 'set'; target: string; valueAST: ASTNode }
  | { type: 'reset'; targets: string[] }

export interface ActionPlan {
  steps: ActionStep[]
}

/** One parse: the root element, if any, plus what the runtime and the diagnostics need. */
export interface ParseResult {
  root: ElementNode | null
  /** Set when the entry picks a component at runtime (`root = $t ? A : B`). */
  rootExpression?: ASTNode
  meta: {
    /** The input was cut mid-statement (streaming). */
    incomplete: boolean
    /** References used but not defined (yet). */
    unresolved: string[]
    /** Value statements defined but not reachable from root. */
    orphaned: string[]
    statementCount: number
    errors: ValidationError[]
  }
  /** `$name` declarations with their default values. */
  stateDeclarations: Record<string, unknown>
}
