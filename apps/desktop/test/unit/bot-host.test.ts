/**
 * Lifecycle of the bot endpoint this desktop embeds, driven through the host the IPC layer calls.
 *
 * The listener, the OAuth server, the local relay and the SQLite store are the real ones, so every case
 * below is answered over the wire exactly as a bot would see it. Only the native chat runtime and the
 * model catalog are stubbed: starting a turn needs an account and a repository, and none of that is
 * what this suite is about.
 */
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  broadcast: vi.fn(),
  capabilities: [
    { providerId: 'grok', providerLabel: 'Grok', modelId: 'grok-4', reasoningEfforts: [], fastMode: false },
  ],
}))

vi.mock('../../src/main/window-ipc', () => ({ broadcast: h.broadcast }))
vi.mock('../../src/main/workspace-service', () => ({ renameConversation: vi.fn() }))
vi.mock('../../src/main/chat/service', () => ({
  listChatRunnerCapabilities: async () => h.capabilities,
  stopChatAndWait: async () => true,
}))
vi.mock('../../src/main/git-service', () => ({
  listBranches: async () => ({ local: ['main'], remoteRefs: [] }),
  createWorktree: async () => ({}),
  listWorktrees: async () => [],
}))
// The native runtime is never reached here; a bot turn has its own suites.
vi.mock('../../src/main/bot/native-host', () => ({
  NativeBotChatHost: class {
    async configure(): Promise<void> {}
    async start(): Promise<never> {
      throw new Error('The native chat runtime is not part of this suite.')
    }
  },
}))

import { BotHost } from '../../src/main/bot/host'
import { BotModelCatalog } from '../../src/main/bot/catalog'
import { getAppSetting, getConversation, getDb, setAppSetting } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const PUBLISHED = 'https://bots.maestrly.test'
const MOVED = 'https://moved.maestrly.test'
const REDIRECT = 'http://127.0.0.1:9931/callback'
const LEGACY_KEY = 'bot.connections.v1'

let host: BotHost
let port: number
let origin: string

/** A port nothing is bound to, so a test never collides with another suite by accident. */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const chosen = (probe.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return chosen
}

const enable = (patch: Record<string, unknown> = {}) =>
  host.configureServer({ enabled: true, host: '127.0.0.1', port, publicUrl: PUBLISHED, ...patch })

const at = (base: string, path: string) => `${base}${path}`

beforeEach(async () => {
  vi.clearAllMocks()
  freshDb()
  host = new BotHost()
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await host.dispose()
  closeDb()
})

/** A connection the owner made on this computer, the only thing a bot can ever be authorized as. */
async function connect(name = 'Grok Bot') {
  const workspace = makeWorkspace()
  const view = await host.connect({ name, workspaceIds: [workspace.id], providerIds: ['grok'] })
  const connection = view.connections.find((item) => item.name === name)
  expect(connection).toBeDefined()
  return { workspace, connection: connection! }
}

/**
 * The whole authorization a bot performs: it registers itself, is sent here, waits while the person at
 * this computer approves it and names the connection, and only then redeems its code.
 */
async function authorizedToken(connectionId: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const registration = await fetch(at(origin, '/oauth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Grok', redirect_uris: [REDIRECT] }),
  })
  expect(registration.status).toBe(201)
  const clientId = ((await registration.json()) as { client_id: string }).client_id
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
  })
  const consent = await fetch(at(origin, `/oauth/authorize?${params}`), { redirect: 'manual' })
  expect(consent.status).toBe(200)
  const poll = (await consent.text()).match(/\/oauth\/authorize\/status\?poll=([A-Za-z0-9_\-%]+)/)
  expect(poll).not.toBeNull()
  const waiting = host.settings().pendingAuthorizations
  expect(waiting).toHaveLength(1)
  host.authorize(waiting[0].id, true, connectionId)
  const ready = await fetch(at(origin, `/oauth/authorize/status?poll=${poll![1]}`))
  const state = (await ready.json()) as { status: string; redirectTo: string }
  expect(state.status).toBe('ready')
  const code = new URL(state.redirectTo).searchParams.get('code') ?? ''
  const granted = await fetch(at(origin, '/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).toString(),
  })
  expect(granted.status).toBe(200)
  return ((await granted.json()) as { access_token: string }).access_token
}

