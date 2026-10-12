import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/gateway/client'
import { pairWithServer, PairingError } from '../src/servers/pairing'

const meta = { protocol: 1, gatewayVersion: '0.16.0', botImage: 'maestrly-bot', botImageVersion: null, features: ['files'] }

function gateway(routes: Record<string, () => { status: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    const answer = routes[`${init.method} ${new URL(url).pathname}`]?.() ?? { status: 404 }
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.json ?? null }
  }
  return { fetch, calls }
}

const input = { address: 'https://bots.example.dev', code: 'k7q2-m9xd', deviceName: 'iPhone', allowLoopback: false }

describe('pairing with a bot server', () => {
  it('reads the server’s features, then pairs with the normalized code', async () => {
    const g = gateway({
      'GET /v1/meta': () => ({ status: 200, json: meta }),
      'POST /v1/pair': () => ({ status: 200, json: { deviceId: 'dev-1', token: 'tok' } }),
    })
    const result = await pairWithServer(input, g.fetch)
    expect(g.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/meta',
      'POST /v1/pair',
    ])
    expect(g.calls[0].headers.Authorization).toBeUndefined()
    expect(JSON.parse(g.calls[1].body ?? '')).toEqual({ code: 'K7Q2M9XD', deviceName: 'iPhone' })
    expect(result.token).toBe('tok')
    expect(result.server).toMatchObject({
      id: 'dev-1',
      origin: 'https://bots.example.dev',
      name: 'bots',
      deviceName: 'iPhone',
      features: ['files'],
    })
  })

  it('names a tailnet server by its machine name', async () => {
    const g = gateway({
      'GET /v1/meta': () => ({ status: 200, json: meta }),
      'POST /v1/pair': () => ({ status: 200, json: { deviceId: 'dev-2', token: 'tok' } }),
    })
    const result = await pairWithServer({ ...input, address: 'https://home-lab.tail1234.ts.net' }, g.fetch)
    expect(result.server.name).toBe('home-lab')
  })

  it('refuses an address or a code it cannot use before reaching the network', async () => {
    const g = gateway({})
    await expect(pairWithServer({ ...input, address: 'http://box.tail1234.ts.net' }, g.fetch)).rejects.toMatchObject({
      reason: 'address',
    })
    await expect(pairWithServer({ ...input, code: '0000' }, g.fetch)).rejects.toMatchObject({ reason: 'code' })
    expect(g.calls).toHaveLength(0)
  })

  it('explains each way pairing can fail', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('Network request failed')
    }
    await expect(pairWithServer(input, offline)).rejects.toMatchObject({ reason: 'unreachable' })
    const newer = gateway({ 'GET /v1/meta': () => ({ status: 200, json: { ...meta, protocol: 2 } }) })
    await expect(pairWithServer(input, newer.fetch)).rejects.toMatchObject({ reason: 'incompatible' })
    for (const [status, code, reason] of [
      [401, 'UNAUTHORIZED', 'expired'],
      [429, 'RATE_LIMITED', 'rate-limited'],
      [500, 'INTERNAL', 'failed'],
    ] as const) {
      const g = gateway({
        'GET /v1/meta': () => ({ status: 200, json: meta }),
        'POST /v1/pair': () => ({ status, json: { code, message: 'x' } }),
      })
      const error = await pairWithServer(input, g.fetch).catch((cause) => cause)
      expect(error).toBeInstanceOf(PairingError)
      expect(error.reason).toBe(reason)
    }
  })
})
