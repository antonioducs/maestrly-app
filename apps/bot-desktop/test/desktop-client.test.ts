import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopInput } from '@maestrly/host-protocol'
import { DesktopClient, takeBatch, type DesktopRpc } from '../src/main/desktop-client'
import { DesktopViewServer } from '../src/main/desktop-view-server'
import { FixtureDesktops } from '../src/main/fixture-desktop'
import { validateResult } from '../src/main/host-client'
import type { DesktopViewEvent, HostTarget } from '../src/shared/types'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const sessionId = randomUUID()
  const desktops = new FixtureDesktops({
    later: (ms, fn) => void setTimeout(fn, Math.min(ms, 20)),
    sessionId: () => sessionId,
    activeTurn: () => undefined,
    turn: () => undefined,
    interrupt: () => {},
    continueTask: () => randomUUID(),
    event: () => {},
  })
  const server = new DesktopViewServer({ origins: () => ['file://'], alive: () => true })
  await server.start()
  const events: DesktopViewEvent[] = []
  const tickets: string[] = []
  let target: HostTarget = { kind: 'local', id: 'local', displayName: 'Este Mac', hostId: 'host-1' }
  const disconnect = vi.fn()
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const rpc: DesktopRpc = {
    request: async (method, params) => {
      requests.push({ method, params })
      return validateResult(method, await desktops.request(method, params))
    },
    disconnect,
  }
  const client = new DesktopClient({
    target: () => target,
    connect: async () => rpc,
    openMedia: async (_target, ticket) => {
      tickets.push(ticket)
      return { stream: desktops.media(ticket) }
    },
    server,
    emit: (_id, event) => events.push(event),
    clientInstanceId: 'window',
    pollMs: 10,
  })
  cleanups.push(async () => {
    client.reset('CLOSED')
    desktops.dispose()
    await server.close()
  })
  return { client, desktops, events, tickets, requests, disconnect, setTarget: (value: HostTarget) => { target = value } }
}
it('keeps media tickets and control capabilities in the main process', async () => {
  const f = await fixture()
  const opened = await f.client.open(7, 'bot-a')
  expect(opened.handle).toMatch(/^[a-f0-9-]{36}$/)
  expect(f.tickets).toHaveLength(1)
  const acquired = await f.client.acquire(7, opened.handle)
  expect(acquired.controlling).toBe(true)
  const capability = f.requests.find((r) => r.method === 'bot.desktop.input' || r.method === 'bot.desktop.renew')?.params.controlCapability
  const exposed = JSON.stringify([opened, acquired, f.events])
  expect(exposed).not.toContain(f.tickets[0])
  expect(exposed).not.toMatch(/controlCapability|mediaTicket/)
  if (typeof capability === 'string') expect(exposed).not.toContain(capability)
})
it('binds views to their renderer and applies input only while controlling', async () => {
  const f = await fixture()
  const opened = await f.client.open(7, 'bot-a')
  expect(() => f.client.input(7, opened.handle, [{ kind: 'pointer', x: 1, y: 1 }])).toThrow(expect.objectContaining({ code: 'CONTROL_EXPIRED' }))
  expect(() => f.client.input(8, opened.handle, [{ kind: 'pointer', x: 1, y: 1 }])).toThrow(expect.objectContaining({ code: 'DESKTOP_UNAVAILABLE' }))
  await expect(f.client.acquire(8, opened.handle)).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
  await f.client.acquire(7, opened.handle)
  f.client.input(7, opened.handle, [{ kind: 'text', text: 'ação' }, { kind: 'button', button: 'left', down: true, x: 300, y: 280 }, { kind: 'button', button: 'left', down: false, x: 300, y: 280 }])
  await vi.waitFor(() => expect(f.desktops.screen('bot-a').applied).toBe(3))
  expect(() => f.client.input(7, opened.handle, [{ kind: 'exec', command: 'rm -rf /' }])).toThrow()
  const inputs = f.requests.filter((r) => r.method === 'bot.desktop.input')
  expect(inputs.map((r) => r.params.sequence)).toEqual([0])
  const returned = await f.client.returnControl(7, { botId: 'bot-a', handle: opened.handle }, false)
  expect(returned).toMatchObject({ status: 'succeeded', continued: false, state: { mode: 'bot' } })
  expect(() => f.client.input(7, opened.handle, [{ kind: 'pointer', x: 1, y: 1 }])).toThrow(expect.objectContaining({ code: 'CONTROL_EXPIRED' }))
})
it('closing the renderer or changing Host ends every view; nothing is reused', async () => {
  const f = await fixture()
  const first = await f.client.open(7, 'bot-a')
  await f.client.acquire(7, first.handle)
  f.client.revoke(7)
  await vi.waitFor(() => expect(f.events.some((e) => e.handle === first.handle && e.phase === 'closed')).toBe(true))
  expect(() => f.client.input(7, first.handle, [{ kind: 'pointer', x: 1, y: 1 }])).toThrow(expect.objectContaining({ code: 'DESKTOP_UNAVAILABLE' }))
  // Closing while in control pauses the bot on the Host side.
  await vi.waitFor(async () => expect((await f.client.inspect('bot-a')).mode).toBe('paused'))
  const second = await f.client.open(7, 'bot-b')
  f.setTarget({ kind: 'ssh', id: 'ssh:mini', alias: 'mini', displayName: 'mini', hostId: 'host-2' })
  await f.client.inspect('bot-b').catch(() => {})
  expect(f.events.find((e) => e.handle === second.handle && e.phase === 'closed')?.reason).toBe('TARGET_CHANGED')
  expect(f.disconnect).toHaveBeenCalled()
})
it('orders input batches and collapses only consecutive pointer motion', () => {
  const queue: DesktopInput[] = [
    { kind: 'pointer', x: 1, y: 1 },
    { kind: 'pointer', x: 2, y: 2 },
    { kind: 'button', button: 'left', down: true, x: 2, y: 2 },
    { kind: 'pointer', x: 3, y: 3 },
    { kind: 'pointer', x: 4, y: 4 },
    { kind: 'key', code: 'KeyA', keysym: 0x61, down: true },
    { kind: 'key', code: 'KeyA', keysym: 0x61, down: false },
  ]
  expect(takeBatch(queue)).toEqual([
    { kind: 'pointer', x: 2, y: 2 },
    { kind: 'button', button: 'left', down: true, x: 2, y: 2 },
    { kind: 'pointer', x: 4, y: 4 },
    { kind: 'key', code: 'KeyA', keysym: 0x61, down: true },
    { kind: 'key', code: 'KeyA', keysym: 0x61, down: false },
  ])
  const long: DesktopInput[] = [{ kind: 'text', text: 'a'.repeat(4000) }, { kind: 'text', text: 'b'.repeat(200) }]
  expect(takeBatch(long)).toHaveLength(1)
  expect(long).toHaveLength(1)
})
