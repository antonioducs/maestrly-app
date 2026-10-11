import { createServer as createNetServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_SETTINGS_OPERATIONS,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  type FleetLoginAttempt,
  type FleetBot,
  type FleetEnvironment,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
const now = () => new Date().toISOString()
type State = {
  accounts: FleetSettingsOutput<'accounts'>
  models: FleetSettingsOutput<'models'>
  skills: FleetSettingsOutput<'skill'>[]
  groups: FleetSettingsOutput<'skillGroups'>
  mcp: FleetSettingsOutput<'mcpServers'>
  runtimes: FleetSettingsOutput<'runtimes'>
  preferences: FleetSettingsOutput<'preferences'>
}
function initial(research: boolean): State {
  const bots = research
    ? [{ id: 'radar', name: 'Radar' }]
    : [
        { id: 'scout', name: 'Scout' },
        { id: 'atlas', name: 'Atlas' },
      ]
  const name = research ? 'Radar Google AI' : 'Estúdio Google AI'
  return {
    accounts: {
      revision: randomUUID(),
      apiKeys: [
        {
          providerId: 'google',
          name,
          kind: 'openai',
          baseURL: 'https://api.example.test/[redacted]',
          keyHint: '••42',
          bots,
        },
      ],
      subscriptions: [
        {
          kind: 'antigravity',
          accountId: null,
          label: 'Google AI',
          email: 'studio@example.test',
          plan: 'Pro',
          state: 'connected',
          bots,
        },
      ],
    },
    models: {
      providers: [
        {
          providerId: 'google',
          name,
          revision: randomUUID(),
          hiddenModelIds: [],
          models: [
            { id: 'gemini-pro', name: 'Gemini Pro', contextWindow: 1000000, bots },
            { id: 'gemini-flash', name: 'Gemini Flash', contextWindow: 1000000, bots: [] },
          ],
        },
      ],
    },
    skills: [
      {
        name: research ? 'radar-research' : 'studio-review',
        description: 'Synthetic review workflow',
        enabled: true,
        source: 'fleet',
        revision: randomUUID(),
        editable: true,
        editableReason: null,
        markdown: '# Synthetic review\nReview the proposed changes.',
      },
    ],
    groups: { revision: randomUUID(), groups: [] },
    mcp: {
      revision: randomUUID(),
      servers: [
        {
          id: 'docs',
          name: research ? 'Radar Docs' : 'Estúdio Docs',
          revision: randomUUID(),
          transport: 'http',
          enabled: true,
          hasCommand: false,
          hasArgs: false,
          hasUrl: true,
          host: 'docs.example.test',
          envKeys: [],
          headerKeys: ['Authorization'],
          unavailable: false,
        },
      ],
    },
    runtimes: {
      runtimes: (['claude-code', 'codex', 'antigravity-acp'] as const).map((id) => ({
        id,
        revision: randomUUID(),
        currentVersion: '1.0.0',
        pendingVersion: null,
        availableVersion: '1.1.0',
        automatic: !research,
        allowedActions: ['check', 'update'],
        state: 'idle',
        progress: null,
        error: null,
        rollbackVersion: null,
      })),
    },
    preferences: { revision: randomUUID(), imageGenEnabled: !research },
  }
}
/** An owner-only loopback gateway; all outbound payloads pass the actual protocol schemas. */
export async function createSettingsGateway() {
  const portServer = createNetServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const callbackPort = (portServer.address() as { port: number }).port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  let login: FleetLoginAttempt | null = null
  const GB = 1024 ** 3
  const host = fleetHostInfoSchema.parse({
    hostname: 'fleet-env-host',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 12,
    memory: { totalBytes: 16 * GB, usedBytes: 4 * GB, botsBytes: 2 * GB },
    disk: { totalBytes: 100 * GB, usedBytes: 20 * GB },
    uptimeSeconds: 7200,
    gatewayVersion: '0.9.3',
    botImage: 'test-image',
    botImageVersion: '0.9.3',
    dockerVersion: '28',
  })
  const capabilities = [
    'provisioning',
    'environments',
    'environment-settings-v1',
    'environment-compaction',
    'context-limit',
    'runtime-updates',
  ]
  const botBase = {
    capabilities,
    role: '',
    instructions: 'Synthetic environment bot',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: true, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.9.3',
    createdAt: now(),
    updatedAt: now(),
  }
  const makeBot = (id: string, name: string, environmentId: string, patch: Record<string, unknown> = {}) =>
    fleetBotSchema.parse({ ...botBase, id, name, environmentId, ...patch })
  const makeEnvironment = (id: string, name: string, botIds: string[], patch: Record<string, unknown> = {}) =>
    fleetEnvironmentSchema.parse({
      id,
      name,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 6, startedAt: now() },
      memoryLimitBytes: null,
      appVersion: '0.9.3',
      capabilities,
      botIds,
      createdAt: now(),
      updatedAt: now(),
      ...patch,
    })
  const environments: FleetEnvironment[] = [
    makeEnvironment('studio', 'Estúdio Dev', ['scout', 'atlas']),
    makeEnvironment('research', 'Pesquisa Radar', ['radar']),
  ]
  const bots: FleetBot[] = [
    makeBot('scout', 'Scout', 'studio', {
      role: 'Pesquisa e implementação',
      selection: { providerId: 'google', modelId: 'gemini-pro', reasoning: null, fastMode: false },
    }),
    makeBot('atlas', 'Atlas', 'studio'),
    makeBot('radar', 'Radar', 'research'),
  ]

  const states = new Map([
    ['studio', initial(false)],
    ['research', initial(true)],
  ])
  const requests: { key: string; environmentId: string; body: Record<string, any> }[] = []
  const errors: string[] = []
  const streams = new Set<ServerResponse>()
  const controls = {
    failNext: '',
    delayNext: '',
    delayMs: 800,
    mcpResult: 'ok' as 'ok' | 'connection-failed' | 'timeout',
    capable: true,
    offline: false,
  }
  function emit(event: unknown) {
    const valid = fleetGatewayEventSchema.parse(event)
    for (const stream of streams) stream.write(`event: fleet\ndata: ${JSON.stringify(valid)}\n\n`)
  }
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      if (controls.offline) return send(503, { code: 'UNAVAILABLE', message: 'Synthetic offline gateway' })
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
        ([, route]) =>
          route.method === request.method &&
          new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
      )
      if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
      const [key, route] = entry
      if (request.headers['x-maestrly-fleet-protocol'] !== '1')
        return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token')
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = route.body
        ? (route.body.parse(JSON.parse(Buffer.concat(chunks).toString())) as Record<string, any>)
        : {}
      const environmentId = decodeURIComponent(url.pathname.match(/^\/v1\/environments\/([^/]+)/)?.[1] ?? '')
      requests.push({ key, environmentId, body })
      if (key === 'events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        streams.add(response)
        response.write(': connected\n\n')
        request.on('close', () => streams.delete(response))
        return
      }
      if (controls.failNext === key) {
        controls.failNext = ''
        return send(503, { code: 'UNAVAILABLE', message: 'Synthetic write failure' })
      }
      const state = states.get(environmentId)!
      let value: unknown
      if (key.startsWith('settings')) {
        const op = key.charAt(8).toLowerCase() + key.slice(9)
        const operation = FLEET_SETTINGS_OPERATIONS[op as keyof typeof FLEET_SETTINGS_OPERATIONS]
        const params: Record<string, string> = {}
        route.path.split('/').forEach((part, index) => {
          if (part.startsWith(':') && part !== ':environmentId')
            params[part.slice(1)] = decodeURIComponent(url.pathname.split('/')[index])
        })
        delete params.eid
        const input = operation.input.parse({ ...params, ...body }) as Record<string, any>
        const provider = state.models.providers.find((p) => p.providerId === input.providerId)
        const skill = state.skills.find((s) => s.name === input.name)
        const mcp = state.mcp.servers.find((s) => s.id === input.id)
        const runtime = state.runtimes.runtimes.find((r) => r.id === input.id)
        const expected =
          op.includes('Account') || op.includes('Subscription')
            ? state.accounts.revision
            : op === 'setModelFilter'
              ? provider?.revision
              : op.includes('SkillGroup')
                ? state.groups.revision
                : op.includes('Skill') || op === 'writeSkill'
                  ? skill?.revision
                  : op.includes('Mcp')
                    ? mcp?.revision
                    : op.includes('Runtime') || op === 'runtimeAction'
                      ? runtime?.revision
                      : state.preferences.revision
        if (input.expectedRevision && input.expectedRevision !== expected)
          return send(409, { code: 'CONFLICT', message: 'Synthetic revision conflict' })
        switch (op) {
          case 'accounts':
            value = state.accounts
            break
          case 'patchAccount':
            Object.assign(state.accounts.apiKeys.find((a) => a.providerId === input.providerId)!, {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
            })
            state.accounts.revision = randomUUID()
            value = state.accounts
            break
          case 'renameSubscription':
            state.accounts.subscriptions.find((a) => a.kind === input.kind)!.label = input.label
            state.accounts.revision = randomUUID()
            value = state.accounts
            break
          case 'removeAccount':
            state.accounts.apiKeys = state.accounts.apiKeys.filter((a) => a.providerId !== input.providerId)
            state.accounts.revision = randomUUID()
            value = { removed: true }
            break
          case 'removeSubscription':
            state.accounts.subscriptions = state.accounts.subscriptions.filter((a) => a.kind !== input.kind)
            state.accounts.revision = randomUUID()
            value = { removed: true }
            break
          case 'models':
            value = state.models
            break
          case 'setModelFilter':
            provider!.hiddenModelIds = input.hiddenModelIds
            provider!.revision = randomUUID()
            value = state.models
            break
          case 'skills':
            value = { skills: state.skills.map(({ markdown: _, ...s }) => s) }
            break
          case 'skill':
            value = skill
            break
          case 'createSkill':
            value = {
              name: input.name,
              markdown: input.markdown,
              description: 'Synthetic skill',
              enabled: true,
              source: 'fleet',
              revision: randomUUID(),
              editable: true,
              editableReason: null,
            }
            state.skills.push(value as State['skills'][number])
            break
          case 'writeSkill':
            skill!.markdown = input.markdown
            skill!.revision = randomUUID()
            value = skill
            break
          case 'setSkillEnabled':
            skill!.enabled = input.enabled
            skill!.revision = randomUUID()
            {
              const { markdown: _, ...summary } = skill!
              value = summary
            }
            break
          case 'removeSkill':
            state.skills = state.skills.filter((s) => s.name !== input.name)
            value = { removed: true }
            break
          case 'skillGroups':
            value = state.groups
            break
          case 'searchSkills':
            value = {
              results: [
                {
                  id: 'library-review',
                  name: 'library-review',
                  description: 'Synthetic library review',
                  source: 'fixture',
                },
              ],
            }
            break
          case 'installSkill':
            state.skills.push({
              name: 'library-review',
              description: 'Synthetic library review',
              enabled: true,
              source: 'registry',
              revision: randomUUID(),
              editable: true,
              editableReason: null,
              markdown: '# Library review',
            })
            value = { skills: state.skills.map(({ markdown: _, ...s }) => s) }
            break
          case 'mcpServers':
            value = state.mcp
            break
          case 'mcpServer':
            value = mcp
            break
          case 'patchMcpServer': {
            if (input.name !== undefined) mcp!.name = input.name
            if (input.enabled !== undefined) mcp!.enabled = input.enabled
            for (const key of ['env', 'headers'] as const) {
              const field = key === 'env' ? 'envKeys' : 'headerKeys'
              mcp![field] = [
                ...new Set([
                  ...mcp![field].filter((k) => !input[key]?.remove?.includes(k)),
                  ...Object.keys(input[key]?.set ?? {}),
                ]),
              ]
            }
            mcp!.revision = randomUUID()
            value = mcp
            break
          }
          case 'testMcpServer':
            value = { code: controls.mcpResult, toolCount: controls.mcpResult === 'ok' ? 7 : 0 }
            break
          case 'removeMcpServer':
            state.mcp.servers = state.mcp.servers.filter((s) => s.id !== input.id)
            value = { removed: true }
            break
          case 'runtimes':
            value = state.runtimes
            break
          case 'runtimeAction':
            runtime!.state = input.action === 'check' ? 'checking' : input.action === 'update' ? 'installing' : 'idle'
            runtime!.allowedActions = input.action === 'cancel' ? ['check', 'update'] : ['cancel']
            runtime!.revision = randomUUID()
            value = runtime
            break
          case 'setRuntimeAutomatic':
            runtime!.automatic = input.automatic
            runtime!.revision = randomUUID()
            value = runtime
            break
          case 'preferences':
            value = state.preferences
            break
          case 'setPreferences':
            state.preferences = { revision: randomUUID(), imageGenEnabled: input.imageGenEnabled }
            value = state.preferences
            break
          default:
            throw new Error(`Unhandled settings operation ${op}`)
        }
      } else
        switch (key) {
          case 'meta':
            value = {
              protocol: 1,
              features: controls.capable ? capabilities : ['provisioning', 'environments'],
              gatewayVersion: host.gatewayVersion,
              botImage: 'test-image',
              botImageVersion: host.botImageVersion,
            }
            break
          case 'pair':
            value = { deviceId: 'settings-device', token: 'fixture-token' }
            break
          case 'host':
            value = host
            break
          case 'botsList':
            value = { bots }
            break
          case 'environmentsList':
            value = { environments }
            break
          case 'inbox':
            value = { items: [] }
            break
          case 'peerMessages':
            value = { messages: [] }
            break
          case 'environmentLoginStart':
            login = {
              loginId: randomUUID(),
              kind: 'antigravity',
              accountId: null,
              method: 'browser',
              state: 'pending',
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              browser: {
                authUrl:
                  'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=' +
                  encodeURIComponent(`http://localhost:${callbackPort}/`),
                callback: { port: callbackPort, path: '/' },
              },
              device: null,
              manual: null,
              account: null,
              error: null,
            }
            value = login
            break
          case 'environmentLoginGet':
            value = login
            break
          case 'environmentLoginCancel':
            login!.state = 'cancelled'
            value = { cancelled: true }
            break
          case 'environmentLoginCallback':
            login!.state = 'completed'
            login!.account = { label: 'Google AI', email: 'studio@example.test', plan: 'Pro' }
            state.accounts.revision = randomUUID()
            value = { status: 200, location: null, contentType: 'text/html', body: '<p>Synthetic sign-in complete</p>' }
            break
          case 'environmentAccountsList':
            value = {
              apiKeys: state.accounts.apiKeys.map(({ bots: _, ...a }) => a),
              subscriptions: state.accounts.subscriptions.map(({ bots: _, ...a }) => a),
            }
            break
          case 'environmentSkillsList':
            value = { skills: [] }
            break
          case 'environmentMcpServersList':
            value = { servers: [] }
            break
          case 'environmentApiKeyAccountAdd':
            state.accounts.apiKeys.push({
              providerId: 'added',
              name: body.name,
              kind: body.kind,
              baseURL: body.baseURL,
              keyHint: '••42',
              bots: [],
            })
            state.accounts.revision = randomUUID()
            value = { providerId: 'added' }
            break
          case 'environmentPatch': {
            const env = environments.find((e) => e.id === environmentId)!
            const expected = body.expected
            if (
              expected &&
              ((expected.name !== undefined && expected.name !== env.name) ||
                (expected.compaction !== undefined &&
                  JSON.stringify(expected.compaction) !== JSON.stringify(env.compaction)))
            ) {
              return send(409, { code: 'CONFLICT', message: 'Environment settings changed. Reload before saving.' })
            }
            const { expected: _expected, ...patch } = body
            Object.assign(env, patch)
            emit({ type: 'environment.updated', at: now(), environment: env })
            value = env
            break
          }
          case 'environmentGet':
            value = environments.find((e) => e.id === environmentId)
            break
          case 'environmentSelections':
            value = {
              options: state.models.providers.flatMap((provider) =>
                provider.models
                  .filter((model) => !provider.hiddenModelIds.includes(model.id))
                  .map((model) => ({
                    id: provider.providerId + '::' + model.id,
                    providerId: provider.providerId,
                    providerLabel: provider.name,
                    modelId: model.id,
                    modelLabel: model.name,
                    efforts: ['low', 'high'],
                    fastMode: false,
                  }))
              ),
              current: null,
            }
            break
          case 'botSelections':
            value = { options: [], current: null }
            break
          default:
            return send(404, { code: 'NOT_FOUND', message: `Unhandled fixture route ${key}` })
        }
      const valid = route.response ? route.response.parse(value) : value
      const serialized = JSON.parse(JSON.stringify(valid ?? null))
      if (controls.delayNext === key) {
        controls.delayNext = ''
        await new Promise((resolve) => setTimeout(resolve, controls.delayMs))
      }
      send(200, serialized)
    } catch (error) {
      errors.push(String(error))
      send(500, { code: 'INTERNAL_ERROR', message: 'Fixture schema failure' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    alignCapture() {
      environments[0].name = 'Estúdio'
      environments[1].name = 'Pesquisa'
      environments[0].botIds.unshift('dev')
      bots.unshift(makeBot('dev', 'Dev', 'studio', { role: 'Desenvolvimento', status: 'working' }))
      const state = states.get('studio')!
      state.accounts.subscriptions.unshift(
        {
          kind: 'codex',
          accountId: null,
          label: 'ChatGPT (Codex)',
          email: 'studio@example.com',
          plan: 'Plus',
          state: 'connected',
          bots: [{ id: 'dev', name: 'Dev' }],
        },
        {
          kind: 'claude',
          accountId: null,
          label: 'Claude',
          email: 'studio@example.com',
          plan: 'Max',
          state: 'connected',
          bots: [
            { id: 'atlas', name: 'Atlas' },
            { id: 'scout', name: 'Scout' },
          ],
        },
        {
          kind: 'grok',
          accountId: null,
          label: 'Grok',
          email: 'research@example.com',
          plan: 'SuperGrok',
          state: 'signed-out',
          bots: [],
        }
      )
      state.accounts.apiKeys.push({
        providerId: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        baseURL: 'https://api.openai.com',
        keyHint: '••••demo',
        bots: [],
      })
      state.models.providers.unshift(
        {
          providerId: 'codex',
          name: 'ChatGPT (Codex)',
          revision: randomUUID(),
          hiddenModelIds: ['gpt-5.1'],
          models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 400000, bots: [{ id: 'dev', name: 'Dev' }] },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', contextWindow: 400000, bots: [] },
            { id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: 400000, bots: [] },
          ],
        },
        {
          providerId: 'claude',
          name: 'Claude',
          revision: randomUUID(),
          hiddenModelIds: ['claude-haiku-4.5'],
          models: [
            {
              id: 'claude-opus-4.6',
              name: 'Claude Opus 4.6',
              contextWindow: 200000,
              bots: [{ id: 'atlas', name: 'Atlas' }],
            },
            {
              id: 'claude-sonnet-4.6',
              name: 'Claude Sonnet 4.6',
              contextWindow: 200000,
              bots: [{ id: 'scout', name: 'Scout' }],
            },
            { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', contextWindow: 200000, bots: [] },
          ],
        },
        {
          providerId: 'openai',
          name: 'OpenAI API',
          revision: randomUUID(),
          hiddenModelIds: [],
          models: [{ id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 400000, bots: [] }],
        }
      )
      environments[0].compaction = {
        providerId: 'claude',
        modelId: 'claude-sonnet-4.6',
        reasoning: null,
        fastMode: false,
        intervalTokens: 100000,
      }
      for (const bot of bots.filter((bot) => ['dev', 'scout'].includes(bot.id))) {
        bot.compaction = environments[0].compaction
        bot.compactionSource = 'environment'
      }
    },
    setVersion(version: string) {
      host.gatewayVersion = version
      host.botImageVersion = version
      for (const environment of environments) environment.appVersion = version
      for (const bot of bots) bot.appVersion = version
    },
    disconnect() {
      controls.offline = true
      for (const stream of streams) stream.end()
    },
    callbackPort,
    url: `http://127.0.0.1:${address.port}`,
    states,
    requests,
    errors,
    controls,
    environments,
    bots,
    emit,
    async close() {
      for (const stream of streams) stream.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
