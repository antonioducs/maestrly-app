// Adapted from OpenUI lang-core (packages/lang-core/src/parser/parser.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt. Changes: one-shot parsing only (a block always hands over its whole text),
// no Query/Mutation statements, no telemetry, and a step budget per parse.

import type { ASTNode, Statement } from './ast'
import { isASTNode, walkAST } from './ast'
import { ACTION_DEFS, BUILTIN_CALLS, isBuiltin } from './builtins'
import { parseExpression } from './expressions'
import { tokenize } from './lexer'
import { materializeValue } from './materialize'
import { createBudget, PARSE_STEPS } from './safe'
import { autoClose, type RawStmt, split } from './statements'
import { T } from './tokens'
import {
  type ElementNode,
  isElementNode,
  type JSONSchemaDef,
  type LibraryJSONSchema,
  type MaterializeCtx,
  type ParamDef,
  type ParamMap,
  type ParseResult,
  type ValidationError,
} from './types'
import { getSchemaDefaultValue, pushValidationIssue } from './validation'

function emptyResult(incomplete = true): ParseResult {
  return {
    root: null,
    meta: { incomplete, unresolved: [], orphaned: [], statementCount: 0, errors: [] },
    stateDeclarations: {},
  }
}

/** Every `$variable` an AST node references. */
function collectStateRefs(node: ASTNode): string[] {
  const refs = new Set<string>()
  walkAST(node, (current) => {
    if (current.k === 'StateRef') refs.add(current.n)
  })
  return [...refs]
}

function classifyStatement(raw: RawStmt, expr: ASTNode): Statement {
  return raw.idTokenType === T.StateVar
    ? { kind: 'state', id: raw.id, init: expr }
    : { kind: 'value', id: raw.id, expr }
}

/** `$name` defaults, materialized to plain values; a `$var` used but never declared defaults to null. */
function stateDeclarations(stmts: Statement[], ctx: MaterializeCtx): Record<string, unknown> {
  const declarations: Record<string, unknown> = {}
  for (const stmt of stmts) if (stmt.kind === 'state') declarations[stmt.id] = materializeValue(stmt.init, ctx)
  for (const stmt of stmts) {
    for (const dep of collectStateRefs(stmt.kind === 'state' ? stmt.init : stmt.expr)) {
      if (!Object.hasOwn(declarations, dep)) declarations[dep] = null
    }
  }
  return declarations
}

const DEFAULT_ROOT_STATEMENT_ID = 'root'

/** A call to a library component: not an `@` function or a built-in. */
function isComponentCall(node: ASTNode | undefined): node is Extract<ASTNode, { k: 'Comp' }> {
  return node?.k === 'Comp' && !node.fn && !isBuiltin(node.name)
}

/** Entry: `root`, else the first statement that calls the root component. */
function pickEntry(stmtMap: Map<string, Statement>, rootName: string): { id: string; fallback: boolean } | null {
  if (stmtMap.has(DEFAULT_ROOT_STATEMENT_ID)) return { id: DEFAULT_ROOT_STATEMENT_ID, fallback: false }
  for (const stmt of stmtMap.values()) {
    if (stmt.kind === 'value' && isComponentCall(stmt.expr) && stmt.expr.name === rootName)
      return { id: stmt.id, fallback: true }
  }
  return null
}

/** Follow refs to the entry's value; a component call that did not render was dropped by validation. */
function resolvesToComponentCall(node: ASTNode | undefined, syms: Map<string, ASTNode>): boolean {
  const seen = new Set<string>()
  while (node?.k === 'Ref' && !seen.has(node.n)) {
    seen.add(node.n)
    node = syms.get(node.n)
  }
  return isComponentCall(node)
}

/** True when a runtime expression can produce a component, e.g. `$t ? A : B`. */
function containsComponent(node: ASTNode): boolean {
  let found = false
  walkAST(node, (current) => {
    if (isComponentCall(current)) found = true
  })
  return found
}

