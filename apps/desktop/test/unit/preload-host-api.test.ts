import { describe, expect, it } from 'vitest'
import { localHostApi, makeHostApi } from '../../src/preload/host-api'

const noop = { invoke: async () => undefined, send: () => {}, on: () => {}, removeListener: () => {} }

describe('host API', () => {
  it('builds the same members over any transport as this computer exposes', () => {
    expect(Object.keys(makeHostApi(noop)).sort()).toEqual(Object.keys(localHostApi).sort())
  })

  it('routes a host call through the given transport', async () => {
    const calls: unknown[][] = []
    const api = makeHostApi({
      ...noop,
      invoke: async (...args: unknown[]) => {
        calls.push(args)
        return []
      },
    })
    await api.listWorkspaces(true)
    expect(calls).toEqual([['workspace:list', true]])
  })

  it('subscribes and unsubscribes on the given transport with the same listener', () => {
    const on: unknown[][] = []
    const off: unknown[][] = []
    const api = makeHostApi({
      ...noop,
      on: (...args: unknown[]) => void on.push(args),
      removeListener: (...args: unknown[]) => void off.push(args),
    })
    const stop = api.onStatus(() => {})
    stop()
    expect(on).toHaveLength(1)
    expect(on[0][0]).toBe('agent:status')
    expect(off).toEqual([['agent:status', on[0][1]]])
  })
})
