// Adapted from OpenUI lang-core (packages/lang-core/src/runtime/evaluator.ts, evaluate-prop.ts and evaluate-tree.ts at
// f7109dd, MIT, Copyright (c) Thesys Inc.). See resources/licenses/openui-MIT.txt.
//
// Changes, all because model-written programs run in the renderer that holds the preload API:
// - fields are read with readField (own data only) and objects built with writeField;
// - `+` and `==` never convert objects, which could run code they carry;
// - action plans and bindings count only when this evaluator made them: data cannot pose as either;
// - every evaluation spends the render budget; a prop that fails evaluates to null instead of its raw AST;
// - no Query/Mutation references, @Run or custom actions.

import type { ASTNode } from './ast'
import { isASTNode, toLiteralAST } from './ast'
import { ACTION_STEPS, BUILTIN_CALLS, BUILTIN_STEPS, BUILTINS, isStep, looseEquals, toNumber } from './builtins'
import type { Library } from './library'
import { nameArgs } from './materialize'
import { isReactiveSchema } from './reactive'
import { type Budget, createBudget, GenUiLimitError, readField, RENDER_STEPS, spend, toText, writeField } from './safe'
import type {
  ActionPlan,
  ActionStep,
  ElementNode,
  FunctionSchema,
  JSONSchemaDef,
  MaterializeCtx,
  ParamDef,
  ParseResult,
} from './types'
import { isElementNode } from './types'
import { getSchemaDefaultValue, INVALID, validateSchemaValue } from './validation'

/** The library, for the reactive schema of each prop. */
export interface SchemaContext {
  library: Pick<Library, 'components'>
}

export interface EvaluationContext {
  /** Reads a `$variable`. */
  getState(name: string): unknown
  /** Resolves a reference left for runtime: a loop variable of @Each. */
  resolveRef(name: string): unknown
  /** Extra scope for `$value` while a binding computes what it stores. */
  extraScope?: Record<string, unknown>
  /** Library functions: their `toJSONSchema().functions` entries plus each `fn`. */
  functions?: Record<string, RuntimeFunction>
  /** Reports a runtime error, such as a library function call that evaluated to null. */
  reportError?: (message: string) => void
  budget?: Budget
}

export interface RuntimeFunction extends FunctionSchema {
  fn: (args: any) => unknown
}

/** A prop bound to a `$variable`: writing `$value` stores `expr` in `target`. */
export interface ReactiveAssign {
  __reactive: 'assign'
  target: string
  expr: ASTNode
}

const madeBindings = new WeakSet<object>()
const madePlans = new WeakSet<object>()

function binding(target: string, expr: ASTNode): ReactiveAssign {
  const value: ReactiveAssign = { __reactive: 'assign', target, expr }
  madeBindings.add(value)
  return value
}

function plan(steps: ActionStep[]): ActionPlan {
  const value = { steps }
  madePlans.add(value)
  return value
}

export function isReactiveAssign(value: unknown): value is ReactiveAssign {
  return typeof value === 'object' && value !== null && madeBindings.has(value)
}

/** True for an action plan this evaluator made; a `{steps: [...]}` object from data is not one. */
export function isActionPlan(value: unknown): value is ActionPlan {
  return typeof value === 'object' && value !== null && madePlans.has(value)
}

/** Shape of the props schema behind a component, for the reactive check of each prop. */
function propSchema(library: SchemaContext['library'], component: string, prop: string): unknown {
  const def = Object.hasOwn(library.components, component) ? library.components[component] : undefined
  return (def?.props as any)?._zod?.def?.shape?.[prop]
}

