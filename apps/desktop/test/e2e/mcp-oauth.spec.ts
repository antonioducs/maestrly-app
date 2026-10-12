import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { fakeOAuthServer } from '../helpers/fake-oauth-mcp'
import { desktop, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<{ function: { name: string; description?: string } }>
}

/**
 * An OpenAI-compatible model that calls `whoami` on the first MCP server it is offered, then answers. With
 * `account`, its call names that signed-in account.
 */
function toolModel(options: { account?: () => string | undefined } = {}) {
  const requests: ModelRequest[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'oauth-fixture', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as ModelRequest
    requests.push(input)
    res.setHeader('content-type', 'text/event-stream')
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'oauth-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'oauth-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    const search = input.tools?.find((entry) => entry.function.name === 'mcp_search')
    const serverId = search?.function.description?.match(/\((mcp_[0-9a-f-]{36})\)/)?.[1]
    const last = input.messages.at(-1)
    if (serverId && last?.role === 'user') {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${requests.length}`,
            type: 'function',
            function: {
              name: 'mcp_call',
              arguments: JSON.stringify({
                server: serverId,
                tool: 'whoami',
                ...(options.account?.() ? { account: options.account() } : {}),
              }),
            },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: `OAUTH-TURN-${requests.length}` })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}

/** Makes `shell.openExternal` of an app play the browser: it follows the consent redirect to the loopback callback. */
async function browserIn(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
      const consent = await fetch(url, { redirect: 'manual' })
      const location = consent.headers.get('location')
      if (location) await fetch(location)
    }
  })
}
const openedIn = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

const toolResults = (requests: ModelRequest[]) =>
  JSON.stringify(requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool'))

async function sendTurn(page: Page, name: string, text: string) {
  await page.getByRole('tab', { name: 'Chats', exact: true }).click()
  await page.locator('.conv-item', { hasText: name }).first().click()
  await page.locator('.chat-input[contenteditable="true"]:visible').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

// Uses the real built application, a synthetic OAuth authorization server and protected MCP endpoint on loopback,
// and a local OpenAI-compatible model. No network, account, or browser is involved.
test('MCP OAuth: a server that needs sign-in is signed in from Settings and then used by the chat', async () => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-mcp-oauth-')))
  const fake = await fakeOAuthServer()
  const model = toolModel()
  let app: ElectronApplication | undefined
  try {
    await listen(model.server)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'profile'), 'mcp-oauth-e2e'),
    })
    await browserIn(app)
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    const added = await api('chatMcpAdd', { name: 'Protected', transport: 'http', url: fake.url })
    expect(added.ok ?? true).toBeTruthy()
    const provider = await api('chatAddProvider', {
      name: 'OAuth fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    await api('chatSetDefault', { providerId: provider.id, modelId: 'oauth-fixture' })
    const chat = await api('createStandaloneConversation', { name: 'OAuth chat' })
    await api('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'oauth-fixture' })
    await api('chatSetPermMode', chat.id, 'full')
    await api('chatSetMode', chat.id, 'agent')
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))

    // Without a sign-in, the tool fails with a pointer to Settings; nothing is registered or opened.
    await sendTurn(page, 'OAuth chat', 'Who am I?')
    await expect(page.getByText('OAUTH-TURN-2', { exact: false })).toBeVisible({ timeout: 60_000 })
    expect(toolResults(model.requests)).toContain('Sign-in required')
    expect(fake.state.registrations).toBe(0)
    expect(await openedIn(app)).toEqual([])

    // Settings shows the server needs sign-in; signing in opens the browser once and stores the result.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    const row = page.locator('div', { hasText: 'Protected' }).filter({ hasText: 'Needs sign-in' }).last()
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Signed in', { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(await openedIn(app)).toHaveLength(1)
    expect(fake.state.registrations).toBe(1)
    const servers = (await api('chatConfig')).mcpServers as Array<{
      name: string
      oauth?: { needsAuth: boolean; accounts: Array<{ status: string }> }
    }>
    expect(servers.find((server) => server.name === 'Protected')?.oauth).toMatchObject({
      needsAuth: false,
      accounts: [{ status: 'connected' }],
    })

    // The next turn reaches the server with the token.
    const before = model.requests.length
    await sendTurn(page, 'OAuth chat', 'Who am I now?')
    await expect(page.getByText(`OAUTH-TURN-${before + 2}`, { exact: false })).toBeVisible({ timeout: 60_000 })
    expect(toolResults(model.requests.slice(before))).toContain('token:at-1')

    // Signing out removes it.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    await page
      .getByRole('group', { name: 'Account Account 1' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click()
    await expect
      .poll(async () => ((await api('chatConfig')).mcpServers as Array<{ oauth?: unknown }>)[0]?.oauth)
      .toBeUndefined()
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await fake.close()
    await rm(root, { recursive: true, force: true })
  }
})

const HOST_ID = 'direct/host'

// The server belongs to a remote workspaces host. The browser part runs on this computer; the host keeps the sign-in.
test('MCP OAuth: signing in to a remote host’s server keeps the sign-in on the host', async () => {
  test.setTimeout(180_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-mcp-oauth-remote-')))
  const fake = await fakeOAuthServer()
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot)
    host = launched.app
    await browserIn(host)
    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'mcp-oauth-remote-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${launched.token}@127.0.0.1:${launched.port}`,
      },
    })
    await browserIn(client)
    const page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const local = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    const remote = (name: string, ...args: unknown[]) =>
      page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
        hostId: HOST_ID,
        name,
        args,
      })
    const server = `127.0.0.1:${launched.port}`
    await expect
      .poll(
        async () =>
          ((await local('hostsList')) as Array<{ id: string; state: string }>).find((h) => h.id === HOST_ID)?.state
      )
      .toBe('online')

    await remote('chatMcpAdd', { name: 'Remote protected', transport: 'http', url: fake.url })
    const [added] = (await remote('chatConfig')).mcpServers as Array<{ id: string }>

    // Sign in from this computer to the host's server.
    const result = await local('chatMcpOAuthConnect', HOST_ID, added.id)
    expect(result).toEqual({ ok: true, accountId: expect.stringMatching(/^acc_/) })
    expect(await openedIn(client)).toHaveLength(1)
    expect(await openedIn(host)).toEqual([])
    const hostServers = (await remote('chatConfig')).mcpServers as Array<{
      id: string
      oauth?: { accounts: Array<{ status: string }> }
    }>
    expect(hostServers.find((item) => item.id === added.id)?.oauth?.accounts).toEqual([
      expect.objectContaining({ status: 'connected' }),
    ])
    expect((await local('chatConfig')).mcpServers).toEqual([])

    // The host's settings show it, through the host selector.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsHost = page.locator('[data-settings-host]')
    await settingsHost.getByRole('combobox').click()
    await page.getByRole('option', { name: server }).click()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    await expect(page.getByText('Signed in', { exact: true })).toBeVisible()
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await fake.close()
    await rm(root, { recursive: true, force: true })
  }
})

