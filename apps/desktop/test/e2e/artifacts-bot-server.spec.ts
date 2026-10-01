import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { FakeGateway } from './helpers/fake-bot-server'
import { fromWire } from '@maestrly/artifact-host'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const REQUEST = 'PUBLISH_ARTIFACT: make a probe page.'
const PAGE =
  '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><h1 id="t">Artifact probe</h1></body></html>'

interface ModelRequest {
  lastUser: string
  tools: string[]
  toolResults: Record<string, string>
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A paired desktop publishes on the server and opens its real isolated viewer from the chat card. */
test('publishes to the paired bot server, opens its viewer, lists versions and deletes', async () => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-artifacts-'))
  const repository = path.join(root, 'repo')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])

  const gateway = new FakeGateway('artifact-e2e-host', { artifacts: true })
  const requests: ModelRequest[] = []
  let app: ElectronApplication | undefined
  let page!: Page

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'artifact-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'artifact-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const end = (res: ServerResponse, text: string) => {
    chunk(res, { role: 'assistant', content: text })
    chunk(res, {}, 'stop')
    res.end('data: [DONE]\n\n')
  }
  const call = (res: ServerResponse, id: string, name: string, args: unknown) => {
    chunk(res, {
      role: 'assistant',
      tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    })
    chunk(res, {}, 'tool_calls')
    res.end('data: [DONE]\n\n')
  }
  const text = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
        : ''

  const model: Server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'artifact-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      tools?: Array<{ function: { name: string } }>
    }
    const lastUser = text([...input.messages].reverse().find((message) => message.role === 'user')?.content)
    const toolResults = Object.fromEntries(
      input.messages
        .filter((message) => message.role === 'tool' && message.tool_call_id)
        .map((message) => [message.tool_call_id!, text(message.content)])
    )
    requests.push({ lastUser, tools: (input.tools ?? []).map((tool) => tool.function.name), toolResults })
    res.setHeader('content-type', 'text/event-stream')
    if (lastUser.includes('PUBLISH_ARTIFACT') && !('art-1' in toolResults))
      return call(res, 'art-1', 'artifact_create', {
        title: 'Probe',
        files: [
          { path: 'index.html', content: PAGE },
          { path: 'app.css', content: 'h1{color:rgb(1,2,3)}' },
        ],
      })
    end(res, 'Published.')
  })

  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>

  try {
    await gateway.start(0)
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_E2E_SKILLS_HOME: root,
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `artifacts-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const mainLog: string[] = []
    app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
    app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    // Keep the local host off: publication must use the selected remote host.
    await page.evaluate(
      async (port) => {
        const artifacts = window.api.artifacts
        await artifacts.setSettings({ ...(await artifacts.getSettings()), hostEnabled: false, port })
      },
      await freePort()
    )
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Bot server', exact: true }).first().click()
    await page.getByRole('button', { name: 'I already have a server', exact: true }).click()
    await page.getByLabel('Server address', { exact: true }).fill(`http://127.0.0.1:${gateway.port}`)
    await page.getByLabel('Pairing code').fill(gateway.issueCode())
    await page.getByLabel('Device name').fill('Artifact owner desktop')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Connected' })).toContainText(
      'artifact-e2e-host'
    )
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click()
    const enabled = page.getByRole('switch', { name: 'Host artifacts on the bot server' })
    await expect(enabled).toHaveAttribute('aria-checked', 'false')
    await enabled.click()
    await expect(enabled).toHaveAttribute('aria-checked', 'true')
    expect(gateway.hostPort).not.toBeNull()
    const hostUrl = `http://127.0.0.1:${gateway.hostPort}`
    await page.getByTestId('artifacts-server-address').fill(hostUrl)
    await page.getByTestId('artifacts-server-address').press('Enter')
    await expect
      .poll(() => page.evaluate(async () => (await window.api.artifacts.serverHost())?.settings.publicAddress))
      .toBe(hostUrl)
    await page.getByRole('combobox', { name: 'Publish new artifacts to' }).click()
    await page.getByRole('option', { name: 'Bot server', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async () => (await window.api.artifacts.getSettings()).publishTo))
      .toBe('server')
    await page.getByRole('button', { name: 'Close', exact: true }).first().click()

    const provider = await api('chatAddProvider', {
      name: 'Artifact fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'artifact-model' })
    const workspace = await api('addWorkspace', repository)
    const conversation = await api('createConversation', {
      workspaceId: workspace.id,
      branch: 'feat/artifacts',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Artifacts',
    })
    await api('chatSetSelection', conversation.id, { providerId: provider.id, modelId: 'artifact-model' })
    expect((await api('chatSetPermMode', conversation.id, 'full')).ok).toBe(true)
    // Artifact tools are Maestrly app tools, which are off until the conversation enables them.
    expect((await api('chatSetConvTools', conversation.id, { app: true })).ok).toBe(true)
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.locator('li.conv-item', { hasText: 'Artifacts' }).first().click()

    expect((await api('chatSend', conversation.id, REQUEST)).ok).toBe(true)
    await expect(page.getByText('Published.')).toBeVisible({ timeout: 60_000 })
    const published = requests.find((request) => 'art-1' in request.toolResults)!
    expect(published.tools).toContain('artifact_create')
    const result = JSON.parse(published.toolResults['art-1']!)
    expect(result).toMatchObject({ ok: true, artifact: { title: 'Probe', version: 1 } })
    const artifactId = result.artifact.id as string

    const upload = gateway.requests.find(
      (request) => request.key === 'artifactUpload' && (request.body as { method: string }).method === 'create'
    )
    expect(upload).toBeTruthy()
    // The fake gateway enforces the same device attribution as production; no bot identity is invented.
    const remote = await page.evaluate(
      async (id) => (await window.api.artifacts.list()).find((item) => item.id === id),
      artifactId
    )
    expect(remote).toMatchObject({ host: 'server', bot: null, conversation: { id: conversation.id } })
    const input = fromWire((upload!.body as { args: unknown[] }).args) as Array<{ files: Array<{ bytes: Uint8Array }> }>
    expect(Buffer.from(input[0]!.files[0]!.bytes).toString()).toBe(PAGE)

    // The card opens the owner view in this conversation's drawer browser.
    const card = page.getByTestId('artifact-card').last()
    await expect(card).toContainText('Probe')
    await card.getByRole('button', { name: 'Open' }).click()

    const probe = await app.evaluate(async ({ webContents }, id) => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        for (const contents of webContents.getAllWebContents()) {
          // The offscreen thumbnail capture also shows this artifact; only the drawer counts here.
          if (contents.isOffscreen() || !contents.getURL().includes(`/a/${id}`)) continue
          const frame = contents.mainFrame.framesInSubtree.find((candidate) => candidate.url.includes('/c/'))
          if (!frame) continue
          const heading = await frame
            .executeJavaScript(`document.getElementById('t')?.textContent ?? null`)
            .catch(() => null)
          if (heading !== 'Artifact probe') continue
          // The heading is parsed before app.css finishes loading; computed styles are final only after `load`.
          const ready = await frame.executeJavaScript('document.readyState').catch(() => null)
          if (ready !== 'complete') continue
          const inside = (await frame.executeJavaScript(`(async () => {
            const heading = document.getElementById('t')
            let cookie
            try { cookie = document.cookie } catch { cookie = 'denied' }
            const api = await fetch('/a/${id}/api/state').then((response) => response.status, () => 'blocked')
            return { color: getComputedStyle(heading).color, cookie, origin: self.origin, api }
          })()`)) as { color: string; cookie: string; origin: string; api: unknown }
          await frame.executeJavaScript(`try { top.location.href = 'about:blank' } catch {} ; true`).catch(() => null)
          await new Promise((resolve) => setTimeout(resolve, 500))
          const cookies = await contents.session.cookies.get({ url: contents.getURL() })
          const ownerCookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
          return { ...inside, viewerUrl: contents.getURL(), contentUrl: frame.url, ownerCookie }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return {
        diagnostics: webContents
          .getAllWebContents()
          .map((contents) =>
            [contents.getURL(), ...contents.mainFrame.framesInSubtree.map((f) => `  ${f.url}`)].join('\n')
          ),
      }
    }, artifactId)

    if ('diagnostics' in probe)
      throw new Error(
        `The artifact frame never rendered:\n${(probe.diagnostics ?? []).join('\n')}\ncard: ${await card.textContent()}\nmain process:\n${mainLog.join('').slice(-3000)}`
      )
    expect(probe.color).toBe('rgb(1, 2, 3)')
    expect(['', 'denied']).toContain(probe.cookie)
    expect(probe.origin).toBe('null')
    expect(probe.api).toBe('blocked')
    expect(probe.viewerUrl).toContain(`/a/${artifactId}`)
    // The single-use ticket never stays in the address bar.
    expect(probe.viewerUrl).not.toContain('#o=')
    expect(probe.contentUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${gateway.hostPort}/c/`))

    expect(
      (await fetch(`${hostUrl}/a/${artifactId}/api/state`, { headers: { cookie: probe.ownerCookie } })).status
    ).toBe(200)

    // The Artifacts center shows the artifact as a card with its preview and conversation, and details it.
    await page.getByTestId('sidebar-artifacts').click()
    const center = page.getByTestId('artifacts-center')
    await expect(center).toBeVisible()
    const centerCard = center.locator(`[data-testid="artifact-card"][data-artifact-id="${artifactId}"]`)
    await expect(centerCard).toContainText('Probe')
    await expect(centerCard).toContainText('Artifacts')
    await expect(centerCard.getByText('Bot server', { exact: true })).toContainText('Bot server')
    await centerCard.getByTestId('artifact-card-select').click()
    const detail = center.getByTestId('artifact-detail')
    await expect(detail).toContainText('Probe')
    await expect(detail.getByTestId('artifact-versions')).toContainText('v1')
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)

    // Deleting it from the card menu removes it, and its content URL stops working.
    await centerCard.getByTestId('artifact-menu').click()
    await page.getByTestId('artifact-delete').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete artifact' }).click()
    await expect(centerCard).toHaveCount(0)
    await expect(center.getByTestId('artifacts-empty')).toContainText('No artifacts yet')
    expect(
      (await fetch(`${hostUrl}/a/${artifactId}/api/state`, { headers: { cookie: probe.ownerCookie } })).status
    ).toBe(404)
    expect((await fetch(probe.contentUrl)).status).toBe(404)
  } finally {
    await app?.close().catch(() => {})
    await gateway.close()
    await new Promise((resolve) => model.close(resolve))
    await removeTempDirEventually(root)
  }
})
