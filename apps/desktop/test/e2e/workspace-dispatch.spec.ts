import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const REQUEST =
  'Elabora o plano e envia para desenvolvimento no workspace Target, criando a branch feat/export a partir da main.'
const COLLISION = 'Send this plan for development in workspace Target, creating branch feat/existing from main.'
const PLAN = 'Implement CSV export. Preserve Unicode headers and test empty input.'

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : ''
const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
  res.write(
    `data: ${JSON.stringify({
      id: 'workspace-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'workspace-primary',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  )
const end = (res: ServerResponse, content: string) => {
  chunk(res, { role: 'assistant', content })
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

test('hands a standalone Ask plan to a named workspace branch without changing the source chat', async () => {
  test.setTimeout(180_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-workspace-dispatch-'))
  const repository = path.join(root, 'Target')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' }).toString().trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repository, 'README.md'), '# Target\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])
  const baseRevision = git(['rev-parse', 'HEAD'])
  git(['checkout', '-q', '-b', 'feat/existing'])
  writeFileSync(path.join(repository, 'existing.txt'), 'Keep this branch and file.\n')
  git(['add', '-A'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'existing work'])
  const existingRevision = git(['rev-parse', 'HEAD'])

  let providerId = ''
  let workspaceId = ''
  let app: ElectronApplication | undefined
  let page!: Page
  const requests: Array<{ lastUser: string; model: string; tools: string[]; results: Record<string, string> }> = []
  const batch = (collision = false) => ({
    target: { workspaceId, baseBranch: 'main' },
    defaults: { providerId, modelId: 'workspace-secondary', reasoning: 'off', fastMode: false },
    tasks: [
      {
        requestKey: collision ? 'collision' : 'export',
        title: collision ? 'Collision' : 'CSV export',
        prompt: PLAN,
        target: { branch: collision ? 'feat/existing' : 'feat/export' },
      },
    ],
  })
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'workspace-primary' }, { id: 'workspace-secondary' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body)
    const lastUser = text([...input.messages].reverse().find((message: any) => message.role === 'user')?.content)
    const results: Record<string, string> = Object.fromEntries(
      input.messages
        .filter((message: any) => message.role === 'tool' && message.tool_call_id)
        .map((message: any) => [message.tool_call_id, text(message.content)])
    )
    requests.push({
      lastUser,
      model: input.model,
      tools: (input.tools ?? []).map((tool: any) => tool.function.name),
      results,
    })
    res.setHeader('content-type', 'text/event-stream')
    if (lastUser.includes(REQUEST)) {
      if (!results.inventory) return call(res, 'inventory', 'list_conversation_workspaces', {})
      if (!results.models) return call(res, 'models', 'list_conversation_models', {})
      if (!results.dispatch) return call(res, 'dispatch', 'start_conversations', batch())
      if (!results.replay) return call(res, 'replay', 'start_conversations', batch())
      return end(res, 'Development started in Target.')
    }
    if (lastUser.includes(COLLISION)) {
      if (!results.collision) return call(res, 'collision', 'start_conversations', batch(true))
      return end(res, 'Existing branch preserved.')
    }
    end(res, 'Received the development plan.')
  })
  const api = (name: string, ...args: unknown[]): Promise<any> =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const idle = (id: string) =>
    expect.poll(async () => (await api('chatRuntime', id)).streaming, { timeout: 60_000 }).toBe(false)
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `workspace-${Date.now()}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)
    const provider = await api('chatAddProvider', {
      name: 'Workspace fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    providerId = provider.id
    await api('chatSetDefault', { providerId, modelId: 'workspace-primary' })
    workspaceId = (await api('addWorkspace', repository)).id
    const source = await api('createStandaloneConversation', { name: 'Planning chat' })
    expect(await api('chatGetMode', source.id)).toBe('ask')
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Planning chat' }).first().click()
    await page.locator('.chat-input[contenteditable="true"]:visible').fill(REQUEST)
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('Development started in Target.')).toBeVisible({ timeout: 60_000 })
    await idle(source.id)
    const replay = requests.find((request) => request.results.replay)!
    expect(replay).toBeDefined()
    expect(replay.tools).not.toContain('bash')
    expect(replay.tools).not.toContain('write')
    expect(replay.tools).not.toContain('edit')
    expect(replay.results.inventory).toContain(workspaceId)
    expect(replay.results.models).toContain('workspace-secondary')
    expect(JSON.parse(replay.results.replay).items[0]).toMatchObject({
      status: 'started',
      replayed: true,
      workspaceId,
      branch: 'feat/export',
      baseRevision,
    })
    const destinations = await api('listConversations', workspaceId)
    expect(destinations).toHaveLength(1)
    const destination = destinations[0]
    expect(destination).toMatchObject({ scope: 'project', workspaceId, branch: 'feat/export', name: 'CSV export' })
    expect(git(['rev-parse', 'feat/export'])).toBe(baseRevision)
    expect(await api('chatGetSelection', destination.id)).toEqual({ providerId, modelId: 'workspace-secondary' })
    expect(await api('chatGetReasoning', destination.id)).toBe('off')
    expect(await api('chatGetFastMode', destination.id)).toBe(false)
    expect(await api('chatGetMode', destination.id)).toBe('agent')
    await idle(destination.id)
    const seed = requests.find((request) => request.lastUser.includes(PLAN))!
    expect(seed.model).toBe('workspace-secondary')
    expect(seed.tools).not.toContain('start_conversations')
    expect(seed.tools).not.toContain('list_conversation_workspaces')
    expect(await api('chatGetMode', source.id)).toBe('ask')
    expect((await api('listStandaloneConversations', true)).find((item: any) => item.id === source.id)).toMatchObject({
      scope: 'standalone',
      workspaceId: null,
      branch: null,
      cwd: source.cwd,
    })
    await expect(page.getByTestId('conversation-dispatch-card').last()).toContainText('CSV export')

    expect((await api('chatSend', source.id, COLLISION)).ok).toBe(true)
    await expect.poll(() => requests.some((request) => request.results.collision), { timeout: 60_000 }).toBe(true)
    await idle(source.id)
    const collision = requests.find((request) => request.results.collision)!
    expect(JSON.parse(collision.results.collision).ok).toBe(false)
    expect(await api('listConversations', workspaceId)).toHaveLength(1)
    expect(git(['rev-parse', 'feat/existing'])).toBe(existingRevision)
    expect(git(['branch', '--show-current'])).toBe('feat/existing')
    expect(git(['status', '--porcelain'])).toBe('')
  } finally {
    await app?.close().catch(() => undefined)
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})