export function evaluate(node: ASTNode, context: EvaluationContext, schemaCtx?: SchemaContext): unknown {
  spend(context.budget)
  switch (node.k) {
    case 'Str':
    case 'Num':
    case 'Bool':
      return node.v
    case 'Null':
    case 'Ph':
      return null

    case 'StateRef':
      return context.extraScope && Object.hasOwn(context.extraScope, node.n)
        ? context.extraScope[node.n]
        : context.getState(node.n)

    case 'Ref':
      return context.resolveRef(node.n)

    case 'Arr':
      return node.els.map((el) => evaluate(el, context))
    case 'Obj': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of node.entries) writeField(out, k, evaluate(v, context))
      return out
    }

    case 'Comp': {
      // Built-ins coerce their args, so they skip validation. Lazy ones get them unevaluated.
      const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined
      if (builtin) {
        if (builtin.lazy) return evaluateLazyBuiltin(node.name, node.args, context, schemaCtx)
        return builtin.fn!(evaluateArgs(node, context))
      }
      if (isStep(node.name)) return evaluateActionCall(node, context)
      const fns = context.functions
      if (fns && Object.hasOwn(fns, node.name)) return callFunction(node.name, fns[node.name]!, node, context)
      // A component inside an expression (`$t ? A : B`, @Each templates): the parser mapped its args to props.
      if (node.mappedProps) {
        const props: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(node.mappedProps)) {
          const schema = schemaCtx && propSchema(schemaCtx.library, node.name, key)
          if (val.k === 'StateRef' && isReactiveSchema(schema)) {
            writeField(props, key, binding(val.n, { k: 'StateRef', n: '$value' }))
          } else if (val.k === 'StateRef' && !schemaCtx) {
            // Without schema context the binding is decided later, in evaluateElementProps
            writeField(props, key, val)
          } else {
            writeField(props, key, evaluate(val, context, schemaCtx))
          }
        }
        const result: ElementNode = {
          type: 'element',
          typeName: node.name,
          props,
          partial: false,
          hasDynamicProps: true,
        }
        if (schemaCtx) {
          for (const [key, val] of Object.entries(props)) {
            if (isElementNode(val)) props[key] = evaluateElementInline(val, context, schemaCtx)
            else if (Array.isArray(val))
              props[key] = val.map((item) =>
                isElementNode(item) ? evaluateElementInline(item, context, schemaCtx) : item
              )
          }
        }
        return result
      }
      // Unknown components were reported and dropped at parse time
      return null
    }

    case 'BinOp': {
      if (node.op === '&&') {
        const left = evaluate(node.left, context)
        return left ? evaluate(node.right, context) : left
      }
      if (node.op === '||') {
        const left = evaluate(node.left, context)
        return left ? left : evaluate(node.right, context)
      }
      const left = evaluate(node.left, context)
      const right = evaluate(node.right, context)
      switch (node.op) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') return toText(left) + toText(right)
          return toNumber(left) + toNumber(right)
        case '-':
          return toNumber(left) - toNumber(right)
        case '*':
          return toNumber(left) * toNumber(right)
        case '/':
          // Division by zero gives 0, not Infinity or NaN
          return toNumber(right) === 0 ? 0 : toNumber(left) / toNumber(right)
        case '%':
          return toNumber(right) === 0 ? 0 : toNumber(left) % toNumber(right)
        case '==':
          return looseEquals(left, right)
        case '!=':
          return !looseEquals(left, right)
        case '>':
          return toNumber(left) > toNumber(right)
        case '<':
          return toNumber(left) < toNumber(right)
        case '>=':
          return toNumber(left) >= toNumber(right)
        case '<=':
          return toNumber(left) <= toNumber(right)
        default:
          return null
      }
    }

    case 'UnaryOp':
      if (node.op === '!') return !evaluate(node.operand, context)
      if (node.op === '-') return -toNumber(evaluate(node.operand, context))
      return null

    case 'Ternary':
      return evaluate(node.cond, context) ? evaluate(node.ifTrue, context) : evaluate(node.ifFalse, context)

    case 'Member': {
      const obj = evaluate(node.obj, context)
      if (obj == null) return null
      // Array pluck: a field of an array is that field of every element
      if (Array.isArray(obj) && node.field !== 'length') return obj.map((item) => readField(item, node.field))
      return readField(obj, node.field)
    }

    case 'Index': {
      const obj = evaluate(node.obj, context)
      const idx = evaluate(node.index, context)
      if (obj == null || idx == null) return null
      return readField(obj, Array.isArray(obj) || typeof obj === 'string' ? String(toNumber(idx)) : toText(idx))
    }

    case 'Assign':
      return binding(node.target, node.value)
  }
}

/** Evaluates an element's props with schema awareness, for a component built inside an expression. */
function evaluateElementInline(el: ElementNode, context: EvaluationContext, schemaCtx: SchemaContext): ElementNode {
  if (el.hasDynamicProps === false) return el
  const evaluated: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(el.props)) {
    writeField(
      evaluated,
      key,
      evaluatePropValue(value, context, schemaCtx, propSchema(schemaCtx.library, el.typeName, key), (child) =>
        evaluateElementInline(child, context, schemaCtx)
      )
    )
  }
  return { ...el, props: evaluated }
}

/**
 * One prop value: AST nodes are evaluated, a `$variable` on a reactive prop becomes a binding, nested elements and
 * arrays recurse, and action plans are kept for click time.
 */
