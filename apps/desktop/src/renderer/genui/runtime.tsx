import {
  Component,
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import type { z } from 'zod'
import {
  type ActionStep,
  createBudget,
  createParser,
  type DefinedComponent,
  defineComponent,
  type ElementNode,
  evaluate,
  evaluateRoot,
  isActionPlan,
  isElementNode,
  isReactiveAssign,
  type Library,
  type ParseResult,
  type Parser,
  RENDER_STEPS,
  type RuntimeFunction,
} from './lang'
import { addGenUiIssue, type GenUiIssue } from './issues'
import { genUiMessage } from './message'

// The React side of generated interfaces: renders a parsed program with the catalog's components and keeps its state.
// State is the program's `$name` defaults with what the person changed on top, so the defaults apply on the first
// render and a default that changes while the program streams in still applies.

export interface GenUiComponentProps<P = Record<string, unknown>> {
  props: P
  renderNode: (value: unknown) => ReactNode
}

export type GenUiComponent = (input: GenUiComponentProps<any>) => ReactNode
export type GenUiLibrary = Library<GenUiComponent>

/** A catalog component: its props schema and a React renderer typed by it. */
export function defineGenUiComponent<T extends z.ZodObject>(config: {
  name: string
  description: string
  props: T
  component: (input: GenUiComponentProps<z.infer<T>>) => ReactNode
}): DefinedComponent<T, GenUiComponent> {
  return defineComponent({ ...config, component: config.component as GenUiComponent })
}

/** What an interface asks its host to do; the host decides whether and how. */
export type GenUiEffect = { kind: 'send'; text: string } | { kind: 'open'; url: string }

export type GenUiState = Record<string, unknown>

interface Runtime {
  live: boolean
  canSend: boolean
  library: GenUiLibrary
  read(name: string): unknown
  write(name: string, value: unknown): void
  run(label: string, action: unknown): void
}

const RuntimeContext = createContext<Runtime | null>(null)

function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('A generated interface component rendered outside its program')
  return runtime
}

/** The message is still streaming: inputs and buttons wait for it. */
export function useGenUiLive(): boolean {
  return useRuntime().live
}

/** Runs a button's action plan; a button without one sends its label as the person. */
export function useGenUiAction(): { run: (label: string, action: unknown) => void; canSend: boolean } {
  const { run, canSend } = useRuntime()
  return { run, canSend }
}

/**
 * The value of an input prop and its setter: a `$variable` binding reads and writes the program state; a literal is
 * the input's own starting value.
 */
export function useBinding<T>(prop: unknown, fallback: T): [T, (value: T) => void] {
  const runtime = useRuntime()
  const [local, setLocal] = useState<{ source: unknown; value: unknown }>({ source: prop, value: prop })
  const bound = isReactiveAssign(prop)
  // A literal that changes (while the program streams in) restarts the input from it
  if (!bound && !Object.is(local.source, prop) && (prop === null || typeof prop !== 'object'))
    setLocal({ source: prop, value: prop })

  const value = bound ? runtime.read(prop.target) : local.value
  const set = useCallback(
    (next: T) => {
      if (!isReactiveAssign(prop)) {
        setLocal({ source: prop, value: next })
        return
      }
      const { target, expr } = prop
      if (expr.k === 'StateRef' && expr.n === '$value') runtime.write(target, next)
      // `$a = $value * 2`: the binding computes what it stores
      else
        runtime.write(
          target,
          evaluate(expr, {
            getState: (name) => runtime.read(name),
            resolveRef: () => null,
            extraScope: { $value: next },
            budget: createBudget(RENDER_STEPS, 'input'),
          })
        )
    },
    [prop, runtime]
  )
  return [(value ?? fallback) as T, set]
}

const parsers = new WeakMap<GenUiLibrary, Parser>()
const functionMaps = new WeakMap<GenUiLibrary, Record<string, RuntimeFunction>>()

function parserFor(library: GenUiLibrary): Parser {
  let parser = parsers.get(library)
  if (!parser) parsers.set(library, (parser = createParser(library.toJSONSchema(), library.root)))
  return parser
}

