import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMcpNeedsAuthError } from '../../src/main/chat/mcp-auth-errors'
import { addMcpServer, connectMcpServer, listMcpServers, removeMcpServer } from '../../src/main/chat/mcp'
import {
  activeMcpOAuthAccounts,
  forgetMcpOAuth,
  hostMcpOAuthProvider,
  mcpOAuthClient,
  mcpOAuthSummary,
  patchMcpOAuthAccount,
  resetMcpOAuthStatusForTests,
  saveMcpOAuthAccount,
  setMcpOAuthClient,
  sweepOrphanMcpOAuth,
} from '../../src/main/chat/mcp-oauth'
import { browserSafeUrl, McpOAuthConnectFailure, runMcpOAuthConnect } from '../../src/main/chat/mcp-oauth-connect'
import {
  connectMcpOAuth,
  forgetMcpOAuthChannel,
  localMcpOAuthHostCalls,
  mcpOAuthDescriptor,
  storeMcpOAuth,
} from '../../src/main/chat/mcp-oauth-ipc'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { pluginLayout } from '../../src/main/plugins/layout'
import { installedDto } from '../../src/main/plugins/service'
import { secureGet, secureSet } from '../../src/main/secure-store'
import { remoteChannelRefusal } from '../../src/shared/host-channels'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { browser, fakeOAuthServer } from '../helpers/fake-oauth-mcp'
import { codexDemoPlugin, installFixturePlugin } from '../helpers/plugin-install'

let fake: Awaited<ReturnType<typeof fakeOAuthServer>>
beforeEach(() => {
  freshDb()
  resetMcpOAuthStatusForTests()
})
afterEach(async () => {
  await fake?.close()
  setAppPluginLayoutForTests(null)
  closeDb()
})

const userServer = () => addMcpServer({ name: 'Protected', transport: 'http', url: fake.url }, { requireSecure: true })

