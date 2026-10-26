import { describe, expect, it } from 'vitest'
import { readSnapshot, responseError } from '../src/shell/responses-model.js'

describe('responseError', () => {
  it('turns the host’s refusals into what the page learns', () => {
    expect(responseError(403, 'responses_closed')).toBe('closed')
    expect(responseError(409, 'too_many_responses')).toBe('full')
    expect(responseError(413, null)).toBe('too_large')
    expect(responseError(400, 'invalid_response')).toBe('invalid')
    expect(responseError(429, null)).toBe('rate_limited')
    expect(responseError(404, null)).toBe('unavailable')
    expect(responseError(403, 'forbidden')).toBe('failed')
    expect(responseError(500, null)).toBe('failed')
    expect(responseError(null, null)).toBe('failed')
  })
})

describe('readSnapshot', () => {
  it('reads the response, or its absence', () => {
    expect(readSnapshot({ response: null })).toBeNull()
    const snapshot = { data: { answer: 'yes', n: [1] }, version: 2, updatedAt: 1000 }
    expect(readSnapshot({ response: snapshot })).toEqual(snapshot)
  })

  it('refuses a malformed answer', () => {
    for (const body of [
      {},
      null,
      'x',
      { response: { data: [], version: 1, updatedAt: 1 } },
      { response: { data: {}, version: 0, updatedAt: 1 } },
      { response: { data: {}, version: 1.5, updatedAt: 1 } },
      { response: { data: {}, version: 1, updatedAt: Number.NaN } },
      { response: { data: {}, version: 1 } },
    ])
      expect(readSnapshot(body)).toBeUndefined()
  })
})