function buildResult(
  stmtMap: Map<string, Statement>,
  wasIncomplete: boolean,
  cat: ParamMap,
  rootName: string
): ParseResult {
  const entry = pickEntry(stmtMap, rootName)
  const syms = new Map<string, ASTNode>()
  for (const [id, stmt] of stmtMap) syms.set(id, stmt.kind === 'state' ? stmt.init : stmt.expr)

  const errors: ValidationError[] = []
  // Value statements not reached from the entry are orphaned; state declarations are consumed separately.
  const unreached = new Set<string>()
  for (const [id, stmt] of stmtMap) if (id !== entry?.id && stmt.kind === 'value') unreached.add(id)
  const ctx: MaterializeCtx = {
    syms,
    cat,
    errors,
    unres: [],
    visited: new Set(),
    partial: wasIncomplete,
    currentStatementId: entry?.id,
    unreached,
    budget: createBudget(PARSE_STEPS, 'program'),
  }

  let root: ElementNode | null = null
  let rootExpression: ASTNode | undefined
  if (entry) {
    const materialized = materializeValue(syms.get(entry.id)!, ctx)
    if (isElementNode(materialized)) {
      root = materialized
      root.statementId = entry.id
    } else if (isASTNode(materialized) && containsComponent(materialized)) {
      rootExpression = materialized
    }
  }

  const declarations = stateDeclarations([...stmtMap.values()], ctx)

  ctx.currentStatementId = entry?.id
  if (!entry) {
    pushValidationIssue(ctx, rootName, '', { code: 'no-root', reason: 'missing' })
  } else if (!root && !rootExpression && !resolvesToComponentCall(syms.get(entry.id), syms)) {
    pushValidationIssue(ctx, rootName, '', { code: 'no-root', reason: 'not-component' })
  } else if (entry.fallback) {
    pushValidationIssue(ctx, rootName, '', { code: 'no-root', reason: root ? 'fallback' : 'missing' })
  }

  return {
    root,
    ...(rootExpression ? { rootExpression } : {}),
    meta: {
      incomplete: wasIncomplete,
      unresolved: ctx.unres,
      // With no entry nothing is reachable; `no-root` alone describes the problem.
      orphaned: entry ? [...unreached] : [],
      statementCount: stmtMap.size,
      errors,
    },
    stateDeclarations: declarations,
  }
}

function skipString(input: string, start: number): number {
  if (input[start] !== '"') return start
  let i = start + 1
  while (i < input.length) {
    const c = input[i]
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i++
  }
  return i
}

/** Code inside markdown fences, or the input as-is. Skips ``` inside double-quoted strings. */
export function stripFences(input: string): string {
  const blocks: string[] = []
  let i = 0
  const isFence = (at: number) => input[at] === '`' && input[at + 1] === '`' && input[at + 2] === '`'

  while (i < input.length) {
    let fenceStart = -1
    while (i < input.length) {
      const next = skipString(input, i)
      if (next > i) {
        i = next
        continue
      }
      if (isFence(i)) {
        fenceStart = i
        break
      }
      i++
    }
    if (fenceStart === -1) break

    // Skip the language tag up to the newline
    let j = fenceStart + 3
    while (j < input.length && input[j] !== '\n') j++
    if (j >= input.length) {
      blocks.push(input.slice(fenceStart + 3).replace(/^[^\n]*\n?/, ''))
      break
    }
    j++

    let closePos = -1
    let k = j
    while (k < input.length) {
      const next = skipString(input, k)
      if (next > k) {
        k = next
        continue
      }
      if (isFence(k)) {
        closePos = k
        break
      }
      k++
    }
    if (closePos === -1) {
      blocks.push(input.slice(j))
      break
    }
    blocks.push(input.slice(j, closePos))
    i = closePos + 3
  }

  return blocks.length > 0 ? blocks.join('\n') : input
}