test('creates a workspace from a vague request in a standalone chat and starts the work in it', async () => {
  test.setTimeout(180_000)
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'maestrly-workspace-creation-')))
  const projects = path.join(root, 'Projects')
  mkdirSync(projects)
  const work = path.join(root, 'export-target-work')
  mkdirSync(work)
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
  git(work, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(work, 'README.md'), '# Export target\n')
  git(work, ['add', '-A'])
  git(work, ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'fixture'])
  const remote = path.join(root, 'export-target.git')
  git(root, ['clone', '-q', '--bare', work, remote])
  const remoteUrl = `file://${remote}`
  const baseRevision = git(remote, ['rev-parse', 'main'])
  // Phrased like a person talks: no explicit verb-object pair, and the retry refers back to the earlier message.
  const FIRST = `pega esse repo ${remoteUrl} e cria lá pra mim, quero fazer o export de CSV nele`
  const AGAIN = 'pronto, defini a pasta. tenta de novo e já começa o export'
  const create = { requestKey: 'export-target', name: 'export-target', source: { kind: 'git', url: remoteUrl } }

  let providerId = ''
  let app: ElectronApplication | undefined
  let page!: Page
  const requests: Array<{ lastUser: string; model: string; tools: string[]; results: Record<string, string> }> = []
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'workspace-primary' }, { id: 'workspace-secondary' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const input = JSON.parse(body)
    const lastUser = text([...input.messages].reverse().find((message: any) => message.role === 'user')?.content)
    const results: Record<string, string> = Object.fromEntries(
      input.messages
        .filter((message: any) => message.role === 'tool' && message.tool_call_id)
        .map((message: any) => [message.tool_call_id, text(message.content)])
    )
    requests.push({ lastUser, model: input.model, tools: (input.tools ?? []).map((tool: any) => tool.function.name), results })
    res.setHeader('content-type', 'text/event-stream')
    if (lastUser.includes(AGAIN)) {
      if (!results['create-2']) return call(res, 'create-2', 'create_workspace', create)
      if (!results['replay-2']) return call(res, 'replay-2', 'create_workspace', create)
      if (!results['dispatch-2'])
        return call(res, 'dispatch-2', 'start_conversations', {
          target: { workspaceId: JSON.parse(results['create-2']).workspaceId },
          defaults: { providerId, modelId: 'workspace-secondary', reasoning: 'off', fastMode: false },
          tasks: [{ requestKey: 'csv-export', title: 'CSV export', prompt: PLAN }],
        })
      return end(res, 'Project ready and work started.')
    }
    if (lastUser.includes(FIRST)) {
      if (!results['inventory-1']) return call(res, 'inventory-1', 'list_conversation_workspaces', {})
      if (!results['create-1']) return call(res, 'create-1', 'create_workspace', create)
      return end(res, 'The projects folder is not set yet.')
    }
    end(res, 'Received.')
  })
  const api = (name: string, ...args: unknown[]): Promise<any> =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  const idle = (id: string) =>
    expect.poll(async () => (await api('chatRuntime', id)).streaming, { timeout: 60_000 }).toBe(false)
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `workspace-creation-${Date.now()}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        // The "Set projects folder" button in the chat card picks this folder.
        AGENTS_E2E_PROJECT_PICKERS: JSON.stringify([projects]),
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)
    const provider = await api('chatAddProvider', {
      name: 'Workspace fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    providerId = provider.id
    await api('chatSetDefault', { providerId, modelId: 'workspace-primary' })
    const source = await api('createStandaloneConversation', { name: 'Idea chat' })
    expect(await api('chatGetMode', source.id)).toBe('ask')
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await page.locator('li.conv-item', { hasText: 'Idea chat' }).first().click()

    // Without a projects folder nothing is created; the card offers to set it.
    await page.locator('.chat-input[contenteditable="true"]:visible').fill(FIRST)
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('The projects folder is not set yet.')).toBeVisible({ timeout: 60_000 })
    await idle(source.id)
    const refused = requests.find((request) => request.results['create-1'])!
    expect(JSON.parse(refused.results['create-1'])).toMatchObject({ ok: false, code: 'projects-directory-not-set' })
    expect(refused.tools).toEqual(expect.arrayContaining(['create_workspace', 'find_github_repositories']))
    for (const name of ['bash', 'write', 'edit']) expect(refused.tools).not.toContain(name)
    expect(readdirSync(projects)).toEqual([])
    const card = page.getByTestId('workspace-creation-card').last()
    await card.getByRole('button', { name: 'Set projects folder' }).click()
    await expect(card).toContainText(`Projects folder: ${projects}`)
    expect(await api('getProjectsDirectory')).toBe(projects)

    // A later message that only says "try again" clones, registers, replays without a second clone and starts
    // the one conversation the new project needs, with no separate request for it.
    expect((await api('chatSend', source.id, AGAIN)).ok).toBe(true)
    await expect(page.getByText('Project ready and work started.')).toBeVisible({ timeout: 60_000 })
    await idle(source.id)
    const done = requests.find((request) => request.results['dispatch-2'])!
    const created = JSON.parse(done.results['create-2'])
    expect(created).toMatchObject({
      ok: true,
      name: 'export-target',
      path: path.join(projects, 'export-target'),
      defaultBranch: 'main',
      remoteUrl,
      reused: false,
    })
    expect(JSON.parse(done.results['replay-2'])).toMatchObject({ ok: true, workspaceId: created.workspaceId, replayed: true })
    expect(JSON.parse(done.results['dispatch-2']).items[0]).toMatchObject({
      status: 'started',
      workspaceId: created.workspaceId,
      baseRevision,
    })
    expect(git(path.join(projects, 'export-target'), ['rev-parse', 'HEAD'])).toBe(baseRevision)
    const registered = (await api('listWorkspaces')).filter((item: any) => item.path === path.join(projects, 'export-target'))
    expect(registered).toHaveLength(1)
    expect(readdirSync(projects)).toEqual(['export-target'])
    const destinations = await api('listConversations', created.workspaceId)
    expect(destinations).toHaveLength(1)
    await idle(destinations[0].id)
    const seed = requests.find((request) => request.lastUser.includes(PLAN))!
    for (const name of ['start_conversations', 'create_workspace', 'find_github_repositories'])
      expect(seed.tools).not.toContain(name)
    expect(await api('chatGetMode', source.id)).toBe('ask')
    await expect(page.getByTestId('workspace-creation-card').last()).toContainText('export-target')
  } finally {
    await app?.close().catch(() => undefined)
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
