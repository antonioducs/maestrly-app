// Adapted from the OpenUI lang-core tests (packages/lang-core/src/runtime/__tests__/actions.test.ts and
// functions.test.ts at f7109dd, MIT, Copyright (c) Thesys Inc.). See apps/desktop/resources/licenses/openui-MIT.txt.
// Cases for custom actions, Query/Mutation and toSpec are gone with those features.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { action } from '../../src/renderer/genui/lang/builtins'
import { evaluate, evaluateElementProps } from '../../src/renderer/genui/lang/evaluator'
import { parseExpression } from '../../src/renderer/genui/lang/expressions'
import { defineFunction } from '../../src/renderer/genui/lang/functions'
import { tokenize } from '../../src/renderer/genui/lang/lexer'
import { createLibrary, defineComponent } from '../../src/renderer/genui/lang/library'
import { createParser } from '../../src/renderer/genui/lang/parser'
import type { ElementNode } from '../../src/renderer/genui/lang/types'

const Button = defineComponent({
  name: 'Button',
  props: z.object({ label: z.string(), action: action().optional() }),
  description: '',
  component: null,
})
const buttons = createLibrary({ root: 'Button', components: [Button] })
const buttonParser = createParser(buttons.toJSONSchema(), 'Button')

function actionOf(source: string): any {
  const { root } = buttonParser.parse(`root = Button("Go", ${source})`)
  const ctx = { getState: () => undefined, resolveRef: () => null }
  return evaluateElementProps(root!, { ctx, library: buttons }).props.action
}

describe('action plans', () => {
  it('evaluates a bare step to a one-step plan', () => {
    expect(actionOf(`@OpenUrl("u")`)).toEqual({ steps: [{ type: 'open_url', url: 'u' }] })
  })

  it('flattens nested Action([...]) plans and drops invalid steps', () => {
    const { steps } = actionOf(`Action([@Set($a, 1), @Reset("a"), Action([@OpenUrl("u")])])`)
    expect(steps.map((s: { type: string }) => s.type)).toEqual(['set', 'open_url'])
  })

  it('passes any @ToAssistant context through; null means none', () => {
    expect(actionOf(`@ToAssistant("Save", {ticket: "T-42"})`).steps[0].context).toEqual({ ticket: 'T-42' })
    expect(actionOf(`@ToAssistant("Save", null)`).steps[0].context).toBeUndefined()
  })

  it('keeps data with a null in its steps array as data', () => {
    const Text = defineComponent({ name: 'Text', props: z.object({ text: z.any() }), description: '', component: null })
    const textLib = createLibrary({ root: 'Text', components: [Text] })
    const { root } = createParser(textLib.toJSONSchema(), 'Text').parse(
      `root = Text({title: "Recipe", steps: ["Boil", null]})`
    )
    const errors: string[] = []
    const ctx = { getState: () => undefined, resolveRef: () => null }
    const el = evaluateElementProps(root!, { ctx, library: textLib, errors })
    expect(errors).toEqual([])
    expect(el.props.text).toEqual({ title: 'Recipe', steps: ['Boil', null] })
  })
})

const Text = defineComponent({
  name: 'Text',
  props: z.object({ value: z.any() }),
  description: 'Shows a value',
  component: null,
})
const fns = [
  defineFunction({
    name: 'Percent',
    description: 'Formats part / total as a percentage',
    params: z.object({ part: z.number(), total: z.number().default(100) }),
    returns: z.string(),
    fn: ({ part, total }) => `${((part / total) * 100).toFixed(1)}%`,
  }),
  defineFunction({
    name: 'Sum2',
    description: 'Sums numbers, with an optional label',
    params: z.object({ numbers: z.array(z.number()), label: z.string().optional() }),
    fn: ({ numbers, label }) => `${label ?? ''}${numbers.reduce((a, b) => a + b, 0)}`,
  }),
]
const lib = createLibrary({ root: 'Text', components: [Text], functions: fns })
const schema = lib.toJSONSchema()
const functions = Object.fromEntries(
  Object.entries(schema.functions!).map(([name, s]) => [name, { ...s, fn: lib.functions[name]!.fn }])
)

function evalRoot(root: ElementNode, state: Record<string, unknown> = {}) {
  const errors: string[] = []
  const ctx = { getState: (n: string) => state[n], resolveRef: () => undefined, functions }
  const evaluated = evaluateElementProps(root, { ctx, library: lib, errors })
  return { value: evaluated.props.value, errors }
}

function run(source: string, state?: Record<string, unknown>) {
  const result = createParser(schema, 'Text').parse(`root = Text(${source})`)
  return { ...evalRoot(result.root!, state), parseErrors: result.meta.errors.map((e) => e.code) }
}

describe('library functions', () => {
  it('are described in toJSONSchema in positional order', () => {
    expect(Object.keys(schema.functions!.Percent!.params.properties!)).toEqual(['part', 'total'])
  })

  it('map args by name, validate literals at parse time, apply defaults', () => {
    expect(run('@Percent(1, 4)')).toEqual({ value: '25.0%', errors: [], parseErrors: [] })
    expect(run('@Percent(25)').value).toBe('25.0%')
    expect(run('@Percent("1", 4)')).toMatchObject({ value: null, parseErrors: ['type-mismatch'] })
    expect(run('@Sum2([1, 2], 3, 4)')).toMatchObject({ value: '3', parseErrors: ['excess-args', 'type-mismatch'] })
    expect(run('@Sum2([1], null)').value).toBe('1')
  })

  it('validate dynamic args at runtime without touching the data', () => {
    const state = { $n: [1, 'x', 2] }
    expect(run('@Sum2($n)', state)).toMatchObject({ value: '3', parseErrors: [] })
    expect(state.$n).toEqual([1, 'x', 2])
    expect(run('@Percent($p)', { $p: '1' }).errors).toEqual([
      'Text.value: @Percent: field "/part" expects number but got string',
    ])
    // A required arg not set yet gives null without an error
    expect(run('@Percent($p)', {})).toMatchObject({ value: null, errors: [] })
  })

  it('run on every streamed chunk', () => {
    const parser = createParser(schema, 'Text')
    expect(evalRoot(parser.parse('root = Text(@Percent(1').root!).value).toBe('1.0%')
    expect(evalRoot(parser.parse('root = Text(@Percent(12, 4))').root!).value).toBe('300.0%')
  })

  it('take positional args from an AST made by parseExpression() alone', () => {
    const ctx = { getState: () => undefined, resolveRef: () => null, functions }
    const evalSource = (src: string) => evaluate(parseExpression(tokenize(src)), ctx)
    expect(evalSource('@Sum([1, 2, 3])')).toBe(6)
    expect(evalSource('@ToAssistant("hi")')).toMatchObject({ steps: [{ message: 'hi' }] })
    expect(evalSource('@Percent(1, 4)')).toBe('25.0%')
  })

  it('reject a name taken by a built-in or a component', () => {
    for (const name of ['Sum', 'Text']) {
      const fn = defineFunction({ name, description: '', params: z.object({}), fn: () => 1 })
      expect(() => createLibrary({ root: 'Text', components: [Text], functions: [fn] })).toThrow('collides')
    }
  })

  it('are listed in the prompt after the built-in lines', () => {
    const prompt = lib.prompt({ preamble: '# Test' })
    expect(prompt).toContain('@Sum(numbers: number[]) → number — Sum of numeric array')
    expect(prompt).toContain('@Percent(part: number, total?: number) → string — Formats part / total')
    expect(createLibrary({ root: 'Text', components: [Text] }).prompt({ preamble: '# Test' })).not.toContain('@Percent')
  })
})
