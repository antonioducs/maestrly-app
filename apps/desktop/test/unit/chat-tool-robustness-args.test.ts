import { jsonSchema } from 'ai'
import { asSchema } from '@ai-sdk/provider-utils'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { coerceToolInput, parseToolArguments } from '../../src/main/chat/tool-robustness/arg-repair'
import {
  isLenientInputSchema,
  lenientInputSchema,
  ToolInputValidationError,
} from '../../src/main/chat/tool-robustness/lenient-input'

describe('parseToolArguments', () => {
  it('leaves valid JSON untouched and reads an empty text as an empty object', () => {
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ ok: true, value: { path: 'a.ts' }, repaired: false })
    expect(parseToolArguments('  ')).toEqual({ ok: true, value: {}, repaired: true })
  })

  it('repairs fences, Python literals, trailing commas and raw control characters', () => {
    expect(parseToolArguments('```json\n{"path": "a.ts"}\n```')).toMatchObject({ ok: true, value: { path: 'a.ts' } })
    expect(parseToolArguments('{"all": True, "limit": None, "x": False}')).toMatchObject({
      ok: true,
      value: { all: true, limit: null, x: false },
    })
    // Python literal names inside strings are data.
    expect(parseToolArguments('{"text": "True story",}')).toMatchObject({ ok: true, value: { text: 'True story' } })
    expect(parseToolArguments('{"tags": ["a", "b",],}')).toMatchObject({ ok: true, value: { tags: ['a', 'b'] } })
    const code = '{"path":"a.py","content":"def f():\n\treturn 1\n"}'
    expect(parseToolArguments(code)).toMatchObject({
      ok: true,
      repaired: true,
      value: { path: 'a.py', content: 'def f():\n\treturn 1\n' },
    })
  })

  it('drops excess closers and adds missing ones only after a complete value', () => {
    expect(parseToolArguments('{"path":"a.ts"}}')).toMatchObject({ ok: true, value: { path: 'a.ts' } })
    expect(parseToolArguments('{"path":"a.ts"')).toMatchObject({ ok: true, value: { path: 'a.ts' } })
    expect(parseToolArguments('{"a":[1,2}')).toMatchObject({ ok: true, value: { a: [1, 2] } })
    expect(parseToolArguments('{"todos":[{"id":"1","done":true}')).toMatchObject({
      ok: true,
      value: { todos: [{ id: '1', done: true }] },
    })
  })

  it('refuses to complete a call cut off inside a string or after a separator', () => {
    const cut = parseToolArguments('{"path":"a.ts","content":"export function main() {\n  return')
    expect(cut).toMatchObject({ ok: false, reason: 'truncated' })
    expect(cut.ok === false && cut.message).toMatch(/cut off .* not executed/)
    expect(cut.ok === false && cut.message).toMatch(/split it into smaller pieces/)
    expect(parseToolArguments('{"path":"a.ts",')).toMatchObject({ ok: false, reason: 'truncated' })
    expect(parseToolArguments('{"path":')).toMatchObject({ ok: false, reason: 'truncated' })
    expect(parseToolArguments('{"todos":[')).toMatchObject({ ok: false, reason: 'truncated' })
    expect(parseToolArguments('{"path":"a","b"')).toMatchObject({ ok: false, reason: 'truncated' })
  })

  it('refuses several concatenated objects and plain text', () => {
    expect(parseToolArguments('{"path":"a"}{"path":"b"}')).toMatchObject({ ok: false, reason: 'multiple' })
    expect(parseToolArguments('{"path":"a"}\n{"path":"b"}')).toMatchObject({ ok: false, reason: 'multiple' })
    expect(parseToolArguments('read the file a.ts')).toMatchObject({ ok: false })
  })
})

const typedSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    limit: { type: 'integer' },
    ratio: { type: 'number' },
    all: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    ids: { type: 'array', items: { type: 'integer' } },
    options: { type: 'object', properties: { deep: { type: 'boolean' } } },
    mode: { enum: ['fast', 'slow'] },
    label: { type: 'string' },
    maybe: { type: ['integer', 'null'] },
    oldString: { type: 'string' },
    node: { $ref: '#/$defs/node' },
  },
  required: ['path'],
  additionalProperties: false,
  $defs: { node: { type: 'object', properties: { depth: { type: 'integer' } } } },
} as const

