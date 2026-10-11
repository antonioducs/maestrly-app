import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FLEET_PROTOCOL_HEADER,
  fleetGatewayEventSchema,
  type FleetDesktopCallEvent,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { DesktopBridge } from '../src/desktop-bridge.js'
import { EventHub } from '../src/events.js'
import { Store } from '../src/store.js'
import { harness } from './harness.js'

type Harness = Awaited<ReturnType<typeof harness>>

/** A paired Mac: its token, and an event stream that takes desktop calls once opened. */
async function mac(h: Harness, name: string) {
  const auth = new Auth(h.store)
  const { token, deviceId } = auth.pair(auth.createPairing().code, name, name)
  const headers = {
    [FLEET_PROTOCOL_HEADER]: '1',
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  }
  const events: FleetGatewayEvent[] = []
  const waiters: Array<() => void> = []
  let controller: AbortController | null = null
  const request = (method: string, route: string, body?: unknown) =>
    fetch(h.origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return {
    deviceId,
    token,
    headers,
    events,
    request,
    async connect(bridge = true) {
      controller = new AbortController()
      const response = await fetch(h.origin + '/v1/events' + (bridge ? '?desktopBridge=1' : ''), {
        headers,
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let boundary: number
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice(6))
                .join('\n')
              if (!data) continue
              events.push(fleetGatewayEventSchema.parse(JSON.parse(data)))
              for (const wake of waiters.splice(0)) wake()
            }
          }
        } catch {
          // The stream was closed by the test.
        }
      })()
      await this.next((event) => event.type === 'hello')
    },
    disconnect() {
      controller?.abort()
      controller = null
    },
    /** The first event since `from` that matches, waiting for it. */
    async next<T extends FleetGatewayEvent>(match: (event: FleetGatewayEvent) => boolean, from = 0): Promise<T> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = events.slice(from).find(match)
        if (found) return found as T
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 10)
        })
      }
      throw new Error('Event not received')
    },
    calls() {
      return events.filter((event): event is FleetDesktopCallEvent => event.type === 'desktop.call')
    },
    answer(callId: string, value: unknown) {
      return request('POST', `/v1/desktop-calls/${callId}/result`, { ok: true, value })
    },
  }
}

async function link(h: Harness, client: Awaited<ReturnType<typeof mac>>, name: string) {
  const response = await client.request('PUT', `/v1/bots/${h.bot.id}/desktop-link`, { name })
  expect(response.status).toBe(200)
  return (await response.json()) as { desktopId: string; name: string; online: boolean; self: boolean }
}
const desktops = async (h: Harness) =>
  (await (await h.request('GET', '/internal/v1/desktops', undefined, true)).json()).desktops as Array<{
    desktopId: string
    name: string
    online: boolean
  }>
const call = (h: Harness, desktopId: string, op = 'listWorkspaces', input: Record<string, unknown> = {}) =>
  h.request('POST', '/internal/v1/desktop/calls', { desktopId, op, input }, true).then((response) => response.json())

