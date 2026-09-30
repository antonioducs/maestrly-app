import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hostApiOf = vi.fn((hostId: string) => ({ tag: hostId }))

beforeEach(() => {
  hostApiOf.mockClear()
  vi.resetModules()
  vi.stubGlobal('window', { api: { hostApi: hostApiOf } })
})
afterEach(() => vi.unstubAllGlobals())

async function load() {
  const context = await import('../../src/renderer/lib/hosts/host-context')
  function Probe() {
    const api = context.useHostApi() as unknown as { tag: string }
    return createElement('p', null, `${context.useHostId()}|${api.tag}`)
  }
  return { ...context, Probe }
}

describe('host context', () => {
  it('is this computer outside a provider', async () => {
    const { Probe } = await load()
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>local|local</p>')
  })

  it("gives a subtree its host's id and API", async () => {
    const { HostProvider, Probe } = await load()
    const markup = renderToStaticMarkup(createElement(HostProvider, { hostId: 's/e', children: createElement(Probe) }))
    expect(markup).toBe('<p>s/e|s/e</p>')
  })

  it('asks the preload for a host API once: each call copies the whole object across the context bridge', async () => {
    const { hostApi } = await load()
    expect(hostApi('s/e')).toBe(hostApi('s/e'))
    hostApi('local')
    expect(hostApiOf.mock.calls).toEqual([['s/e'], ['local']])
  })
})