describe('coerceToolInput', () => {
  it('converts the kinds the schema asks for', () => {
    expect(
      coerceToolInput(typedSchema, {
        path: 'a.ts',
        limit: '50',
        ratio: '0.5',
        all: 'TRUE',
        tags: '["a", "b"]',
        options: '{"deep": "false"}',
        mode: 'Fast',
        label: 42,
        maybe: 'null',
        node: { depth: '3' },
      })
    ).toEqual({
      path: 'a.ts',
      limit: 50,
      ratio: 0.5,
      all: true,
      tags: ['a', 'b'],
      options: { deep: false },
      mode: 'fast',
      label: '42',
      maybe: null,
      node: { depth: 3 },
    })
  })

  it('wraps a scalar into an array, but never a string that looks like JSON', () => {
    expect(coerceToolInput(typedSchema, { path: 'a', tags: 'single', ids: '7' })).toEqual({
      path: 'a',
      tags: ['single'],
      ids: [7],
    })
    expect(coerceToolInput(typedSchema, { path: 'a', tags: '["broken' })).toEqual({ path: 'a', tags: '["broken' })
  })

  it('parses a whole argument object sent as a string, double-encoded or not', () => {
    expect(coerceToolInput(typedSchema, '{"path":"a.ts","limit":"5"}')).toEqual({ path: 'a.ts', limit: 5 })
    expect(coerceToolInput(typedSchema, JSON.stringify(JSON.stringify({ path: 'a.ts' })))).toEqual({ path: 'a.ts' })
  })

  it('renames snake_case keys onto declared camelCase ones and drops optional placeholders', () => {
    expect(coerceToolInput(typedSchema, { path: 'a', old_string: 'x', limit: null, ratio: '' })).toEqual({
      path: 'a',
      oldString: 'x',
    })
    // A required key keeps its placeholder for the validator, and a declared key is never overwritten.
    expect(coerceToolInput(typedSchema, { path: null, oldString: 'y', old_string: 'x' })).toEqual({
      path: null,
      oldString: 'y',
      old_string: 'x',
    })
  })

  it('leaves values it cannot convert and returns the same reference when nothing changes', () => {
    const valid = { path: 'a.ts', limit: 5, tags: ['a'] }
    expect(coerceToolInput(typedSchema, valid)).toBe(valid)
    const unconvertible = { path: 'a', limit: 'fifty', all: '1', ratio: '0x10', mode: 'medium' }
    expect(coerceToolInput(typedSchema, unconvertible)).toEqual(unconvertible)
    expect(coerceToolInput(typedSchema, { path: 'a', limit: '1.5' })).toEqual({ path: 'a', limit: '1.5' })
  })

  it('follows unions and keeps a string a union already accepts', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        count: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        level: { oneOf: [{ const: 1 }, { const: 2 }] },
      },
    }
    expect(coerceToolInput(schema, { id: '7', count: '3', level: '2' })).toEqual({ id: '7', count: 3, level: 2 })
    expect(coerceToolInput(schema, { count: 'null' })).toEqual({ count: null })
  })

  it('survives recursive references', () => {
    const tree = {
      type: 'object',
      properties: { value: { type: 'integer' }, children: { type: 'array', items: { $ref: '#' } } },
    }
    expect(coerceToolInput(tree, { value: '1', children: [{ value: '2', children: [] }] })).toEqual({
      value: 1,
      children: [{ value: 2, children: [] }],
    })
    const cyclic = { $defs: { a: { $ref: '#/$defs/a' } }, type: 'object', properties: { x: { $ref: '#/$defs/a' } } }
    expect(coerceToolInput(cyclic, { x: '1' })).toEqual({ x: '1' })
  })
})

const readParams = z.object({
  path: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(2000).optional(),
})

describe('lenientInputSchema', () => {
  it('returns the original validation result for a valid call and publishes the same JSON Schema', async () => {
    const original = asSchema(readParams)
    const lenient = lenientInputSchema(readParams, { toolName: 'read' })
    expect(isLenientInputSchema(lenient)).toBe(true)
    expect(lenientInputSchema(lenient, { toolName: 'read' })).toBe(lenient)
    expect(await lenient.jsonSchema).toEqual(await original.jsonSchema)
    const valid = { path: 'a.ts', limit: 10 }
    expect(await lenient.validate!(valid)).toEqual(await original.validate!(valid))
  })

  it('accepts a call only after coercion makes the original validator accept it', async () => {
    const onCoerced = vi.fn()
    const lenient = lenientInputSchema(readParams, { toolName: 'read', onCoerced })
    expect(await lenient.validate!({ path: 'a.ts', limit: '50' })).toEqual({
      success: true,
      value: { path: 'a.ts', limit: 50 },
    })
    expect(onCoerced).toHaveBeenCalledWith('read')
    // The coerced value still has to pass every constraint of the original schema.
    const tooLarge = await lenient.validate!({ path: 'a.ts', limit: '5000' })
    expect(tooLarge.success).toBe(false)
    expect(onCoerced).toHaveBeenCalledTimes(1)
  })

  it('reports a failure as a short list of issues with the original error as cause', async () => {
    const lenient = lenientInputSchema(readParams, { toolName: 'read' })
    const result = await lenient.validate!({ limit: 'many' })
    expect(result.success).toBe(false)
    const error = (result as unknown as { error: ToolInputValidationError }).error
    expect(error).toBeInstanceOf(ToolInputValidationError)
    expect(error.message).toMatch(/^The arguments do not match the tool's input schema:\n- path: /)
    expect(error.message).toContain('- limit: ')
    expect(error.message).toMatch(/call the tool again\.$/)
    expect(error.cause).toBeInstanceOf(z.ZodError)
  })

  it('coerces for a schema without validator only when the JSON Schema rejects the value', async () => {
    const lenient = lenientInputSchema(
      jsonSchema({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }),
      { toolName: 'external' }
    )
    expect(await lenient.validate!({ count: '3' })).toEqual({ success: true, value: { count: 3 } })
    const valid = { count: 3 }
    expect(await lenient.validate!(valid)).toEqual({ success: true, value: valid })
    // Whatever was accepted before is still accepted: the tool validates inside execute.
    expect(await lenient.validate!({ count: 'three' })).toEqual({ success: true, value: { count: 'three' } })
  })
})
