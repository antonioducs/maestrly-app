import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { access } from 'node:fs/promises'
import { test, expect, type ElectronApplication } from '@playwright/test'
import { WebSocket } from 'ws'
import {
  MobileBridgeClient,
  type MobileBridgeSocket,
  type MobileBridgeState,
  type MobileEvent,
} from '@maestrly/bot-fleet-protocol'
import { desktop, fixtureModel, launchHost, listen, portOf } from './helpers/remote-host'

/** A socket to the host's control server as the gateway opens it: the control token travels, no Origin. */
function hostSocket(port: number, token: string): MobileBridgeSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/v1/bridge`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Maestrly-Fleet-Protocol': '1' },
  }) as unknown as MobileBridgeSocket
}

/** A computer's bridge session, only to configure the host's model account as a person's desktop would. */
async function configureModel(port: number, token: string, appVersion: string, baseURL: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/bridge`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Maestrly-Fleet-Protocol': '1' },
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const results = new Map<number, (value: { ok: boolean; value?: unknown }) => void>()
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data))
    if (frame.t === 'result') results.get(frame.id)?.(frame)
  })
  let id = 0
  const invoke = (channel: string, ...args: unknown[]) =>
    new Promise<{ ok: boolean; value?: any }>((resolve) => {
      results.set(++id, resolve)
      socket.send(JSON.stringify({ t: 'invoke', id, origin: 1, channel, args }))
    })
  socket.send(
    JSON.stringify({
      t: 'hello',
      protocol: 1,
      appVersion,
      client: { deviceName: 'Laptop', os: 'mac', locale: 'en' },
    })
  )
  socket.send(JSON.stringify({ t: 'open', origin: 1, role: 'main' }))
  const provider = await invoke('chat:provider-add', {
    name: 'Phone fixture',
    kind: 'openai',
    key: 'fixture-key',
    baseURL,
  })
  expect(provider.value?.ok).toBe(true)
  await invoke('chat:set-default', { providerId: provider.value.id, modelId: 'remote-fixture' })
  socket.close()
}

// The built app in server mode, as a workspaces environment runs it, and a phone speaking the mobile API to it over
// the bridge the gateway would pass through: the mobile client of the protocol package, as the app uses it.
test('mobile bridge: a phone lists, creates and streams a chat on a workspaces host', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-mobile-bridge-')))
  const model = fixtureModel()
  let host: ElectronApplication | undefined
  let client: MobileBridgeClient | undefined
  try {
    await listen(model.server)
    const workspacesRoot = path.join(root, 'srv')
    await mkdir(workspacesRoot)
    const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot)
    host = launched.app
    const health = await (
      await fetch(`http://127.0.0.1:${launched.port}/v1/health`, {
        headers: { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${launched.token}` },
      })
    ).json()
    expect(health.capabilities).toContain('mobile-api')
    await configureModel(
      launched.port,
      launched.token,
      health.appVersion,
      `http://127.0.0.1:${portOf(model.server)}/v1`
    )

    const states: MobileBridgeState[] = []
    const events: MobileEvent[] = []
    // An app version the host has never heard of: a phone needs the same mobile API, not the same build.
    client = new MobileBridgeClient({
      connect: async () => hostSocket(launched.port, launched.token),
      appVersion: '9.9.9',
      client: { deviceName: 'iPhone', os: 'ios', locale: 'pt-BR' },
      onEvent: (event) => events.push(event),
      onState: (state) => states.push(state),
    })
    client.start()
    await expect.poll(() => states.at(-1)).toBe('open')

    expect(await client.invoke('lists', {})).toEqual({ workspaces: [], chats: [] })
    const chat = await client.invoke('create', { workspaceId: null, name: 'From the phone' })
    expect(chat).toMatchObject({ name: 'From the phone', workspaceId: null, status: 'idle' })
    const opened = await client.invoke('open', { conversationId: chat.id })
    expect(opened.page.items).toEqual([])

    const clientId = '550e8400-e29b-41d4-a716-446655440000'
    expect(
      await client.invoke('send', { conversationId: chat.id, text: 'Hello from the phone', attachments: [], clientId })
    ).toEqual({ status: 'started' })
    // The answer streams to the phone as transcript items.
    await expect
      .poll(
        () =>
          events
            .filter((event) => event.key === 'items' && event.payload.conversationId === chat.id)
            .flatMap((event) => (event.key === 'items' ? event.payload.items : []))
            .filter((item) => item.kind === 'assistant' && !item.streaming)
            .map((item) => (item.kind === 'assistant' ? item.text : '')),
        { timeout: 60_000 }
      )
      .toContain('Answered on the host, turn 1.')
    expect(model.requests).toHaveLength(1)
    // A resend after a reconnect is not sent twice.
    expect(
      await client.invoke('send', { conversationId: chat.id, text: 'Hello from the phone', attachments: [], clientId })
    ).toEqual({ status: 'duplicate' })

    const reopened = await client.invoke('open', { conversationId: chat.id })
    expect(reopened.page.items.map((item) => item.kind)).toEqual(['user', 'assistant'])
    expect(reopened.page.items[0]).toMatchObject({ kind: 'user', text: 'Hello from the phone' })

    // The phone reads and changes the chat's setup, and chooses from the models the host's accounts offer.
    const setup = await client.invoke('setup', { conversationId: chat.id })
    expect(setup.mode).toBe('ask')
    expect((await client.invoke('setSetup', { conversationId: chat.id, patch: { mode: 'agent' } })).mode).toBe('agent')
    const models = await client.invoke('models', {})
    expect(models.options.map((option) => option.modelId)).toContain('remote-fixture')

    const lists = await client.invoke('lists', {})
    expect(lists.chats.map((item) => item.name)).toEqual(['From the phone'])
    // The host's language stays as it was: the phone said pt-BR.
    expect(lists.chats[0].status).not.toBe('error')
  } finally {
    client?.stop()
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
