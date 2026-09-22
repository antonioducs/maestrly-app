import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { BotDesktopClient, BotOwnerClient } from '../../src/main/bot/client'

afterEach(() => vi.unstubAllGlobals())

it('uses the device-only credential on the personal relay without organization or runner headers', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Response.json(url.endsWith('/claim') ? null : { ok: true })
    })
  )
  const desktopId = randomUUID()
  const client = new BotDesktopClient('https://bridge.example.test', desktopId, 'synthetic-device-credential')
  await client.inventory({ capability: 'bot:conversations:v1', enabled: true, workspaces: [], selections: [] })
  expect(await client.claim()).toBeNull()
  for (const call of calls) {
    expect(call.url).toContain('/api/v1/bot-desktops/')
    expect(call.init?.headers).toMatchObject({
      authorization: 'BotDesktop synthetic-device-credential',
      'x-maestrly-bot-desktop-id': desktopId,
    })
    expect(JSON.stringify(call.init)).not.toMatch(/organization|runner|Bearer/)
  }
})

it('refreshes owner authorization per request and never accepts an owner identity from the caller', async () => {
  const calls: RequestInit[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return Response.json([])
    })
  )
  let token = 'first-owner-token'
  const client = new BotOwnerClient('https://bridge.example.test', async () => token)
  await client.connections()
  token = 'refreshed-owner-token'
  await client.conversations()
  expect(calls[0].headers).toMatchObject({ authorization: 'Bearer first-owner-token' })
  expect(calls[1].headers).toMatchObject({ authorization: 'Bearer refreshed-owner-token' })
  expect(calls.every((call) => call.body === undefined)).toBe(true)
})

it('fails before sending a request when the owner is disconnected', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(new BotOwnerClient('https://bridge.example.test', async () => null).connections()).rejects.toThrow(
    /Sign in/
  )
  expect(fetch).not.toHaveBeenCalled()
})
