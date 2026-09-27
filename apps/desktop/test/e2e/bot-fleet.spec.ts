import { createServer as createNetServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type Locator } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetArchivedBotSchema,
  fleetArchivedEnvironmentSchema,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  fleetPendingInteractionSchema,
  fleetRoutineSchema,
  fleetOwnerMemorySchema,
  fleetOwnerMemoryEntrySchema,
  fleetBotMemorySchema,
  fleetRoutineRunSchema,
  fleetSendMessageRequestSchema,
  fleetConversationCallRequestSchema,
  type FleetArchivedBot,
  type FleetArchivedEnvironment,
  type FleetBotAccounts,
  type FleetEnvironment,
  type FleetBotSkills,
  type FleetBotMcpServers,
  type FleetLoginAttempt,
  type FleetLoginStartRequest,
  type FleetAccountImportRequest,
  type FleetSkillInstallRequest,
  type FleetMcpImportRequest,
  type FleetBot,
  type FleetSelection,
  type FleetRoutine,
} from '@maestrly/bot-fleet-protocol'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const now = () => new Date().toISOString()

/**
 * WCAG contrast, against the dialog surface (#1E1E21), of the most visible cue an element paints: its border when it
 * has one, else its background, composited as the browser paints them. A selected state needs 3:1 (WCAG 1.4.11).
 */
function stateContrastOnDialog(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('No canvas')
    const paint = (...colors: string[]) => {
      for (const color of colors) {
        // An unparsed color leaves fillStyle unchanged; fail instead of measuring the previous layer.
        context.fillStyle = '#010203'
        context.fillStyle = color
        if (context.fillStyle === '#010203' && color !== '#010203') throw new Error('Unparsed color ' + color)
        context.fillRect(0, 0, 1, 1)
      }
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const style = getComputedStyle(element)
    const surface = luminance(paint('#1E1E21'))
    const layers = ['#1E1E21', style.backgroundColor]
    if (Number.parseFloat(style.borderTopWidth) > 0) layers.push(style.borderTopColor)
    const cue = luminance(paint(...layers))
    return (Math.max(surface, cue) + 0.05) / (Math.min(surface, cue) + 0.05)
  })
}

