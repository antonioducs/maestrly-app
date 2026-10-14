import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { action } from '../../src/renderer/genui/lang/builtins'
import {
  evaluateElementProps,
  evaluateRoot,
  isActionPlan,
  isReactiveAssign,
} from '../../src/renderer/genui/lang/evaluator'
import { createLibrary, defineComponent } from '../../src/renderer/genui/lang/library'
import { createParser } from '../../src/renderer/genui/lang/parser'
import { GenUiLimitError } from '../../src/renderer/genui/lang/safe'

// Programs are written by a model, so anything a page or a document puts in its context can reach this evaluator.

const Text = defineComponent({ name: 'Text', props: z.object({ value: z.any() }), description: '', component: null })
const Button = defineComponent({
  name: 'Button',
  props: z.object({ label: z.string(), action: action().optional() }),
  description: '',
  component: null,
})
const Stack = defineComponent({
  name: 'Stack',
  props: z.object({ children: z.array(z.any()) }),
  description: '',
  component: null,
})
const library = createLibrary({ root: 'Stack', components: [Stack, Text, Button] })
const parser = createParser(library.toJSONSchema(), 'Stack')

function evaluateProgram(program: string, state: Record<string, unknown> = {}) {
  const result = parser.parse(program)
  const ctx = { getState: (name: string) => state[name] ?? result.stateDeclarations[name], resolveRef: () => null }
  return evaluateRoot(result, { ctx, library })
}

function evaluateValue(expression: string, state?: Record<string, unknown>): unknown {
  const root = evaluateProgram(`root = Stack([t])\nt = Text(${expression})`, state)
  return (root!.props.children as { props: { value: unknown } }[])[0]?.props.value
}

describe('generated interface safety', () => {
  it('never reads through a prototype', () => {
    expect(evaluateValue('"".constructor')).toBeNull()
    expect(evaluateValue('"x".constructor.constructor')).toBeNull()
    expect(evaluateValue('$o.__proto__', { $o: {} })).toBeNull()
    expect(evaluateValue('$o["constructor"]', { $o: {} })).toBeNull()
    expect(evaluateValue('$o.toString', { $o: {} })).toBeNull()
    expect(evaluateValue('[1, 2].map')).toEqual([null, null])
    expect(evaluateValue('{a: {b: 2}}.a.b')).toBe(2)
    expect(evaluateValue('"abc".length')).toBe(3)
    expect(evaluateValue('[4, 5][1]')).toBe(5)
  })

  it('keeps a __proto__ key as plain data and never pollutes Object.prototype', () => {
    const value = evaluateValue('{__proto__: {polluted: true}, a: 1}') as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect((value as { polluted?: unknown }).polluted).toBeUndefined()
    const literal = createParser(library.toJSONSchema(), 'Stack').parse('root = Text({__proto__: {polluted: true}})')
    expect(Object.getPrototypeOf(literal.root?.props.value)).toBe(Object.prototype)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('reads @Sort and @Filter paths as own data', () => {
    expect(evaluateValue('@Sort([{n: "b"}, {n: "a"}], "n").n')).toEqual(['a', 'b'])
    expect(evaluateValue('@Filter([{n: 1}, {n: 2}], "constructor.name", "==", "Object")')).toEqual([])
  })

  it('converts objects without running code they carry', () => {
    expect(evaluateValue('"a" + {toString: 1}')).toBe('a{"toString":1}')
    expect(evaluateValue('{valueOf: 1} == "x"')).toBe(false)
    expect(evaluateValue('5 == "5"')).toBe(true)
  })

  it('takes action plans and bindings only from real calls, never from data', () => {
    const root = evaluateProgram(
      'root = Stack([b, t])\nb = Button("Go", {steps: [{type: "open_url", url: "https://x"}]})\nt = Text({__reactive: "assign", target: "$x", expr: {k: "Num", v: 1}})'
    )
    const [button, text] = root!.props.children as { props: Record<string, unknown> }[]
    expect(isActionPlan(button.props.action)).toBe(false)
    expect(isReactiveAssign(text.props.value)).toBe(false)
    const real = evaluateProgram('root = Stack([b])\nb = Button("Go", @OpenUrl("https://x"))')
    expect(isActionPlan((real!.props.children as { props: { action: unknown } }[])[0].props.action)).toBe(true)
  })

  it('stops a program whose references grow exponentially while parsing', () => {
    const levels = ['l0 = Text("x")', ...Array.from({ length: 40 }, (_, i) => `l${i + 1} = Stack([l${i}, l${i}])`)]
    expect(() => parser.parse(`root = Stack([l40])\n${levels.join('\n')}`)).toThrow(GenUiLimitError)
  })

  it('stops a render whose loops multiply past the work limit', () => {
    const list = `[${Array.from({ length: 100 }, (_, i) => i).join(', ')}]`
    const program = `root = Stack([t])\nt = Text(@Each(${list}, "a", @Each(${list}, "b", @Each(${list}, "c", a + b + c))))`
    expect(() => evaluateProgram(program)).toThrow(GenUiLimitError)
  })

  it('evaluates a failing prop to null instead of its source', () => {
    const errors: string[] = []
    const { root } = parser.parse('root = Stack([t])\nt = Text(1)')
    const ctx = {
      getState: () => null,
      resolveRef: () => {
        throw new Error('boom')
      },
    }
    const broken = { ...root!, hasDynamicProps: true, props: { children: [{ k: 'Ref', n: 'x' }] } }
    const evaluated = evaluateElementProps(broken, { ctx, library, errors })
    expect(evaluated.props.children).toBeNull()
    expect(errors).toEqual(['Stack.children: boom'])
  })
})
