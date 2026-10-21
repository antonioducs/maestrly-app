import { describe, expect, it } from 'vitest'
import { createGatewayClient, GatewayError, routeTimeoutMs, type FetchLike } from '../src/gateway/client'

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(respond: (call: Call) => { status: number; json?: unknown } | Promise<never>) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body }
    calls.push(call)
    const answer = await respond(call)
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => {
        if (answer.json === undefined) throw new SyntaxError('no body')
        return answer.json
      },
    }
  }
  return { fetch, calls }
}

const origin = 'https://g.example'

describe('gateway client', () => {
  it('sends the protocol and device headers and validates the response', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, json: { items: [], before: null } }))
    const client = createGatewayClient({ origin, token: 't0k', fetch })
    const page = await client.call('botTranscript', {
      params: { id: 'juno' },
      query: { before: 'it1', limit: 50, reasoning: undefined },
    })
    expect(page).toEqual({ items: [], before: null })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://g.example/v1/bots/juno/transcript?before=it1&limit=50')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].body).toBeUndefined()
    expect(calls[0].headers['X-Maestrly-Fleet-Protocol']).toBe('1')
    expect(calls[0].headers.Authorization).toBe('Bearer t0k')
    expect(calls[0].headers.Origin).toBeUndefined()
  })

  it('turns gateway envelopes into errors that keep the code and message', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, json: { code: 'NOT_FOUND', message: 'Bot not found' } }))
    const error = await createGatewayClient({ origin, token: 't', fetch })
      .call('botGet', { params: { id: 'juno' } })
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Bot not found', retryable: false })
  })

  it('falls back on the status when there is no envelope', async () => {
    for (const [status, code, retryable] of [
      [401, 'UNAUTHORIZED', false],
      [426, 'PROTOCOL_INCOMPATIBLE', false],
      [503, 'INTERNAL', true],
    ] as const) {
      const { fetch } = fakeFetch(() => ({ status }))
      await expect(createGatewayClient({ origin, token: 't', fetch }).call('host')).rejects.toMatchObject({
        code,
        status,
        retryable,
      })
    }
  })

  it('reports network failures and timeouts as retryable', async () => {
    const offline = fakeFetch(() => Promise.reject(new TypeError('Network request failed')))
    await expect(createGatewayClient({ origin, token: 't', fetch: offline.fetch }).call('host')).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
    })
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    await expect(
      createGatewayClient({ origin, token: 't', fetch: hanging }).call('host', { timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('waits for deletions of shared files as long as the gateway does', () => {
    expect(routeTimeoutMs('botFilesDelete')).toBe(65_000)
    expect(routeTimeoutMs('botFilesList')).toBe(15_000)
    expect(routeTimeoutMs('botStart')).toBe(300_000)
  })

  it('times out a server that answers the headers and then stalls the body', async () => {
    const stalled: FetchLike = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
    await expect(
      createGatewayClient({ origin, token: 't', fetch: stalled }).call('host', { timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    const failing: FetchLike = async () => ({ ok: false, status: 503, json: () => new Promise(() => {}) })
    await expect(
      createGatewayClient({ origin, token: 't', fetch: failing }).call('host', { timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('refuses a response that does not match the contract', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, json: { items: 'nope' } }))
    await expect(
      createGatewayClient({ origin, token: 't', fetch }).call('botTranscript', { params: { id: 'juno' } })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' })
  })

  it('rejects an invalid body before using the network', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, json: {} }))
    await expect(
      createGatewayClient({ origin, token: null, fetch }).call('pair', { body: { code: 'x', deviceName: '' } })
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