describe('desktop bridge', () => {
  it('advertises the bridge and tells each bot that the gateway routes desktop calls', async () => {
    const h = await harness(Date.now, { environments: true })
    expect((await (await h.request('GET', '/v1/meta')).json()).features).toContain('desktop-bridge')
    expect(h.instance.installs.at(-1)?.profile.gateway.desktopBridgeEnabled).toBe(true)
  })

  it('routes each call to the Mac it names, and only that Mac may answer it', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    const imac = await mac(h, 'iMac')
    await macbook.connect()
    await imac.connect()
    const a = await link(h, macbook, 'MacBook')
    const b = await link(h, imac, 'Home iMac')
    expect(a).toMatchObject({ name: 'MacBook', online: true, self: true })
    expect(a.desktopId).toMatch(/^dsk_/)
    expect(a.desktopId).not.toContain(macbook.deviceId)
    expect(await desktops(h)).toEqual([
      expect.objectContaining({ desktopId: a.desktopId, name: 'MacBook', online: true }),
      expect.objectContaining({ desktopId: b.desktopId, name: 'Home iMac', online: true }),
    ])
    // Each Mac sees the bot's links, its own marked as self.
    const seen = await imac.next<Extract<FleetGatewayEvent, { type: 'desktop_link.updated' }>>(
      (event) => event.type === 'desktop_link.updated' && event.links.length === 2
    )
    expect(seen.links.map((item) => item.self)).toEqual([false, true])

    const pending = call(h, b.desktopId, 'readChat', { conversationId: 'c-1' })
    const sent = await imac.next<FleetDesktopCallEvent>((event) => event.type === 'desktop.call')
    expect(sent).toMatchObject({
      botId: h.bot.id,
      desktopId: b.desktopId,
      op: 'readChat',
      input: { conversationId: 'c-1' },
    })
    expect(macbook.calls()).toEqual([])
    // Another Mac cannot answer for it, and an unknown call is not found.
    expect((await macbook.answer(sent.callId, { forged: true })).status).toBe(403)
    expect((await imac.answer('00000000-0000-4000-8000-000000000000', {})).status).toBe(404)
    expect((await imac.answer(sent.callId, { conversation: 'from the iMac' })).status).toBe(204)
    expect(await pending).toEqual({ ok: true, value: { conversation: 'from the iMac' } })
    // An answer counts once.
    expect((await imac.answer(sent.callId, {})).status).toBe(404)

    // A failure the Mac reports reaches the bot as it is.
    const refused = call(h, a.desktopId, 'createChat', { workspaceId: 'w-1' })
    const second = await macbook.next<FleetDesktopCallEvent>((event) => event.type === 'desktop.call')
    const failure = {
      ok: false,
      error: { code: 'desktop_refused', message: 'The connection grant was changed or revoked.' },
    }
    expect((await macbook.request('POST', `/v1/desktop-calls/${second.callId}/result`, failure)).status).toBe(204)
    expect(await refused).toEqual(failure)
  })

  it('fails a call for a Mac that is offline at once, and keeps the other Mac working', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    const imac = await mac(h, 'iMac')
    await macbook.connect()
    await imac.connect()
    const a = await link(h, macbook, 'MacBook')
    const b = await link(h, imac, 'iMac')

    // A call in flight when its Mac goes away fails at once instead of waiting for the timeout.
    const inFlight = call(h, b.desktopId)
    await imac.next((event) => event.type === 'desktop.call')
    imac.disconnect()
    const started = Date.now()
    expect(await inFlight).toMatchObject({ ok: false, error: { code: 'desktop_offline' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect.poll(async () => (await desktops(h)).map((item) => item.online)).toEqual([true, false])
    expect(await call(h, b.desktopId)).toMatchObject({
      ok: false,
      error: { code: 'desktop_offline', message: expect.stringContaining('"iMac" is offline') },
    })

    const working = call(h, a.desktopId)
    const sent = await macbook.next<FleetDesktopCallEvent>((event) => event.type === 'desktop.call')
    await macbook.answer(sent.callId, { workspaces: [] })
    expect(await working).toEqual({ ok: true, value: { workspaces: [] } })

    // A stream that does not take desktop calls never makes a Mac online.
    await imac.connect(false)
    expect((await desktops(h)).map((item) => item.online)).toEqual([true, false])
  })

  it('refuses a desktop the bot was not linked to, including another bot’s', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    await macbook.connect()
    expect(await call(h, 'dsk_unknownunknownunknown')).toMatchObject({
      ok: false,
      error: { code: 'desktop_not_linked' },
    })
    const created = await h.request('POST', '/v1/bots', {
      name: 'Other',
      instructions: '',
      ceiling: 'ask',
      talksTo: [],
      environmentId: h.bot.environmentId,
      idempotencyKey: '00000000-0000-4000-8000-000000000011',
    })
    const other = await created.json()
    const linked = await macbook.request('PUT', `/v1/bots/${other.id}/desktop-link`, { name: 'MacBook' })
    const { desktopId } = await linked.json()
    expect(await call(h, desktopId)).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
    expect(macbook.calls()).toEqual([])
  })

  it('unlinks one Mac on its own, by another Mac, or by revoking it, without touching the other', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    const imac = await mac(h, 'iMac')
    const laptop = await mac(h, 'Laptop')
    for (const client of [macbook, imac, laptop]) await client.connect()
    const a = await link(h, macbook, 'MacBook')
    const b = await link(h, imac, 'iMac')
    const c = await link(h, laptop, 'Laptop')

    // Another Mac removes the laptop's link; the laptop hears it has no link left.
    const from = laptop.events.length
    expect((await imac.request('DELETE', `/v1/bots/${h.bot.id}/desktop-links/${c.desktopId}`)).status).toBe(204)
    const gone = await laptop.next<Extract<FleetGatewayEvent, { type: 'desktop_link.updated' }>>(
      (event) => event.type === 'desktop_link.updated' && event.links.length === 2,
      from
    )
    expect(gone.links.some((item) => item.self)).toBe(false)
    expect(await call(h, c.desktopId)).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
    expect((await imac.request('DELETE', `/v1/bots/${h.bot.id}/desktop-links/${c.desktopId}`)).status).toBe(404)

    // Revoking the MacBook takes its link and its waiting calls; the iMac keeps working.
    const waiting = call(h, a.desktopId)
    await macbook.next((event) => event.type === 'desktop.call')
    expect((await macbook.request('DELETE', '/v1/devices/self')).status).toBe(204)
    expect(await waiting).toMatchObject({ ok: false })
    expect((await desktops(h)).map((item) => item.desktopId)).toEqual([b.desktopId])
    const kept = call(h, b.desktopId)
    const sent = await imac.next<FleetDesktopCallEvent>((event) => event.type === 'desktop.call')
    await imac.answer(sent.callId, 'still here')
    expect(await kept).toEqual({ ok: true, value: 'still here' })

    // The iMac takes back its own access.
    expect((await imac.request('DELETE', `/v1/bots/${h.bot.id}/desktop-link`)).status).toBe(204)
    expect(await desktops(h)).toEqual([])
  })

  it('renames a link without changing the id the bot holds, and lists links for the owner', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    const first = await link(h, macbook, 'MacBook')
    const renamed = await link(h, macbook, 'Work MacBook')
    expect(renamed.desktopId).toBe(first.desktopId)
    expect(renamed).toMatchObject({ name: 'Work MacBook', online: false, self: true })
    const listed = await (await h.request('GET', `/v1/bots/${h.bot.id}/desktop-links`)).json()
    expect(listed.links).toEqual([expect.objectContaining({ desktopId: first.desktopId, self: false })])
    expect((await macbook.request('PUT', `/v1/bots/${h.bot.id}/desktop-link`, { name: ' ' })).status).toBe(400)
    expect((await macbook.request('PUT', '/v1/bots/missing/desktop-link', { name: 'MacBook' })).status).toBe(404)
  })

  it('clears every link of a deleted bot and tells the Macs', async () => {
    const h = await harness(Date.now, { environments: true })
    const macbook = await mac(h, 'MacBook')
    await macbook.connect()
    const a = await link(h, macbook, 'MacBook')
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    // An archived bot keeps its links: restoring it brings its access back.
    expect(h.store.desktopLinks(h.bot.id)).toHaveLength(1)
    expect((await macbook.request('GET', `/v1/bots/${h.bot.id}/desktop-links`)).status).toBe(200)
    const from = macbook.events.length
    expect((await h.request('DELETE', `/v1/archived-bots/${h.bot.id}`)).status).toBe(204)
    const cleared = await macbook.next<Extract<FleetGatewayEvent, { type: 'desktop_link.updated' }>>(
      (event) => event.type === 'desktop_link.updated' && event.botId === h.bot.id,
      from
    )
    expect(cleared.links).toEqual([])
    expect(h.store.desktopLinkById(a.desktopId)).toBeNull()
    expect((await macbook.request('GET', `/v1/bots/${h.bot.id}/desktop-links`)).status).toBe(404)
  })
})

