import { describe, expect, it } from 'vitest'
import { requestSchema, responseSchema } from '../src/index.js'
describe('host wire contracts', () => {
  it('accepts only version 1 high level methods', () => {
    expect(
      requestSchema.safeParse({
        version: 1,
        id: 'r',
        method: 'host.inspect',
        params: {},
      }).success
    ).toBe(true)
    for (const input of [
      { version: 2, id: 'r', method: 'host.inspect', params: {} },
      { version: 1, id: 'r', method: 'qmp.execute', params: {} },
      {
        version: 1,
        id: 'r',
        method: 'vm.start',
        params: {
          vmId: 'x',
          expectedRevision: 1,
          idempotencyKey: 'k',
          args: [],
        },
      },
    ])
      expect(requestSchema.safeParse(input).success).toBe(false)
  })
  it('requires exactly one response outcome', () => {
    expect(responseSchema.safeParse({ version: 1, id: 'r', result: null }).success).toBe(true)
    expect(responseSchema.safeParse({ version: 1, id: 'r' }).success).toBe(false)
    expect(
      responseSchema.safeParse({
        version: 1,
        id: 'r',
        result: {},
        error: { code: 'X', message: 'x' },
      }).success
    ).toBe(false)
  })
})

it('restricts verification to fixed modes and removal to explicit boolean deletion', () => {
  for (const params of [
    { vmId: 'v', mode: 'exec' },
    { vmId: 'v', mode: 'write-marker', path: '/etc/passwd' },
    { vmId: 'v', mode: 'read-marker', command: 'guest-exec' },
  ])
    expect(
      requestSchema.safeParse({
        version: 1,
        id: 'r',
        method: 'vm.verify',
        params,
      }).success
    ).toBe(false)
  expect(
    requestSchema.parse({
      version: 1,
      id: 'r',
      method: 'vm.remove',
      params: { vmId: 'v', expectedRevision: 0, idempotencyKey: 'k' },
    }).params
  ).toHaveProperty('deleteData', false)
  expect(
    requestSchema.safeParse({
      version: 1,
      id: 'r',
      method: 'vm.remove',
      params: {
        vmId: 'v',
        expectedRevision: 0,
        idempotencyKey: 'k',
        deleteData: 'true',
      },
    }).success
  ).toBe(false)
})

it('validates read-only lookup and strict retained inventory options', () => {
  expect(requestSchema.parse({ version: 1, id: 'r', method: 'vm.list', params: {} }).params).toEqual({
    includeRetained: false,
  })
  expect(
    requestSchema.safeParse({ version: 1, id: 'r', method: 'vm.list', params: { includeRetained: true } }).success
  ).toBe(true)
  for (const params of [{ includeRetained: 'true' }, { path: '/tmp' }, { includeRetained: true, path: '/tmp' }])
    expect(requestSchema.safeParse({ version: 1, id: 'r', method: 'vm.list', params }).success).toBe(false)
  expect(
    requestSchema.safeParse({ version: 1, id: 'r', method: 'operation.lookup', params: { idempotencyKey: 'saved' } })
      .success
  ).toBe(true)
  for (const params of [{}, { idempotencyKey: '' }, { idempotencyKey: 'saved', path: '/tmp' }])
    expect(requestSchema.safeParse({ version: 1, id: 'r', method: 'operation.lookup', params }).success).toBe(false)
})
