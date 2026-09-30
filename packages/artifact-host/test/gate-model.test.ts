import { describe, expect, it } from 'vitest'
import type { ViewerGate, ViewerState } from '../src/shell/contract.js'
import { entryScreen, POLL_INTERVAL_MS, parseFragment } from '../src/shell/gate-model.js'

const state: ViewerState = {
  artifact: { id: 'A'.repeat(22), title: 'Probe', currentVersion: 1, versions: [] },
  identity: { kind: 'invited', name: 'Maria' },
  ownerName: 'Antonio',
  can: { comment: true, resolve: false },
}

const gate = (overrides: Partial<ViewerGate['gate']>): ViewerGate => ({
  gate: { request: false, guest: false, code: false, pending: null, ...overrides },
  ownerName: 'Antonio',
})

describe('parseFragment', () => {
  it('reads the tokens and the version a link carries', () => {
    expect(parseFragment('#i=abc&v=2')).toEqual({ invite: 'abc', version: 2 })
    expect(parseFragment('#o=ticket')).toEqual({ owner: 'ticket' })
    expect(parseFragment('#o=ticket&v=3&preview=1')).toEqual({ owner: 'ticket', version: 3, preview: true })
    expect(parseFragment('#preview=yes')).toEqual({})
    expect(parseFragment('')).toEqual({})
    expect(parseFragment('#')).toEqual({})
  })

  it('ignores versions that are not positive whole numbers, and empty tokens', () => {
    for (const hash of ['#v=abc', '#v=0', '#v=-1', '#v=1.5', '#v=', '#i=&o='])
      expect(parseFragment(hash), hash).toEqual({})
  })
})

describe('entryScreen', () => {
  it('always shows an invitation before anything else', () => {
    expect(entryScreen({ fragment: { invite: 'abc' }, state })).toEqual({ screen: 'invite', token: 'abc' })
    expect(entryScreen({ fragment: { invite: 'abc' }, state: null })).toEqual({ screen: 'invite', token: 'abc' })
  })

  it('shows the page to whoever has access', () => {
    expect(entryScreen({ fragment: {}, state })).toEqual({ screen: 'viewer' })
  })

  it('shows what a visitor without access may do', () => {
    expect(entryScreen({ fragment: {}, state: gate({ request: true, pending: 'pending' }) })).toEqual({
      screen: 'waiting',
    })
    expect(entryScreen({ fragment: {}, state: gate({ request: true, pending: 'denied' }) })).toEqual({
      screen: 'denied',
    })
    expect(entryScreen({ fragment: {}, state: gate({ guest: true, code: true }) })).toEqual({
      screen: 'guest',
      code: true,
    })
    expect(entryScreen({ fragment: {}, state: gate({ guest: true }) })).toEqual({ screen: 'guest', code: false })
    expect(entryScreen({ fragment: {}, state: gate({ request: true }) })).toEqual({ screen: 'request' })
    expect(entryScreen({ fragment: {}, state: gate({}) })).toEqual({ screen: 'unavailable' })
    expect(entryScreen({ fragment: {}, state: null })).toEqual({ screen: 'unavailable' })
  })

  it('checks a waiting request every five seconds', () => {
    expect(POLL_INTERVAL_MS).toBe(5000)
  })
})