/** The library functions as the evaluator runs them; computed once per library. */
export function functionsFor(library: GenUiLibrary): Record<string, RuntimeFunction> {
  let functions = functionMaps.get(library)
  if (!functions) {
    const schemas = library.toJSONSchema().functions ?? {}
    functions = Object.fromEntries(
      Object.entries(schemas).flatMap(([name, schema]) =>
        Object.hasOwn(library.functions, name) ? [[name, { ...schema, fn: library.functions[name].fn }]] : []
      )
    )
    functionMaps.set(library, functions)
  }
  return functions
}

/** Parses a program; a parser crash or the work limit is a failure, never an exception. */
export function parseGenUi(
  code: string,
  library: GenUiLibrary
): { result: ParseResult | null; failure: string | null } {
  try {
    return { result: parserFor(library).parse(code), failure: null }
  } catch (error) {
    return { result: null, failure: error instanceof Error ? error.message : String(error) }
  }
}

function readState(state: GenUiState, defaults: GenUiState, name: string): unknown {
  if (Object.hasOwn(state, name)) return state[name]
  return Object.hasOwn(defaults, name) ? defaults[name] : null
}

/**
 * What a button does, in order: a button without an action sends its label; an action that is not a plan the
 * evaluator made does nothing. Returns the effects for the host and the new state, or null when it did not change.
 */
export function runAction(
  label: string,
  action: unknown,
  scope: { state: GenUiState; defaults: GenUiState; functions?: Record<string, RuntimeFunction> }
): { effects: GenUiEffect[]; state: GenUiState | null } {
  let steps: ActionStep[]
  if (action == null) steps = [{ type: 'continue_conversation', message: label }]
  else if (isActionPlan(action)) steps = action.steps
  else return { effects: [], state: null }
  const effects: GenUiEffect[] = []
  let next = scope.state
  let changed = false
  for (const step of steps) {
    if (step.type === 'continue_conversation') {
      const text = genUiMessage(step.message, step.context)
      if (text) effects.push({ kind: 'send', text })
    } else if (step.type === 'open_url') {
      effects.push({ kind: 'open', url: step.url })
    } else if (step.type === 'set') {
      const current = next
      const value = evaluate(step.valueAST, {
        getState: (name) => readState(current, scope.defaults, name),
        resolveRef: () => null,
        functions: scope.functions,
        budget: createBudget(RENDER_STEPS, 'action'),
      })
      next = { ...next, [step.target]: value }
      changed = true
    } else if (step.type === 'reset') {
      next = Object.fromEntries(Object.entries(next).filter(([name]) => !step.targets.includes(name)))
      changed = true
    }
  }
  return { effects, state: changed ? next : null }
}

export interface GenUiProgramProps {
  code: string
  library: GenUiLibrary
  /** The message is still streaming. */
  live: boolean
  /** What the person changed earlier, restored over the program's defaults. */
  initialState?: GenUiState
  /** Called after each change the person makes, with everything changed so far. */
  onStateChange?: (state: GenUiState) => void
  onEffect?: (effect: GenUiEffect) => void
  canSend?: boolean
}

/**
 * What the parser and the evaluator dropped from a complete program: invalid calls, names used but never defined,
 * statements never shown, and props whose evaluation failed. The program renders what is left, so without this list
 * its author never learns why part of the interface is missing.
 */
export function programIssues(result: ParseResult | null, runtimeErrors: readonly string[]): readonly GenUiIssue[] {
  let issues: readonly GenUiIssue[] = []
  if (result) {
    for (const error of result.meta.errors)
      if (error.severity !== 'warning') issues = addGenUiIssue(issues, { kind: 'invalid', detail: error.message })
    for (const name of result.meta.unresolved) issues = addGenUiIssue(issues, { kind: 'undefined', detail: name })
    for (const name of result.meta.orphaned) issues = addGenUiIssue(issues, { kind: 'unused', detail: name })
  }
  for (const error of runtimeErrors) issues = addGenUiIssue(issues, { kind: 'runtime', detail: error })
  return issues
}

/**
 * One program, rendered: `content` is the interface, or null with why in `failure` (a complete program that renders
 * nothing), and `issues` what was dropped from it. While the program streams in, inputs and buttons stay disabled and
 * neither a failure nor issues are reported.
 */