// The same synthetic provider, now without dynamic registration: the person enters their own OAuth client, signs in
// two accounts, the model picks one by name, and the + menu turns one off for the conversation.
test('MCP OAuth: an own client and two accounts, chosen by the model and turned off per conversation', async () => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-mcp-accounts-')))
  const fake = await fakeOAuthServer({
    registration: false,
    clients: { 'own-client': 'own-secret' },
    users: ['alice', 'bob'],
  })
  fake.state.nextUser.push('alice', 'bob')
  let account: string | undefined
  const model = toolModel({ account: () => account })
  let app: ElectronApplication | undefined
  try {
    await listen(model.server)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'profile'), 'mcp-accounts-e2e'),
    })
    await browserIn(app)
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    await api('chatMcpAdd', { name: 'Protected', transport: 'http', url: fake.url })
    const provider = await api('chatAddProvider', {
      name: 'OAuth fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    await api('chatSetDefault', { providerId: provider.id, modelId: 'oauth-fixture' })
    const chat = await api('createStandaloneConversation', { name: 'Accounts chat' })
    await api('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'oauth-fixture' })
    await api('chatSetPermMode', chat.id, 'full')
    await api('chatSetMode', chat.id, 'agent')
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))

    // The first call finds the server needs sign-in.
    await sendTurn(page, 'Accounts chat', 'Who am I?')
    await expect(page.getByText('OAUTH-TURN-2', { exact: false })).toBeVisible({ timeout: 60_000 })

    // The server registers no apps: signing in asks for the person's own client, then signs Alice in with it.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const form = page.getByTestId('mcp-own-client')
    await expect(form).toBeVisible({ timeout: 30_000 })
    expect(await openedIn(app)).toEqual([])
    await form.getByLabel('Client ID').fill('own-client')
    await form.getByLabel('Client secret (optional)').fill('own-secret')
    await form.getByRole('button', { name: 'Save and sign in', exact: true }).click()
    const alice = page.getByRole('group', { name: 'Account alice@example.test' })
    await expect(alice).toContainText('Signed in', { timeout: 30_000 })
    await expect(page.getByText('Own OAuth client: own-client', { exact: true })).toBeVisible()
    expect(fake.state.registrations).toBe(0)
    expect(fake.state.authenticatedClients).toContain('own-client')
    // Nothing a window can read carries the secret.
    expect(JSON.stringify(await api('chatConfig'))).not.toContain('own-secret')

    // A second account: the provider is asked for its account chooser.
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Account bob@example.test' })).toContainText('Signed in', {
      timeout: 30_000,
    })
    expect(fake.state.lastPrompt).toBe('select_account')
    await page.keyboard.press('Escape')

    // The model names Bob, and the call runs with Bob's tokens.
    account = 'bob@example.test'
    let before = model.requests.length
    await sendTurn(page, 'Accounts chat', 'Who is Bob?')
    await expect(page.getByText(`OAUTH-TURN-${before + 2}`, { exact: false })).toBeVisible({ timeout: 60_000 })
    const call = model.requests[before].tools?.find((entry) => entry.function.name === 'mcp_call')
    expect(call?.function.description).toContain('Protected: alice@example.test, bob@example.test')
    expect(toolResults(model.requests.slice(before))).toContain('token:at-bob')

    // The + menu lists both accounts; turning Bob off leaves Alice, with no account to choose.
    await page.getByTitle('Add', { exact: true }).click()
    const bob = page.getByRole('switch', { name: 'Protected account bob@example.test' })
    await expect(page.getByRole('switch', { name: 'Protected account alice@example.test' })).toBeVisible()
    await bob.click()
    await expect(bob).toHaveAttribute('aria-checked', 'false')
    await page.getByTitle('Add', { exact: true }).click()
    account = undefined
    before = model.requests.length
    await sendTurn(page, 'Accounts chat', 'Who am I now?')
    await expect(page.getByText(`OAUTH-TURN-${before + 2}`, { exact: false })).toBeVisible({ timeout: 60_000 })
    const narrowed = model.requests[before].tools?.find((entry) => entry.function.name === 'mcp_call')
    expect(narrowed?.function.description).not.toContain('several signed-in accounts')
    expect(toolResults(model.requests.slice(before))).toContain('token:at-alice')
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await fake.close()
    await rm(root, { recursive: true, force: true })
  }
})
