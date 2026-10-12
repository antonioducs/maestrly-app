import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { type FixtureFiles, makeGitRepo } from '../helpers/plugin-fixtures'
import { desktop, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'

/** A dependency-free MCP stdio server (newline-delimited JSON-RPC) with one tool that echoes its text. */
const ECHO_SERVER = `import { createInterface } from 'node:readline'
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.id === undefined) return
  if (request.method === 'initialize')
    return send({ id: request.id, result: {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'release-notes-echo', version: '1.0.0' },
    } })
  if (request.method === 'tools/list')
    return send({ id: request.id, result: { tools: [{
      name: 'echo_note',
      description: 'Echoes a release note line.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { readOnlyHint: true },
    }] } })
  if (request.method === 'tools/call')
    return send({ id: request.id, result: { content: [{ type: 'text', text: 'note:' + request.params?.arguments?.text }] } })
  send({ id: request.id, error: { code: -32601, message: 'Method not found' } })
})
`

/** A synthetic Codex marketplace written for this test: a portable plugin and one that only has an app connector. */
const marketplace = (): FixtureFiles => ({
  '.agents/plugins/marketplace.json': JSON.stringify({
    name: 'e2e-market',
    interface: { displayName: 'E2E market' },
    plugins: [
      { name: 'release-notes', source: { source: 'local', path: './plugins/release-notes' }, category: 'Productivity' },
      { name: 'hosted-only', source: { source: 'local', path: './plugins/hosted-only' } },
    ],
  }),
  'plugins/release-notes/.codex-plugin/plugin.json': JSON.stringify({
    name: 'release-notes',
    version: '1.0.0',
    description: 'Drafts release notes.',
    license: 'MIT',
  }),
  'plugins/release-notes/LICENSE': 'MIT License (synthetic test fixture)\n',
  'plugins/release-notes/skills/draft/SKILL.md':
    '---\ndescription: Draft release notes from merged changes\n---\nWrite the release notes.\n',
  'plugins/release-notes/.mcp.json': JSON.stringify({
    mcpServers: { notes: { command: 'node', args: ['./mcp/server.mjs'] } },
  }),
  'plugins/release-notes/mcp/server.mjs': ECHO_SERVER,
  'plugins/release-notes/agents/notes-reviewer.md':
    '---\ndescription: Reviews release notes\ntools: Read\n---\nNOTES-REVIEWER-PROMPT: check the notes.\n',
  'plugins/hosted-only/.codex-plugin/plugin.json': JSON.stringify({ name: 'hosted-only', version: '1.0.0' }),
  'plugins/hosted-only/.app.json': JSON.stringify({ apps: { hosted: { id: 'connector_e2e_fixture' } } }),
})

interface ModelRequest {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
  tools?: Array<{ function: { name: string; description?: string; parameters?: unknown } }>
}

/**
 * An OpenAI-compatible model that calls the plugin's tool through `mcp_call` once per turn, then answers. It finds the
 * plugin server's id in the `mcp_search` description, as a model would.
 */
function toolModel() {
  const requests: ModelRequest[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'plugin-fixture', object: 'model' }] }))
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
          id: 'plugin-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'plugin-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      )
    const search = input.tools?.find((entry) => entry.function.name === 'mcp_search')
    const serverId = search?.function.description?.match(/\((plg_[\w-]+)\)/)?.[1]
    const answered = input.messages.some((message) => message.role === 'tool')
    const last = input.messages.at(-1)
    // The plugin's agent, run as a subagent: its prompt is the system message.
    if (
      JSON.stringify(input.messages).includes('NOTES-REVIEWER-PROMPT') &&
      !input.tools?.some((t) => t.function.name === 'task')
    ) {
      chunk({ role: 'assistant', content: 'REVIEWER-DONE' })
      chunk({}, 'stop')
    } else if (last?.role === 'user' && JSON.stringify(last.content).includes('Review the notes')) {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_plugin_agent',
            type: 'function',
            function: {
              name: 'task',
              arguments: JSON.stringify({ agent: 'release-notes-notes-reviewer', prompt: 'Check the draft notes.' }),
            },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else if (serverId && !answered) {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_plugin_echo',
            type: 'function',
            function: {
              name: 'mcp_call',
              arguments: JSON.stringify({ server: serverId, tool: 'echo_note', arguments: { text: 'from-e2e' } }),
            },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: 'PLUGIN-TURN-DONE' })
      chunk({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  return { server, requests }
}

/** Settings → Maestrly Chat → Plugins, on the host chosen in **Settings of** (this computer unless `host` is given). */
async function openPluginCenter(page: Page, host?: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  if (host) {
    const settingsHost = page.locator('[data-settings-host]')
    await settingsHost.getByRole('combobox').click()
    await page.getByRole('option', { name: host }).click()
    await expect(settingsHost.getByRole('combobox')).toContainText(host)
  }
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
  const center = page.getByTestId('plugins-settings')
  await expect(center).toBeVisible()
  return center
}

/** Adds the fixture source, opens the portable plugin, and installs it with consent to run its server. */
async function addSourceAndInstall(page: Page, center: ReturnType<Page['getByTestId']>, url: string) {
  await center.getByRole('button', { name: 'Add source', exact: true }).click()
  const add = page.getByRole('dialog', { name: 'Add source' })
  await expect(add).toContainText('Adding a source only lists its plugins.')
  await expect(add).toContainText('Maestrly does not review plugins from third-party sources.')
  await add.getByLabel('Repository').fill(url)
  await add.getByRole('button', { name: 'Add source', exact: true }).click()
  await expect(add).toHaveCount(0)

  // Only the plugin that works with every model is offered; the one that relies on an app connector is counted, with why.
  const card = center.locator('[data-plugin="release-notes"]')
  await expect(card).toContainText('Works with every model')
  await expect(center.locator('[data-plugin="hosted-only"]')).toHaveCount(0)
  await center.getByRole('button', { name: /^1 plugin doesn’t work the same with every model/ }).click()
  await expect(center.getByTestId('incompatible-plugins')).toContainText('It depends on ChatGPT app connectors')
  await card.click()

  const details = center.getByTestId('plugin-details')
  await expect(details.getByTestId('third-party-source')).toBeVisible()
  await expect(details).toContainText('Draft release notes from merged changes')
  await expect(details).toContainText('MIT')
  await expect(details).toContainText('notes')
  // The plugin's agent becomes a subagent every model can call.
  await expect(details).toContainText('#release-notes-notes-reviewer')
  await expect(details).toContainText('Tools: read')
  await details.getByRole('button', { name: 'Install', exact: true }).click()

  // The local server is approved by its exact launch line.
  const install = page.getByRole('dialog', { name: /^Install / })
  await expect(install).toContainText('server.mjs')
  await install.getByRole('checkbox', { name: /: notes/ }).check()
  const installButton = install.getByRole('button', { name: 'Install', exact: true })
  const executables = install.getByRole('checkbox', { name: /scripts or executables/ })
  if (await executables.count()) await executables.check()
  await installButton.click()
  await expect(install).toHaveCount(0)
  await expect(details.getByRole('button', { name: 'Installed', exact: true })).toBeVisible()
}

// Uses the real built application, a synthetic Git source under a temporary folder, a dependency-free MCP stdio server,
// and a local OpenAI-compatible model. No network, account, or third-party plugin is involved.
test('plugins: add a source, install with consent, use the skill and tool, and uninstall', async () => {
  test.setTimeout(240_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-plugins-')))
  const repos = path.join(root, 'repos')
  await mkdir(repos)
  const repo = await makeGitRepo(marketplace(), { parent: repos, name: 'market' })
  const model = toolModel()
  let app: ElectronApplication | undefined
  try {
    await listen(model.server)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'profile'), 'plugins-e2e'),
        MAESTRLY_E2E_PLUGIN_GIT_ROOT: repos,
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const api = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    const center = await openPluginCenter(page)
    await addSourceAndInstall(page, center, pathToFileURL(repo.dir).href)
    const state = await api('pluginsState')
    expect(state.installed).toHaveLength(1)
    expect(state.installed[0]).toMatchObject({ name: 'release-notes', enabled: true, scope: { kind: 'global' } })

    // The plugin's skill and server join the lists, managed by the plugin.
    await page.getByRole('tab', { name: 'Skills', exact: true }).click()
    await expect(page.getByText('/release-notes:draft', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Tools', exact: true }).click()
    await expect(page.getByText(/^From /).first()).toBeVisible()

    // A chat with any model gets the skill in its catalog and calls the plugin's tool.
    const provider = await api('chatAddProvider', {
      name: 'Plugin fixture',
      kind: 'openai',
      key: 'synthetic-fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    expect(provider.ok).toBe(true)
    await api('chatSetDefault', { providerId: provider.id, modelId: 'plugin-fixture' })
    const chat = await api('createStandaloneConversation', { name: 'Plugin chat' })
    await api('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'plugin-fixture' })
    await api('chatSetPermMode', chat.id, 'full')
    expect((await api('chatSetMode', chat.id, 'agent')).ok).toBe(true)
    const skills = (await api('chatSkillsState', chat.id)).skills as Array<{ name: string; plugin?: unknown }>
    expect(skills.find((skill) => skill.name === 'release-notes:draft')?.plugin).toMatchObject({
      key: expect.stringContaining('release-notes'),
      kind: 'skill',
    })

    // The chat was created through the API: reload so the sidebar lists it.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Plugin chat' }).first().click()
    await page.locator('.chat-input[contenteditable="true"]:visible').fill('Draft the notes')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('PLUGIN-TURN-DONE', { exact: false })).toBeVisible({ timeout: 60_000 })
    expect(JSON.stringify(model.requests[0].messages)).toContain('release-notes:draft')
    const toolResult = model.requests.flatMap((request) => request.messages).find((message) => message.role === 'tool')
    expect(JSON.stringify(toolResult?.content)).toContain('note:from-e2e')

    // The plugin's agent runs as a subagent: the model is offered it in `task` and gets its answer.
    const beforeReview = model.requests.length
    await page.locator('.chat-input[contenteditable="true"]:visible').fill('Review the notes')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(() =>
        JSON.stringify(
          model.requests
            .slice(beforeReview)
            .flatMap((request) => request.messages)
            .filter((message) => message.role === 'tool')
        )
      )
      .toContain('REVIEWER-DONE')
    const offered = model.requests[beforeReview].tools?.find((entry) => entry.function.name === 'task')
    expect(JSON.stringify(offered?.function.parameters)).toContain('release-notes-notes-reviewer')
    expect(
      model.requests
        .slice(beforeReview)
        .some((request) => JSON.stringify(request.messages).includes('NOTES-REVIEWER-PROMPT'))
    ).toBe(true)
    await expect(page.getByText('release-notes-notes-reviewer').first()).toBeVisible()

    // The composer's menus group the plugin's skill under its name and link to the plugin center.
    await page.locator('button[title="Skills"]:visible').click()
    const skillsMenu = page.getByRole('dialog', { name: 'Skills in this conversation' })
    await expect(skillsMenu.getByText('/release-notes:draft')).toBeVisible()
    await skillsMenu.getByRole('button', { name: 'Browse plugins' }).click()
    await expect(page.getByTestId('plugins-settings')).toBeVisible()

    // Uninstalling removes the skill and the server from every conversation.
    await page
      .getByTestId('plugins-settings')
      .getByRole('tab', { name: /^Installed/ })
      .click()
    await page.getByRole('button', { name: /^Uninstall: / }).click()
    await page
      .getByRole('dialog', { name: /^Uninstall / })
      .getByRole('button', { name: 'Uninstall', exact: true })
      .click()
    await expect.poll(async () => (await api('pluginsState')).installed.length).toBe(0)
    const after = (await api('chatSkillsState', chat.id)).skills as Array<{ name: string }>
    expect(after.some((skill) => skill.name.startsWith('release-notes:'))).toBe(false)
    const servers = (await api('chatConfig')).mcpServers as Array<{ plugin?: unknown }>
    expect(servers.some((server) => server.plugin)).toBe(false)
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

const HOST_ID = 'direct/host'

// Two instances of the built app: one hosts workspaces in server mode, the other is a person's desktop connected straight
// to it. The plugin is fetched and installed by the host, and only the host's conversations get it.
test('plugins: a remote workspaces host installs and serves its own plugins', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-plugins-remote-')))
  const repos = path.join(root, 'repos')
  await mkdir(repos)
  const repo = await makeGitRepo(marketplace(), { parent: repos, name: 'market' })
  const workspacesRoot = path.join(root, 'srv')
  await mkdir(workspacesRoot)
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot, {
      MAESTRLY_E2E_PLUGIN_GIT_ROOT: repos,
    })
    host = launched.app
    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'plugins-remote-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${launched.token}@127.0.0.1:${launched.port}`,
      },
    })
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

    const center = await openPluginCenter(page, server)
    await expect(center).toContainText('Plugins installed here run in this environment')
    await addSourceAndInstall(page, center, pathToFileURL(repo.dir).href)

    // The host holds the source and the plugin; this computer has neither.
    expect((await remote('pluginsState')).installed).toHaveLength(1)
    const localState = await local('pluginsState')
    expect(localState.installed).toHaveLength(0)
    expect(localState.marketplaces.some((source: { url: string }) => source.url.startsWith('file:'))).toBe(false)

    // A chat on the host sees the plugin's skill; a chat on this computer does not.
    const remoteChat = await remote('createStandaloneConversation', { name: 'Remote plugin chat' })
    const remoteSkills = (await remote('chatSkillsState', remoteChat.id)).skills as Array<{ name: string }>
    expect(remoteSkills.some((skill) => skill.name === 'release-notes:draft')).toBe(true)
    const localChat = await local('createStandaloneConversation', { name: 'Local chat' })
    const localSkills = (await local('chatSkillsState', localChat.id)).skills as Array<{ name: string }>
    expect(localSkills.some((skill) => skill.name.startsWith('release-notes:'))).toBe(false)

    // From the host's chat, Browse plugins opens the plugin center of that host.
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page
      .locator(`#sidebar-panel-chats [data-host-section="${HOST_ID}"] .conv-item`, { hasText: 'Remote plugin chat' })
      .click()
    await page.locator('button[title="Add"]:visible').click()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Browse plugins' }).click()
    await expect(page.locator('[data-settings-host]').getByRole('combobox')).toContainText(server)
    const reopened = page.getByTestId('plugins-settings')
    await expect(reopened.getByRole('tab', { name: /^Installed · 1/ })).toBeVisible()
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