function evaluatePropValue(
  value: unknown,
  context: EvaluationContext,
  schemaCtx: SchemaContext,
  reactiveSchema: unknown,
  recurseElement: (el: ElementNode) => ElementNode
): unknown {
  if (value == null || typeof value !== 'object') return value
  const reactive = isReactiveSchema(reactiveSchema)

  if (isASTNode(value)) {
    if (value.k === 'StateRef' && reactive) return binding(value.n, { k: 'StateRef', n: '$value' })
    const result = evaluate(value, context, schemaCtx)
    if (isElementNode(result)) return recurseElement(result)
    if (Array.isArray(result)) return result.map((item) => (isElementNode(item) ? recurseElement(item) : item))
    // A binding outside a reactive prop reads as the value it is bound to
    if (isReactiveAssign(result) && !reactive) return context.getState(result.target) ?? null
    return result
  }
  if (Array.isArray(value))
    return value.map((item) => evaluatePropValue(item, context, schemaCtx, reactiveSchema, recurseElement))
  if (isElementNode(value)) return recurseElement(value)
  if (isActionPlan(value) || isReactiveAssign(value)) return value

  // Plain data: recurse only when it nests objects
  const obj = value as Record<string, unknown>
  if (!Object.values(obj).some((v) => typeof v === 'object' && v !== null)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj))
    writeField(out, k, evaluatePropValue(v, context, schemaCtx, reactiveSchema, recurseElement))
  return out
}

/** Context of one render: the evaluation context, the library and where runtime errors go. */
export interface EvalContext {
  ctx: EvaluationContext
  library: Pick<Library, 'components'>
  errors?: string[]
}

/** Every prop of the tree resolved to a concrete value; a prop that fails is null and its error recorded. */
export function evaluateElementProps(el: ElementNode, evalCtx: EvalContext): ElementNode {
  if (el.hasDynamicProps === false) return el
  const schemaCtx: SchemaContext = { library: evalCtx.library }
  const evaluated: Record<string, unknown> = {}
  let key = ''
  const report = (msg: string) => evalCtx.errors?.push(`${el.typeName}.${key}: ${msg}`)
  const ctx = { ...evalCtx.ctx, reportError: report }
  for (const [propKey, value] of Object.entries(el.props)) {
    key = propKey
    try {
      writeField(
        evaluated,
        key,
        evaluatePropValue(value, ctx, schemaCtx, propSchema(evalCtx.library, el.typeName, key), (child) =>
          evaluateElementProps(child, evalCtx)
        )
      )
    } catch (e) {
      // The work limit stops the whole render; any other failure costs only this prop
      if (e instanceof GenUiLimitError) throw e
      writeField(evaluated, key, null)
      report(e instanceof Error ? e.message : String(e))
    }
  }
  return { ...el, props: evaluated }
}

/** The root, or the component a runtime entry (`root = $t ? A : B`) picks, with every prop evaluated; null if none. */
export function evaluateRoot(
  result: Pick<ParseResult, 'root' | 'rootExpression'>,
  evalCtx: EvalContext
): ElementNode | null {
  const ctx = evalCtx.ctx.budget
    ? evalCtx
    : { ...evalCtx, ctx: { ...evalCtx.ctx, budget: createBudget(RENDER_STEPS, 'render') } }
  if (result.root) return evaluateElementProps(result.root, ctx)
  if (!result.rootExpression) return null
  const value = evaluate(result.rootExpression, ctx.ctx, { library: ctx.library })
  return isElementNode(value) ? evaluateElementProps(value, ctx) : null
}

// @Percent(done, 10) with done = 3 -> {part: 3, total: 10}
function evaluateArgs(
  node: ASTNode & { k: 'Comp' },
  context: EvaluationContext,
  params: ParamDef[] = BUILTIN_CALLS.get(node.name)?.params ?? []
): Record<string, unknown> {
  const named = node.mappedProps ?? nameArgs(node.args, params)
  const args: Record<string, unknown> = {}
  for (const key of Object.keys(named)) writeField(args, key, evaluate(named[key]!, context))
  return args
}

/** A library function's args; an explicit null for an optional param is omitted, so its default applies. */
function callArgs(
  node: ASTNode & { k: 'Comp' },
  context: EvaluationContext,
  params: JSONSchemaDef
): Record<string, unknown> {
  const names = Object.keys(params.properties ?? {})
  const args = evaluateArgs(
    node,
    context,
    names.map((name) => ({ name, required: false }))
  )
  for (const key of Object.keys(args)) {
    if (args[key] === null && !params.required?.includes(key)) delete args[key]
  }
  return args
}

// returns z.string() but fn gives 5 -> reports "@Percent: ... expects string but got number"
function checkValue(value: unknown, schema: unknown, name: string, path: string, context: EvaluationContext): unknown {
  const ctx = { errors: [], partial: false } as unknown as MaterializeCtx
  const checked = validateSchemaValue(value, schema, name, path, ctx)
  for (const e of ctx.errors) context.reportError?.(`@${name}: ${e.message}`)
  return checked
}

// @Percent($p) with $p unset -> null, no error
function missesRequired(args: Record<string, unknown>, params: RuntimeFunction['params']): boolean {
  return !!params.required?.some(
    (key) => args[key] == null && getSchemaDefaultValue(params.properties?.[key]) === undefined
  )
}

