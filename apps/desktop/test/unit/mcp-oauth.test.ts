import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMcpNeedsAuthError } from '../../src/main/chat/mcp-auth-errors'
import { addMcpServer, connectMcpServer, listMcpServers, removeMcpServer } from '../../src/main/chat/mcp'
import {
  hostMcpOAuthProvider,
  mcpOAuthStatus,
  resetMcpOAuthStatusForTests,
  saveMcpOAuth,
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
import { remoteChannelRefusal } from '../../src/shared/host-channels'
import { closeDb, freshDb } from '../helpers/db'
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
    expect(mcpOAuthStatus(server)).toBe('connected')
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
    expect(mcpOAuthStatus(server)).toBe('needs-auth')
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
    expect(mcpOAuthStatus(listMcpServers()[0])).toBe('none')
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
    expect(saveMcpOAuth({ id: added.id, url: 'https://other.example/mcp' }, bundle)).toBe(false)
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
    expect(saveMcpOAuth(gone, bundle(gone.url))).toBe(true)
    expect(sweepOrphanMcpOAuth(new Set([kept.id]))).toBe(1)
    expect(mcpOAuthStatus(listMcpServers()[0])).toBe('connected')
    expect(mcpOAuthStatus({ ...gone, transport: 'http' })).toBe('none')
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
    expect(before.mcpServers.find((server) => server.key === 'remote')?.authStatus).toBe('needs-auth')
    expect(mcpOAuthDescriptor(id)).toMatchObject({ serverId: id, url: fake.url, scopes: ['notes.read'] })

    expect(await connectMcpOAuth(localMcpOAuthHostCalls, 'local', id, { openExternal: browser })).toEqual({ ok: true })
    expect(fake.state.lastScope).toBe('notes.read')
    const after = await installedDto(record)
    expect(after.setup.serversNeedingAuth).toEqual([])
    expect(after.mcpServers.find((server) => server.key === 'remote')?.authStatus).toBe('connected')
  })

  it('keeps the browser part on this computer', () => {
    expect(remoteChannelRefusal('mcp-oauth:connect')).not.toBeNull()
    expect(remoteChannelRefusal('mcp-oauth:cancel')).not.toBeNull()
    expect(remoteChannelRefusal('chat:mcp-oauth:store')).toBeNull()
    expect(mcpOAuthDescriptor('mcp_00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