describe('desktop bridge timeouts', () => {
  it('gives up on a Mac that does not answer, with what to do next', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-bridge-'))
    const store = new Store(dir)
    try {
      const sent: FleetGatewayEvent[] = []
      const events = Object.assign(new EventHub(async () => {}), {
        bridgeOnline: () => true,
        sendToDevice: (_deviceId: string, event: FleetGatewayEvent) => {
          sent.push(event)
          return true
        },
      })
      const bridge = new DesktopBridge(store, events, { timeoutMs: 30 })
      store.db
        .prepare(
          "INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,created_at,updated_at) VALUES('e','E','running','{}','c','v','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')"
        )
        .run()
      store.db
        .prepare(
          "INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,environment_id,slot) VALUES('b','B','','','#000000','ask','null','[]',0,'running','{}','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','e',1)"
        )
        .run()
      store.db
        .prepare(
          "INSERT INTO devices(id,name,token_sha256,created_at) VALUES('d','Mac','" +
            'a'.repeat(64) +
            "','2026-10-01T00:00:00.000Z')"
        )
        .run()
      const link = store.saveDesktopLink('b', 'd', 'Studio', 'dsk_timeouttimeouttimeout')
      const result = await bridge.call('b', { desktopId: link.desktopId, op: 'sendMessage', input: {} })
      expect(sent).toHaveLength(1)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'desktop_timeout', message: expect.stringContaining('same idempotencyKey') },
      })
      // A Mac that answers after the timeout is told the call is gone.
      expect(() => bridge.result((sent[0] as FleetDesktopCallEvent).callId, 'd', { ok: true, value: null })).toThrow(
        'Desktop call not found'
      )
      // Too many waiting calls of one bot are refused before they reach the Mac.
      const busy = new DesktopBridge(store, events, { timeoutMs: 60_000 })
      const calls = Array.from({ length: 16 }, () =>
        busy.call('b', { desktopId: link.desktopId, op: 'listChats', input: {} })
      )
      expect(await busy.call('b', { desktopId: link.desktopId, op: 'listChats', input: {} })).toMatchObject({
        ok: false,
        error: { code: 'desktop_busy' },
      })
      busy.close()
      expect((await Promise.all(calls)).every((item) => !item.ok)).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