// @Percent(1, 0) where fn throws -> null, reports "@Percent threw: ..."
function callFunction(
  name: string,
  def: RuntimeFunction,
  node: ASTNode & { k: 'Comp' },
  context: EvaluationContext
): unknown {
  const raw = callArgs(node, context, def.params)
  if (missesRequired(raw, def.params)) return null
  const args = checkValue(raw, def.params, name, '', context)
  if (args === INVALID) return null
  let result: unknown
  try {
    result = def.fn(args)
  } catch (e) {
    context.reportError?.(`@${name} threw: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  if (!def.returns) return result
  const checked = checkValue(result, def.returns, name, '/returns', context)
  return checked === INVALID ? null : (checked ?? null)
}

/** A step call is a one-step plan, an invalid step an empty plan; Action([...]) flattens the plans it lists. */
function evaluateActionCall(node: ASTNode & { k: 'Comp' }, context: EvaluationContext): ActionPlan {
  const { name, args } = node
  if (name === 'Action') {
    const list = args.length > 0 ? evaluate(args[0], context) : []
    return plan((Array.isArray(list) ? list : []).flatMap((v) => (isActionPlan(v) ? v.steps : [])))
  }
  const def = BUILTIN_STEPS[name]!
  const step = def.step ? def.step(evaluateArgs(node, context)) : evaluateLazyStep(name, args)
  return plan(step ? [step] : [])
}

/** The steps whose args are `$variables`, read as AST. */
function evaluateLazyStep(name: string, args: ASTNode[]): ActionStep | null {
  switch (name) {
    case 'Set':
      // valueAST is evaluated at click time; @Each loop variables were substituted already
      if (args.length < 2 || args[0].k !== 'StateRef') return null
      return { type: ACTION_STEPS.Set, target: args[0].n, valueAST: args[1] }
    case 'Reset': {
      const targets = args.filter((a): a is ASTNode & { k: 'StateRef' } => a.k === 'StateRef').map((a) => a.n)
      return targets.length ? { type: ACTION_STEPS.Reset, targets } : null
    }
    default:
      return null
  }
}

/** Replaces every Ref(varName) with the item's literal, so deferred expressions keep the loop variable. */
function substituteRef(node: ASTNode, varName: string, value: unknown): ASTNode {
  const sub = (child: ASTNode) => substituteRef(child, varName, value)
  switch (node.k) {
    case 'Ref':
      return node.n === varName ? toLiteralAST(value) : node
    case 'Member': {
      const obj = sub(node.obj)
      // t.id on a literal object resolves now
      if (obj.k === 'Obj') {
        const entry = obj.entries.find(([k]) => k === node.field)
        if (entry) return entry[1]
      }
      return { ...node, obj }
    }
    case 'Index':
      return { ...node, obj: sub(node.obj), index: sub(node.index) }
    case 'BinOp':
      return { ...node, left: sub(node.left), right: sub(node.right) }
    case 'UnaryOp':
      return { ...node, operand: sub(node.operand) }
    case 'Ternary':
      return { ...node, cond: sub(node.cond), ifTrue: sub(node.ifTrue), ifFalse: sub(node.ifFalse) }
    case 'Arr':
      return { ...node, els: node.els.map(sub) }
    case 'Obj':
      return { ...node, entries: node.entries.map(([k, v]) => [k, sub(v)] as [string, ASTNode]) }
    case 'Comp': {
      const result = { ...node, args: node.args.map(sub) }
      if (node.mappedProps) {
        const mapped: Record<string, ASTNode> = {}
        for (const key of Object.keys(node.mappedProps)) writeField(mapped, key, sub(node.mappedProps[key]!))
        result.mappedProps = mapped
      }
      return result
    }
    case 'Assign':
      return { ...node, value: sub(node.value) }
    default:
      return node
  }
}

/** @Each(array, varName, template): the template once per item, with the loop variable substituted. */
function evaluateLazyBuiltin(
  name: string,
  args: ASTNode[],
  context: EvaluationContext,
  schemaCtx?: SchemaContext
): unknown {
  if (name !== 'Each' || args.length < 3) return name === 'Each' ? [] : null
  const arr = evaluate(args[0], context)
  if (!Array.isArray(arr)) return []
  const varArg = args[1]
  const varName = varArg.k === 'Ref' ? varArg.n : varArg.k === 'Str' ? varArg.v : null
  if (!varName) return []
  const template = args[2]
  return arr.map((item) => {
    const childCtx: EvaluationContext = {
      ...context,
      resolveRef: (refName) => (refName === varName ? item : context.resolveRef(refName)),
    }
    const result = evaluate(substituteRef(template, varName, item), childCtx, schemaCtx)
    return schemaCtx && isElementNode(result) ? evaluateElementInline(result, childCtx, schemaCtx) : result
  })
}