export function useGenUiProgram({
  code,
  library,
  live,
  initialState,
  onStateChange,
  onEffect,
  canSend = true,
}: GenUiProgramProps): { content: ReactNode; failure: string | null; issues: readonly GenUiIssue[] } {
  const parsed = useMemo(() => parseGenUi(code, library), [code, library])
  const defaults = parsed.result?.stateDeclarations ?? {}
  const [state, setState] = useState<GenUiState>(() => initialState ?? {})
  // Actions run after renders and must see the latest state and defaults
  const latest = useRef({ state, defaults })
  latest.current = { state, defaults }
  const callbacks = useRef({ onStateChange, onEffect })
  callbacks.current = { onStateChange, onEffect }

  const functions = functionsFor(library)
  const rendered = useMemo(() => {
    const errors: string[] = []
    if (!parsed.result) return { root: null, failure: parsed.failure ?? 'The program is empty', errors }
    const defaults = parsed.result.stateDeclarations
    try {
      const root = evaluateRoot(parsed.result, {
        ctx: { getState: (name) => readState(state, defaults, name), resolveRef: () => null, functions },
        library,
        errors,
      })
      const firstError = parsed.result.meta.errors.find((error) => error.severity !== 'warning')
      return { root, failure: root ? null : (firstError?.message ?? 'The program has no root component'), errors }
    } catch (error) {
      return { root: null, failure: error instanceof Error ? error.message : String(error), errors }
    }
  }, [parsed, state, library, functions])

  const commit = useCallback((next: GenUiState) => {
    latest.current = { ...latest.current, state: next }
    setState(next)
    callbacks.current.onStateChange?.(next)
  }, [])

  const runtime = useMemo<Runtime>(
    () => ({
      live,
      canSend,
      library,
      read: (name) => readState(latest.current.state, latest.current.defaults, name),
      write: (name, value) => commit({ ...latest.current.state, [name]: value }),
      run: (label, action) => {
        if (live) return
        const outcome = runAction(label, action, { ...latest.current, functions })
        for (const effect of outcome.effects) {
          if (effect.kind === 'open' || canSend) callbacks.current.onEffect?.(effect)
        }
        if (outcome.state) commit(outcome.state)
      },
    }),
    [live, canSend, library, commit, functions]
  )

  const issues = useMemo(
    () => (live ? [] : programIssues(parsed.result, rendered.errors)),
    [live, parsed.result, rendered.errors]
  )

  if (!rendered.root) return { content: null, failure: live ? null : (rendered.failure ?? ''), issues }
  return {
    content: (
      <RuntimeContext.Provider value={runtime}>
        <RenderNode node={rendered.root} />
      </RuntimeContext.Provider>
    ),
    failure: null,
    issues,
  }
}

function renderValue(value: unknown): ReactNode {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item, i) => <Fragment key={i}>{renderValue(item)}</Fragment>)
  if (isElementNode(value)) return <RenderNode node={value} />
  return null
}

function RenderNode({ node }: { node: ElementNode }) {
  const { library } = useRuntime()
  const definition = Object.hasOwn(library.components, node.typeName) ? library.components[node.typeName] : undefined
  if (!definition) return null
  const Renderer = definition.component
  return (
    <LastGoodChildren>
      <Renderer props={node.props} renderNode={renderValue} />
    </LastGoodChildren>
  )
}

/**
 * Adapted from OpenUI react-lang's ElementErrorBoundary (packages/react-lang/src/Renderer.tsx at f7109dd, MIT,
 * Copyright (c) Thesys Inc.). A component that fails keeps showing what it last rendered, so a streaming or computed
 * value that breaks one component never blanks the interface; new children get a fresh attempt.
 */
class LastGoodChildren extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  private lastGood: ReactNode = null

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidMount(): void {
    if (!this.state.failed) this.lastGood = this.props.children
  }

  componentDidUpdate(previous: { children: ReactNode }): void {
    if (!this.state.failed) this.lastGood = this.props.children
    else if (previous.children !== this.props.children) this.setState({ failed: false })
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('Generated interface component failed', error, info.componentStack)
  }

  render(): ReactNode {
    return this.state.failed ? this.lastGood : this.props.children
  }
}