test('fleet UI pairs, handles requests, creates a bot, controls its screen, and schedules a routine', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-fleet-e2e-'))
  const requests: Array<{ key: string; body: unknown; path: string; method: string | undefined }> = []
  const skillText =
    '---\nname: e2e-notes\ndescription: Synthetic fleet notes.\n---\n# E2E notes\nRemember the fixture.\n'
  const skillDir = path.join(root, '.agents', 'skills', 'e2e-notes')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), skillText)
  const portProbe = createNetServer()
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
  const portAddress = portProbe.address()
  if (!portAddress || typeof portAddress === 'string') throw new Error('No callback port')
  const callbackPort = portAddress.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  let occupiedPort: ReturnType<typeof createNetServer> | undefined
  const provisioned = new Map<
    string,
    { accounts: FleetBotAccounts; skills: FleetBotSkills['skills']; servers: FleetBotMcpServers['servers'] }
  >()
  function botProvisioning(id: string) {
    let value = provisioned.get(id)
    if (!value) {
      value = { accounts: { apiKeys: [], subscriptions: [] }, skills: [], servers: [] }
      provisioned.set(id, value)
    }
    return value
  }
  const logins = new Map<string, { attempt: FleetLoginAttempt; polls: number }>()
  const streams = new Set<ServerResponse>()
  const host = fleetHostInfoSchema.parse({
    hostname: 'fleet-e2e-host',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 23,
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 2 * 1024 ** 3,
      botsBytes: 1024 ** 3,
    },
    disk: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 },
    uptimeSeconds: 3600,
    gatewayVersion: '0.9.2',
    botImage: 'test-image',
    botImageVersion: '0.9.2',
    dockerVersion: '28',
  })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
    'base64'
  )
  const base = {
    capabilities: ['provisioning'],
    role: 'Helps with orders',
    instructions: 'Check incoming orders',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    usage: {
      contextUsedTokens: 22600,
      contextWindowTokens: 828400,
      contextQuality: 'estimated',
      costUsd: 0.12,
      updatedAt: now(),
    },
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'waiting',
    activity: { kind: 'permission', title: 'Run ls' },
    pendingCount: 1,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: {
      memoryBytes: 1024 ** 3,
      memoryLimitBytes: 2 * 1024 ** 3,
      cpuPercent: 9,
      startedAt: now(),
    },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.9.2',
    createdAt: now(),
    updatedAt: now(),
  }
  const bots: FleetBot[] = [
    fleetBotSchema.parse({
      ...base,
      id: 'scout',
      name: 'Scout',
      compaction: {
        providerId: 'prov_e2e',
        modelId: 'model-e2e',
        reasoning: null,
        fastMode: false,
        intervalTokens: 100_000,
      },
      compactionState: {
        configured: true,
        problem: null,
        background: { status: 'ready', error: null },
        progress: null,
      },
    }),
  ]
  // Archived bots: the listed summary and the record a restore brings back. Legacy's files were removed by hand.
  const archived = new Map<string, { summary: FleetArchivedBot; record: FleetBot }>([
    [
      'legacy',
      {
        summary: fleetArchivedBotSchema.parse({
          id: 'legacy',
          name: 'Legacy',
          role: '',
          tint: '#aa6644',
          createdAt: now(),
          archivedAt: now(),
          files: 'missing',
        }),
        record: fleetBotSchema.parse({ ...base, id: 'legacy', name: 'Legacy', lifecycle: 'archived' }),
      },
    ],
  ])
  let inbox = [
    fleetPendingInteractionSchema.parse({
      kind: 'permission',
      id: 'perm-1',
      at: now(),
      title: 'Run ls',
      detail: '$ ls',
      tool: { name: 'bash', target: 'ls -la' },
      itemId: 'item-1',
    }),
    fleetPendingInteractionSchema.parse({
      kind: 'help',
      id: 'help-1',
      at: now(),
      reason: 'Sign in',
      itemId: 'item-help',
    }),
  ]
  const transcript: unknown[] = [
    {
      id: 'item-1',
      at: now(),
      kind: 'permission',
      requestId: 'perm-1',
      title: 'Run ls',
      detail: '$ ls',
      tool: { name: 'bash', target: 'ls -la' },
      state: 'pending',
      resolvedAt: null,
    },
  ]
  transcript.push({
    id: 'image-tool',
    at: now(),
    kind: 'tool',
    name: 'browser_screenshot',
    target: null,
    state: 'done',
    output: null,
    images: [{ id: 'shot-1', mediaType: 'image/png', byteSize: png.length, name: 'Screenshot' }],
  })
  // One image the bot evicted (404) and one whose first read fails while the bot restarts (503).
  transcript.push({
    id: 'image-failures',
    at: now(),
    kind: 'tool',
    name: 'computer_screenshot',
    target: null,
    state: 'done',
    output: null,
    images: [
      { id: 'shot-gone', mediaType: 'image/png', byteSize: png.length, name: 'Evicted' },
      { id: 'shot-flaky', mediaType: 'image/png', byteSize: png.length, name: 'Flaky' },
    ],
  })
  transcript.push({
    id: 'compaction-1',
    at: now(),
    kind: 'compaction',
    origin: 'prepared',
    summary: 'E2E-SUMMARY **saved context**',
    truncated: false,
  })
  let flakyImageFailures = 1
  const imageReads: string[] = []
  const routines: FleetRoutine[] = [
    fleetRoutineSchema.parse({
      id: 'bot-routine',
      botId: 'new-bot',
      title: 'Bot check',
      prompt: 'Check',
      schedule: { kind: 'interval', everyMinutes: 90 },
      enabled: true,
      nextRunAt: now(),
      lastRunAt: now(),
      lastOutcome: 'skipped_busy',
      createdBy: 'bot',
      createdAt: now(),
      updatedAt: now(),
    }),
  ]

  let ownerMemoryFull = false
  const ownerMemory = fleetOwnerMemorySchema.parse({
    revision: 1,
    activeChars: 22,
    entries: [
      {
        id: 'owner-seed',
        content: 'Prefers morning updates.',
        status: 'active',
        author: { kind: 'bot', botId: 'scout', name: 'Scout' },
        origin: 'owner',
        replacesId: null,
        replacedById: null,
        createdAt: now(),
        updatedAt: now(),
      },
    ],
  })
  const routineRuns = [
    fleetRoutineRunSchema.parse({
      id: 'run-1',
      routineId: 'scout-routine',
      botId: 'scout',
      trigger: 'schedule',
      status: 'completed',
      deliveredAt: now(),
      finishedAt: now(),
      report: { summary: 'Checked 3 stores', pending: 'One store unavailable', notes: 'Retry Magalu first' },
      finalText: 'Found three offers.',
    }),
  ]
  const botMemories = [
    fleetBotMemorySchema.parse({
      id: 'm1',
      title: 'Portal login',
      content: 'Use the owner portal to check orders.'.padEnd(4000, '.'),
      truncated: true,
      type: 'procedure',
      status: 'active',
      pinned: false,
      source: 'auto',
      useCount: 2,
      createdAt: now(),
      updatedAt: now(),
    }),
  ]
  routines.push(
    fleetRoutineSchema.parse({
      ...routines[0],
      id: 'scout-routine',
      botId: 'scout',
      title: 'Scout check',
    })
  )
  transcript.push({
    id: 'recalled-user',
    at: now(),
    kind: 'user',
    text: 'Check the portal',
    source: 'owner',
    queued: false,
    memories: [{ id: 'm1', title: 'Portal login' }],
  })
  let currentSelection: FleetSelection = {
    providerId: 'prov_e2e',
    modelId: 'model-e2e',
    reasoning: 'medium',
    fastMode: false,
  }
  let conversationTools = { app: true, imageGen: true, mcpDisabled: [] as string[] }
  let skillOverride: 'on' | 'off' | undefined
  let skillSelection: { kind: 'all' | 'none' } = { kind: 'all' }
  let subagentsEnabled = true
  let subagentProfilesEnabled = true
  let takeoverConflicts = 1
  let rejectCancellation = false
  const memoryActivity = {
    seq: 2,
    at: now(),
    botId: 'scout',
    kind: 'owner_memory_saved',
    summary: 'Prefers weekly summaries.',
    data: {},
  }
  let memoryActivityReady = false
  function emit(event: unknown) {
    const valid = fleetGatewayEventSchema.parse(event)
    const frame = `event: fleet\ndata: ${JSON.stringify(valid)}\n\n`
    for (const stream of streams) stream.write(frame)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!entry) {
      send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
      return
    }
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1') {
      send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
      return
    }
    if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token') {
      send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      return
    }
    let body: unknown
    if (route.body) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        send(400, { code: 'INVALID_REQUEST', message: 'Bad body' })
        return
      }
    }
    requests.push({ key, body, path: url.pathname, method: request.method })
    if (key === 'botMessageSend') body = fleetSendMessageRequestSchema.parse(body)
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
    const id = url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1] ?? ''
    const bot = bots.find((item) => item.id === id)
    let value: unknown
    switch (key) {
      case 'botAccountsList':
        value = botProvisioning(id).accounts
        break
      case 'botSkillsList':
        value = { skills: botProvisioning(id).skills }
        break
      case 'botMcpServersList':
        value = { servers: botProvisioning(id).servers }
        break
      case 'botAccountsImport': {
        const input = body as FleetAccountImportRequest
        value = {
          results: input.items.map((item, index) => {
            if (item.type === 'api-key')
              botProvisioning(id).accounts.apiKeys.push({
                providerId: 'prov_imported',
                name: item.name,
                kind: item.kind,
                baseURL: item.baseURL,
                keyHint: item.key.slice(-4),
              })
            return { index, target: 'prov_imported', outcome: 'added', error: null }
          }),
        }
        break
      }
      case 'botSkillInstall': {
        const input = body as FleetSkillInstallRequest
        botProvisioning(id).skills.push({
          name: input.name,
          description: 'Synthetic fleet notes.',
          files: input.files.length,
          bytes: 100,
          source: 'fleet',
        })
        value = { name: input.name, outcome: 'added' }
        break
      }
      case 'botMcpServersImport': {
        const input = body as FleetMcpImportRequest
        value = {
          results: input.servers.map((item, index) => {
            botProvisioning(id).servers.push({
              id: 'mcp_imported',
              name: item.name,
              transport: item.transport,
              command: item.command ?? null,
              host: item.url ? new URL(item.url).host : null,
              enabled: item.enabled,
              envKeys: [],
              headerKeys: [],
              unavailable: false,
            })
            return { index, target: 'mcp_imported', outcome: 'added', error: null }
          }),
        }
        break
      }
      case 'botSubscriptionRemove':
        botProvisioning(id).accounts.subscriptions = botProvisioning(id).accounts.subscriptions.filter(
          (item) =>
            item.kind !== url.pathname.split('/').at(-2) ||
            (item.accountId ?? 'default') !== url.pathname.split('/').at(-1)
        )
        break
      case 'botSkillRemove':
        botProvisioning(id).skills = botProvisioning(id).skills.filter(
          (item) => item.name !== decodeURIComponent(url.pathname.split('/').at(-1)!)
        )
        break
      case 'botMcpServerRemove':
        botProvisioning(id).servers = botProvisioning(id).servers.filter(
          (item) => item.id !== url.pathname.split('/').at(-1)
        )
        break
      case 'botLoginStart': {
        const input = body as FleetLoginStartRequest
        const attempt: FleetLoginAttempt = {
          loginId: randomUUID(),
          kind: input.kind,
          accountId: null,
          method: input.method,
          state: 'pending',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          browser:
            input.kind === 'claude'
              ? {
                  authUrl:
                    'https://claude.ai/oauth/authorize?redirect_uri=' +
                    encodeURIComponent('http://localhost:' + callbackPort + '/callback'),
                  callback: { port: callbackPort, path: '/callback' },
                }
              : null,
          device:
            input.kind === 'grok' ? { verificationUrl: 'https://accounts.x.ai/device', userCode: 'E2E-GROK' } : null,
          manual: input.kind === 'claude' ? { url: 'https://platform.claude.com/oauth/authorize' } : null,
          account: null,
          error: null,
        }
        logins.set(attempt.loginId, { attempt, polls: 0 })
        value = attempt
        break
      }
      case 'botLoginGet':
      case 'botLoginCallback':
      case 'botLoginCode':
      case 'botLoginCancel': {
        const loginId = url.pathname.split('/')[5]
        const login = logins.get(loginId)!
        if (key === 'botLoginGet') login.polls++
        if (key === 'botLoginCancel' && rejectCancellation) {
          rejectCancellation = false
          send(503, { code: 'UNAVAILABLE', message: 'Synthetic cancellation failure' })
          return
        }
        if (key === 'botLoginCancel') login.attempt.state = 'cancelled'
        else if (
          key === 'botLoginCode' ||
          key === 'botLoginCallback' ||
          (login.attempt.kind === 'grok' && login.polls >= 2)
        ) {
          login.attempt.state = 'completed'
          login.attempt.account = { label: login.attempt.kind, email: 'owner@example.com', plan: null }
          const subscriptions = botProvisioning(id).accounts.subscriptions
          if (!subscriptions.some((item) => item.kind === login.attempt.kind))
            subscriptions.push({
              kind: login.attempt.kind,
              accountId: null,
              label: login.attempt.kind === 'grok' ? 'Grok' : 'Claude',
              email: 'owner@example.com',
              plan: null,
              state: 'connected',
            })
        }
        value =
          key === 'botLoginCallback'
            ? { status: 302, location: 'https://platform.claude.com/oauth/code/success', contentType: null, body: '' }
            : login.attempt
        break
      }

      case 'ownerMemoryList':
        ownerMemory.activeChars = ownerMemory.entries
          .filter((entry) => entry.status === 'active')
          .reduce((sum, entry) => sum + entry.content.length, 0)
        value = {
          ...ownerMemory,
          entries: ownerMemory.entries.filter(
            (entry) => url.searchParams.get('status') !== 'active' || entry.status === 'active'
          ),
        }
        break
      case 'ownerMemoryCreate': {
        if (ownerMemoryFull) {
          send(409, { code: 'CONFLICT', message: 'Owner memory is full (4000 characters).' })
          return
        }
        const input = body as { content: string }
        const entry = fleetOwnerMemoryEntrySchema.parse({
          ...ownerMemory.entries[0],
          id: randomUUID(),
          content: input.content,
          author: { kind: 'owner' },
          origin: null,
          replacesId: null,
          replacedById: null,
          createdAt: now(),
          updatedAt: now(),
        })
        ownerMemory.entries.push(entry)
        value = entry
        break
      }
      case 'ownerMemoryPatch': {
        const index = ownerMemory.entries.findIndex((entry) => entry.id === url.pathname.split('/').at(-1))
        ownerMemory.entries[index] = fleetOwnerMemoryEntrySchema.parse({
          ...ownerMemory.entries[index],
          ...(body as object),
        })
        value = ownerMemory.entries[index]
        break
      }
      case 'ownerMemoryDelete':
        ownerMemory.entries = ownerMemory.entries.filter((entry) => entry.id !== url.pathname.split('/').at(-1))
        break
      case 'botRoutineRuns':
        value = {
          runs: routineRuns.filter((run) => run.botId === id && run.routineId === url.pathname.split('/').at(-2)),
        }
        break
      case 'botMemoriesList':
        value = {
          memories:
            id === 'scout'
              ? botMemories.filter((memory) => url.searchParams.get('status') === 'all' || memory.status === 'active')
              : [],
        }
        break
      case 'botMemoryPatch': {
        const index = botMemories.findIndex((memory) => memory.id === url.pathname.split('/').at(-1))
        botMemories[index] = fleetBotMemorySchema.parse({ ...botMemories[index], ...(body as object) })
        value = botMemories[index]
        break
      }
      case 'botMemoryDelete': {
        const index = botMemories.findIndex((memory) => memory.id === url.pathname.split('/').at(-1))
        botMemories.splice(index, 1)
        break
      }
      case 'meta':
        value = {
          protocol: 1,
          features: ['provisioning'],
          gatewayVersion: '0.9.2',
          botImage: 'test-image',
          botImageVersion: '0.9.2',
        }
        break
      case 'pair':
        value = { deviceId: 'device-e2e', token: 'fixture-token' }
        break
      case 'host':
        value = host
        break
      case 'botsList':
        value = { bots }
        break
      case 'botGet':
        value = bot
        break
      case 'botArchive': {
        if (!bot) {
          send(404, { code: 'NOT_FOUND', message: 'Bot not found' })
          return
        }
        const record = fleetBotSchema.parse({ ...bot, lifecycle: 'archived', status: 'offline' })
        bots.splice(bots.indexOf(bot), 1)
        archived.set(bot.id, {
          summary: fleetArchivedBotSchema.parse({
            id: bot.id,
            name: bot.name,
            role: bot.role,
            tint: bot.tint,
            createdAt: bot.createdAt,
            archivedAt: now(),
            files: 'kept',
          }),
          record,
        })
        // Same order as the gateway: the archived bot, its removal, then the reply.
        emit({ type: 'bot.updated', at: now(), bot: record })
        emit({ type: 'bot.removed', at: now(), botId: bot.id })
        await new Promise((resolve) => setTimeout(resolve, 100))
        value = record
        break
      }
      case 'archivedBotsList':
        value = { bots: [...archived.values()].map((item) => item.summary) }
        break
      case 'archivedBotRestore':
      case 'archivedBotDelete': {
        const archivedId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
        const entry = archived.get(archivedId)
        if (!entry) {
          send(404, { code: 'NOT_FOUND', message: 'Archived bot not found' })
          return
        }
        archived.delete(archivedId)
        if (key === 'archivedBotDelete') break
        const restoring = fleetBotSchema.parse({
          ...entry.record,
          lifecycle: 'creating',
          status: 'starting',
          setup: { step: 'container', error: null, errorMessage: null },
        })
        bots.push(restoring)
        emit({ type: 'bot.updated', at: now(), bot: restoring })
        setTimeout(() => {
          const ready = fleetBotSchema.parse({
            ...restoring,
            lifecycle: 'running',
            status: 'idle',
            setup: { step: 'ready', error: null, errorMessage: null },
          })
          bots[bots.findIndex((item) => item.id === ready.id)] = ready
          emit({ type: 'bot.updated', at: now(), bot: ready })
        }, 300)
        value = restoring
        break
      }
      case 'botsCreate': {
        const input = body as {
          name: string
          instructions: string
          ceiling: string
          talksTo: string[]
        }
        const created = fleetBotSchema.parse({
          ...base,
          id: 'new-bot',
          name: input.name,
          instructions: input.instructions,
          ceiling: input.ceiling,
          talksTo: input.talksTo,
          status: 'starting',
          pendingCount: 0,
          activity: null,
          lifecycle: 'starting',
          setup: { step: 'container', error: null, errorMessage: null },
        })
        bots.push(created)
        value = created
        setTimeout(() => {
          const ready = fleetBotSchema.parse({
            ...created,
            status: 'idle',
            lifecycle: 'running',
            setup: { step: 'ready', error: null, errorMessage: null },
          })
          bots[bots.findIndex((item) => item.id === created.id)] = ready
          emit({ type: 'bot.updated', at: now(), bot: ready })
        }, 800)
        break
      }
      case 'botConversationCall': {
        const input = fleetConversationCallRequestSchema.parse(body)
        const profileState = () => ({
          rules: null,
          diagnostics: [],
          enabled: subagentProfilesEnabled,
          subagentsEnabled,
        })
        const skillsState = () => ({
          skills: [
            {
              name: 'order-check',
              description: 'Check orders',
              source: 'fixture',
              dir: '/skills/order-check',
              scope: 'global',
              modelInvocable: true,
              userInvocable: true,
              resources: { scripts: 0, references: 0, assets: 0 },
              enabled: skillOverride !== 'off',
              baseEnabled: true,
              enabledGlobally: true,
              override: skillOverride,
              groupIds: [],
              inSelectedGroup: true,
            },
          ],
          groups: [],
          selection: skillSelection,
          selectedGroupMissing: false,
          hasOverrides: skillOverride !== undefined,
        })
        let result: unknown
        switch (input.op) {
          case 'chatConfig':
            result = {
              mcpServers: [{ id: 'fixture-mcp', name: 'Fixture MCP', transport: 'http', enabled: true }],
              appToolsEnabled: true,
              imageGenEnabled: true,
            }
            break
          case 'chatGetConvTools':
            result = conversationTools
            break
          case 'chatSetConvTools':
            conversationTools = { ...conversationTools, ...(input.args[0] as Partial<typeof conversationTools>) }
            result = { ok: true }
            break
          case 'chatSubagentProfilesGetConversation':
            result = profileState()
            break
          case 'chatSubagentProfilesSetConversationEnabled':
            subagentProfilesEnabled = input.args[0] as boolean
            result = { ok: true, value: profileState() }
            break
          case 'chatSubagentsSetConversationEnabled':
            subagentsEnabled = input.args[0] as boolean
            result = { ok: true, value: profileState() }
            break
          case 'chatSkillsState':
            result = skillsState()
            break
          case 'chatSkillSetOverride':
            skillOverride = input.args[1] === 'inherit' ? undefined : (input.args[1] as 'on' | 'off')
            result = { ok: true }
            break
          case 'chatSkillResetOverrides':
            skillOverride = undefined
            result = { ok: true }
            break
          case 'chatSkillSetSelection':
            skillSelection = input.args[0] as typeof skillSelection
            result = { ok: true }
            break
          case 'chatCommands':
            result = {
              prompts: [],
              project: [],
              skills:
                skillOverride === 'off'
                  ? []
                  : [{ name: 'order-check', description: 'Check orders', source: 'fixture' }],
            }
            break
          case 'chatCompact':
            result = { ok: true }
            break
          case 'chatBackgroundCompactionRetry':
            result = { ok: true }
            break
        }
        value = { result }
        break
      }
      case 'botSelections':
        value = {
          options: [
            {
              id: 'prov_e2e::model-e2e',
              providerId: 'prov_e2e',
              providerLabel: 'Fake',
              modelId: 'model-e2e',
              modelLabel: 'Model',
              efforts: ['medium', 'high'],
              fastMode: true,
            },
            {
              id: 'prov_e2e::model-plus',
              providerId: 'prov_e2e',
              providerLabel: 'Fake',
              modelId: 'model-plus',
              modelLabel: 'Plus',
              efforts: ['high'],
              fastMode: false,
            },
          ],
          current: currentSelection,
        }
        break
      case 'botPatch': {
        if (bot) {
          const patch = body as Partial<FleetBot>
          if (patch.selection) currentSelection = patch.selection
          const updated = fleetBotSchema.parse({ ...bot, ...patch })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
          value = updated
        }
        break
      }
      case 'botImage':
        imageReads.push(url.pathname.split('/').pop() ?? '')
        if (url.pathname.endsWith('/shot-gone')) {
          send(404, { code: 'NOT_FOUND', message: 'Image not found' })
          return
        }
        if (url.pathname.endsWith('/shot-flaky') && flakyImageFailures > 0) {
          flakyImageFailures--
          send(503, { code: 'INSTANCE_UNAVAILABLE', message: 'Bot restarting' })
          return
        }
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': String(png.length),
        })
        response.end(png)
        return
      case 'botApiKeyAccountAdd': {
        const input = body as { name: string; kind: 'openai'; baseURL: string | null; key: string }
        botProvisioning(id).accounts.apiKeys.push({
          providerId: 'prov_e2e',
          name: input.name,
          kind: input.kind,
          baseURL: input.baseURL,
          keyHint: input.key.slice(-4),
        })
        value = { providerId: 'prov_e2e' }
        if (bot) {
          const input = body as { name: string }
          const updated = fleetBotSchema.parse({
            ...bot,
            status: 'idle',
            accounts: {
              connected: true,
              providers: [{ id: 'prov_e2e', label: input.name }],
            },
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botAccountRemove': {
        botProvisioning(id).accounts.apiKeys = botProvisioning(id).accounts.apiKeys.filter(
          (item) => item.providerId !== url.pathname.split('/').at(-1)
        )
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            status: 'setup',
            accounts: { connected: false, providers: [] },
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botTranscript':
        value = { items: id === 'scout' ? transcript : [], before: null }
        break
      case 'botMessageSend': {
        const input = body as { text: string }
        transcript.push({
          id: randomUUID(),
          at: now(),
          kind: 'user',
          text: input.text,
          source: 'owner',
          queued: false,
        })
        value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
        break
      }
      case 'botInteractionResolve': {
        inbox = inbox.filter((item) => item.id !== 'perm-1')
        const item = transcript[0] as Record<string, unknown>
        item.state = 'approved'
        item.resolvedAt = now()
        emit({
          type: 'inbox.updated',
          at: now(),
          items: inbox.map((interaction) => ({ botId: 'scout', interaction })),
        })
        break
      }
      case 'inbox':
        value = {
          items: inbox.map((interaction) => ({ botId: 'scout', interaction })),
        }
        break
      case 'peerMessages':
        value = { messages: [] }
        break
      case 'activity':
        value = { entries: memoryActivityReady ? [memoryActivity] : [], lastSeq: memoryActivityReady ? 2 : 0 }
        break
      case 'botTakeover': {
        if (takeoverConflicts-- > 0) {
          send(409, { code: 'CONFLICT', message: 'Bot is finishing a step' })
          return
        }
        value = {
          state: 'human',
          deviceId: 'device-e2e',
          deviceName: 'Mac',
          since: now(),
        }
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            takeover: value,
            status: 'human',
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botTakeoverRelease': {
        value = {
          state: 'none',
          deviceId: null,
          deviceName: null,
          since: null,
        }
        if (bot) {
          const updated = fleetBotSchema.parse({
            ...bot,
            takeover: value,
            status: 'idle',
          })
          bots[bots.indexOf(bot)] = updated
          emit({ type: 'bot.updated', at: now(), bot: updated })
        }
        break
      }
      case 'botScreenTicket':
        value = {
          ticket: 'ticket-e2e',
          path: '/v1/screen?ticket=ticket-e2e',
          expiresAt: now(),
        }
        break
      case 'botRoutinesList':
        value = { routines: routines.filter((routine) => routine.botId === id) }
        break
      case 'botRoutinesCreate': {
        const input = body as {
          title: string
          prompt: string
          schedule: unknown
          enabled: boolean
        }
        const created = fleetRoutineSchema.parse({
          ...input,
          id: 'routine-e2e',
          botId: id,
          nextRunAt: null,
          lastRunAt: null,
          lastOutcome: null,
          createdBy: 'owner',
          createdAt: now(),
          updatedAt: now(),
        })
        routines.push(created)
        value = created
        break
      }
      case 'screen':
        send(404, { code: 'NOT_FOUND', message: 'No websocket in fixture' })
        return
    }
    try {
      if (route.response) value = route.response.parse(value)
      if (!route.response) {
        response.writeHead(204)
        response.end()
      } else send(200, value)
    } catch (error) {
      send(500, { code: 'INTERNAL', message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const url = `http://127.0.0.1:${address.port}`
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_E2E_SKILLS_HOME: root,
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'fleet-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
      },
    })
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { __opened: string[] }
      state.__opened = []
      shell.openExternal = async (url) => {
        state.__opened.push(url)
      }
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    const inventory = await page.evaluate(async () => {
      const provider = await window.api.chatAddProvider({
        name: 'Mac fixture key',
        kind: 'openai',
        baseURL: 'https://fixture-user:fixture-password@api.example.com/v1?token=fixture-url-token#fixture-fragment',
        key: '',
      })
      if (!provider.id) throw new Error('No fixture provider')
      await window.api.chatSetKey(provider.id, 'sk-e2e-provision')
      await window.api.chatMcpAdd({
        name: 'Mac fixture MCP',
        transport: 'stdio',
        command: 'node',
        args: ['fixture.mjs'],
        env: { FIXTURE_TOKEN: 'fixture-mcp-secret' },
      })
      return window.api.fleetProvisioningInventory()
    })
    for (const secret of [
      'sk-e2e-provision',
      'fixture-user',
      'fixture-password',
      'fixture-url-token',
      'fixture-fragment',
      'fixture-mcp-secret',
    ])
      expect(JSON.stringify(inventory)).not.toContain(secret)
    expect(inventory.apiKeys.some((item) => item.name === 'Mac fixture key')).toBe(true)
    expect(inventory.skills.some((item) => item.name === 'e2e-notes')).toBe(true)
    // A cached authenticated provider is synthetic; inventory scanning and all import IPCs remain real.
    await app.evaluate(({ ipcMain }, inventory) => {
      ipcMain.removeHandler('fleet:provisioning:inventory')
      ipcMain.handle('fleet:provisioning:inventory', () => ({
        ...inventory,
        logins: [{ id: 'grok:default', kind: 'grok', label: 'Grok', email: null }],
      }))
    }, inventory)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Servidor de bots' }).first().click()
    await page.getByLabel('Endereço do servidor').fill(url)
    await page.getByLabel('Código de pareamento').fill('ABCD-EFGH')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Conectado' })).toContainText(
      'fleet-e2e-host'
    )
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
    const rendererProvisioning = await page.evaluate(async () => {
      const inventory = await window.api.fleetProvisioningInventory()
      const report = await window.api.fleetImportFromMac('privacy-check', {
        apiKeyIds: inventory.apiKeys.filter((item) => item.name === 'Mac fixture key').map((item) => item.id),
        copyIds: [],
        skillNames: ['e2e-notes'],
        mcpServerIds: inventory.mcpServers.filter((item) => item.name === 'Mac fixture MCP').map((item) => item.id),
      })
      const accounts = await window.api.fleetBotAccounts('privacy-check')
      return { inventory, report, accounts }
    })
    expect(rendererProvisioning.report.accounts[0].outcome).toBe('added')
    expect(rendererProvisioning.accounts.apiKeys[0].baseURL).toBe('https://api.example.com/v1')
    for (const secret of [
      'sk-e2e-provision',
      'fixture-user',
      'fixture-password',
      'fixture-url-token',
      'fixture-fragment',
      'fixture-mcp-secret',
    ]) {
      expect(JSON.stringify(rendererProvisioning)).not.toContain(secret)
      expect(await page.content()).not.toContain(secret)
    }

    await page.getByRole('tab', { name: 'Bots' }).click()
    await expect(page.getByRole('button', { name: /fleet-e2e-host/ })).toBeVisible()
    // A gateway without environments keeps the flat list and the views from before them.
    await expect(page.getByRole('button', { name: /^Ambiente / })).toHaveCount(0)
    await page.getByRole('button', { name: 'Memória sobre você', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Memória sobre você' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Quem vê' })).toHaveCount(0)
    await expect(page.getByText('Prefers morning updates.')).toBeVisible()
    await page.getByRole('textbox', { name: 'Adicionar' }).fill('Prefiro respostas curtas.')
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'ownerMemoryCreate').at(-1)?.body)
      .toMatchObject({
        content: 'Prefiro respostas curtas.',
        idempotencyKey: expect.any(String),
      })
    const addedMemory = page.getByRole('listitem').filter({ hasText: 'Prefiro respostas curtas.' })
    await addedMemory.getByRole('button', { name: 'Editar', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Editar' })).toBeFocused()
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await expect(addedMemory.getByRole('button', { name: 'Editar', exact: true })).toBeFocused()
    await addedMemory.getByRole('button', { name: 'Editar', exact: true }).click()
    await page.getByRole('textbox', { name: 'Editar' }).fill('Prefiro respostas curtas e diretas.')
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('textbox', { name: 'Editar' }) })
      .getByRole('button', { name: 'Salvar', exact: true })
      .click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'ownerMemoryPatch').at(-1)?.body)
      .toEqual({ content: 'Prefiro respostas curtas e diretas.' })
    const editedMemory = page.getByRole('listitem').filter({ hasText: 'Prefiro respostas curtas e diretas.' })
    await expect(editedMemory.getByRole('button', { name: 'Editar', exact: true })).toBeFocused()
    ownerMemoryFull = true
    await page.getByRole('textbox', { name: 'Adicionar' }).fill('One more preference.')
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'A memória sobre você está cheia (4000 caracteres). Remova ou encurte um item antes.'
    )
    ownerMemoryFull = false
    await editedMemory.getByRole('button', { name: 'Remover', exact: true }).click()
    await expect(editedMemory).toHaveCount(0)
    await page.getByRole('button', { name: 'Mostrar removidos e substituídos (1)' }).click()
    await expect(editedMemory.getByRole('button', { name: 'Restaurar' })).toBeVisible()
    ownerMemory.entries.push(
      fleetOwnerMemoryEntrySchema.parse({
        ...ownerMemory.entries[0],
        id: 'live-memory',
        content: 'Prefers weekly summaries.',
      })
    )
    ownerMemory.revision = 7
    emit({ type: 'owner_memory.updated', revision: 7, at: now() })
    await expect(page.getByText('Prefers weekly summaries.')).toBeVisible()
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await expect(page.getByRole('heading', { name: 'Scout' })).toBeVisible()
    await expect(page.getByText('Scout quer rodar um comando')).toBeVisible()
    await expect(page.getByText('ls -la')).toBeVisible()
    await expect(page.getByText('Resumo preparado em segundo plano')).toBeVisible()
    await page.getByText('Resumo do contexto anterior').click()
    await expect(page.getByText('E2E-SUMMARY')).toBeVisible()
    await expect(page.locator('[data-background-compaction-status="ready"]')).toBeVisible()
    await expect(page.getByText('~22.6k/828.4k 2.7% · ~$0.120')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir Screenshot' })).toBeVisible()
    await expect.poll(() => [...imageReads].sort()).toEqual(['shot-1', 'shot-flaky', 'shot-gone'])
    // An evicted image says so; a failed read offers a retry. Both explanations fit their box.
    const gone = page.getByRole('status').filter({ hasText: 'Imagem não está mais disponível' })
    const flaky = page.getByRole('status').filter({ hasText: 'Não foi possível carregar a imagem' })
    await expect(gone).toBeVisible()
    await expect(gone.getByRole('button')).toHaveCount(0)
    await expect(flaky).toBeVisible()
    for (const tile of [gone, flaky])
      expect(
        await tile.evaluate((element) => {
          const box = element.getBoundingClientRect()
          // Text nodes included: the whole content must sit inside the border.
          const range = document.createRange()
          range.selectNodeContents(element)
          const content = range.getBoundingClientRect()
          return (
            content.top >= box.top + 1 &&
            content.bottom <= box.bottom - 1 &&
            content.left >= box.left + 1 &&
            content.right <= box.right - 1
          )
        })
      ).toBe(true)
    await flaky.getByRole('button', { name: 'Tentar de novo' }).click()
    await expect(page.getByRole('button', { name: 'Abrir Flaky' })).toBeVisible()
    await page.getByRole('button', { name: 'Abrir Screenshot' }).click()
    await expect(page.getByRole('dialog').getByAltText('Screenshot')).toBeVisible()
    await page.keyboard.press('Escape')
    // Leaving the bot and coming back shows the loaded images again without downloading them.
    const readsBeforeLeaving = imageReads.length
    await page
      .getByRole('button', { name: /fleet-e2e-host/ })
      .first()
      .click()
    await expect(page.getByRole('button', { name: 'Abrir Screenshot' })).toHaveCount(0)
    await page.getByRole('button', { name: /Scout/ }).first().click()
    await expect(page.getByRole('button', { name: 'Abrir Screenshot' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abrir Flaky' })).toBeVisible()
    await expect(gone).toBeVisible()
    expect(imageReads.slice(readsBeforeLeaving)).toEqual(['shot-gone'])
    await expect(page.getByText('Lembrou: Portal login')).toBeVisible()
    await page.getByRole('tab', { name: 'Ajustes' }).click()
    const scoutRoutine = page.getByText('Scout check', { exact: true }).locator('../../..')
    await scoutRoutine.getByRole('button', { name: 'Histórico', exact: true }).click()
    await expect(page.getByText('Concluída', { exact: true })).toBeVisible()
    await expect(page.getByText('Fez: Checked 3 stores', { exact: true })).toBeVisible()
    await expect(page.getByText('Notas para a próxima: Retry Magalu first', { exact: true })).toBeVisible()
    await page.getByText('Resposta final', { exact: true }).click()
    await expect(page.getByText('Found three offers.')).toBeVisible()
    routineRuns[0].status = 'delivered'
    const runningScout = fleetBotSchema.parse({
      ...bots.find((bot) => bot.id === 'scout'),
      status: 'working',
      updatedAt: now(),
    })
    emit({ type: 'bot.updated', at: now(), bot: runningScout })
    await expect(page.getByText('Em andamento', { exact: true })).toBeVisible()
    routineRuns[0].status = 'cancelled'
    // A queued next turn can keep status and timestamps unchanged after cancellation.
    emit({ type: 'bot.updated', at: now(), bot: runningScout })
    await expect(page.getByText('Cancelada', { exact: true })).toBeVisible()
    await expect(page.getByText('Em andamento', { exact: true })).toHaveCount(0)
    const botMemory = page.getByRole('region', { name: 'Memória do bot', exact: true })
    await expect(botMemory.getByText('Portal login', { exact: true })).toBeVisible()
    await expect(botMemory.getByText('Automática', { exact: true })).toBeVisible()
    await expect(
      botMemory.getByText('Resumida — só os primeiros 4.000 caracteres aparecem.', { exact: true })
    ).toBeVisible()
    await botMemory.getByRole('button', { name: 'Mostrar conteúdo', exact: true }).click()
    await expect(
      botMemory.getByText('Resumida — só os primeiros 4.000 caracteres aparecem.', { exact: true })
    ).toBeVisible()
    await botMemory.getByRole('button', { name: 'Fixar', exact: true }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'botMemoryPatch').at(-1)?.body)
      .toEqual({ pinned: true })
    await expect(botMemory.getByRole('button', { name: 'Desafixar', exact: true })).toBeVisible()
    memoryActivityReady = true
    emit({ type: 'activity', at: now(), entry: memoryActivity })
    await page.evaluate(() => window.api.fleetRefresh())
    await expect(page.getByText('Aprendeu sobre você · Prefers weekly summaries.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Dispensar', exact: true }).click()
    await page.getByRole('tab', { name: 'Conversa' }).click()
    const setupScout = fleetBotSchema.parse({
      ...bots[0],
      compaction: null,
      status: 'setup',
      activity: { kind: 'setup', need: 'compaction' },
      compactionState: {
        configured: false,
        problem: 'missing',
        background: { status: 'idle', error: null },
        progress: null,
      },
    })
    bots[0] = setupScout
    emit({ type: 'bot.updated', at: now(), bot: setupScout })
    await expect(page.getByRole('button', { name: 'Escolher modelo de compactação' })).toBeVisible()
    await page.getByRole('tab', { name: 'Tela' }).click()
    await expect(page.getByRole('heading', { name: 'Conectar uma conta' })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Conversa' }).click()
    await page.getByRole('button', { name: 'Escolher modelo de compactação' }).click()
    await expect(page.getByRole('heading', { name: 'Compactação' })).toBeInViewport()
    await page.getByRole('button', { name: 'Modelo de compactação', exact: true }).click()
    await page.getByRole('option', { name: 'Fake · Model' }).click()
    await page.getByLabel('Preparar um resumo a cada (mil tokens)').fill('100')
    await page.getByRole('button', { name: 'Salvar compactação' }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { compaction?: { modelId?: string } })
            ?.compaction?.modelId
      )
      .toBe('model-e2e')
    const configuredScout = fleetBotSchema.parse({
      ...bots[0],
      status: 'waiting',
      activity: { kind: 'permission', title: 'Run ls' },
      compactionState: {
        configured: true,
        problem: null,
        background: { status: 'ready', error: null },
        progress: null,
      },
    })
    bots[0] = configuredScout
    emit({ type: 'bot.updated', at: now(), bot: configuredScout })
    await page.getByRole('tab', { name: 'Conversa' }).click()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('/compact')
    await page.getByRole('button', { name: /^\/compact / }).click()
    await expect
      .poll(
        () =>
          requests.filter(
            (item) => item.key === 'botConversationCall' && (item.body as { op: string }).op === 'chatCompact'
          ).length
      )
      .toBe(1)
    await page.getByTitle('Adicionar').click()
    await expect(page.getByText('Fixture MCP')).toBeVisible()
    await page.getByRole('switch', { name: 'Fixture MCP' }).click()
    await expect
      .poll(
        () =>
          (
            requests
              .filter(
                (item) => item.key === 'botConversationCall' && (item.body as { op: string }).op === 'chatSetConvTools'
              )
              .at(-1)?.body as { args: [{ mcpDisabled?: string[] }] } | undefined
          )?.args[0].mcpDisabled
      )
      .toEqual(['fixture-mcp'])
    await page.getByTitle('Adicionar').click()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('/order')
    await expect(page.getByText('/order-check')).toBeVisible()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('')
    await page.getByTitle('Skills', { exact: true }).click()
    await expect(page.getByText('/order-check')).toBeVisible()
    await page.getByRole('button', { name: 'Desligada' }).click()
    await expect
      .poll(
        () =>
          (
            requests
              .filter(
                (item) =>
                  item.key === 'botConversationCall' && (item.body as { op: string }).op === 'chatSkillSetOverride'
              )
              .at(-1)?.body as { args: string[] } | undefined
          )?.args
      )
      .toEqual(['order-check', 'off'])
    await page.getByTitle('Skills', { exact: true }).click()
    await page.getByRole('button', { name: 'medium' }).first().click()
    await page.getByRole('button', { name: 'high', exact: true }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { reasoning?: string } })
            ?.selection?.reasoning
      )
      .toBe('high')
    await page.getByRole('button', { name: 'Fast', exact: true }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { fastMode?: boolean } })
            ?.selection?.fastMode
      )
      .toBe(true)
    await expect(page.getByTitle(/Trocar modelo/)).toHaveClass(/rounded-md/)
    // Closed, the chip names the provider by its label (as the desktop does), never by its internal id.
    await expect(page.getByTitle(/Trocar modelo/)).toContainText('Fake · model-e2e')
    await expect(page.getByTitle(/Trocar modelo/)).not.toContainText('prov_e2e')
    await page.getByTitle(/Trocar modelo/).click()
    await expect(page.getByRole('button', { name: 'model-plus' })).toBeVisible()
    await page.getByRole('button', { name: 'model-plus' }).click()
    await expect
      .poll(
        () =>
          (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { selection?: { modelId?: string } })
            ?.selection?.modelId
      )
      .toBe('model-plus')
    await page.getByRole('button', { name: 'Aprovar por mim' }).click()
    await page.getByRole('button', { name: 'Acesso completo' }).last().click()
    await expect
      .poll(() => (requests.filter((item) => item.key === 'botPatch').at(-1)?.body as { ceiling?: string })?.ceiling)
      .toBe('full')
    await page
      .locator('input[type="file"][accept^="image/*"]')
      .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByAltText('test.png')).toBeVisible()
    await page.locator('[data-placeholder="Mensagem para Scout…"]').fill('Check the orders')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botMessageSend').length).toBe(1)
    const sent = requests.find((item) => item.key === 'botMessageSend')?.body as {
      text: string
      attachments: { mediaType: string; name: string; dataBase64: string }[]
    }
    expect(sent.text).toBe('Check the orders')
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0]).toMatchObject({ name: 'test.png', mediaType: 'image/png' })
    expect(Buffer.from(sent.attachments[0].dataBase64, 'base64')).toEqual(png)
    await page.getByRole('button', { name: 'Aprovar uma vez' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botInteractionResolve').length).toBe(1)
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page.getByRole('button', { name: /Aguardando você/ }).click()
    await expect(page.getByRole('heading', { name: 'Aguardando você' })).toBeVisible()
    await page.getByRole('tab', { name: 'Bots' }).click()
    await page.getByRole('button', { name: 'Criar bot' }).first().click()
    // The selected choice stands out (3:1) and carries a check mark; the others recede.
    const createDialog = page.getByRole('dialog', { name: 'Criar bot' })
    await expect(createDialog.getByRole('radiogroup', { name: 'Onde ele roda' })).toHaveCount(0)
    const selectedCeiling = createDialog.getByRole('radio', { name: /Aprovar por mim/ })
    const otherCeiling = createDialog.getByRole('radio', { name: /Pedir aprovação/ })
    await expect(selectedCeiling).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => stateContrastOnDialog(selectedCeiling)).toBeGreaterThanOrEqual(3)
    expect(await stateContrastOnDialog(otherCeiling)).toBeLessThan(1.5)
    await expect(selectedCeiling.locator('svg')).toHaveCount(1)
    await expect(otherCeiling.locator('svg')).toHaveCount(0)
    const peer = createDialog.getByRole('button', { name: 'Scout', exact: true })
    await peer.click()
    await expect(peer).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => stateContrastOnDialog(peer)).toBeGreaterThanOrEqual(3)
    await expect(peer.locator('svg')).toHaveCount(1)
    await peer.click()
    await expect(peer).toHaveAttribute('aria-pressed', 'false')
    // Measured at rest: under the pointer it shows the hover fill.
    await page.mouse.move(0, 0)
    await expect.poll(() => stateContrastOnDialog(peer)).toBeLessThan(1.5)
    await page.getByRole('dialog', { name: 'Criar bot' }).getByLabel('Nome').fill('Orders')
    await createDialog.getByRole('button', { name: 'Trazer do seu Mac', exact: true }).click()
    await createDialog.getByRole('checkbox', { name: 'Mac fixture key', exact: true }).check()
    await createDialog.getByRole('checkbox', { name: 'e2e-notes', exact: true }).check()
    await createDialog.getByRole('checkbox', { name: 'Grok', exact: true }).check()
    await createDialog.getByRole('checkbox', { name: 'Mac fixture MCP', exact: true }).check()
    await page.getByRole('dialog', { name: 'Criar bot' }).getByRole('button', { name: 'Criar bot' }).click()
    const grokLogin = page.getByRole('dialog', { name: 'Entrar em Grok no Orders', exact: true })
    await expect(grokLogin.getByText('E2E-GROK', { exact: true })).toBeVisible()
    await expect
      .poll(() => requests.find((item) => item.key === 'botAccountsImport')?.body)
      .toMatchObject({ items: [{ type: 'api-key', key: 'sk-e2e-provision', name: 'Mac fixture key' }] })
    expect(requests.find((item) => item.key === 'botSkillInstall')?.body).toMatchObject({
      name: 'e2e-notes',
      files: [{ path: 'SKILL.md', data: Buffer.from(skillText).toString('base64'), executable: false }],
    })
    await expect
      .poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { __opened: string[] }).__opened))
      .toContain('https://accounts.x.ai/device')
    await expect(grokLogin.getByText('Conectado como owner@example.com')).toBeVisible()
    await grokLogin.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(createDialog.getByRole('list').filter({ hasText: 'Mac fixture key' })).toContainText('Adicionado')
    await createDialog.getByRole('button', { name: 'Concluir', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
    await page.getByRole('tab', { name: 'Tela' }).click()
    await expect(page.getByRole('region', { name: 'Tela do Orders' })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Área da tela' })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Tela indisponível' })).toBeVisible()
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await page
      .getByRole('dialog', { name: 'Assumir a tela do Orders?' })
      .getByRole('button', { name: 'Assumir' })
      .click()
    await expect(page.getByRole('alert')).toContainText('O bot está terminando um passo')
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await page
      .getByRole('dialog', { name: 'Assumir a tela do Orders?' })
      .getByRole('button', { name: 'Assumir' })
      .click()
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeover').length).toBe(2)
    // The holder switch highlights exactly the "Você" half, whatever the bot name's width.
    const holder = page.getByRole('status', { name: 'Quem controla a tela: Você' })
    await expect(holder).toBeVisible()
    await expect
      .poll(async () => {
        const [indicator, you] = await Promise.all([
          holder.locator('[aria-hidden="true"]').boundingBox(),
          holder.getByText('Você', { exact: true }).boundingBox(),
        ])
        if (!indicator || !you) return null
        return Math.max(Math.abs(indicator.x - you.x), Math.abs(indicator.width - you.width)) <= 1
      })
      .toBe(true)
    await page.getByRole('button', { name: 'Devolver ao Orders' }).click()
    await page.getByPlaceholder('Opcional').fill('Signed in')
    await page.getByRole('button', { name: 'Devolver', exact: true }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botTakeoverRelease').length).toBe(1)
    expect(requests.find((item) => item.key === 'botTakeoverRelease')?.body).toMatchObject({
      note: 'Signed in',
      continue: true,
    })
    const orders = bots.find((item) => item.id === 'new-bot')!
    const foreign = fleetBotSchema.parse({
      ...orders,
      status: 'human',
      takeover: {
        state: 'human',
        deviceId: 'other-device',
        deviceName: 'Office Mac',
        since: now(),
      },
    })
    bots[bots.indexOf(orders)] = foreign
    emit({ type: 'bot.updated', at: now(), bot: foreign })
    await expect(page.getByRole('status', { name: 'Quem controla a tela: Office Mac' })).toBeVisible()
    await expect(page.getByText('Office Mac está controlando a tela.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Assumir controle' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Devolver ao Orders' })).toHaveCount(0)
    // Parsed as the gateway reads it: a Mac without environments gets the browser area.
    await expect
      .poll(() => requests.filter((item) => item.key === 'botScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'view', surface: 'browser' })
    expect(requests.filter((item) => item.key === 'botTakeoverRelease')).toHaveLength(1)
    await page.getByRole('tab', { name: 'Ajustes' }).click()
    const accountsSection = page.getByRole('region', { name: 'Contas do bot', exact: true })
    const resourcesSection = page.getByRole('region', { name: 'Skills e MCP', exact: true })
    await expect(accountsSection.getByText(/Mac fixture key.*…sion/)).toBeVisible()
    const listRequests = () =>
      requests.filter((item) => ['botAccountsList', 'botSkillsList', 'botMcpServersList'].includes(item.key)).length
    const beforeResourceUpdates = listRequests()
    const currentBot = bots.find((item) => item.id === 'new-bot')!
    for (let index = 0; index < 4; index++) {
      emit({
        type: 'bot.updated',
        at: now(),
        bot: { ...currentBot, resources: { ...currentBot.resources, cpuPercent: index + 1 } },
      })
      await page.waitForTimeout(250)
    }
    expect(listRequests()).toBe(beforeResourceUpdates)

    for (const secret of [
      'sk-e2e-provision',
      'fixture-user',
      'fixture-password',
      'fixture-url-token',
      'fixture-fragment',
      'fixture-mcp-secret',
    ])
      expect(await page.content()).not.toContain(secret)
    await accountsSection.getByRole('button', { name: 'Trazer do Mac…', exact: true }).click()
    const importDialog = page.getByRole('dialog', { name: 'Trazer do seu Mac', exact: true })
    await expect(importDialog.getByText('Já no bot', { exact: true })).toBeVisible()
    await expect(importDialog.getByRole('checkbox', { name: 'e2e-notes', exact: true })).toHaveCount(0)
    await importDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await resourcesSection.getByRole('button', { name: 'Trazer do Mac…', exact: true }).click()
    await expect(importDialog.getByText('Já no bot', { exact: true })).toHaveCount(2)
    await expect(importDialog.getByRole('checkbox', { name: 'Mac fixture key', exact: true })).toHaveCount(0)
    await importDialog.getByRole('button', { name: 'Fechar', exact: true }).click()
    await accountsSection.getByRole('button', { name: 'Entrar com Claude', exact: true }).click()
    const claudeLogin = page.getByRole('dialog', { name: 'Entrar em Claude no Orders', exact: true })
    await expect(claudeLogin.getByText('Abrimos claude.ai no seu navegador. Entre e autorize.')).toBeVisible()
    await expect(claudeLogin.getByLabel('Código', { exact: true })).toHaveCount(0)
    const callback = await fetch('http://localhost:' + callbackPort + '/callback?code=a&state=b', {
      redirect: 'manual',
    })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('https://platform.claude.com/oauth/code/success')
    expect(requests.find((item) => item.key === 'botLoginCallback')?.body).toEqual({
      path: '/callback',
      query: 'code=a&state=b',
    })
    await expect(claudeLogin.getByText('Conectado como owner@example.com')).toBeVisible()
    await claudeLogin.getByRole('button', { name: 'Pronto', exact: true }).click()
    occupiedPort = createNetServer()
    await new Promise<void>((resolve) => occupiedPort!.listen(callbackPort, '127.0.0.1', resolve))
    await accountsSection.getByRole('button', { name: 'Entrar com Claude', exact: true }).click()
    await expect(claudeLogin.getByLabel('Código', { exact: true })).toBeVisible()
    await claudeLogin.getByRole('button', { name: 'Abrir link', exact: true }).click()
    await claudeLogin.getByLabel('Código', { exact: true }).fill('fixture-manual-code')
    await claudeLogin.getByRole('button', { name: 'Enviar código', exact: true }).click()
    await expect
      .poll(() => requests.find((item) => item.key === 'botLoginCode')?.body)
      .toEqual({ code: 'fixture-manual-code' })
    await expect(claudeLogin.getByText('Conectado como owner@example.com')).toBeVisible()
    await claudeLogin.getByRole('button', { name: 'Pronto', exact: true }).click()
    await new Promise<void>((resolve) => occupiedPort!.close(() => resolve()))
    occupiedPort = undefined
    // Closing must not wait for a failed cancellation or keep polling the abandoned attempt.
    rejectCancellation = true
    await accountsSection.getByRole('button', { name: 'Entrar com Claude', exact: true }).click()
    await expect(claudeLogin.getByText('Abrimos claude.ai no seu navegador. Entre e autorize.')).toBeVisible()
    const abandonedId = [...logins.keys()].at(-1)!
    await claudeLogin.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await expect(claudeLogin).toHaveCount(0)
    await expect.poll(() => rejectCancellation).toBe(false)
    const abandonedPolls = logins.get(abandonedId)!.polls

    // A rejected IPC import still advances through the selected logins and can finish.
    await app.evaluate(({ ipcMain }) => {
      const channel = 'fleet:provisioning:import'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
        ._invokeHandlers
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
        throw new Error('Synthetic import rejection')
      })
    })
    await accountsSection.getByRole('button', { name: 'Trazer do Mac…', exact: true }).click()
    await importDialog.getByRole('checkbox', { name: 'Grok', exact: true }).check()
    await importDialog.getByRole('button', { name: 'Enviar para o bot', exact: true }).click()
    await expect(grokLogin.getByText('Conectado como owner@example.com')).toBeVisible()
    await grokLogin.getByRole('button', { name: 'Pronto', exact: true }).click()
    await expect(importDialog.getByRole('alert')).toContainText('Synthetic import rejection')
    await importDialog.getByRole('button', { name: 'Concluir', exact: true }).click()
    await expect(importDialog).toHaveCount(0)
    expect(logins.get(abandonedId)!.polls).toBe(abandonedPolls)

    for (const name of ['Grok', 'Claude', 'Mac fixture key']) {
      await accountsSection
        .getByRole('listitem')
        .filter({ hasText: name })
        .getByRole('button', { name: 'Remover', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Remover conta de modelo?' })
        .getByRole('button', { name: 'Remover', exact: true })
        .click()
      await expect(accountsSection.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)
    }
    expect(requests.find((item) => item.path === '/v1/bots/new-bot/subscriptions/grok/default')?.method).toBe('DELETE')
    for (const name of ['e2e-notes', 'Mac fixture MCP']) {
      await resourcesSection
        .getByRole('listitem')
        .filter({ hasText: name })
        .getByRole('button', { name: 'Remover', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: 'Remover ' + name + ' deste bot?' })
        .getByRole('button', { name: 'Remover', exact: true })
        .click()
      await expect(resourcesSection.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)
    }
    expect(requests.find((item) => item.key === 'botSkillRemove')).toMatchObject({
      method: 'DELETE',
      path: '/v1/bots/new-bot/skills/e2e-notes',
    })
    expect(requests.find((item) => item.key === 'botMcpServerRemove')).toMatchObject({
      method: 'DELETE',
      path: '/v1/bots/new-bot/mcp-servers/mcp_imported',
    })
    const withoutProvisioning = fleetBotSchema.parse({
      ...bots.find((item) => item.id === 'new-bot'),
      capabilities: [],
    })
    emit({ type: 'bot.updated', at: now(), bot: withoutProvisioning })
    await expect(accountsSection.getByText('Reinicie este bot para atualizá-lo antes.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Trazer do Mac…', exact: true })).toHaveCount(0)
    emit({ type: 'bot.updated', at: now(), bot: bots.find((item) => item.id === 'new-bot')! })
    const apiKey = 'fleet-e2e-secret-key-123'
    await page.getByLabel('Nome da conta').fill('Fake model')
    await page.getByLabel('Chave de API').fill(apiKey)
    await page.getByText('Avançado').click()
    await page.getByLabel('URL base (opcional)').fill('http://fake-model:8080/v1')
    await page.getByRole('button', { name: 'Adicionar conta' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botApiKeyAccountAdd').length).toBe(1)
    expect(requests.find((item) => item.key === 'botApiKeyAccountAdd')?.body).toEqual({
      kind: 'openai',
      name: 'Fake model',
      key: apiKey,
      baseURL: 'http://fake-model:8080/v1',
    })
    await expect(accountsSection.getByText(/Fake model.*fake-model:8080.*…-123/)).toBeVisible()
    expect(JSON.stringify(await page.evaluate(() => window.api.fleetBotAccounts('new-bot')))).not.toContain(apiKey)
    expect(await page.content()).not.toContain(apiKey)
    await expect(page.getByLabel('Chave de API')).toHaveValue('')
    await page.getByRole('button', { name: 'Remover', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Remover conta de modelo?' })
      .getByRole('button', { name: 'Remover' })
      .click()
    await expect.poll(() => requests.filter((item) => item.key === 'botAccountRemove').length).toBe(2)
    await page.getByRole('button', { name: 'Adicionar rotina' }).click()
    await expect(page.getByText('A cada 1 h 30 min')).toBeVisible()
    await expect(page.getByText('Criada pelo bot')).toBeVisible()
    await expect(page.getByText('Pulada: execução anterior em andamento')).toBeVisible()
    const routineDialog = page.getByRole('dialog', { name: 'Adicionar rotina' })
    await routineDialog.getByLabel('Título').fill('Daily orders')
    await routineDialog.getByLabel('Instrução').fill('Check the orders')
    const monday = routineDialog.getByRole('button', { name: 'Seg' })
    await monday.click()
    await expect(monday).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => stateContrastOnDialog(monday)).toBeGreaterThanOrEqual(3)
    await monday.click()
    const intervalMode = routineDialog.getByRole('radio', { name: 'Intervalo' })
    await intervalMode.click()
    await expect(intervalMode).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => stateContrastOnDialog(intervalMode)).toBeGreaterThanOrEqual(3)
    await expect(intervalMode.locator('svg')).toHaveCount(1)
    await routineDialog.getByLabel('A cada').fill('10')
    await expect(routineDialog.getByRole('alert')).toContainText('15 minutos')
    await expect(routineDialog.getByRole('button', { name: 'Salvar rotina' })).toBeDisabled()
    await routineDialog.getByLabel('A cada').fill('30')
    await expect(routineDialog.getByRole('alert')).toHaveCount(0)
    await routineDialog.getByRole('button', { name: 'Salvar rotina' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'botRoutinesCreate').length).toBe(1)
    expect(requests.find((item) => item.key === 'botRoutinesCreate')?.body).toMatchObject({
      schedule: { kind: 'interval', everyMinutes: 30 },
    })
    routines.push(
      fleetRoutineSchema.parse({
        id: 'refreshed-routine',
        botId: 'new-bot',
        title: 'Fresh from bot',
        prompt: 'Check',
        schedule: { kind: 'interval', everyMinutes: 30 },
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        lastOutcome: null,
        createdBy: 'bot',
        createdAt: now(),
        updatedAt: now(),
      })
    )
    const listsBeforeActivity = requests.filter((item) => item.key === 'botRoutinesList').length
    emit({
      type: 'activity',
      at: now(),
      entry: {
        // Gateway activity seqs only grow; stay above every entry this spec already served.
        seq: 100,
        at: now(),
        botId: 'new-bot',
        kind: 'routine_created',
        summary: 'Fresh from bot',
        data: { routineId: 'refreshed-routine' },
      },
    })
    await expect
      .poll(() => requests.filter((item) => item.key === 'botRoutinesList').length)
      .toBeGreaterThan(listsBeforeActivity)
    await expect(
      page.getByText('Fresh from bot', { exact: true }).locator('..').getByText('Criada pelo bot')
    ).toBeVisible()
    await expect(page.getByText('A cada 30 min').first()).toBeVisible()

    // Archive, restore, and delete forever.
    await page.getByRole('button', { name: 'Arquivar Orders' }).click()
    await page.getByRole('dialog', { name: 'Arquivar bot?' }).getByRole('button', { name: 'Arquivar' }).click()
    // The dialog closes once the archive reply is back, after the removal event it must not undo.
    await expect(page.getByRole('dialog', { name: 'Arquivar bot?' })).toHaveCount(0)
    await page
      .getByRole('button', { name: /fleet-e2e-host/ })
      .first()
      .click()
    const archivedSection = page.getByRole('region', { name: 'Arquivados' })
    await expect(page.getByRole('row', { name: /Orders/ })).toHaveCount(0)
    await expect(archivedSection.getByRole('listitem').filter({ hasText: 'Orders' })).toBeVisible()
    await expect(archivedSection.getByText(/arquivos guardados no servidor/)).toBeVisible()
    await expect(archivedSection.getByText(/os arquivos não estão mais no servidor/)).toBeVisible()
    await archivedSection.getByRole('button', { name: 'Restaurar Orders' }).click()
    await expect.poll(() => requests.filter((item) => item.key === 'archivedBotRestore').length).toBe(1)
    await expect(archivedSection.getByRole('listitem').filter({ hasText: 'Orders' })).toHaveCount(0)
    await expect(page.getByRole('row', { name: /Orders/ })).toBeVisible()
    await archivedSection.getByRole('button', { name: 'Apagar Legacy de vez' }).click()
    const deleteDialog = page.getByRole('dialog', { name: 'Apagar Legacy de vez?' })
    const deleteForever = deleteDialog.getByRole('button', { name: 'Apagar de vez' })
    await expect(deleteForever).toBeDisabled()
    await deleteDialog.getByLabel('Digite Legacy para confirmar').fill('legacy')
    await expect(deleteForever).toBeDisabled()
    await deleteDialog.getByLabel('Digite Legacy para confirmar').fill('Legacy')
    await deleteForever.click()
    await expect.poll(() => requests.filter((item) => item.key === 'archivedBotDelete').length).toBe(1)
    await expect(deleteDialog).toHaveCount(0)
    await expect(archivedSection.getByText('Nenhum bot arquivado.')).toBeVisible()
  } finally {
    if (occupiedPort) await new Promise<void>((resolve) => occupiedPort!.close(() => resolve()))
    await app?.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('fleet UI organizes bots in environments that share accounts, screens and lifecycle', async () => {
  test.setTimeout(240_000)
  const GB = 1024 ** 3
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-fleet-env-e2e-'))
  const requests: Array<{ key: string; body: unknown; path: string; method: string | undefined }> = []
  const streams = new Set<ServerResponse>()
  function emit(event: unknown) {
    const valid = fleetGatewayEventSchema.parse(event)
    for (const stream of streams) stream.write(`event: fleet\ndata: ${JSON.stringify(valid)}\n\n`)
  }
  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
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
  const capabilities = ['provisioning', 'environments']
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
    makeEnvironment('acme', 'Acme', ['scout']),
    makeEnvironment('home', 'Home', ['diary']),
  ]
  const bots: FleetBot[] = [
    makeBot('scout', 'Scout', 'acme', { role: 'Finds orders' }),
    makeBot('diary', 'Diary', 'home'),
  ]
  const archivedEnvironments = new Map<
    string,
    { summary: FleetArchivedEnvironment; environment: FleetEnvironment; bots: FleetBot[] }
  >([
    [
      'old-lab',
      {
        summary: fleetArchivedEnvironmentSchema.parse({
          id: 'old-lab',
          name: 'Old lab',
          createdAt: now(),
          archivedAt: now(),
          files: 'kept',
          bots: [{ id: 'lab-bot', name: 'Lab bot', role: '', tint: '#aa6644' }],
        }),
        environment: makeEnvironment('old-lab', 'Old lab', ['lab-bot']),
        bots: [makeBot('lab-bot', 'Lab bot', 'old-lab')],
      },
    ],
  ])
  const archivedBots = new Map<string, { summary: FleetArchivedBot; record: FleetBot }>()
  const accounts = new Map<string, FleetBotAccounts>()
  const accountsOf = (id: string) => {
    let value = accounts.get(id)
    if (!value) {
      value = { apiKeys: [], subscriptions: [] }
      accounts.set(id, value)
    }
    return value
  }
  const ownerMemory = fleetOwnerMemorySchema.parse({
    revision: 1,
    activeChars: 28,
    entries: [
      {
        id: 'acme-note',
        content: 'Acme invoices go to finance.',
        status: 'active',
        author: { kind: 'owner' },
        origin: null,
        replacesId: null,
        replacedById: null,
        environmentId: 'acme',
        createdAt: now(),
        updatedAt: now(),
      },
    ],
  })
  // The first control request on an environment display finds another session holding it.
  let screenConflicts = 1
  const ticket = () => ({ ticket: 'ticket-env-e2e', path: '/v1/screen?ticket=ticket-env-e2e', expiresAt: now() })
  const upsertEnvironment = (environment: FleetEnvironment) => {
    const index = environments.findIndex((item) => item.id === environment.id)
    if (index >= 0) environments[index] = environment
    else environments.push(environment)
    emit({ type: 'environment.updated', at: now(), environment })
  }
  const conversationResult = (op: string): unknown => {
    switch (op) {
      case 'chatConfig':
        return { mcpServers: [], appToolsEnabled: true, imageGenEnabled: true }
      case 'chatGetConvTools':
        return { app: true, imageGen: true, mcpDisabled: [] }
      case 'chatSubagentProfilesGetConversation':
        return { rules: null, diagnostics: [], enabled: true, subagentsEnabled: true }
      case 'chatSkillsState':
        return { skills: [], groups: [], selection: { kind: 'all' }, selectedGroupMissing: false, hasOverrides: false }
      case 'chatCommands':
        return { prompts: [], project: [], skills: [] }
      default:
        return { ok: true }
    }
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!entry) {
      send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
      return
    }
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1') {
      send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
      return
    }
    if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-token') {
      send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      return
    }
    let body: unknown
    if (route.body) {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      try {
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        send(400, { code: 'INVALID_REQUEST', message: 'Bad body' })
        return
      }
    }
    requests.push({ key, body, path: url.pathname, method: request.method })
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
    const botId = url.pathname.match(/^\/v1\/bots\/([^/]+)/)?.[1] ?? ''
    const bot = bots.find((item) => item.id === botId)
    const environmentId = decodeURIComponent(
      url.pathname.match(/^\/v1\/(?:archived-)?environments\/([^/]+)/)?.[1] ?? ''
    )
    const environment = environments.find((item) => item.id === environmentId)
    const notFound = () => send(404, { code: 'NOT_FOUND', message: 'Not found' })
    let value: unknown
    switch (key) {
      case 'meta':
        value = {
          protocol: 1,
          features: ['provisioning', 'environments'],
          gatewayVersion: '0.9.3',
          botImage: 'test-image',
          botImageVersion: '0.9.3',
        }
        break
      case 'pair':
        value = { deviceId: 'device-env-e2e', token: 'fixture-token' }
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
      case 'activity':
        value = { entries: [], lastSeq: 0 }
        break
      case 'botGet':
        if (!bot) return notFound()
        value = bot
        break
      case 'botTranscript':
        value = { items: [], before: null }
        break
      case 'botSelections':
        value = { options: [], current: null }
        break
      case 'botRoutinesList':
        value = { routines: [] }
        break
      case 'botMemoriesList':
        value = { memories: [] }
        break
      case 'botConversationCall':
        value = { result: conversationResult(fleetConversationCallRequestSchema.parse(body).op) }
        break
      case 'environmentAccountsList':
        value = accountsOf(environmentId)
        break
      case 'environmentSkillsList':
        value = { skills: [] }
        break
      case 'environmentMcpServersList':
        value = { servers: [] }
        break
      case 'environmentApiKeyAccountAdd': {
        const input = body as { name: string; kind: 'openai'; baseURL: string | null; key: string }
        accountsOf(environmentId).apiKeys.push({
          providerId: 'prov_env',
          name: input.name,
          kind: input.kind,
          baseURL: input.baseURL,
          keyHint: input.key.slice(-4),
        })
        value = { providerId: 'prov_env' }
        break
      }
      case 'environmentUiOpen':
        if (!environment) return notFound()
        break
      case 'environmentPatch': {
        if (!environment) return notFound()
        const updated = fleetEnvironmentSchema.parse({ ...environment, ...(body as object), updatedAt: now() })
        upsertEnvironment(updated)
        value = updated
        break
      }
      case 'environmentRestart': {
        if (!environment) return notFound()
        const restarted = fleetEnvironmentSchema.parse({ ...environment, lifecycle: 'running', updatedAt: now() })
        upsertEnvironment(restarted)
        value = restarted
        break
      }
      case 'environmentArchive': {
        if (!environment) return notFound()
        const members = bots.filter((item) => item.environmentId === environment.id)
        const record = fleetEnvironmentSchema.parse({ ...environment, lifecycle: 'archived' })
        environments.splice(environments.indexOf(environment), 1)
        for (const member of members) bots.splice(bots.indexOf(member), 1)
        archivedEnvironments.set(environment.id, {
          summary: fleetArchivedEnvironmentSchema.parse({
            id: environment.id,
            name: environment.name,
            createdAt: environment.createdAt,
            archivedAt: now(),
            files: 'kept',
            bots: members.map((member) => ({ id: member.id, name: member.name, role: member.role, tint: member.tint })),
          }),
          environment,
          bots: members,
        })
        // Same order as the gateway: the archived environment, its removal, then the reply.
        emit({ type: 'environment.updated', at: now(), environment: record })
        emit({ type: 'environment.removed', at: now(), environmentId: environment.id })
        value = record
        break
      }
      case 'archivedEnvironmentsList':
        value = { environments: [...archivedEnvironments.values()].map((item) => item.summary) }
        break
      case 'archivedEnvironmentRestore': {
        const archived = archivedEnvironments.get(environmentId)
        if (!archived) return notFound()
        archivedEnvironments.delete(environmentId)
        const restored = fleetEnvironmentSchema.parse({
          ...archived.environment,
          lifecycle: 'running',
          updatedAt: now(),
        })
        bots.push(...archived.bots)
        upsertEnvironment(restored)
        for (const member of archived.bots) emit({ type: 'bot.updated', at: now(), bot: member })
        value = restored
        break
      }
      case 'archivedEnvironmentDelete':
        if (!archivedEnvironments.delete(environmentId)) return notFound()
        break
      case 'archivedBotsList':
        value = { bots: [...archivedBots.values()].map((item) => item.summary) }
        break
      case 'botArchive': {
        if (!bot) return notFound()
        const record = fleetBotSchema.parse({ ...bot, lifecycle: 'archived', status: 'offline' })
        bots.splice(bots.indexOf(bot), 1)
        archivedBots.set(bot.id, {
          summary: fleetArchivedBotSchema.parse({
            id: bot.id,
            name: bot.name,
            role: bot.role,
            tint: bot.tint,
            createdAt: bot.createdAt,
            archivedAt: now(),
            files: 'kept',
            environmentId: bot.environmentId,
          }),
          record,
        })
        const owner = environments.find((item) => item.id === bot.environmentId)
        if (owner)
          upsertEnvironment(
            fleetEnvironmentSchema.parse({ ...owner, botIds: owner.botIds.filter((id) => id !== bot.id) })
          )
        emit({ type: 'bot.updated', at: now(), bot: record })
        emit({ type: 'bot.removed', at: now(), botId: bot.id })
        value = record
        break
      }
      case 'botsCreate': {
        const input = body as {
          name: string
          instructions: string
          ceiling: string
          talksTo: string[]
          environmentId?: string
          environment?: { name: string }
        }
        const id = slug(input.name)
        const joined = input.environmentId ? environments.find((item) => item.id === input.environmentId) : undefined
        if (input.environmentId && !joined) return notFound()
        const target = joined
          ? fleetEnvironmentSchema.parse({ ...joined, botIds: [...joined.botIds, id] })
          : makeEnvironment(slug(input.environment?.name ?? input.name), input.environment?.name ?? input.name, [id], {
              lifecycle: 'creating',
              setup: { step: 'container', error: null, errorMessage: null },
            })
        upsertEnvironment(target)
        const created = makeBot(id, input.name, target.id, {
          instructions: input.instructions,
          ceiling: input.ceiling,
          talksTo: input.talksTo,
          status: 'starting',
          lifecycle: joined ? 'running' : 'creating',
          setup: { step: joined ? 'profile' : 'container', error: null, errorMessage: null },
        })
        bots.push(created)
        value = created
        setTimeout(() => {
          if (!joined)
            upsertEnvironment(
              fleetEnvironmentSchema.parse({
                ...environments.find((item) => item.id === target.id),
                lifecycle: 'running',
                setup: { step: 'ready', error: null, errorMessage: null },
              })
            )
          const ready = fleetBotSchema.parse({
            ...created,
            status: 'idle',
            lifecycle: 'running',
            setup: { step: 'ready', error: null, errorMessage: null },
          })
          bots[bots.findIndex((item) => item.id === id)] = ready
          emit({ type: 'bot.updated', at: now(), bot: ready })
        }, 1500)
        break
      }
      case 'botScreenTicket':
        if (!bot) return notFound()
        value = ticket()
        break
      case 'environmentScreenTicket':
        if (!environment) return notFound()
        if ((body as { mode: string }).mode === 'control' && screenConflicts-- > 0) {
          send(409, { code: 'CONFLICT', message: 'Another control session holds the environment display' })
          return
        }
        value = ticket()
        break
      case 'screen':
        send(404, { code: 'NOT_FOUND', message: 'No websocket in fixture' })
        return
      case 'ownerMemoryList':
        value = ownerMemory
        break
      case 'ownerMemoryCreate': {
        const input = body as { content: string; environmentId: string | null }
        const created = fleetOwnerMemoryEntrySchema.parse({
          id: randomUUID(),
          content: input.content,
          status: 'active',
          author: { kind: 'owner' },
          origin: null,
          replacesId: null,
          replacedById: null,
          environmentId: input.environmentId,
          createdAt: now(),
          updatedAt: now(),
        })
        ownerMemory.entries.push(created)
        value = created
        break
      }
      case 'ownerMemoryPatch': {
        const index = ownerMemory.entries.findIndex((item) => item.id === url.pathname.split('/').at(-1))
        if (index < 0) return notFound()
        ownerMemory.entries[index] = fleetOwnerMemoryEntrySchema.parse({
          ...ownerMemory.entries[index],
          ...(body as object),
          updatedAt: now(),
        })
        value = ownerMemory.entries[index]
        break
      }
      default:
        return notFound()
    }
    try {
      if (route.response) value = route.response.parse(value)
      if (!route.response) {
        response.writeHead(204)
        response.end()
      } else send(200, value)
    } catch (error) {
      send(500, { code: 'INTERNAL', message: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const url = `http://127.0.0.1:${address.port}`
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_E2E_SKILLS_HOME: root,
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'fleet-env-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'pt-BR',
        ELECTRON_RENDERER_URL: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Servidor de bots' }).first().click()
    await page.getByLabel('Endereço do servidor').fill(url)
    await page.getByLabel('Código de pareamento').fill('ABCD-EFGH')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Conectado' })).toContainText(
      'fleet-env-host'
    )
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()

    // Bots are grouped under their environment; each header names it, its state and its bots.
    await page.getByRole('tab', { name: 'Bots' }).click()
    const group = (name: string) => page.getByRole('group', { name, exact: true })
    const header = (name: string) => group(name).getByRole('button', { name: new RegExp(`^Ambiente ${name} · `) })
    await expect(group('Acme').getByRole('button', { name: 'Ambiente Acme · rodando · 1 bot' })).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /Scout/ })).toBeVisible()
    await expect(group('Home').getByRole('button', { name: /Diary/ })).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /Diary/ })).toHaveCount(0)

    // A new environment is named after the bot until the owner names it; its bot can bring accounts from the Mac.
    await page.getByRole('button', { name: 'Criar bot' }).first().click()
    const createDialog = page.getByRole('dialog', { name: 'Criar bot' })
    const where = createDialog.getByRole('radiogroup', { name: 'Onde ele roda' })
    await expect(where.getByRole('radio', { name: /Novo ambiente/ })).toHaveAttribute('aria-checked', 'true')
    await expect(where.getByRole('radio', { name: /Novo ambiente/ }).locator('svg')).toHaveCount(1)
    await expect(createDialog.getByRole('button', { name: 'Trazer do seu Mac', exact: true })).toBeVisible()
    const botName = createDialog.getByLabel('Nome', { exact: true })
    const environmentName = createDialog.getByLabel('Nome do ambiente')
    await botName.fill('Orders')
    await expect(environmentName).toHaveValue('Orders')
    await environmentName.fill('Company X')
    await botName.fill('Orders bot')
    await expect(environmentName).toHaveValue('Company X')
    await createDialog.getByRole('button', { name: 'Criar bot' }).click()
    await expect(createDialog.getByText('Criando contêiner')).toBeVisible()
    await expect
      .poll(() => requests.find((item) => item.key === 'botsCreate')?.body)
      .toMatchObject({ name: 'Orders bot', environment: { name: 'Company X' } })
    expect(requests.find((item) => item.key === 'botsCreate')?.body).not.toHaveProperty('environmentId')
    await expect(page.getByRole('heading', { name: 'Orders bot', exact: true })).toBeVisible()
    await expect(group('Company X').getByRole('button', { name: /Orders bot/ })).toBeVisible()

    // A sibling joins Acme from its environment view: no container, no Mac import, the environment id in the request.
    await header('Acme').click()
    await expect(page.getByRole('heading', { name: 'Acme', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Novo bot neste ambiente' }).click()
    await expect(where.getByRole('radio', { name: /Ambiente existente/ })).toHaveAttribute('aria-checked', 'true')
    await expect(
      createDialog.getByText('Usa as contas, skills, servidores MCP e logins de sites de Acme.')
    ).toBeVisible()
    await expect(
      createDialog.getByText('Bots no mesmo ambiente podem ver os arquivos e as telas uns dos outros.')
    ).toBeVisible()
    await expect(createDialog.getByRole('button', { name: 'Trazer do seu Mac', exact: true })).toHaveCount(0)
    await botName.fill('Partner')
    const provisioningBefore = requests.filter((item) => /Import|LoginStart|SkillInstall/.test(item.key)).length
    await createDialog.getByRole('button', { name: 'Criar bot' }).click()
    await expect(createDialog.getByText('Configurando perfil')).toBeVisible()
    await expect(createDialog.getByText('Criando contêiner')).toHaveCount(0)
    await expect
      .poll(() => requests.filter((item) => item.key === 'botsCreate').at(-1)?.body)
      .toMatchObject({ name: 'Partner', environmentId: 'acme' })
    expect(requests.filter((item) => item.key === 'botsCreate').at(-1)?.body).not.toHaveProperty('environment')
    await expect(page.getByRole('heading', { name: 'Partner', exact: true })).toBeVisible()
    expect(requests.filter((item) => /Import|LoginStart|SkillInstall/.test(item.key))).toHaveLength(provisioningBefore)
    await expect(group('Acme').getByRole('button', { name: 'Ambiente Acme · rodando · 2 bots' })).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /Partner/ })).toBeVisible()

    // Searching an environment's name shows all its bots; searching a bot keeps only it under its environment.
    const search = page.getByRole('textbox', { name: 'Filtrar bots…' })
    await search.fill('partner')
    await expect(group('Acme').getByRole('button', { name: /Partner/ })).toBeVisible()
    await expect(group('Acme').getByRole('button', { name: /Scout/ })).toHaveCount(0)
    await expect(group('Home')).toHaveCount(0)
    await search.fill('home')
    await expect(group('Home').getByRole('button', { name: /Diary/ })).toBeVisible()
    await expect(group('Acme')).toHaveCount(0)
    await search.fill('')

    // Restarting an environment names every bot it restarts.
    await header('Acme').click()
    await page.getByRole('button', { name: 'Reiniciar ambiente' }).click()
    const restartDialog = page.getByRole('dialog', { name: 'Reiniciar Acme?' })
    await expect(restartDialog).toContainText('Todos os bots deste ambiente reiniciam: Partner e Scout.')
    await restartDialog.getByRole('button', { name: 'Reiniciar', exact: true }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'environmentRestart').map((item) => item.path))
      .toEqual(['/v1/environments/acme/restart'])
    await expect(restartDialog).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Limite de memória' }).click()
    await page.getByRole('option', { name: '8 GB', exact: true }).click()
    await expect
      .poll(() => requests.find((item) => item.key === 'environmentPatch')?.body)
      .toEqual({ memoryLimitBytes: 8 * GB })
    await expect(page.getByRole('combobox', { name: 'Limite de memória' })).toContainText('8 GB')

    // Accounts are added to the environment; its key never comes back to the renderer.
    const environmentKey = 'fleet-env-e2e-secret-key-456'
    const environmentAccounts = page.getByRole('region', { name: 'Contas do ambiente', exact: true })
    await expect(environmentAccounts.getByText('Nenhuma conta neste ambiente ainda.')).toBeVisible()
    await page.getByLabel('Nome da conta').fill('Shared model')
    await page.getByLabel('Chave de API').fill(environmentKey)
    await page.getByRole('button', { name: 'Adicionar conta' }).click()
    await expect
      .poll(() => requests.find((item) => item.key === 'environmentApiKeyAccountAdd')?.path)
      .toBe('/v1/environments/acme/accounts/api-key')
    await expect(environmentAccounts.getByText(/Shared model.*…-456/)).toBeVisible()
    expect(
      JSON.stringify(await page.evaluate(() => window.api.fleetBotAccounts({ environmentId: 'acme' })))
    ).not.toContain(environmentKey)
    expect(await page.content()).not.toContain(environmentKey)
    expect(requests.filter((item) => item.key === 'botApiKeyAccountAdd')).toHaveLength(0)

    // The composer manages skills on the environment screen, without taking over the bot.
    await group('Acme').getByRole('button', { name: /Scout/ }).click()
    await expect(page.getByRole('heading', { name: 'Scout', exact: true })).toBeVisible()
    await page.getByTitle('Skills', { exact: true }).click()
    // The menu names both its settings icon and its link after the environment screen.
    await page.getByRole('button', { name: 'Gerenciar skills na tela do ambiente' }).last().click()
    await expect
      .poll(() => requests.find((item) => item.key === 'environmentUiOpen'))
      .toMatchObject({ path: '/v1/environments/acme/ui/open', body: { target: 'skills' } })
    await expect(page.getByRole('heading', { name: 'Acme', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Tela', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() => requests.filter((item) => item.key === 'environmentScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'view' })
    // Its screen needs no takeover; a second control session on the shared display is refused and explained.
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Outra tela deste ambiente está sendo controlada.' })
    ).toBeVisible()
    expect(requests.filter((item) => item.key === 'environmentScreenTicket').map((item) => item.body)).toContainEqual({
      mode: 'control',
    })
    await expect
      .poll(() => requests.filter((item) => item.key === 'environmentScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'view' })
    await page.getByRole('button', { name: 'Assumir controle' }).click()
    await expect(page.getByRole('button', { name: 'Parar de controlar' })).toBeVisible()
    await expect
      .poll(() => requests.filter((item) => item.key === 'environmentScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'control' })
    expect(requests.filter((item) => ['botTakeover', 'botUiOpen'].includes(item.key))).toHaveLength(0)

    // A bot's screen switches between its browser area and its apps screen.
    await group('Acme').getByRole('button', { name: /Scout/ }).click()
    await page.getByRole('tab', { name: 'Tela', exact: true }).click()
    const surfaces = page.getByRole('radiogroup', { name: 'Área da tela' })
    await expect(surfaces.getByRole('radio', { name: 'Navegador' })).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => requests.filter((item) => item.key === 'botScreenTicket').at(-1))
      .toMatchObject({ path: '/v1/bots/scout/screen-tickets', body: { mode: 'view', surface: 'browser' } })
    await surfaces.getByRole('radio', { name: 'Apps' }).click()
    await expect(surfaces.getByRole('radio', { name: 'Apps' })).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => requests.filter((item) => item.key === 'botScreenTicket').at(-1)?.body)
      .toEqual({ mode: 'view', surface: 'apps' })

    // Archiving a bot of a shared environment archives only it.
    await group('Acme')
      .getByRole('button', { name: /Partner/ })
      .click()
    await page.getByRole('tab', { name: 'Ajustes' }).click()
    await expect(
      page.getByRole('region', { name: 'Ambiente', exact: true }).getByRole('button', { name: 'Ambiente: Acme' })
    ).toBeVisible()
    await expect(page.getByRole('region', { name: 'Contas do bot', exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Skills e MCP', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Arquivar Partner' }).click()
    const archiveBot = page.getByRole('dialog', { name: 'Arquivar bot?' })
    await expect(archiveBot).toContainText('Este bot sai do ambiente')
    await archiveBot.getByRole('button', { name: 'Arquivar' }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'botArchive').map((item) => item.path))
      .toEqual(['/v1/bots/partner/archive'])
    await expect(group('Acme').getByRole('button', { name: /Partner/ })).toHaveCount(0)
    await expect(group('Acme').getByRole('button', { name: /Scout/ })).toBeVisible()
    expect(requests.filter((item) => item.key === 'environmentArchive')).toHaveLength(0)
    const archivedBotsSection = page.getByRole('region', { name: 'Bots arquivados' })
    await expect(archivedBotsSection.getByRole('listitem').filter({ hasText: 'Partner' })).toBeVisible()
    // The server lists each environment once with its resources, and its bots under it without counting them again.
    await expect(page.getByRole('row').filter({ hasText: 'Acme' }).first()).toContainText('1.0 GB')
    await expect(page.getByRole('row').filter({ hasText: 'Scout' })).toContainText('—')

    // Archiving an environment archives its bots with it; restoring brings them back.
    await header('Home').click()
    await page.getByRole('button', { name: 'Arquivar Home' }).click()
    const archiveEnvironment = page.getByRole('dialog', { name: 'Arquivar ambiente?' })
    await expect(archiveEnvironment).toContainText('Diary')
    await archiveEnvironment.getByRole('button', { name: 'Arquivar' }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'environmentArchive').map((item) => item.path))
      .toEqual(['/v1/environments/home/archive'])
    await expect(group('Home')).toHaveCount(0)
    const archivedEnvironmentsSection = page.getByRole('region', { name: 'Ambientes arquivados' })
    const archivedHome = archivedEnvironmentsSection.getByRole('listitem').filter({ hasText: 'Home' })
    await expect(archivedHome).toContainText('Bots: Diary')
    await expect(archivedBotsSection.getByRole('listitem').filter({ hasText: 'Diary' })).toHaveCount(0)
    await archivedEnvironmentsSection.getByRole('button', { name: 'Restaurar Home' }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'archivedEnvironmentRestore').map((item) => item.path))
      .toEqual(['/v1/archived-environments/home/restore'])
    await expect(group('Home').getByRole('button', { name: /Diary/ })).toBeVisible()
    await expect(archivedHome).toHaveCount(0)
    await archivedEnvironmentsSection.getByRole('button', { name: 'Apagar Old lab de vez' }).click()
    const deleteDialog = page.getByRole('dialog', { name: 'Apagar Old lab de vez?' })
    const deleteForever = deleteDialog.getByRole('button', { name: 'Apagar de vez' })
    await expect(deleteForever).toBeDisabled()
    await deleteDialog.getByLabel('Digite Old lab para confirmar').fill('Old lab')
    await deleteForever.click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'archivedEnvironmentDelete').map((item) => item.path))
      .toEqual(['/v1/archived-environments/old-lab'])
    await expect(archivedEnvironmentsSection.getByText('Nenhum ambiente arquivado.')).toBeVisible()

    // Owner memory: an environment entry can become global, and a new entry can be scoped to one environment.
    await page.getByRole('button', { name: 'Memória sobre você', exact: true }).click()
    const acmeNote = page.getByRole('listitem').filter({ hasText: 'Acme invoices go to finance.' })
    await expect(acmeNote.getByText('Acme', { exact: true })).toBeVisible()
    await acmeNote.getByRole('button', { name: 'Tornar global' }).click()
    await expect
      .poll(() => requests.find((item) => item.key === 'ownerMemoryPatch')?.body)
      .toEqual({ environmentId: null })
    await expect(acmeNote.getByText('Todos os bots', { exact: true })).toBeVisible()
    await expect(acmeNote.getByRole('button', { name: 'Tornar global' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Quem vê' })).toContainText('Todos os bots')
    await page.getByRole('combobox', { name: 'Quem vê' }).click()
    await page.getByRole('option', { name: 'Acme', exact: true }).click()
    await page.getByRole('textbox', { name: 'Adicionar' }).fill('Prefers PDF invoices.')
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await expect
      .poll(() => requests.find((item) => item.key === 'ownerMemoryCreate')?.body)
      .toMatchObject({ content: 'Prefers PDF invoices.', environmentId: 'acme' })
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Prefers PDF invoices.' }).getByText('Acme', { exact: true })
    ).toBeVisible()
  } finally {
    await app?.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