describe('MCP OAuth sign-in', () => {
  it('signs in on this computer, stores the result on the host, and connects with the token', async () => {
    fake = await fakeOAuthServer()
    const added = userServer()
    const descriptor = mcpOAuthDescriptor(added.id)
    expect(descriptor).toEqual({ serverId: added.id, name: 'Protected', url: fake.url })

    const opened: string[] = []
    const result = await connectMcpOAuth(localMcpOAuthHostCalls, 'local', added.id, {
      openExternal: async (url) => {
        opened.push(url)
        await browser(url)
      },
    })
    expect(result).toEqual({ ok: true })
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]).searchParams.get('code_challenge_method')).toBe('S256')
    expect(fake.state.registrations).toBe(1)
    expect(fake.state.lastResource).toBe(fake.url)

    const [server] = listMcpServers()
    expect(mcpOAuthSummary(server)).toEqual({
      needsAuth: false,
      client: null,
      accounts: [
        {
          id: expect.stringMatching(/^acc_[0-9a-f]{12}$/),
          label: 'Account 1',
          email: null,
          scope: { kind: 'global' },
          status: 'connected',
        },
      ],
    })
    const connection = await connectMcpServer(server)
    const output = await connection.callTool('whoami')
    await connection.close()
    expect(JSON.stringify(output.content)).toContain('token:at-1')
  })

  it('never registers a client or opens a browser in the background: the server needs sign-in', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    const error = await connectMcpServer(server).catch((cause) => cause)
    expect(isMcpNeedsAuthError(error)).toBe(true)
    expect(String(error.message)).toContain('connect "Protected" in Settings')
    expect(fake.state.registrations).toBe(0)
    expect(fake.state.authorizations).toBe(0)
    expect(mcpOAuthSummary(server)).toEqual({ needsAuth: true, accounts: [], client: null })
  })

  it('refreshes an expired token on the host and keeps the new one', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    await connectMcpOAuth(localMcpOAuthHostCalls, 'local', server.id, { openExternal: browser })
    fake.state.validTokens.delete('at-1')
    const connection = await connectMcpServer(server)
    const output = await connection.callTool('whoami')
    await connection.close()
    expect(JSON.stringify(output.content)).toContain('token:at-2')
    expect(fake.state.refreshes).toBe(1)
    expect(await hostMcpOAuthProvider(server).tokens()).toMatchObject({ access_token: 'at-2' })
  })

  it('drops the sign-in when the server is removed or signed out', async () => {
    fake = await fakeOAuthServer()
    const added = userServer()
    await connectMcpOAuth(localMcpOAuthHostCalls, 'local', added.id, { openExternal: browser })
    expect(forgetMcpOAuthChannel(added.id)).toEqual({ ok: true })
    expect(mcpOAuthSummary(listMcpServers()[0])).toEqual({ needsAuth: false, accounts: [], client: null })
    await connectMcpOAuth(localMcpOAuthHostCalls, 'local', added.id, { openExternal: browser })
    removeMcpServer(added.id)
    expect(await hostMcpOAuthProvider({ ...added }).tokens()).toBeUndefined()
  })

  it('reports servers without dynamic registration, declined consent, and cancellation', async () => {
    fake = await fakeOAuthServer({ registration: false })
    const descriptor = { serverId: 'mcp_x', name: 'X', url: fake.url }
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error) => (error instanceof McpOAuthConnectFailure ? error.code : 'other')
      )
    expect(
      await failure(runMcpOAuthConnect({ descriptor, openExternal: browser, signal: new AbortController().signal }))
    ).toBe('registration-unsupported')
    await fake.close()

    fake = await fakeOAuthServer({ deny: true })
    expect(
      await failure(
        runMcpOAuthConnect({
          descriptor: { ...descriptor, url: fake.url },
          openExternal: browser,
          signal: new AbortController().signal,
        })
      )
    ).toBe('denied')

    const controller = new AbortController()
    expect(
      await failure(
        runMcpOAuthConnect({
          descriptor: { ...descriptor, url: fake.url },
          openExternal: async () => controller.abort(),
          signal: controller.signal,
        })
      )
    ).toBe('cancelled')
  })

  it.each([
    ['https://auth.example/authorize', true],
    ['http://127.0.0.1:8080/authorize', true],
    ['http://localhost/authorize', true],
    ['http://auth.example/authorize', false],
    ['https://user:pass@auth.example/authorize', false],
    ['file:///etc/passwd', false],
    ['smb://share.example/x', false],
    ['vscode://extension/run', false],
  ])('opens only web authorization URLs in the browser: %s', (url, safe) => {
    expect(browserSafeUrl(new URL(url))).toBe(safe)
  })

  it('never opens an unsafe authorization endpoint advertised by the server', async () => {
    fake = await fakeOAuthServer({ authorizationEndpoint: 'vscode://evil.example/authorize' })
    const opened: string[] = []
    const error = await runMcpOAuthConnect({
      descriptor: { serverId: 'mcp_x', name: 'X', url: fake.url },
      openExternal: async (url) => {
        opened.push(url)
      },
      signal: new AbortController().signal,
    }).catch((cause) => cause)
    expect(error).toBeInstanceOf(McpOAuthConnectFailure)
    expect(error.message).toContain('unsafe authorization URL')
    expect(opened).toEqual([])
  })

  it('stores only a valid bundle for the server it was made for', async () => {
    fake = await fakeOAuthServer()
    const added = userServer()
    const bundle = {
      url: fake.url,
      redirectUri: 'http://127.0.0.1:4567/callback',
      clientInformation: { client_id: 'c' },
      tokens: { access_token: 'a', token_type: 'Bearer' },
    }
    expect(storeMcpOAuth('not-an-id', bundle)).toEqual({ ok: false, error: 'invalid-input' })
    expect(storeMcpOAuth(added.id, { ...bundle, redirectUri: 'https://evil.example/callback' })).toEqual({
      ok: false,
      error: 'invalid-input',
    })
    expect(storeMcpOAuth(added.id, { ...bundle, url: 'https://elsewhere.example/mcp' })).toEqual({
      ok: false,
      error: 'server-changed',
    })
    expect(storeMcpOAuth(added.id, bundle)).toEqual({ ok: true })
    // A sign-in made for another URL is not used once the server points elsewhere.
    expect(saveMcpOAuthAccount({ id: added.id, url: 'https://other.example/mcp' }, bundle, {})).toEqual({
      ok: false,
      error: 'server-changed',
    })
  })

  it('drops sign-ins of servers that no longer exist at startup', async () => {
    fake = await fakeOAuthServer()
    const kept = userServer()
    const bundle = (url: string) => ({
      url,
      redirectUri: 'http://127.0.0.1:4567/callback',
      clientInformation: { client_id: 'c' },
      tokens: { access_token: 'a', token_type: 'Bearer' },
    })
    expect(storeMcpOAuth(kept.id, bundle(fake.url))).toEqual({ ok: true })
    const gone = { id: 'mcp_00000000-0000-0000-0000-000000000001', url: 'https://gone.example/mcp' }
    expect(saveMcpOAuthAccount(gone, bundle(gone.url), {})).toMatchObject({ ok: true })
    expect(sweepOrphanMcpOAuth(new Set([kept.id]))).toBe(1)
    expect(mcpOAuthSummary(listMcpServers()[0]).accounts).toHaveLength(1)
    expect(mcpOAuthSummary({ ...gone, transport: 'http' }).accounts).toEqual([])
  })

  it('signs in to a plugin server that declares OAuth, with the scopes it asks for', async () => {
    fake = await fakeOAuthServer()
    const layout = pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-plugin-')))
    setAppPluginLayoutForTests(layout)
    const record = await installFixturePlugin(layout, {
      name: 'signed',
      files: codexDemoPlugin('signed', {}, { remote: { url: fake.url, scopes: ['notes.read'] } }),
    })
    const id = record.servers.remote.id
    const before = await installedDto(record)
    expect(before.setup.serversNeedingAuth).toEqual(['remote'])
    expect(before.mcpServers.find((server) => server.key === 'remote')?.oauth).toEqual({
      needsAuth: true,
      accounts: [],
      client: null,
    })
    expect(mcpOAuthDescriptor(id)).toMatchObject({ serverId: id, url: fake.url, scopes: ['notes.read'] })

    expect(await connectMcpOAuth(localMcpOAuthHostCalls, 'local', id, { openExternal: browser })).toEqual({ ok: true })
    expect(fake.state.lastScope).toBe('notes.read')
    const after = await installedDto(record)
    expect(after.setup.serversNeedingAuth).toEqual([])
    expect(after.mcpServers.find((server) => server.key === 'remote')?.oauth).toMatchObject({
      needsAuth: false,
      accounts: [{ label: 'Account 1', status: 'connected' }],
    })
  })

  it('keeps the browser part on this computer', () => {
    expect(remoteChannelRefusal('mcp-oauth:connect')).not.toBeNull()
    expect(remoteChannelRefusal('mcp-oauth:cancel')).not.toBeNull()
    expect(remoteChannelRefusal('chat:mcp-oauth:store')).toBeNull()
    expect(mcpOAuthDescriptor('mcp_00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('several MCP sign-in accounts per server', () => {
  const bundle = (url: string, token: string, email?: string) => ({
    url,
    redirectUri: 'http://127.0.0.1:4567/callback',
    clientInformation: { client_id: 'c' },
    tokens: { access_token: token, token_type: 'Bearer', refresh_token: `r-${token}` },
    ...(email ? { email } : {}),
  })
  const labels = (server: Parameters<typeof mcpOAuthSummary>[0]) =>
    mcpOAuthSummary(server).accounts.map((account) => account.label)
  const accountId = (result: ReturnType<typeof saveMcpOAuthAccount>) => {
    if (!result.ok) throw new Error(result.error)
    return result.accountId
  }

  it('adds accounts with default labels, keeps an account on a new sign-in, and forgets one at a time', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    const a = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'a'), {}))
    const b = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'b'), {}))
    expect(a).not.toBe(b)
    expect(labels(server)).toEqual(['Account 1', 'Account 2'])
    expect(saveMcpOAuthAccount(server, bundle(fake.url, 'c'), { label: 'account 1' })).toEqual({
      ok: false,
      error: 'label-taken',
    })

    expect(saveMcpOAuthAccount(server, bundle(fake.url, 'a2'), { accountId: a })).toEqual({ ok: true, accountId: a })
    expect(labels(server)).toEqual(['Account 1', 'Account 2'])
    expect(await hostMcpOAuthProvider({ ...server, oauthAccountId: a }).tokens()).toMatchObject({ access_token: 'a2' })
    expect(await hostMcpOAuthProvider({ ...server, oauthAccountId: b }).tokens()).toMatchObject({ access_token: 'b' })
    expect(saveMcpOAuthAccount(server, bundle(fake.url, 'x'), { accountId: 'acc_000000000000' })).toEqual({
      ok: false,
      error: 'unknown-account',
    })

    expect(patchMcpOAuthAccount(server.id, b, { label: 'Work' })).toEqual({ ok: true })
    expect(patchMcpOAuthAccount(server.id, b, { label: 'ACCOUNT 1' })).toEqual({ ok: false, error: 'label-taken' })
    expect(patchMcpOAuthAccount(server.id, b, { label: '  ' })).toEqual({ ok: false, error: 'invalid-label' })
    expect(patchMcpOAuthAccount(server.id, 'acc_000000000000', { label: 'X' })).toEqual({
      ok: false,
      error: 'unknown-account',
    })

    forgetMcpOAuth(server.id, a)
    expect(labels(server)).toEqual(['Work'])
    forgetMcpOAuth(server.id)
    expect(mcpOAuthSummary(server)).toEqual({ needsAuth: false, accounts: [], client: null })
  })

  it('labels an account by its e-mail and signs the same e-mail in again instead of adding it twice', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    const alice = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'a', 'alice@example.test'), {}))
    expect(mcpOAuthSummary(server).accounts).toEqual([
      expect.objectContaining({ id: alice, label: 'alice@example.test', email: 'alice@example.test' }),
    ])
    expect(saveMcpOAuthAccount(server, bundle(fake.url, 'a2', 'Alice@Example.test'), {})).toEqual({
      ok: true,
      accountId: alice,
    })
    expect(mcpOAuthSummary(server).accounts).toHaveLength(1)
  })

  it('offers each account only where its scope applies', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    const w1 = makeWorkspace()
    const p1 = makeConversation(w1.id)
    const standalone = makeStandaloneConversation()
    const a = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'a'), {}))
    const b = accountId(
      saveMcpOAuthAccount(server, bundle(fake.url, 'b'), { scope: { kind: 'projects', workspaceIds: [w1.id] } })
    )
    const ids = (conversationId: string | null | undefined) =>
      activeMcpOAuthAccounts(server, conversationId).map((account) => account.id)
    expect(ids(p1.id)).toEqual([a, b])
    expect(ids(standalone.id)).toEqual([a])
    expect(ids(null)).toEqual([a])
    expect(ids(undefined)).toEqual([a, b])
    expect(patchMcpOAuthAccount(server.id, b, { scope: { kind: 'global' } })).toEqual({ ok: true })
    expect(ids(standalone.id)).toEqual([a, b])
  })

  it('reads a sign-in saved by an earlier version as one account', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    secureSet(`chat.mcpOAuth.${server.id}`, JSON.stringify({ v: 1, savedAt: 1, ...bundle(fake.url, 'old') }))
    resetMcpOAuthStatusForTests()
    expect(mcpOAuthSummary(server).accounts).toEqual([
      expect.objectContaining({ label: 'Account 1', email: null, scope: { kind: 'global' }, status: 'connected' }),
    ])
    expect(JSON.parse(secureGet(`chat.mcpOAuth.${server.id}`) ?? '{}').v).toBe(2)
    expect(await hostMcpOAuthProvider(server).tokens()).toMatchObject({ access_token: 'old' })
  })

  it('marks only the rejected account as needing sign-in, and keeps it to sign in again', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    const a = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'a'), {}))
    const b = accountId(saveMcpOAuthAccount(server, bundle(fake.url, 'b'), {}))
    await hostMcpOAuthProvider({ ...server, oauthAccountId: b }).invalidateCredentials?.('tokens')
    expect(mcpOAuthSummary(server).accounts.map((account) => [account.id, account.status])).toEqual([
      [a, 'connected'],
      [b, 'needs-auth'],
    ])
    expect(await hostMcpOAuthProvider({ ...server, oauthAccountId: a }).tokens()).toMatchObject({ access_token: 'a' })
    expect(await hostMcpOAuthProvider({ ...server, oauthAccountId: b }).tokens()).toBeUndefined()
    expect(saveMcpOAuthAccount(server, bundle(fake.url, 'b2'), { accountId: b })).toEqual({ ok: true, accountId: b })
    expect(mcpOAuthSummary(server).accounts.every((account) => account.status === 'connected')).toBe(true)
  })

  it('keeps an own OAuth client per server and never shows its secret', async () => {
    fake = await fakeOAuthServer()
    userServer()
    const [server] = listMcpServers()
    expect(setMcpOAuthClient(server, { clientId: 'own', clientSecret: 'synthetic-secret' })).toBe(true)
    expect(mcpOAuthClient(server)).toEqual({ clientId: 'own', clientSecret: 'synthetic-secret' })
    const summary = mcpOAuthSummary(server)
    expect(summary).toEqual({ needsAuth: false, accounts: [], client: { clientId: 'own' } })
    expect(JSON.stringify(summary)).not.toContain('synthetic-secret')
    // The client is bound to the server's URL, like its accounts.
    expect(mcpOAuthClient({ id: server.id, url: 'https://other.example/mcp' })).toBeNull()
    expect(setMcpOAuthClient(server, null)).toBe(true)
    expect(mcpOAuthClient(server)).toBeNull()
  })
})
