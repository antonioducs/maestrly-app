import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createSocket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
/**
 * The address the owner publishes. TLS is terminated by whatever they put in front of the endpoint, so
 * this suite reaches the listener on loopback and carries the published name in the Host header, exactly
 * as a reverse proxy would. No name is ever resolved, and nothing here needs a certificate.
 */
const publicUrl = 'https://maestrly.example'
const publicHost = new URL(publicUrl).host

/**
 * The private bot path, end to end, against the real desktop application and nothing else.
 *
 * This file plays the bot: it discovers the endpoint this computer serves, registers itself, authorizes
 * with PKCE, waits for the person to approve it, and then speaks JSON-RPC over HTTP like any other MCP
 * client. No server, no database and no relay take part, no organization, project, board, card or runner
 * exists, and the provider is a local fixture so no external account or credential is involved.
 */
test('personal bot conversations: a private bot drives native chats through this desktop alone', async () => {
  test.skip(!process.env.MAESTRLY_BOT_CONVERSATIONS_E2E, 'Run scripts/test-bot-conversations-e2e.mjs')
  test.setTimeout(600_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-relay-'))
  const repo = path.join(root, 'repo')
  const profile = path.join(root, 'profile')
  let app: ElectronApplication | undefined
  let page!: Page
  let model: Server | undefined
  let held: ServerResponse | undefined
  let holdMarker: string | null = null
  let answeredWith = ''
  let endpointPort = 0
  const calls: string[] = []
  const seen = (marker: string) => calls.filter((entry) => entry === marker).length
  /** Let go of a turn this suite is holding open on the provider side. */
  const release = () => {
    held?.destroy()
    held = undefined
  }

  const freePort = async () => {
    const probe = createSocket()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as { port: number }
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }

  interface Reply {
    status: number
    headers: Record<string, string | string[] | undefined>
    text: string
    json: any
  }
  /** Every bot request: loopback socket, published name in Host, exactly like a proxy in front of it. */
  const dial = (
    method: string,
    target: string,
    options: { headers?: Record<string, string>; body?: string; host?: string } = {}
  ) =>
    new Promise<Reply>((resolve, reject) => {
      const url = new URL(target, publicUrl)
      const body = options.body
      const outbound = httpRequest(
        {
          host: '127.0.0.1',
          port: endpointPort,
          method,
          path: url.pathname + url.search,
          headers: {
            host: options.host ?? publicHost,
            ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
            ...options.headers,
          },
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (part: string) => (text += part))
          response.on('end', () => {
            let json: any = null
            try {
              json = text ? JSON.parse(text) : null
            } catch {}
            resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json })
          })
        }
      )
      outbound.on('error', reject)
      if (body !== undefined) outbound.write(body)
      outbound.end()
    })

  const chunk = (res: ServerResponse, delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'bot-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'bot-fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    )
  const end = (res: ServerResponse, content?: string) => {
    if (content) chunk(res, { role: 'assistant', content })
    chunk(res, {}, 'stop')
    res.end('data: [DONE]\n\n')
  }

  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  // The desktop bot surface, one adapter deep: the preload names of src/preload/api-bot.ts.
  const bot = {
    settings: () => call('botSettings') as Promise<any>,
    configureServer: (input: Record<string, unknown>) => call('botConfigureServer', input) as Promise<any>,
    connect: (input: Record<string, unknown>) => call('botConnect', input) as Promise<any>,
    authorize: (id: string, approved: boolean, connectionId: string) =>
      call('botAuthorize', id, approved, connectionId) as Promise<any>,
    revoke: (connectionId: string) => call('botRevoke', connectionId) as Promise<any>,
    setPermissionCeiling: (connectionId: string, ceiling: 'ask' | 'auto' | 'full') =>
      call('botSetPermissionCeiling', connectionId, ceiling) as Promise<any>,
    management: (conversationId: string, state: 'active' | 'paused') =>
      call('botSetManagement', conversationId, state) as Promise<any>,
  }

  const launch = async () => {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-relay-e2e',
        AGENTS_USERDATA: profile,
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page
      .getByRole('button', { name: 'Skip', exact: true })
      .click({ timeout: 10_000 })
      .catch(() => {})
  }

  let rpcId = 0
  const rpc = (token: string, method: string, params?: unknown) =>
    dial('POST', '/mcp/bots', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const { status, json } = await rpc(token, 'tools/call', { name, arguments: args })
    if (status !== 200 || !json) throw new Error(`${name} was refused with ${status}`)
    if (json.error) throw new Error(`${name} failed: ${json.error.message}`)
    if (json.result?.isError) throw new Error(`${name} failed: ${json.result.content?.[0]?.text ?? 'unknown'}`)
    return json.result.structuredContent as any
  }

  /** What a bot reads before it can authorize: the protected resource, then its authorization server. */
  const discover = async () => {
    const resource = await dial('GET', '/.well-known/oauth-protected-resource/mcp/bots')
    expect(resource.status, resource.text).toBe(200)
    expect(resource.json.resource).toBe(`${publicUrl}/mcp/bots`)
    const server = await dial('GET', '/.well-known/oauth-authorization-server')
    expect(server.status, server.text).toBe(200)
    expect(server.json.issuer).toBe(resource.json.authorization_servers[0])
    expect(server.json.code_challenge_methods_supported).toContain('S256')
    return { resource: resource.json, server: server.json }
  }

  /** Register, start the code flow with PKCE, and stop where the person has to answer. */
  const requestAuthorization = async (clientName: string) => {
    const { resource, server } = await discover()
    const redirectUri = `http://127.0.0.1:${await freePort()}/callback`
    const registered = await dial('POST', server.registration_endpoint, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    expect(registered.status, registered.text).toBe(201)
    expect(registered.json.client_secret, 'a bot is a public client').toBeUndefined()
    const verifier = randomBytes(48).toString('base64url')
    const state = randomUUID()
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: registered.json.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: (resource.scopes_supported ?? []).join(' '),
      resource: resource.resource,
      state,
    })
    const consent = await dial('GET', `${server.authorization_endpoint}?${query.toString()}`)
    expect(consent.status, consent.text).toBe(200)
    expect(consent.text, 'nothing is granted by asking').not.toContain('code=')
    const poll = /authorize\/status\?poll=([A-Za-z0-9._~%-]+)/.exec(consent.text)?.[1]
    expect(poll, 'the waiting page carries its own secret, never a request id').toBeTruthy()
    await expect
      .poll(async () => (await bot.settings()).pendingAuthorizations.map((item: any) => item.clientName), {
        timeout: 30_000,
        intervals: [500],
      })
      .toContain(clientName)
    const pending = (await bot.settings()).pendingAuthorizations.find((item: any) => item.clientName === clientName)
    return { server, resource, client: registered.json, redirectUri, verifier, state, poll: poll!, pending }
  }

  /** The owner answers in the application; only then does a code exist, and only for this connection. */
  const authorize = async (clientName: string, connectionId: string) => {
    const waiting = await requestAuthorization(clientName)
    await bot.authorize(waiting.pending.id, true, connectionId)
    const ready = await dial('GET', `/oauth/authorize/status?poll=${waiting.poll}`)
    expect(ready.json?.status, ready.text).toBe('ready')
    const redirected = new URL(ready.json.redirectTo)
    expect(redirected.searchParams.get('state')).toBe(waiting.state)
    const code = redirected.searchParams.get('code')
    expect(code, ready.json.redirectTo).toBeTruthy()
    const redeem = () =>
      dial('POST', waiting.server.token_endpoint, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: waiting.client.client_id,
          redirect_uri: waiting.redirectUri,
          code_verifier: waiting.verifier,
          resource: waiting.resource.resource,
        }).toString(),
      })
    const granted = await redeem()
    expect(granted.status, granted.text).toBe(200)
    expect(granted.json.token_type).toBe('Bearer')
    return granted.json.access_token as string
  }

  const row = (name: string) => page.locator('.conv-item').filter({ hasText: name }).first()
  const conversations = async (workspaceId: string) =>
    (await call('listConversations', workspaceId)) as Array<{
      id: string
      name: string
      cwd: string
      branch: string
      botOrigin?: { connectionId: string; botName: string }
      botManagementState?: string
    }>

  try {
    // ---- A repository that exists only for this run -------------------------------------------------
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, 'source.txt'), 'bot-source-proof\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')

    // ---- The provider the conversations actually run against ----------------------------------------
    model = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'bot-fixture', object: 'model' }] }))
        return
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      for await (const part of req) body += part
      const input = JSON.parse(body)
      const last = [...(input.messages ?? [])].reverse().find((message: any) => message.role === 'user')
      const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      const marker = /proof-[a-z-]+/.exec(content)?.[0] ?? 'proof-unknown'
      calls.push(marker)
      res.setHeader('content-type', 'text/event-stream')
      const replyTo = (id: string) =>
        (input.messages ?? []).find((message: any) => message.role === 'tool' && message.tool_call_id === id)
      const invoke = (id: string, suffix: string, args: unknown) => {
        const name = input.tools
          ?.map((entry: any) => entry.function.name)
          .find((value: string) => value === suffix || value.endsWith(`_${suffix}`) || value.includes(`__${suffix}_`))
        if (!name) {
          end(res, `Missing fixture tool: ${suffix}`)
          return
        }
        chunk(res, {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        })
        chunk(res, {}, 'tool_calls')
        res.end('data: [DONE]\n\n')
      }
      // An ordinary question: the bot may answer this one, and the turn continues with what it said.
      if (marker === 'proof-question') {
        const answer = replyTo('ask-branch')
        if (!answer) {
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
        answeredWith = typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content)
        end(res, 'Bot evidence for proof-question.')
        return
      }
      // A file write is a protected operation: what happens to it is the owner's ceiling, not the bot's.
      if (['proof-permission', 'proof-denial', 'proof-permission-auto'].includes(marker)) {
        if (!replyTo(marker)) {
          invoke(marker, 'write', { path: `${marker}.txt`, content: 'Owner-approved fixture\n' })
          return
        }
        end(res, `Bot evidence for ${marker}.`)
        return
      }
      // A plan is the owner's decision, so this one is expected to stall until they answer it.
      if (marker === 'proof-plan') {
        if (!replyTo('plan-review')) {
          invoke('plan-review', 'review_plan', {
            title: 'Verified plan',
            plan: 'Read the existing evidence and confirm the approved plan.',
          })
          return
        }
        end(res, 'Bot evidence for proof-plan.')
        return
      }
      if (holdMarker && marker === holdMarker) {
        held = res
        chunk(res, { role: 'assistant', content: `Holding the turn for ${marker}: ` })
        return
      }
      end(res, `Bot evidence for ${marker}.`)
    })
    await new Promise<void>((resolve) => model!.listen(0, '127.0.0.1', resolve))
    const modelPort = (model.address() as { port: number }).port

    // ---- The person's own desktop: a project, an account, and the endpoint they turn on --------------
    await launch()
    const workspace = (await call('addWorkspace', repo)) as { id: string; name: string }
    const provider = (await call('chatAddProvider', {
      name: 'Bot fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${modelPort}/v1`,
    })) as { ok: boolean; id: string }
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'bot-fixture' })

    expect((await bot.settings()).server.enabled, 'the endpoint is off until the person turns it on').toBe(false)
    endpointPort = await freePort()
    await bot.configureServer({ enabled: true, host: '127.0.0.1', port: endpointPort, publicUrl })
    await expect
      .poll(async () => (await bot.settings()).server.state, { timeout: 30_000, intervals: [500] })
      .toBe('listening')
    const published = (await bot.settings()).server
    expect(published.publicUrl).toBe(publicUrl)
    expect(published.port).toBe(endpointPort)
    // Only the published name and the loopback listener are served; anything else is a foreign host.
    expect((await dial('GET', '/.well-known/oauth-protected-resource/mcp/bots')).status).toBe(200)
    expect(
      (await dial('GET', '/.well-known/oauth-protected-resource/mcp/bots', { host: 'attacker.example' })).status,
      'a request under another name never reaches these chats'
    ).toBe(403)

    // ---- The person connects one bot, to one repository, from their own desktop ----------------------
    const connected = await bot.connect({
      name: 'Private Grok bot',
      workspaceIds: [workspace.id],
      providerIds: [provider.id],
      selections: [{ providerId: provider.id, modelId: 'bot-fixture' }],
      actions: ['chats:read', 'chats:write', 'chats:control', 'chats:answer'],
    })
    const record = connected.connections.find((item: any) => item.name === 'Private Grok bot')
    expect(record, JSON.stringify(connected)).toBeTruthy()
    expect(record.workspaceIds).toEqual([workspace.id])
    expect(record.revokedAt).toBeNull()
    // What the person copies into their bot is a configuration, never a credential.
    expect(record.mcpConfig).not.toMatch(/credential|client_secret|"secret"|access_token/i)
    const configured: any = Object.values(JSON.parse(record.mcpConfig).mcpServers)[0]
    expect(new URL(configured.url).pathname).toBe('/mcp/bots')
    expect(new URL(configured.url).origin).toBe(publicUrl)
    expect(configured.oauth.clientId).toBeUndefined()
    expect(record.mcpConfig).not.toContain(repo)
    expect(record.mcpConfig).not.toContain(profile)

    // ---- Nothing is granted until the person answers, and a denial grants nothing --------------------
    expect((await rpc('not-a-token', 'tools/list')).status, 'an unauthenticated bot is refused').toBe(401)
    const refused = await requestAuthorization('Bot the person refuses')
    await bot.authorize(refused.pending.id, false, record.id)
    const denial = await dial('GET', `/oauth/authorize/status?poll=${refused.poll}`)
    expect(denial.json?.status).toBe('ready')
    expect(new URL(denial.json.redirectTo).searchParams.get('error')).toBe('access_denied')
    expect(new URL(denial.json.redirectTo).searchParams.get('code')).toBeNull()

    const botToken = await authorize('Private Grok bot', record.id)
    const catalog = await rpc(botToken, 'tools/list')
    expect(catalog.status, catalog.text).toBe(200)
    const toolNames: string[] = catalog.json.result.tools.map((entry: any) => entry.name)
    for (const required of [
      'bot_list_workspaces',
      'bot_list_chats',
      'bot_create_chat',
      'bot_send_message',
      'bot_read_chat',
      'bot_answer_question',
      'bot_cancel_turn',
      'bot_wait_events',
    ])
      expect(toolNames, `the bot catalog is missing ${required}`).toContain(required)
    expect(
      toolNames.filter((name) => name.startsWith('maestrly_')),
      'a bot must not reach the delegation tools'
    ).toEqual([])

    const listed = await tool(botToken, 'bot_list_workspaces', {})
    expect(listed.workspaces.map((item: any) => item.workspaceId)).toEqual([workspace.id])
    expect(JSON.stringify(listed), 'no path from this computer is ever advertised').not.toContain(repo)
    expect(JSON.stringify(listed)).not.toContain(profile)
    const offered = await tool(botToken, 'bot_list_selections', {})
    const selection = offered.selections.find((item: any) => item.label === 'bot-fixture')
    expect(selection, 'the desktop must offer the model it actually has').toBeTruthy()
    // Nothing was chosen for this bot, so it is offered the strictest mode and nothing else.
    expect(selection.permissionModes, 'a bot is only offered what its owner allowed it').toEqual(['ask'])
    const botSelection = { selectionId: selection.selectionId }

    const transcript = async (token: string, conversationId: string) =>
      (await tool(token, 'bot_read_chat', { conversationId })) as any
    const assistantText = (snapshot: any) =>
      snapshot.messages
        .filter((message: any) => message.role === 'assistant')
        .flatMap((message: any) => message.parts.map((part: any) => part.text ?? ''))
        .join('\n')
    const awaitEvidence = async (conversationId: string, marker: string) =>
      expect
        .poll(async () => assistantText(await transcript(botToken, conversationId)), {
          timeout: 120_000,
          intervals: [1_000],
        })
        .toContain(`Bot evidence for ${marker}`)

    // ---- The bot starts a conversation, and the person sees it on their own desktop ------------------
    const first = await tool(botToken, 'bot_create_chat', {
      workspaceId: workspace.id,
      name: 'Bot chat one',
      baseBranch: 'main',
      selection: botSelection,
      message: 'Report the evidence for proof-one.',
      idempotencyKey: randomUUID(),
    })
    const firstId: string = first.conversation.id
    await awaitEvidence(firstId, 'proof-one')
    const followed = await tool(botToken, 'bot_wait_events', { conversationId: firstId, cursor: 0, timeoutSeconds: 5 })
    expect(followed.events.length, 'the durable stream replays what already happened').toBeGreaterThan(0)
    expect(followed.cursor).toBeGreaterThan(0)

    const local = await conversations(workspace.id)
    expect(local).toHaveLength(1)
    const firstLocal = local[0]!
    expect(firstLocal.name).toBe('Bot chat one')
    expect(firstLocal.botOrigin?.botName).toBe('Private Grok bot')
    expect(firstLocal.botOrigin?.connectionId).toBe(record.id)
    expect(firstLocal.botManagementState).toBe('active')
    expect(firstLocal.branch.startsWith('bot/'), 'a bot conversation gets its own branch').toBe(true)
    expect(firstLocal.cwd).not.toBe(repo)
    expect(firstLocal.cwd.startsWith(repo + path.sep), 'a bot never runs in the repository itself').toBe(false)
    await access(path.join(firstLocal.cwd, '.git'))
    await access(path.join(firstLocal.cwd, 'source.txt'))

    await row('Bot chat one').click()
    await expect(page.getByText('Bot evidence for proof-one.', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText('Report the evidence for proof-one.', { exact: false }).first()).toBeVisible()
    await expect(row('Bot chat one').getByTestId('conversation-bot-badge')).toContainText('Private Grok bot')
    await page.screenshot({ path: test.info().outputPath('bot-conversation.png'), fullPage: true })

    // A conversation the person starts is theirs: no badge, and no bot can see it.
    const human = (await call('createConversation', {
      workspaceId: workspace.id,
      branch: 'human-chat',
      isNewBranch: true,
      base: 'main',
      mode: 'worktree',
      name: 'Human chat',
    })) as { id: string }
    await page.reload()
    await page.waitForFunction(() => Boolean((window as any).api))
    await expect(row('Human chat')).toBeVisible()
    await expect(row('Human chat').getByTestId('conversation-bot-badge')).toHaveCount(0)
    expect((await tool(botToken, 'bot_list_chats', {})).conversations.map((item: any) => item.id)).toEqual([firstId])

    // ---- Continuing the conversation keeps its worktree ----------------------------------------------
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Continue and report proof-two.',
      idempotencyKey: randomUUID(),
    })
    await awaitEvidence(firstId, 'proof-two')
    const resumed = (await conversations(workspace.id)).find((item) => item.id === firstLocal.id)!
    expect(resumed.cwd, 'a follow-up resumes the same worktree').toBe(firstLocal.cwd)

    // ---- An ordinary question reaches the bot, and its answer drives the rest of the turn -------------
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Ask which branch to use, then report proof-question.',
      idempotencyKey: randomUUID(),
    })
    await expect
      .poll(
        async () =>
          (await transcript(botToken, firstId)).questions.filter((item: any) => item.state === 'pending').length,
        {
          timeout: 120_000,
          intervals: [1_000],
        }
      )
      .toBe(1)
    const question = (await transcript(botToken, firstId)).questions.find((item: any) => item.state === 'pending')
    expect(JSON.stringify(question)).toContain('Which branch should I use?')
    await tool(botToken, 'bot_answer_question', {
      conversationId: firstId,
      questionId: question.id,
      answers: [['main']],
      idempotencyKey: randomUUID(),
    })
    await awaitEvidence(firstId, 'proof-question')
    expect(answeredWith, 'the answer the bot gave is what the conversation continued with').toContain('main')

    // ---- Tool approvals stay on the desktop and only authorize this operation -----------------------
    await row('Bot chat one').click()
    for (const [marker, decision] of [
      ['proof-permission', 'Allow once'],
      ['proof-denial', 'Deny'],
    ] as const) {
      await tool(botToken, 'bot_send_message', {
        conversationId: firstId,
        text: `Write the evidence file for ${marker}.`,
        idempotencyKey: randomUUID(),
      })
      const allowOnce = page.getByRole('button', { name: 'Allow once', exact: true })
      await expect(allowOnce).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0)
      await expect(access(path.join(firstLocal.cwd, `${marker}.txt`))).rejects.toThrow()
      if (marker === 'proof-permission') {
        // An outdated renderer could still send this. It must leave the request pending, without a crash.
        const runtime = await call('chatRuntime', firstLocal.id)
        await call('chatPermissionRespond', runtime.pendingPermissions[0].id, 'always')
        expect((await call('chatRuntime', firstLocal.id)).pendingPermissions).toHaveLength(1)
        await expect(allowOnce).toBeVisible()
      }
      await page.getByRole('button', { name: decision, exact: true }).click()
      await expect(allowOnce).toHaveCount(0)
      await awaitEvidence(firstId, marker)
      if (decision === 'Allow once') {
        expect(await readFile(path.join(firstLocal.cwd, `${marker}.txt`), 'utf8')).toBe('Owner-approved fixture\n')
      } else {
        await expect(access(path.join(firstLocal.cwd, `${marker}.txt`))).rejects.toThrow()
      }
    }

    // ---- The owner moves that ceiling; the bot runs inside it and never past it ---------------------
    // What the composer shows about this conversation is what its next turn will actually run under.
    const permissionMode = page.getByTitle('Permission mode')
    await expect(permissionMode).toContainText('Ask for approval')
    await bot.setPermissionCeiling(record.id, 'auto')
    await expect
      .poll(
        async () =>
          (await tool(botToken, 'bot_list_selections', {})).selections.find((item: any) => item.label === 'bot-fixture')
            ?.permissionModes,
        { timeout: 60_000, intervals: [1_000] }
      )
      .toEqual(['ask', 'auto'])

    // Approve-for-me writes inside the worktree on its own: nothing waits on the desktop for it.
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Write the evidence file for proof-permission-auto.',
      idempotencyKey: randomUUID(),
    })
    await awaitEvidence(firstId, 'proof-permission-auto')
    expect(await readFile(path.join(firstLocal.cwd, 'proof-permission-auto.txt'), 'utf8')).toBe(
      'Owner-approved fixture\n'
    )
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
    // The bot configured this conversation, so the composer follows it without being reopened.
    await expect(permissionMode).toContainText('Approve for me')

    // Asking for more than the owner allowed fails the instruction; it never becomes a prompt for them.
    await tool(botToken, 'bot_configure_chat', {
      conversationId: firstId,
      selection: { ...botSelection, permissionMode: 'full' },
      idempotencyKey: randomUUID(),
    })
    await expect
      .poll(
        async () =>
          (await tool(botToken, 'bot_wait_events', { conversationId: firstId, cursor: 0, timeoutSeconds: 5 })).events
            .map((event: any) => event.payload)
            .filter(
              (payload: any) =>
                payload.type === 'command' &&
                payload.command.kind === 'configure' &&
                payload.command.status === 'failed'
            )
            .map((payload: any) => payload.command.payload.selection.permissionMode),
        { timeout: 120_000, intervals: [1_000] }
      )
      .toEqual(['full'])
    // The refusal is the bot's to read: it never turns into a prompt the person has to dismiss.
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
    // A refused configure changes nothing, so the chat still runs at the ceiling its owner chose.
    expect((await transcript(botToken, firstId)).conversation.selection.permissionMode).toBeUndefined()

    // ---- The person pauses the bot from their own desktop --------------------------------------------
    await bot.management(firstLocal.id, 'paused')
    await expect
      .poll(async () => (await transcript(botToken, firstId)).conversation.managementState, {
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe('paused')
    await expect(
      tool(botToken, 'bot_send_message', {
        conversationId: firstId,
        text: 'Ignore the pause and report proof-ignored.',
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow()
    expect(seen('proof-ignored'), 'a paused conversation runs nothing').toBe(0)
    // The conversation stays the person's while it is paused.
    await row('Bot chat one').click()
    await expect(page.getByText('Bot evidence for proof-two.', { exact: false }).first()).toBeVisible()
    await bot.management(firstLocal.id, 'active')
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Resume and report proof-resumed.',
      idempotencyKey: randomUUID(),
    })
    await awaitEvidence(firstId, 'proof-resumed')

    // ---- The person releases the chat and writes in it, without taking it from the bot ----------------
    await row('Bot chat one').click()
    const composer = page.locator('.chat-input:visible')
    await expect(composer).toHaveAttribute('data-placeholder', /Private Grok bot/)
    await page.getByRole('button', { name: 'Release chat', exact: true }).click()
    const releaseDialog = page.getByRole('dialog')
    await expect(releaseDialog).toContainText('read the chat again')
    await releaseDialog.getByRole('button', { name: 'Release chat', exact: true }).click()
    await expect(page.getByTestId('bot-manual-chat')).toContainText('Shared with Private Grok bot')
    // Releasing is not pausing: the bot still holds the chat on both sides.
    expect((await conversations(workspace.id)).find((item) => item.id === firstLocal.id)?.botManagementState).toBe(
      'active'
    )
    expect((await transcript(botToken, firstId)).conversation.managementState).toBe('active')

    await composer.click()
    await page.keyboard.type('Report the evidence for proof-shared.')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Bot evidence for proof-shared.', { exact: false }).first()).toBeVisible({
      timeout: 120_000,
    })

    // The bot is told nothing: its own stream still carries only what its commands produced.
    expect(JSON.stringify(await transcript(botToken, firstId))).not.toContain('proof-shared')
    const history = (args: Record<string, unknown> = {}) =>
      tool(botToken, 'bot_read_chat_history', { conversationId: firstId, ...args })
    const readAll = async () => {
      const texts: string[] = []
      let cursor: string | null = null
      do {
        const current: any = await history(cursor ? { cursor, limit: 200 } : { limit: 200 })
        texts.push(...current.messages.map((message: any) => message.text))
        cursor = current.nextCursor
      } while (cursor)
      return texts
    }
    const everything = await readAll()
    expect(everything, 'reading the chat back finds what the person wrote').toContain(
      'Report the evidence for proof-shared.'
    )
    expect(everything).toContain('Bot evidence for proof-shared.')
    expect(everything, 'and what the bot itself sent earlier').toContain('Report the evidence for proof-one.')
    expect(everything.join('\n'), 'reasoning and tool work stay on this computer').not.toContain('fixture-key')
    // It pages, and a page never carries more than what was asked for.
    const firstPage: any = await history({ limit: 1 })
    expect(firstPage.messages).toHaveLength(1)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBeTruthy()

    // ---- One turn at a time: a bot command waits for the turn the person started ----------------------
    holdMarker = 'proof-held'
    await composer.click()
    await page.keyboard.type('Start the long turn for proof-held.')
    await page.keyboard.press('Enter')
    await expect.poll(() => seen('proof-held'), { timeout: 120_000, intervals: [500] }).toBe(1)
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Continue and report proof-queued.',
      idempotencyKey: randomUUID(),
    })
    await page.waitForTimeout(5_000)
    expect(seen('proof-queued'), 'the bot never starts on top of the turn the person is running').toBe(0)
    release()
    holdMarker = null
    await awaitEvidence(firstId, 'proof-queued')
    // And the chat is still the bot's: nothing about releasing it changed that.
    expect((await conversations(workspace.id)).find((item) => item.id === firstLocal.id)?.botManagementState).toBe(
      'active'
    )

    // ---- A second conversation gets a worktree of its own ---------------------------------------------
    const second = await tool(botToken, 'bot_create_chat', {
      workspaceId: workspace.id,
      name: 'Bot chat two',
      baseBranch: 'main',
      selection: botSelection,
      message: 'Report the evidence for proof-three.',
      idempotencyKey: randomUUID(),
    })
    const secondId: string = second.conversation.id
    await awaitEvidence(secondId, 'proof-three')
    const secondLocal = (await conversations(workspace.id)).find((item) => item.name === 'Bot chat two')!
    expect(secondLocal.cwd).not.toBe(firstLocal.cwd)
    expect(secondLocal.branch).not.toBe(firstLocal.branch)
    await access(path.join(secondLocal.cwd, '.git'))
    await expect(row('Bot chat two').getByTestId('conversation-bot-badge')).toContainText('Private Grok bot')

    // ---- Cancelling stops the turn that is running, and keeps the conversation usable ------------------
    holdMarker = 'proof-cancel'
    await tool(botToken, 'bot_send_message', {
      conversationId: secondId,
      text: 'Start a long turn for proof-cancel.',
      idempotencyKey: randomUUID(),
    })
    await expect.poll(() => seen('proof-cancel'), { timeout: 120_000, intervals: [500] }).toBe(1)
    await tool(botToken, 'bot_cancel_turn', { conversationId: secondId, idempotencyKey: randomUUID() })
    await expect
      .poll(async () => (await transcript(botToken, secondId)).pendingCommand, { timeout: 120_000, intervals: [1_000] })
      .toBeNull()
    release()
    holdMarker = null
    expect(assistantText(await transcript(botToken, secondId))).not.toContain('Bot evidence for proof-cancel')
    expect(seen('proof-cancel'), 'a cancelled instruction is never started again').toBe(1)

    // ---- A plan is the owner's decision: the bot is told to wait, never asked to decide ---------------
    if (selection.modes.includes('plan')) {
      const planning = await tool(botToken, 'bot_create_chat', {
        workspaceId: workspace.id,
        name: 'Bot plan chat',
        baseBranch: 'main',
        selection: { ...botSelection, mode: 'plan' },
        message: 'Submit a plan and report proof-plan.',
        idempotencyKey: randomUUID(),
      })
      const planningId: string = planning.conversation.id
      await expect.poll(() => seen('proof-plan'), { timeout: 120_000, intervals: [500] }).toBeGreaterThan(0)
      await page.waitForTimeout(10_000)
      const planned = await transcript(botToken, planningId)
      expect(
        planned.questions.filter((item: any) => item.state === 'pending'),
        'a plan is never answerable'
      ).toEqual([])
      expect(JSON.stringify(planned), 'the plan itself stays with the person').not.toContain(
        'confirm the approved plan'
      )
      await tool(botToken, 'bot_cancel_turn', { conversationId: planningId, idempotencyKey: randomUUID() })
    } else {
      test.info().annotations.push({
        type: 'not-verified',
        description: 'This desktop offered no plan mode for the fixture selection, so no plan was submitted.',
      })
    }

    // ---- Another bot of the same person sees none of it ------------------------------------------------
    const withSecondBot = await bot.connect({
      name: 'Second bot',
      workspaceIds: [workspace.id],
      providerIds: [provider.id],
      selections: [{ providerId: provider.id, modelId: 'bot-fixture' }],
    })
    const secondRecord = withSecondBot.connections.find((item: any) => item.name === 'Second bot')
    const otherToken = await authorize('Second bot', secondRecord.id)
    expect((await tool(otherToken, 'bot_list_chats', {})).conversations).toEqual([])
    await expect(tool(otherToken, 'bot_read_chat', { conversationId: firstId })).rejects.toThrow()
    await expect(tool(otherToken, 'bot_read_chat_history', { conversationId: firstId })).rejects.toThrow()
    await expect(
      tool(otherToken, 'bot_send_message', {
        conversationId: firstId,
        text: 'Take over and report proof-foreign.',
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow()
    expect(seen('proof-foreign')).toBe(0)

    // ---- A crash in the middle of a turn never replays the instruction ---------------------------------
    holdMarker = 'proof-restart'
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Start the long turn for proof-restart.',
      idempotencyKey: randomUUID(),
    })
    await expect.poll(() => seen('proof-restart'), { timeout: 120_000, intervals: [500] }).toBe(1)
    // A crash, not a graceful quit: the durable receipt, not the shutdown path, must prevent the replay.
    const crashed = app!.process()
    crashed.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      if (crashed.exitCode !== null || crashed.signalCode) resolve()
      else crashed.once('exit', () => resolve())
    })
    app = undefined
    release()
    // Nothing answers while the application is down: no relay holds anything on the bot's behalf.
    await expect(rpc(botToken, 'tools/list')).rejects.toThrow()
    await launch()
    holdMarker = null
    // The endpoint the person enabled comes back with the application, on the same address.
    await expect
      .poll(
        async () =>
          (await dial('GET', '/.well-known/oauth-protected-resource/mcp/bots').catch(() => ({ status: 0 }))).status,
        {
          timeout: 120_000,
          intervals: [1_000],
        }
      )
      .toBe(200)
    expect((await rpc(botToken, 'tools/list')).status, 'the token outlives the restart').toBe(200)
    // The lease has to expire before the command can be reclaimed; the receipt then settles it.
    await expect
      .poll(async () => (await transcript(botToken, firstId)).pendingCommand, {
        timeout: 240_000,
        intervals: [2_000],
      })
      .toBeNull()
    await tool(botToken, 'bot_send_message', {
      conversationId: firstId,
      text: 'Recover and report proof-after.',
      idempotencyKey: randomUUID(),
    })
    await awaitEvidence(firstId, 'proof-after')
    expect(seen('proof-restart'), 'an interrupted instruction is reported, never run again').toBe(1)

    // ---- Revoking cuts the bot, and leaves the person's conversations alone --------------------------------
    await bot.revoke(record.id)
    await expect
      .poll(async () => (await rpc(botToken, 'tools/list')).status, { timeout: 30_000, intervals: [1_000] })
      .toBe(401)
    await expect(
      tool(botToken, 'bot_send_message', {
        conversationId: firstId,
        text: 'Keep going after revocation and report proof-revoked.',
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow()
    expect(seen('proof-revoked')).toBe(0)

    const survivors = (await conversations(workspace.id)).map((item) => item.name).sort()
    for (const name of ['Bot chat one', 'Bot chat two', 'Human chat'])
      expect(survivors, 'a revoked bot leaves the conversations on this computer').toContain(name)
    await access(firstLocal.cwd)
    await access(secondLocal.cwd)
    await row('Bot chat one').click()
    await expect(page.getByText('Bot evidence for proof-two.', { exact: false }).first()).toBeVisible()
    expect(human.id).toBeTruthy()

    // ---- Turning the endpoint off stops answering anybody ------------------------------------------------
    await bot.configureServer({ enabled: false })
    await expect
      .poll(
        async () =>
          await dial('GET', '/.well-known/oauth-protected-resource/mcp/bots').then(
            () => 'up',
            () => 'down'
          ),
        {
          timeout: 30_000,
          intervals: [1_000],
        }
      )
      .toBe('down')
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('failure.png'), fullPage: true }).catch(() => {})
      await test.info().attach('page-text', {
        body: await page
          .locator('body')
          .innerText()
          .catch(() => ''),
        contentType: 'text/plain',
      })
    }
    await test.info().attach('provider-calls', { body: JSON.stringify(calls), contentType: 'application/json' })
    throw error
  } finally {
    release()
    await app?.close().catch(() => {})
    model?.closeAllConnections()
    if (model) await new Promise<void>((resolve) => model!.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
