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

  it('does not touch the preload while rendering: a component only reaches its host when it calls it', async () => {
    const context = await load()
    vi.stubGlobal('window', undefined)
    let api: unknown
    function Holder() {
      api = context.useHostApi()
      return null
    }
    expect(renderToStaticMarkup(createElement(Holder))).toBe('')
    expect(hostApiOf).not.toHaveBeenCalled()
    vi.stubGlobal('window', { api: { hostApi: hostApiOf } })
    expect((api as { tag: string }).tag).toBe('local')
    expect(hostApiOf.mock.calls).toEqual([['local']])
  })

  it('gives the same API object for a host on every render, so effects depending on it do not rerun', async () => {
    const context = await load()
    const seen: unknown[] = []
    function Holder() {
      seen.push(context.useHostApi())
      return null
    }
    renderToStaticMarkup(createElement(Holder))
    renderToStaticMarkup(createElement(Holder))
    expect(seen[0]).toBe(seen[1])
  })
})
