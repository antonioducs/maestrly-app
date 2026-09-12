import { createServer, type Server, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, readFile, access, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, expect, _electron as electron, chromium } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url)),
  require = createRequire(import.meta.url)
test('real project chat: code, memory, skills, MCP, historic cards, streamed turns and web decisions', async ({
  request,
}, info) => {
  test.skip(!process.env.MAESTRLY_PROJECT_CHAT_E2E, 'Run scripts/test-project-chat-e2e.mjs')
  test.setTimeout(180000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-project-chat-')),
    server = process.env.MAESTRLY_SERVER_URL!,
    web = process.env.MAESTRLY_WEB_URL!
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined,
    browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    model: Server | undefined
  let held: ServerResponse | undefined,
    phase = 'context'
  let sentAt = 0
  const requests: any[] = [],
    latencies: number[] = [],
    used: string[] = []
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  try {
    await mkdir(path.join(root, '.agents/skills/chat-fixture'), { recursive: true })
    await writeFile(path.join(root, 'source.txt'), 'source-context-proof\n')
    await writeFile(
      path.join(root, '.agents/skills/chat-fixture/SKILL.md'),
      '---\nname: chat-fixture\ndescription: Verify project chat integration with known evidence.\n---\nThe skill evidence is skill-context-proof. Read the source and return evidence.\n'
    )
    git(['init', '-q', '-b', 'main'])
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    const mcpFile = path.join(root, 'fixture-mcp.mjs')
    await writeFile(
      mcpFile,
      `import {McpServer} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href)};\nimport {StdioServerTransport} from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href)};\nconst s=new McpServer({name:'chat-fixture',version:'1'});s.registerTool('fixture_echo',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:'mcp-context-proof'}]}));await s.connect(new StdioServerTransport());`
    )
    const chunk = (res: ServerResponse, delta: unknown, finish_reason: string | null = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'chat-fixture',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n'
      )
    const end = (res: ServerResponse, text?: string) => {
      if (text) chunk(res, { role: 'assistant', content: text })
      chunk(res, {}, 'stop')
      res.end('data: [DONE]\n\n')
    }
    model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            data: [
              { id: 'chat-fixture', object: 'model' },
              { id: 'chat-fixture-secondary', object: 'model' },
            ],
          })
        )
        return
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      for await (const c of req) body += c
      const input = JSON.parse(body)
      requests.push(input)
      res.setHeader('content-type', 'text/event-stream')
      const did = (id: string) => input.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === id)
      const invoke = (id: string, suffix: string, args: unknown) => {
        const name = input.tools
          ?.map((t: any) => t.function.name)
          .find((n: string) => n === suffix || n.endsWith('_' + suffix) || n.includes('__' + suffix + '_'))
        if (!name) {
          end(res, 'Missing fixture tool: ' + suffix)
          return
        }
        used.push(suffix)
        chunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        })
        chunk(res, {}, 'tool_calls')
        res.end('data: [DONE]\n\n')
      }
      if (phase === 'context') {
        const steps: [string, string, unknown][] = [
          ['proof-read', 'read', { path: 'source.txt' }],
          ['proof-memory', 'memory_search', { query: 'chat proof' }],
          ['proof-skill', 'use_skill', { name: 'chat-fixture' }],
          ['proof-discover', 'mcp_search', { server: 'Project chat MCP', query: 'fixture_echo' }],
          ['proof-mcp', 'mcp_call', { server: 'Project chat MCP', tool: 'fixture_echo', arguments: {} }],
          ['proof-board', 'board_search_cards', { query: 'Historical', done: true }],
        ]
        const next = steps.find(([id]) => !did(id))
        if (next) {
          invoke(...next)
          return
        }
        held = res
        sentAt = Date.now()
        chunk(res, { role: 'assistant', content: 'Live project evidence: ' })
        return
      }
      if (phase === 'followup') {
        end(res, 'The previous evidence remains in this conversation.')
        return
      }
      if (phase === 'question') {
        if (!did('ask-branch')) {
          invoke('ask-branch', 'ask_question', {
            questions: [
              {
                header: 'Branch',
                question: 'Which branch should I use?',
                options: [{ label: 'main' }, { label: 'release' }],
              },
            ],
          })
          return
        }
        if (!did('write-proof')) {
          invoke('write-proof', 'write', { path: 'chat-proof.txt', content: 'web-permission-proof\n' })
          return
        }
        end(res, 'Wrote the proof after your answer and permission.')
        return
      }
      if (phase === 'auto') {
        if (!did('auto-bash')) {
          invoke('auto-bash', 'bash', { command: 'printf auto-command-proof' })
          return
        }
        end(res, 'Auto mode command completed after approval.')
        return
      }
      if (phase === 'full') {
        if (!did('full-write')) {
          invoke('full-write', 'write', { path: 'full-access-proof.txt', content: 'full-access-proof\n' })
          return
        }
        end(res, 'Full access write completed without an approval prompt.')
        return
      }
      if (phase === 'plan') {
        invoke('plan-review', 'review_plan', {
          title: 'Verified plan',
          plan: 'Read the existing evidence and confirm the approved plan.',
        })
        return
      }
      if (phase === 'approved') {
        end(res, 'Approved implementation complete.')
        return
      }
      if (phase === 'visual') {
        const marker = process.env.MAESTRLY_CHAT_PREVIEW_INFO
        const action = marker ? await readFile(marker + '.action', 'utf8').catch(() => 'message') : 'message'
        if (action === 'plan') {
          invoke('visual-plan-' + requests.length, 'review_plan', {
            title: 'Review the project evidence',
            plan: '## Verification\n\n1. Read the source in the selected worktree.\n2. Check project memory and completed cards.\n3. Report the evidence before applying a change.',
          })
          return
        }
        if (action === 'question') {
          invoke('visual-question-' + requests.length, 'ask_question', {
            questions: [
              {
                header: 'Next step',
                question: 'What would you like to inspect next?',
                options: [{ label: 'Source code' }, { label: 'Completed cards' }],
              },
            ],
          })
          return
        }
        end(
          res,
          '## Project evidence\n\nThe conversation uses the selected **main** worktree and its project memory.\n\n- Source: \\`source-context-proof\\`\n- Memory: \\`memory-context-proof\\`\n- MCP: \\`mcp-context-proof\\`\n\nThe completed card is available through the board search tool.\n\n\\`\\`\\`ts\nconst project = { context: "available", connected: true }\n\\`\\`\\`'
        )
        return
      }
      held = res
      chunk(res, { role: 'assistant', content: 'Connection recovery proof: ' })
    })
    await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', resolve))
    const modelPort = (model.address() as { port: number }).port
    const login = await request.post(server + '/api/auth/sign-in/email', {
      data: { email: process.env.MAESTRLY_E2E_EMAIL, password: process.env.MAESTRLY_E2E_PASSWORD },
    })
    expect(login.ok()).toBe(true)
    const headers = { 'x-maestrly-protocol-version': '1.0' }
    const org = (await (await request.get(server + '/api/v1/organizations', { headers })).json())[0].id
    const post = async (url: string, data: unknown) => {
      const r = await request.post(server + url, {
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        data,
      })
      expect(r.ok(), await r.text()).toBe(true)
      return r.json()
    }
    const created = await post('/api/v1/organizations/' + org + '/projects', { name: 'Project chat fixture' }),
      projectId = created.project.id,
      boardId = created.boardId
    const board = await (
      await request.get(server + `/api/v1/organizations/${org}/boards/${boardId}`, { headers })
    ).json()
    const done = board.columns.find((c: any) => c.role === 'done')
    const card = await post(`/api/v1/organizations/${org}/boards/${boardId}/cards`, {
      title: 'Historical completed decision',
      columnId: done.id,
      description: 'historic-card-proof',
    })
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'project-chat-test',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const local = await app.firstWindow()
    await local.getByRole('button', { name: 'Skip', exact: true }).click()
    const call = (name: string, ...args: unknown[]) =>
      local.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    const connection = await call('platformAddConnection', server)
    const pending = await call('platformBeginDeviceAuthorization', connection.id, '')
    expect(
      (await request.get(server + '/api/auth/device?user_code=' + encodeURIComponent(pending.userCode))).ok()
    ).toBe(true)
    expect(
      (await request.post(server + '/api/auth/device/approve', { data: { userCode: pending.userCode } })).ok()
    ).toBe(true)
    await expect
      .poll(async () => (await call('platformPollDeviceAuthorization', connection.id)).state, {
        timeout: 25000,
        intervals: [1100],
      })
      .toBe('connected')
    const workspace = await call('addWorkspace', root)
    await call('platformSetProjectBinding', {
      workspaceId: workspace.id,
      connectionId: connection.id,
      organizationId: org,
      projectId,
      boardId,
    })
    await call('setMemoryEnabled', workspace.id, true)
    await call('createMemory', {
      workspaceId: workspace.id,
      title: 'Chat proof',
      content: 'memory-context-proof',
      type: 'decision',
      source: 'user',
      pinned: true,
    })
    const provider = await call('chatAddProvider', {
      name: 'Project chat fixture',
      baseURL: `http://127.0.0.1:${modelPort}/v1`,
      key: 'fixture-key',
      kind: 'openai',
    })
    expect(provider.ok).toBe(true)
    const mcp = await call('chatMcpAdd', {
      name: 'Project chat MCP',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFile],
    })
    expect(mcp.ok, mcp.error).toBe(true)
    const settings = await call('platformExecutorSettings')
    await call('platformSaveExecutorSettings', {
      ...settings,
      providerIds: [provider.id],
      allowAppTools: true,
      allowMcp: true,
      interactiveChat: true,
      skills: true,
      background: true,
    })
    const status = await call('platformRunnerStart', connection.id)
    expect(status.state, status.error).toBe('running')
    browser = await chromium.launch()
    const context = await browser.newContext({
        storageState: await request.storageState(),
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage()
    page.on('pageerror', (e) => console.error('web chat fixture', e.message))
    await page.goto(web)
    await page.getByRole('button', { name: 'Project chat', exact: true }).click()
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
    const send = async (text: string) => {
      await page.getByRole('textbox', { name: 'Message the project' }).fill(text)
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
    }
    await page.evaluate(() => {
      const arrivals: Record<string, number> = {}
      ;(window as any).__chatArrivals = arrivals
      new MutationObserver(() => {
        const text = document.querySelector('.project-chat-message.assistant')?.textContent ?? ''
        for (const marker of ['Live project evidence:', ...Array.from({ length: 5 }, (_, i) => 'chunk-' + i)])
          if (text.includes(marker) && !arrivals[marker]) arrivals[marker] = Date.now()
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await send('Inspect the project evidence and find the completed card.')
    // The fixture MCP is a real subprocess and its use needs one explicit web permission.
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    await expect(allow).toBeVisible({ timeout: 30000 })
    await allow.click()
    await expect(page.locator('.project-chat-message.assistant')).toContainText('Live project evidence:', {
      timeout: 30000,
    })
    latencies.push((await page.evaluate(() => (window as any).__chatArrivals['Live project evidence:'])) - sentAt)
    expect(held).toBeTruthy()
    for (let i = 0; i < 5; i++) {
      sentAt = Date.now()
      chunk(held!, { content: 'chunk-' + i + ' ' })
      await page.waitForFunction(
        (word) => document.querySelector('.project-chat-message.assistant')?.textContent?.includes(word),
        'chunk-' + i
      )
      latencies.push((await page.evaluate((marker) => (window as any).__chatArrivals[marker], 'chunk-' + i)) - sentAt)
    }
    expect(used).toEqual(
      expect.arrayContaining(['read', 'memory_search', 'use_skill', 'mcp_search', 'mcp_call', 'board_search_cards'])
    )
    const evidence = JSON.stringify(requests.at(-1).messages)
    for (const proof of [
      'source-context-proof',
      'memory-context-proof',
      'skill-context-proof',
      'mcp-context-proof',
      'historic-card-proof',
    ])
      expect(evidence).toContain(proof)
    end(held!, 'Evidence verified.')
    held = undefined
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    const sessionRow = (
      await (
        await request.get(server + `/api/v1/organizations/${org}/projects/${projectId}/chat/sessions`, { headers })
      ).json()
    ).items[0]
    const remoteId = sessionRow.id
    const base = `/api/v1/organizations/${org}/projects/${projectId}/chat/sessions/${remoteId}`
    phase = 'followup'
    await send('Remember the evidence from the previous turn.')
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText('previous evidence remains')
    expect(JSON.stringify(requests.at(-1).messages)).toContain('Live project evidence')
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    phase = 'question'
    await send('Ask before editing.')
    await page.getByRole('radio', { name: 'main', exact: true }).check()
    await page.getByRole('button', { name: 'Send response', exact: true }).click()
    await expect(allow).toBeVisible()
    await allow.click()
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText(
      'after your answer and permission'
    )
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('secondary')
    await page.getByRole('option', { name: /chat-fixture-secondary/ }).click()
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('secondary')
    await page.getByRole('combobox', { name: 'Permission profile', exact: true }).click()
    await page.getByRole('option', { name: 'Approve for me', exact: true }).click()
    phase = 'auto'
    await send('Run the verification command in auto mode.')
    await expect(allow).toBeVisible()
    await allow.click()
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText(
      'Auto mode command completed after approval.'
    )
    expect(requests.at(-1).model).toBe('chat-fixture-secondary')
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Chat mode', exact: true }).click()
    await expect(page.getByRole('option')).toHaveText(['Agent', 'Ask'])
    await page.getByRole('option', { name: 'Agent', exact: true }).click()
    await page.getByRole('combobox', { name: 'Permission profile', exact: true }).click()
    await page.getByRole('option', { name: 'Full access', exact: true }).click()
    phase = 'full'
    await send('Write the full access proof.')
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText(
      'Full access write completed without an approval prompt.'
    )
    await expect(allow).toHaveCount(0)
    const proofPath = (await readdir(path.join(root, 'profile'), { recursive: true })).find((entry) =>
      entry.endsWith('full-access-proof.txt')
    )
    expect(proofPath).toBeTruthy()
    expect((await readFile(path.join(root, 'profile', proofPath!), 'utf8')).trim()).toBe('full-access-proof')
    const configured = await (await request.get(server + base, { headers })).json()
    expect(configured.session).toMatchObject({
      model: expect.any(String),
      mode: 'agent',
      reasoning: null,
      fastMode: false,
      permMode: 'full',
    })
    await page.reload()
    await page.getByRole('button', { name: 'Project chat', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Permission profile', exact: true })).toContainText('Full access')
    await expect(page.getByRole('combobox', { name: 'Chat mode', exact: true })).toContainText('Agent')
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('secondary')
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    phase = 'plan'
    await send('Prepare a plan.')
    await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled()
    phase = 'approved'
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText(
      'Approved implementation complete.'
    )
    await expect(page.getByRole('status').filter({ hasText: 'Ready to chat' })).toBeVisible()
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 })
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath(`project-chat-${width}-${theme}.png`), animations: 'disabled' })
      }
    phase = 'recovery'
    await send('Keep streaming while I reconnect.')
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText('Connection recovery proof:')
    await context.setOffline(true)
    chunk(held!, { content: 'saved while offline ' })
    await context.setOffline(false)
    await page.reload()
    await page.getByRole('button', { name: 'Project chat', exact: true }).click()
    await expect(page.locator('.project-chat-message.assistant').last()).toContainText('saved while offline')
    await page.getByRole('button', { name: 'Stop response', exact: true }).click()
    await expect
      .poll(async () => (await (await request.get(server + base, { headers })).json()).turn.state)
      .toBe('cancelled')
    const snapshot = await (await request.get(server + base, { headers })).json()
    expect(snapshot.session.id).toBe(remoteId)
    expect(new Set(snapshot.messages.map((m: any) => m.id)).size).toBe(snapshot.messages.length)
    expect((await readFile(path.join(root, 'source.txt'), 'utf8')).trim()).toBe('source-context-proof')
    expect(card.id).toBeTruthy()
    const sorted = latencies.slice().sort((a, b) => a - b),
      p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
    await info.attach('stream-latency', {
      body: JSON.stringify({ samplesMs: latencies, p95Ms: p95 }),
      contentType: 'application/json',
    })
    await writeFile(info.outputPath('stream-latency.json'), JSON.stringify({ samplesMs: latencies, p95Ms: p95 }))
    expect(p95).toBeLessThan(500)
    if (process.env.MAESTRLY_CHAT_PREVIEW_INFO) {
      test.setTimeout(0)
      phase = 'visual'
      const file = process.env.MAESTRLY_CHAT_PREVIEW_INFO
      await writeFile(
        file,
        JSON.stringify({
          web,
          server,
          sessionId: remoteId,
          email: process.env.MAESTRLY_E2E_EMAIL,
          password: process.env.MAESTRLY_E2E_PASSWORD,
        }),
        { mode: 0o600 }
      )
      while (
        !(await access(file + '.stop').then(
          () => true,
          () => false
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 250))
      await rm(file, { force: true })
      await rm(file + '.stop', { force: true })
      await rm(file + '.action', { force: true })
    }
    await call('platformRunnerStop')
  } finally {
    held?.end()
    await browser?.close()
    await app?.close()
    model?.closeAllConnections()
    if (model) await new Promise<void>((resolve) => model!.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
