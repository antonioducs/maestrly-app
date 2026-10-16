import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_METHODS, type ArtifactHost, callAdmin, openArtifactHost } from '@maestrly/artifact-host'
import { _electron as electron, type ElectronApplication, expect, test } from '@playwright/test'
import { desktop, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'

const HOST_ID = 'direct/host'

// A workspaces host has no paired server: it publishes its chats' artifacts on the gateway that runs it, with the token
// the gateway gave its container. Here the host is the built app in server mode, the gateway's internal API a stand-in
// over a real artifact host, and the person's desktop connects straight to the host (the development-only direct host).
test('remote host artifacts: an agent publishes on the server, and the computer showing the chat opens it', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-remote-artifacts-')))
  const hostToken = randomBytes(32).toString('base64url')
  let artifacts: ArtifactHost | undefined
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined

  // The gateway's internal API: only the host's token, only the artifact routes.
  const calls: Array<{ route: string; method: string }> = []
  const gateway = createServer(async (req, res) => {
    const route = /^\/internal\/v1\/artifacts\/(admin|upload)$/.exec(req.url ?? '')?.[1]
    if (req.method !== 'POST' || !route) return res.writeHead(404).end()
    if (req.headers.authorization !== `Bearer ${hostToken}`) return res.writeHead(401).end()
    let body = ''
    for await (const part of req) body += part
    const { method, args } = JSON.parse(body) as { method: string; args: unknown[] }
    calls.push({ route, method })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(await callAdmin(artifacts!.admin, method as never, args, { allowed: ADMIN_METHODS })))
  })

  // A model that publishes a page, opens it, and then says so.
  const toolResults = new Map<string, string>()
  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'remote-artifacts',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'remote-artifacts',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'remote-artifacts', object: 'model' }] }))
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    let body = ''
    for await (const part of req) body += part
    const { messages } = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
    }
    for (const message of messages)
      if (message.role === 'tool' && message.tool_call_id)
        toolResults.set(
          message.tool_call_id,
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
    res.setHeader('content-type', 'text/event-stream')
    const call = (id: string, name: string, args: unknown) => {
      chunk(res, {
        role: 'assistant',
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      })
      chunk(res, {}, 'tool_calls')
    }
    if (!toolResults.has('create'))
      call('create', 'artifact_create', {
        title: 'Remote page',
        files: [{ path: 'index.html', content: '<h1>Published from the server</h1>' }],
      })
    else if (!toolResults.has('open'))
      call('open', 'artifact_open', { id: JSON.parse(toolResults.get('create')!).artifact.id })
    else {
      chunk(res, { role: 'assistant', content: 'The page is on the server.' })
      chunk(res, {}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })

  try {
    artifacts = await openArtifactHost({ dataDir: path.join(root, 'artifacts'), port: 0, quotaBytes: 1024 * 1024 })
    await listen(gateway)
    await listen(model)
    const workspacesRoot = path.join(root, 'srv')
    await mkdir(workspacesRoot)
    const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot, {
      MAESTRLY_BOT_GATEWAY_URL: `http://127.0.0.1:${portOf(gateway)}`,
      MAESTRLY_HOST_GATEWAY_TOKEN: hostToken,
    })
    host = launched.app
    // The host keeps the token to itself: the shells and agents it starts do not inherit it.
    expect(await host.evaluate(() => process.env.MAESTRLY_HOST_GATEWAY_TOKEN ?? null)).toBeNull()

    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'remote-artifacts-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${launched.token}@127.0.0.1:${launched.port}`,
      },
    })
    const page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    // This computer opens artifacts through its own connection to the server; here it only records what it opens.
    await client.evaluate(({ ipcMain }) => {
      const opened: unknown[][] = []
      ;(globalThis as { openedArtifacts?: unknown[][] }).openedArtifacts = opened
      ipcMain.removeHandler('artifacts:open-external')
      ipcMain.handle('artifacts:open-external', (_event, id, version) => {
        opened.push([id, version])
      })
    })
    const opened = () => client!.evaluate(() => (globalThis as { openedArtifacts?: unknown[][] }).openedArtifacts ?? [])
    const remote = (name: string, ...args: unknown[]) =>
      page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
        hostId: HOST_ID,
        name,
        args,
      })
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).api.hostsList())).map((item: any) => item.state))
      .toEqual(['online', 'online'])

    const provider = await remote('chatAddProvider', {
      name: 'Remote artifacts',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model)}/v1`,
    })
    expect(provider.ok).toBe(true)
    await remote('chatSetDefault', { providerId: provider.id, modelId: 'remote-artifacts' })
    await page.getByRole('tab', { name: 'Chats' }).click()
    await page.locator(`[data-host-shortcut="${HOST_ID}"]`).click()
    await page.getByRole('button', { name: `New chat on 127.0.0.1:${launched.port}`, exact: true }).click()
    await expect.poll(async () => (await remote('listStandaloneConversations', true)).length).toBe(1)
    const [chat] = await remote('listStandaloneConversations', true)
    await remote('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'remote-artifacts' })
    expect((await remote('chatSetPermMode', chat.id, 'full')).ok).toBe(true)
    expect((await remote('chatSetConvTools', chat.id, { app: true })).ok).toBe(true)

    await page.locator('.chat-input[contenteditable="true"]:visible').fill('Publish the page')
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('The page is on the server.')).toBeVisible({ timeout: 60_000 })

    // Published on the server through the host's token, as the device its environment is.
    const created = JSON.parse(toolResults.get('create')!)
    expect(created).toMatchObject({ ok: true, artifact: { title: 'Remote page', version: 1 } })
    const id = created.artifact.id as string
    expect(await artifacts.admin.get(id)).toMatchObject({
      ownerKind: 'device',
      ownerId: 'workspaces',
      conversationId: chat.id,
      currentVersion: 1,
    })
    expect(calls).toContainEqual({ route: 'upload', method: 'create' })
    // The host's browser cannot reach the viewer: this computer, which shows the chat, opens it.
    expect(toolResults.get('open')).toContain('Asked the computer showing this conversation to open "Remote page"')
    await expect.poll(opened).toEqual([[id, 1]])

    // Its card opens it on this computer too, never in the host's browser.
    const card = page.getByTestId('artifact-card').filter({ hasText: 'Remote page' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: /Open/ }).click()
    await expect.poll(opened).toEqual([
      [id, 1],
      [id, 1],
    ])
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => gateway.close(resolve))
    await new Promise((resolve) => model.close(resolve))
    await artifacts?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