/** What a bot does with the token it holds; only a usable token reaches the tool catalog. */
async function listTools(token: string, base = origin): Promise<number> {
  const response = await fetch(at(base, '/mcp/bots'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  return response.status
}

/** The approval modes this desktop actually published to a bot, read back from its saved inventory. */
const published = (connectionId: string): string[] => {
  const row = getDb()
    .prepare('SELECT payload FROM bot_local_inventory WHERE connection_id=?')
    .get(connectionId) as unknown as { payload: string } | undefined
  const inventory = JSON.parse(row?.payload ?? '{"selections":[]}') as {
    selections: Array<{ permissionModes: string[] }>
  }
  return [...new Set(inventory.selections.flatMap((selection) => selection.permissionModes))]
}

const count = (table: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as unknown as { total: number }).total

describe('the embedded bot endpoint', () => {
  it('serializes overlapping starts and closes every listener on stop', async () => {
    await Promise.all([enable(), enable()])
    expect(host.settings().server.state).toBe('listening')
    await host.stop()
    await expect(fetch(at(origin, '/.well-known/oauth-authorization-server'))).rejects.toThrow()
  })

  it('waits for an in-flight start before shutdown completes', async () => {
    const starting = enable()
    await host.stop()
    await starting
    expect(host.settings().server.state).toBe('stopped')
    await expect(fetch(at(origin, '/.well-known/oauth-authorization-server'))).rejects.toThrow()
  })

  it('publishes the configured address and releases the listener on shutdown', async () => {
    const view = await enable({ publicUrl: `${PUBLISHED}/` })
    expect(view.server).toMatchObject({ state: 'listening', enabled: true, port, publicUrl: PUBLISHED })
    expect(view.server.error).toBeUndefined()
    const discovery = await fetch(at(origin, '/.well-known/oauth-protected-resource/mcp/bots'))
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toMatchObject({
      resource: `${PUBLISHED}/mcp/bots`,
      authorization_servers: [PUBLISHED],
    })

    await host.stop()

    expect(host.settings().server.state).toBe('stopped')
    await expect(fetch(at(origin, '/.well-known/oauth-protected-resource/mcp/bots'))).rejects.toThrow()
  })

  it('refuses to enable the endpoint until an address is published', async () => {
    const view = await enable({ publicUrl: '' })
    expect(view.server).toMatchObject({ state: 'error', publicUrl: '' })
    expect(view.server.error).toMatch(/HTTPS address/)
    expect(view.state).toBe('stopped')
  })

  it('reports a port already in use and binds again once it is free', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
    try {
      const view = await enable()
      expect(view.server.state).toBe('error')
      expect(view.server.error).toMatch(/EADDRINUSE/)
      // A listener that could not bind is not a failed application: nothing else is disturbed.
      expect(view.state).toBe('stopped')
      expect(view.error).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    expect((await enable()).server.state).toBe('listening')
  })

  it('restores the endpoint and the connections saved on this computer at startup', async () => {
    const { connection } = await connect()
    await enable()
    await host.stop()
    const restarted = new BotHost()
    try {
      await restarted.restore()
      const view = restarted.settings()
      expect(view.server.state).toBe('listening')
      expect(view.state).toBe('connected')
      expect(view.connections.map((item) => item.id)).toEqual([connection.id])
    } finally {
      await restarted.dispose()
    }
  })

  it('keeps a bot authorized while the listener moves and drops it when the address moves', async () => {
    const { connection } = await connect()
    await enable()
    const token = await authorizedToken(connection.id)
    expect(await listTools(token)).toBe(200)

    // The local port is not the audience: moving it must not ask every bot to authorize again.
    const moved = await freePort()
    await enable({ port: moved })
    expect(await listTools(token, `http://127.0.0.1:${moved}`)).toBe(200)

    // A different published address is a different audience, so nothing issued under the old one lives.
    await enable({ port: moved, publicUrl: MOVED })
    expect(await listTools(token, `http://127.0.0.1:${moved}`)).toBe(401)
    expect(count('bot_oauth_tokens')).toBe(0)
    expect(count('bot_oauth_requests')).toBe(0)
  })

  it('leaves a revoked connection nothing to act with and takes its chats back', async () => {
    const { workspace, connection } = await connect()
    await enable()
    const token = await authorizedToken(connection.id)
    expect(await listTools(token)).toBe(200)
    const conversation = makeConversation(workspace.id)
    const botOrigin = JSON.stringify({ kind: 'bot', connectionId: connection.id, botName: 'Grok Bot' })
    getDb()
      .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
      .run(botOrigin, conversation.id)

    const view = await host.revoke(connection.id)

    expect(view.connections[0]).toMatchObject({ id: connection.id, revokedAt: expect.any(String) })
    expect(view.state).toBe('stopped')
    expect(await listTools(token)).toBe(401)
    expect(count('bot_oauth_tokens')).toBe(0)
    expect(getConversation(conversation.id)?.botManagementState).toBe('revoked')
  })

  it('keeps a connection saved by the relayed release readable, revocable and never authorizable', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const saved = {
      id: 'legacy-connection',
      name: 'Relayed bot',
      clientId: 'relayed-client',
      desktopId: 'relayed-desktop',
      workspaceIds: [workspace.id],
      revokedAt: null,
      mcpConfig: '{"mcpServers":{"maestrly":{}}}',
      actions: ['chats:read'],
    }
    setAppSetting(LEGACY_KEY, JSON.stringify([saved]))
    getDb()
      .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
      .run(JSON.stringify({ kind: 'bot', connectionId: saved.id, botName: saved.name }), conversation.id)

    expect(host.settings().connections).toEqual([
      expect.objectContaining({ id: saved.id, legacy: true, mcpConfig: saved.mcpConfig, revokedAt: null }),
    ])
    // It never ran here, so it can neither be re-scoped nor be handed a token.
    await expect(host.updateWorkspaces(saved.id, [workspace.id])).rejects.toThrow(/Reconnect/)
    expect(() => host.authorize('any-request', true, saved.id)).toThrow()

    const view = await host.revoke(saved.id)

    expect(view.connections[0]).toMatchObject({ id: saved.id, legacy: true, revokedAt: expect.any(String) })
    expect(getConversation(conversation.id)?.botManagementState).toBe('revoked')
    // The record is marked, never deleted: what a bot once did on this computer stays explainable.
    expect(JSON.parse(getAppSetting(LEGACY_KEY) ?? '[]')).toHaveLength(1)
  })

  it('offers a bot only the approval modes the person allowed it, and refuses anything past them', async () => {
    const workspace = makeWorkspace()
    const view = await host.connect({
      name: 'Approving bot',
      workspaceIds: [workspace.id],
      providerIds: ['grok'],
      permissionCeiling: 'auto',
    })
    const connection = view.connections.find((item) => item.name === 'Approving bot')!
    expect(connection.permissionCeiling).toBe('auto')
    expect(published(connection.id)).toEqual(['ask', 'auto'])

    // Up to the ceiling is the bot's to ask for; anything past it is refused with the owner's gate.
    const catalog = new BotModelCatalog(['grok'], undefined, 'auto')
    const selectionId = (await catalog.selections())[0]!.selectionId
    expect(await catalog.resolve({ selectionId, permissionMode: 'auto' })).toMatchObject({ permissionMode: 'auto' })
    // Asking for nothing runs at the ceiling: what the person allowed is what applies.
    expect(await catalog.resolve({ selectionId })).toMatchObject({ permissionMode: 'auto' })
    await expect(catalog.resolve({ selectionId, permissionMode: 'full' })).rejects.toThrow(/owner approval/i)

    // Moving the ceiling republishes what a bot may ask for; a bot never moves it itself.
    const narrowed = await host.setPermissionCeiling(connection.id, 'ask')
    expect(narrowed.connections.find((item) => item.id === connection.id)?.permissionCeiling).toBe('ask')
    expect(published(connection.id)).toEqual(['ask'])
    expect((await host.setPermissionCeiling(connection.id, 'full')).connections[0]?.permissionCeiling).toBe('full')
    expect(published(connection.id)).toEqual(['ask', 'auto', 'full'])
  })

  it('never lets a connection from the relayed release be given a ceiling here', async () => {
    setAppSetting(
      LEGACY_KEY,
      JSON.stringify([
        {
          id: 'legacy-connection',
          name: 'Relayed bot',
          clientId: 'relayed-client',
          desktopId: 'relayed-desktop',
          workspaceIds: [],
          revokedAt: null,
          mcpConfig: '{}',
          actions: ['chats:read'],
        },
      ])
    )
    expect(host.settings().connections[0]).toMatchObject({ legacy: true, permissionCeiling: 'ask' })
    await expect(host.setPermissionCeiling('legacy-connection', 'full')).rejects.toThrow(/Reconnect/)
  })

  it('hides an unreadable saved record without deleting it or failing the screen', async () => {
    setAppSetting(LEGACY_KEY, 'not json at all')
    const view = host.settings()
    expect(view.connections).toEqual([])
    expect(view.state).toBe('stopped')
    expect(getAppSetting(LEGACY_KEY)).toBe('not json at all')
  })
})
