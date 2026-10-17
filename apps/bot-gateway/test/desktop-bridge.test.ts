import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FLEET_PROTOCOL_HEADER,
  fleetGatewayEventSchema,
  type FleetDesktopCallEvent,
  type FleetDesktopCallResult,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'
import { Auth } from '../src/auth.js'
import { DesktopBridge, type DesktopBridgeHosts } from '../src/desktop-bridge.js'
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

/** A gateway with a running workspaces environment whose Maestrly takes bots' calls, and that environment's token. */
async function hosted(options: { calls?: boolean } = {}) {
  const h = await harness(Date.now, { environments: true })
  h.instance.provisioning.capabilities.push(
    'workspaces-host',
    ...(options.calls === false ? [] : ['host-desktop-calls'])
  )
  const environment = h.lifecycle.createEnvironment({ name: 'Personal', memoryLimitBytes: null, kind: 'workspaces' })
  await settled(h, environment.id, 'running')
  const token = h.store.hostGatewaySecrets(environment.id)!.gatewayToken
  const headers = { [FLEET_PROTOCOL_HEADER]: '1', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  const host = (method: string, route: string, body?: unknown) => h.request(method, route, body, true, headers)
  return { h, environmentId: environment.id, token, host }
}
async function settled(h: Harness, id: string, lifecycle: string) {
  for (let i = 0; i < 300 && h.lifecycle.environment(id)?.lifecycle !== lifecycle; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(h.lifecycle.environment(id)?.lifecycle).toBe(lifecycle)
}
const hostLink = async (host: (method: string, route: string, body?: unknown) => Promise<Response>, botId: string) => {
  const response = await host('PUT', `/internal/v1/host/bots/${botId}/desktop-link`, { name: 'Personal' })
  expect(response.status).toBe(200)
  return (await response.json()) as { desktopId: string; kind: string; self: boolean; environmentId: string }
}

describe('desktop bridge to workspaces environments', () => {
  it('lets a workspaces host link itself and sends the bot’s calls to its control server', async () => {
    const { h, environmentId, host } = await hosted()
    expect((await (await h.request('GET', '/v1/meta')).json()).moreFeatures).toContain('host-desktop-calls')
    const macbook = await mac(h, 'MacBook')
    await macbook.connect()
    const linked = await hostLink(host, h.bot.id)
    expect(linked).toMatchObject({ name: 'Personal', kind: 'environment', self: true, environmentId, online: true })
    expect(linked).toMatchObject({ botId: h.bot.id })
    expect(linked.desktopId).toMatch(/^dsk_/)
    // The owner's computers hear of it and read which environment it is; the bot never does.
    const seen = await macbook.next<Extract<FleetGatewayEvent, { type: 'desktop_link.updated' }>>(
      (event) => event.type === 'desktop_link.updated' && event.links.length === 1
    )
    expect(seen.links[0]).toMatchObject({
      desktopId: linked.desktopId,
      kind: 'environment',
      self: false,
      environmentId,
    })
    const listed = await desktops(h)
    expect(listed).toEqual([
      {
        desktopId: linked.desktopId,
        name: 'Personal',
        kind: 'environment',
        online: true,
        lastSeenAt: null,
        linkedAt: expect.any(String),
      },
    ])
    const owner = await (await h.request('GET', `/v1/bots/${h.bot.id}/desktop-links`)).json()
    expect(owner.links).toEqual([expect.objectContaining({ desktopId: linked.desktopId, environmentId, self: false })])

    const answered = await call(h, linked.desktopId, 'createChat', { workspaceId: 'w-1' })
    expect(answered).toEqual({ ok: true, value: { op: 'createChat', desktop: { id: 'local', name: 'host' } } })
    expect(h.instance.hostDesktop.calls).toEqual([
      {
        callId: expect.any(String),
        botId: h.bot.id,
        desktopId: linked.desktopId,
        op: 'createChat',
        input: { workspaceId: 'w-1' },
        expiresAt: expect.any(String),
      },
    ])
    // No computer heard of the call: it went to the environment alone.
    expect(macbook.calls()).toEqual([])
    // A failure the host reports reaches the bot as it is.
    const failure = { ok: false, error: { code: 'desktop_refused', message: 'The workspace is not authorized.' } }
    h.instance.hostDesktop.answer = () => failure
    expect(await call(h, linked.desktopId)).toEqual(failure)
    // An answer larger than a bot may receive does not reach it.
    h.instance.hostDesktop.answer = () => ({ ok: true, value: 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(await call(h, linked.desktopId)).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })

    const own = await (await host('GET', '/internal/v1/host/desktop-links')).json()
    expect(own.links).toEqual([expect.objectContaining({ desktopId: linked.desktopId, botId: h.bot.id, self: true })])
    // Linking again renames the link and keeps the id the bot holds.
    const renamed = await host('PUT', `/internal/v1/host/bots/${h.bot.id}/desktop-link`, { name: 'Home' })
    expect(await renamed.json()).toMatchObject({ desktopId: linked.desktopId, name: 'Home' })
  })

  it('keeps a host token to its own links, and a bot’s token away from them', async () => {
    const { h, environmentId, host } = await hosted()
    const linked = await hostLink(host, h.bot.id)
    // A host token never acts as a bot.
    expect((await host('GET', '/internal/v1/desktops')).status).toBe(403)
    expect(
      (await host('POST', '/internal/v1/desktop/calls', { desktopId: linked.desktopId, op: 'listChats' })).status
    ).toBe(403)
    expect((await host('GET', '/internal/v1/peers')).status).toBe(403)
    // A bot's token never links an environment, nor reads its links.
    expect((await h.request('GET', '/internal/v1/host/desktop-links', undefined, true)).status).toBe(403)
    expect(
      (await h.request('PUT', `/internal/v1/host/bots/${h.bot.id}/desktop-link`, { name: 'Forged' }, true)).status
    ).toBe(403)
    expect((await h.request('DELETE', `/internal/v1/host/bots/${h.bot.id}/desktop-link`, undefined, true)).status).toBe(
      403
    )
    // A computer's token does not reach the internal API at all.
    const macbook = await mac(h, 'MacBook')
    expect((await h.request('GET', '/internal/v1/host/desktop-links', undefined, true, macbook.headers)).status).toBe(
      401
    )
    // The environment comes from the token, never from the request.
    const forged = await host('PUT', `/internal/v1/host/bots/${h.bot.id}/desktop-link`, {
      name: 'Forged',
      environmentId: 'other',
    })
    expect(forged.status).toBe(400)
    expect((await host('PUT', '/internal/v1/host/bots/missing/desktop-link', { name: 'Personal' })).status).toBe(404)

    // Another workspaces environment sees and removes only its own links.
    const other = h.lifecycle.createEnvironment({ name: 'Company', memoryLimitBytes: null, kind: 'workspaces' })
    await settled(h, other.id, 'running')
    const otherToken = h.store.hostGatewaySecrets(other.id)!.gatewayToken
    const otherHeaders = { ...macbook.headers, Authorization: 'Bearer ' + otherToken }
    const otherHost = (method: string, route: string) => h.request(method, route, undefined, true, otherHeaders)
    expect((await (await otherHost('GET', '/internal/v1/host/desktop-links')).json()).links).toEqual([])
    expect((await otherHost('DELETE', `/internal/v1/host/bots/${h.bot.id}/desktop-link`)).status).toBe(204)
    expect(h.store.desktopLinksOfEnvironment(environmentId)).toHaveLength(1)
    // An archived environment's token is refused.
    await h.lifecycle.archiveEnvironment(other.id)
    expect((await otherHost('GET', '/internal/v1/host/desktop-links')).status).toBe(401)
  })

  it('answers at once for an environment that does not take calls, and starts one that was stopped', async () => {
    const { h, environmentId, host } = await hosted()
    const linked = await hostLink(host, h.bot.id)
    await h.lifecycle.stopEnvironment(environmentId)
    expect((await desktops(h)).map((item) => item.online)).toEqual([false])
    const stopped = await call(h, linked.desktopId)
    expect(stopped).toMatchObject({
      ok: false,
      error: { code: 'desktop_offline', message: expect.stringContaining('it is starting now') },
    })
    await settled(h, environmentId, 'running')
    expect((await call(h, linked.desktopId)).ok).toBe(true)
    // An environment whose Maestrly cannot take calls is never sent one.
    const before = h.instance.hostDesktop.calls.length
    h.instance.provisioning.capabilities.splice(h.instance.provisioning.capabilities.indexOf('host-desktop-calls'), 1)
    await h.lifecycle.restartEnvironment(environmentId)
    await settled(h, environmentId, 'running')
    expect(await call(h, linked.desktopId)).toMatchObject({
      ok: false,
      error: { code: 'desktop_unavailable', message: expect.stringContaining('cannot take your calls yet') },
    })
    expect(h.instance.hostDesktop.calls).toHaveLength(before)
    // An archived environment is not started for a bot.
    await h.lifecycle.archiveEnvironment(environmentId)
    expect(await call(h, linked.desktopId)).toMatchObject({
      ok: false,
      error: { code: 'desktop_offline', message: expect.stringContaining('not available on this server') },
    })
    expect(h.store.getEnvironment(environmentId)?.archivedAt).not.toBeNull()
  })

  it('keeps an environment in use while it runs a call, and fails the call once it stops', async () => {
    const { h, environmentId, host } = await hosted()
    const linked = await hostLink(host, h.bot.id)
    h.instance.hostDesktop.hold = true
    const pending = call(h, linked.desktopId, 'waitEvents', { conversationId: 'c-1', cursor: 0 })
    await expect.poll(() => h.instance.hostDesktop.calls.length).toBe(1)
    expect(h.lifecycle.hostConnections(environmentId)).toBe(1)
    await h.lifecycle.stopEnvironment(environmentId)
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'desktop_offline', message: expect.stringContaining('stopped before it answered') },
    })
    expect(h.lifecycle.hostConnections(environmentId)).toBe(0)
    for (const release of h.instance.hostDesktop.released.splice(0)) release()
  })

  it('removes an environment’s link from a computer, by the host itself, or with the bot or the environment', async () => {
    const { h, environmentId, host } = await hosted()
    const macbook = await mac(h, 'MacBook')
    await macbook.connect()
    const linked = await hostLink(host, h.bot.id)
    // From one of the owner's computers: the environment is told to check its own side.
    expect((await macbook.request('DELETE', `/v1/bots/${h.bot.id}/desktop-links/${linked.desktopId}`)).status).toBe(204)
    await expect.poll(() => h.instance.hostDesktop.linksChanged).toEqual([h.bot.id])
    expect(await call(h, linked.desktopId)).toMatchObject({ ok: false, error: { code: 'desktop_not_linked' } })
    expect(await desktops(h)).toEqual([])

    // By the host itself.
    const again = await hostLink(host, h.bot.id)
    expect(again.desktopId).not.toBe(linked.desktopId)
    expect((await host('DELETE', `/internal/v1/host/bots/${h.bot.id}/desktop-link`)).status).toBe(204)
    expect(await desktops(h)).toEqual([])

    // With the bot: every environment that runs is told.
    await hostLink(host, h.bot.id)
    h.instance.hostDesktop.linksChanged.length = 0
    await h.lifecycle.archiveEnvironment(h.bot.environmentId!)
    expect((await h.request('DELETE', `/v1/archived-bots/${h.bot.id}`)).status).toBe(204)
    expect(h.store.desktopLinksOfEnvironment(environmentId)).toEqual([])
    await expect.poll(() => h.instance.hostDesktop.linksChanged).toEqual([h.bot.id])
  })

  it('takes the links of a deleted environment, and tells the computers', async () => {
    const { h, environmentId, host } = await hosted()
    const macbook = await mac(h, 'MacBook')
    await macbook.connect()
    await hostLink(host, h.bot.id)
    await h.lifecycle.archiveEnvironment(environmentId)
    // An archived environment keeps its links: restoring it brings its access back.
    expect(h.store.desktopLinksOfEnvironment(environmentId)).toHaveLength(1)
    expect((await desktops(h)).map((item) => item.online)).toEqual([false])
    const from = macbook.events.length
    await h.lifecycle.purgeEnvironment(environmentId)
    expect(h.store.desktopLinksOfEnvironment(environmentId)).toEqual([])
    const cleared = await macbook.next<Extract<FleetGatewayEvent, { type: 'desktop_link.updated' }>>(
      (event) => event.type === 'desktop_link.updated' && event.links.length === 0,
      from
    )
    expect(cleared.botId).toBe(h.bot.id)
  })

  it('counts computers and environments together toward the links of a bot', async () => {
    const { h, host } = await hosted()
    const auth = new Auth(h.store)
    for (let index = 0; index < 20; index++) {
      const { deviceId } = auth.pair(auth.createPairing().code, 'Mac ' + index, 'remote-' + index)
      h.store.saveDesktopLink(h.bot.id, deviceId, 'Mac ' + index, 'dsk_limit' + String(index).padStart(16, '0'))
    }
    const refused = await host('PUT', `/internal/v1/host/bots/${h.bot.id}/desktop-link`, { name: 'Personal' })
    expect(refused.status).toBe(409)
    expect((await refused.json()).message).toContain('computers and environments')
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

  it('gives up on a workspaces environment that does not answer, and stops waiting for it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-bridge-'))
    const store = new Store(dir)
    try {
      const signals: AbortSignal[] = []
      let answer: (signal: AbortSignal) => Promise<FleetDesktopCallResult> = (signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      const hosts: DesktopBridgeHosts = {
        state: () => 'online',
        wake: () => {},
        call: (_environmentId, _call, signal) => {
          signals.push(signal)
          return answer(signal)
        },
        linksChanged: () => {},
        online: () => ['host'],
      }
      const bridge = new DesktopBridge(store, new EventHub(async () => {}), { timeoutMs: 30, hosts })
      for (const [id, kind] of [
        ['e', 'bots'],
        ['host', 'workspaces'],
      ])
        store.db
          .prepare(
            "INSERT INTO environments(id,name,lifecycle,setup_json,container_name,volume_name,created_at,updated_at,kind) VALUES(?,?,'running','{}',?,?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',?)"
          )
          .run(id, id, 'c-' + id, 'v-' + id, kind)
      store.db
        .prepare(
          "INSERT INTO bots(id,name,role,instructions,tint,ceiling,selection_json,talks_to_json,paused,lifecycle,setup_json,created_at,updated_at,environment_id,slot) VALUES('b','B','','','#000000','ask','null','[]',0,'running','{}','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','e',1)"
        )
        .run()
      const link = store.saveEnvironmentDesktopLink('b', 'host', 'Personal', 'dsk_hosthosthosthosthost')
      const request = { desktopId: link.desktopId, op: 'sendMessage' as const, input: {} }
      expect(await bridge.call('b', request)).toMatchObject({
        ok: false,
        error: { code: 'desktop_timeout', message: expect.stringContaining('same idempotencyKey') },
      })
      // The request to the environment was given up along with the call.
      expect(signals.at(-1)?.aborted).toBe(true)
      expect(bridge.environmentCalls('host')).toBe(0)
      // An environment that cannot be reached fails the call with no detail of why.
      answer = async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.2:7680')
      }
      const failed = await bridge.call('b', request)
      expect(failed).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })
      expect(JSON.stringify(failed)).not.toContain('ECONNREFUSED')
      // A server shutting down ends the calls still waiting for an environment.
      answer = () => new Promise(() => {})
      void bridge.call('b', request)
      expect(bridge.environmentCalls('host')).toBe(1)
      bridge.close()
      expect(bridge.environmentCalls('host')).toBe(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