/** Strip // and # line comments outside of strings (both quote styles). */
function stripComments(input: string): string {
  let inStr: false | '"' | "'" = false
  return input
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inStr) {
          if (c === '\\' && i + 1 < line.length) {
            i++
            continue
          }
          if (c === inStr) inStr = false
          continue
        }
        if (c === '"' || c === "'") {
          inStr = c
          continue
        }
        if ((c === '/' && line[i + 1] === '/') || c === '#') return line.substring(0, i).trimEnd()
      }
      return line
    })
    .join('\n')
}

function preprocess(input: string): string {
  return stripComments(stripFences(input.trim())).trim()
}

/** Parse a whole program, complete or cut mid-stream. Throws GenUiLimitError past the work limit. */
export function parse(input: string, cat: ParamMap, rootName = ''): ParseResult {
  const trimmed = preprocess(input)
  if (!trimmed) return emptyResult()

  const { text, wasIncomplete } = autoClose(trimmed)
  const stmts = split(tokenize(text))
  if (!stmts.length) return emptyResult(wasIncomplete)

  // A name defined twice keeps its last definition
  const stmtMap = new Map<string, Statement>()
  for (const s of stmts) stmtMap.set(s.id, classifyStatement(s, parseExpression(s.tokens)))
  return buildResult(stmtMap, wasIncomplete, cat, rootName)
}

// {$ref: "#/$defs/ActionExpression"} -> its body, so action slots validate as inline unions
function inlineActionRefs(node: unknown, defs: Map<string, unknown>): unknown {
  if (!node || typeof node !== 'object') return node
  const ref = (node as { $ref?: unknown }).$ref
  if (typeof ref === 'string') return defs.has(ref) ? inlineActionRefs(defs.get(ref), defs) : node
  const copy = (Array.isArray(node) ? [...node] : { ...node }) as Record<string, unknown>
  let changed = false
  for (const [key, value] of Object.entries(copy)) {
    copy[key] = inlineActionRefs(value, defs)
    changed ||= copy[key] !== value
  }
  return changed ? copy : node
}

function compileParams(def: JSONSchemaDef, defs: Map<string, unknown>): ParamDef[] {
  const properties = def.properties ?? {}
  const required = def.required ?? []
  return Object.keys(properties).map((key) => ({
    name: key,
    required: required.includes(key),
    defaultValue: getSchemaDefaultValue(properties[key]),
    schema: defs.size ? inlineActionRefs(properties[key], defs) : properties[key],
  }))
}

export function compileSchema(schema: LibraryJSONSchema): ParamMap {
  const map: ParamMap = new Map()
  const components = schema.properties && new Set(Object.keys(schema.properties))
  // Action $defs (ActionExpression, OpenUrl, ToAssistant) are data shapes, never components
  const defs = new Map<string, unknown>()
  for (const name of Object.keys(ACTION_DEFS)) {
    const body = schema.$defs?.[name]
    if (body && !components?.has(name)) defs.set(`#/$defs/${name}`, body)
  }
  for (const [name, def] of Object.entries(schema.$defs ?? {})) {
    // Skip non-component defs, e.g. zod's hoisted recursive schemas (__schema0)
    if (components ? !components.has(name) : defs.has(`#/$defs/${name}`)) continue
    map.set(name, { params: compileParams(def, defs) })
  }
  map.callDefs = new Map(BUILTIN_CALLS)
  for (const [name, fn] of Object.entries(schema.functions ?? {})) {
    map.callDefs.set(name, { kind: 'function', params: compileParams(fn.params, defs) })
  }
  return map
}

export interface Parser {
  parse(input: string): ParseResult
}

/** A parser for one library: `createParser(library.toJSONSchema(), library.root)`. */
export function createParser(schema: LibraryJSONSchema, rootName: string): Parser {
  const paramMap = compileSchema(schema)
  return { parse: (input) => parse(input, paramMap, rootName) }
}
