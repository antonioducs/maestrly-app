import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_PARALLEL_TURNS_FEATURE,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetPeerThreadSchema,
  fleetSendMessageRequestSchema,
  type FleetBot,
  type FleetPeerThread,
  type FleetPeerThreadPatchRequest,
  type FleetPeerThreadSettings,
  type FleetSendMessageRequest,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const MINUTE = 60_000

type Fixture = {
  page: Page
  emit: (event: unknown) => void
  bot: () => FleetBot
  setBot: (patch: Partial<FleetBot>) => void
  threads: Map<string, FleetPeerThread>
  threadMessages: Array<{ threadId: string; body: FleetSendMessageRequest }>
  patches: Array<{ threadId: string; body: FleetPeerThreadPatchRequest }>
  deletes: string[]
  settings: FleetPeerThreadSettings[]
  cancels: string[]
  screenshot: (name: string) => Promise<void>
}

/** A bot that talks with another one in conversations of their own, behind a gateway that keeps them. */
async function withThreads(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-peer-threads-'))
  const now = Date.now()
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString()
  const at = new Date(now).toISOString()
  let bot = fleetBotSchema.parse({
    id: 'atlas',
    name: 'Atlas',
    role: '',
    instructions: '',
    tint: '#5b7cfa',
    ceiling: 'auto',
    selection: null,
    talksTo: ['nina'],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: at },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.21.0',
    capabilities: [FLEET_PEER_CONVERSATIONS_FEATURE, FLEET_PARALLEL_TURNS_FEATURE],
    turns: [],
    createdAt: at,
    updatedAt: at,
  })
  const nina = fleetBotSchema.parse({ ...bot, id: 'nina', name: 'Nina', tint: '#13a394', talksTo: ['atlas'] })
  const record = (fields: Partial<FleetPeerThread> & Pick<FleetPeerThread, 'id' | 'title'>) =>
    fleetPeerThreadSchema.parse({
      botId: bot.id,
      peer: { botId: 'nina', name: 'Nina' },
      origin: 'peer',
      status: 'open',
      hops: 1,
      hopLimit: 8,
      messages: 2,
      pinned: false,
      conversation: 'own',
      report: null,
      reportAt: null,
      working: false,
      peerWorking: false,
      createdAt: ago(90),
      lastActivityAt: ago(60),
      expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
      conversationDeletedAt: null,
      kept: null,
      ...fields,
    })
  const threads = new Map<string, FleetPeerThread>(
    [
      record({
        id: 't-asked',
        title: 'Release 4.2',
        origin: 'primary',
        messages: 4,
        createdAt: ago(80),
        lastActivityAt: ago(70),
        report: 'Nina says 4.2 passed 412 of 415 tests; the 3 failures have a fix in PR #1184.',
        reportAt: ago(70),
      }),
      record({
        id: 't-paused',
        title: 'Flaky checkout test',
        status: 'paused',
        hops: 8,
        messages: 10,
        lastActivityAt: ago(20),
      }),
      record({
        id: 't-gone',
        title: 'GPU hours in September',
        conversation: 'deleted',
        conversationDeletedAt: ago(5 * 24 * 60),
        lastActivityAt: ago(6 * 24 * 60),
        expiresAt: null,
        kept: { folder: 'bots/nina/2026-09-23-1602', files: [{ name: 'gpu-hours.csv', kind: 'file', byteSize: 120 }] },
      }),
    ].map((item) => [item.id, item])
  )
  const transcripts = new Map<string, FleetTranscriptItem[]>([
    [
      't-asked',
      [
        {
          kind: 'peer_out',
          id: 'thread-open:t-asked',
          at: ago(80),
          to: { botId: 'nina', name: 'Nina' },
          text: 'Did release 4.2 pass its regression?',
          delivered: true,
          thread: { id: 't-asked' },
        },
        {
          kind: 'user',
          id: 'input:peer-1',
          at: ago(75),
          text: 'It passed 412 of 415 tests. The 3 failures have a fix in PR #1184.',
          source: 'peer',
          peer: { botId: 'nina', name: 'Nina' },
          queued: false,
          memories: [],
          images: [],
        },
      ],
    ],
    [
      't-paused',
      [
        {
          kind: 'user',
          id: 'input:peer-2',
          at: ago(25),
          text: 'Should I ask Orion for the CI runner, or will you?',
          source: 'peer',
          peer: { botId: 'nina', name: 'Nina' },
          queued: false,
          memories: [],
          images: [],
        },
      ],
    ],
  ])
  const primary: FleetTranscriptItem[] = [
    {
      kind: 'user',
      id: 'input:owner-1',
      at: ago(81),
      text: 'Ask Nina whether release 4.2 passed its regression.',
      source: 'owner',
      queued: false,
      memories: [],
      images: [],
    },
    {
      kind: 'peer_out',
      id: 'peer-out-1',
      at: ago(80),
      to: { botId: 'nina', name: 'Nina' },
      text: 'Did release 4.2 pass its regression?',
      delivered: true,
      thread: { id: 't-asked' },
    },
  ]
  const threadMessages: Fixture['threadMessages'] = []
  const patches: Fixture['patches'] = []
  const deletes: string[] = []
  const settings: FleetPeerThreadSettings[] = []
  const cancels: string[] = []
  const failures: string[] = []
  const streams = new Set<ServerResponse>()
  const emit = (event: unknown) => {
    const frame = `event: fleet\ndata: ${JSON.stringify(fleetGatewayEventSchema.parse(event))}\n\n`
    for (const stream of streams) stream.write(frame)
  }
  const setBot = (patch: Partial<FleetBot>) => {
    bot = fleetBotSchema.parse({ ...bot, ...patch, updatedAt: new Date().toISOString() })
    emit({ type: 'bot.updated', at: new Date().toISOString(), bot })
  }
  let app: ElectronApplication | undefined
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
        ([, route]) =>
          route.method === request.method &&
          new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
      )
      if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
      const [key, route] = entry
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-threads-token') {
        failures.push(`Missing authentication: ${key}`)
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      }
      let body: any
      if (route.body) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      const threadId = url.pathname.match(/\/peer-threads\/([^/]+)/)?.[1]
      let value: unknown
      switch (key) {
        case 'meta':
          value = {
            protocol: 1,
            gatewayVersion: '0.21.0',
            botImage: 'fixture',
            botImageVersion: null,
            features: [FLEET_PEER_CONVERSATIONS_FEATURE, FLEET_PARALLEL_TURNS_FEATURE],
          }
          break
        case 'pair':
          value = { deviceId: 'fixture-device', token: 'fixture-threads-token' }
          break
        case 'events':
          if (url.searchParams.get('peerThreads') !== '1') failures.push('The event stream did not ask for threads')
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          streams.add(response)
          response.write(': connected\n\n')
          request.on('close', () => streams.delete(response))
          return
        case 'host':
          value = {
            hostname: 'threads-fixture',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 0,
            memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, botsBytes: 0 },
            disk: { totalBytes: 80 * 1024 ** 3, usedBytes: 0 },
            uptimeSeconds: 60,
            gatewayVersion: '0.21.0',
            botImage: 'fixture',
            botImageVersion: null,
            dockerVersion: '28',
          }
          break
        case 'botsList':
          value = { bots: [bot, nina] }
          break
        case 'botGet':
          value = url.pathname.endsWith('/nina') ? nina : bot
          break
        case 'inbox':
          value = { items: [] }
          break
        case 'peerMessages':
          value = { messages: [] }
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
        case 'botTranscript':
          value = { items: url.pathname.includes('/atlas/') ? primary : [], before: null }
          break
        case 'botPeerThreads':
          value = { threads: [...threads.values()] }
          break
        case 'botPeerThreadTranscript':
          value = { items: transcripts.get(threadId!) ?? [], before: null }
          break
        case 'botPeerThreadPatch': {
          patches.push({ threadId: threadId!, body })
          const thread = threads.get(threadId!)!
          const updated = fleetPeerThreadSchema.parse({
            ...thread,
            ...(body.pinned !== undefined
              ? { pinned: body.pinned, expiresAt: body.pinned ? null : thread.expiresAt }
              : {}),
            ...(body.resume ? { status: 'open', hops: 0 } : {}),
          })
          threads.set(threadId!, updated)
          value = updated
          break
        }
        case 'botPeerThreadConversationDelete': {
          deletes.push(threadId!)
          const deleted = fleetPeerThreadSchema.parse({
            ...threads.get(threadId!),
            conversation: 'deleted',
            conversationDeletedAt: new Date().toISOString(),
            expiresAt: null,
            kept: { folder: 'bots/nina/2026-10-18-0951', files: [{ name: 'ci-logs.txt', kind: 'file', byteSize: 64 }] },
          })
          threads.set(threadId!, deleted)
          value = deleted
          break
        }
        case 'botPeerThreadMessageSend':
          threadMessages.push({ threadId: threadId!, body: fleetSendMessageRequestSchema.parse(body) })
          value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
          break
        case 'botPeerThreadSettings':
          settings.push(body)
          setBot({ peerSettings: body })
          value = body
          break
        case 'botCancel':
          cancels.push(url.search)
          response.writeHead(204)
          response.end()
          return
        case 'botConversationCall': {
          const results: Record<string, unknown> = {
            chatConfig: { mcpServers: [], appToolsEnabled: true, imageGenEnabled: true },
            chatGetConvTools: { app: true, imageGen: true, mcpDisabled: [] },
            chatSubagentProfilesGetConversation: {
              rules: null,
              diagnostics: [],
              enabled: true,
              subagentsEnabled: true,
            },
            chatSkillsState: {
              skills: [],
              groups: [],
              selection: { kind: 'all' },
              selectedGroupMissing: false,
              hasOverrides: false,
            },
            chatCommands: { prompts: [], project: [], skills: [] },
          }
          value = { result: results[body.op] ?? { ok: true } }
          break
        }
        default:
          return send(404, { code: 'NOT_FOUND', message: `Unused fixture route: ${key}` })
      }
      send(200, route.response ? route.response.parse(value) : value)
    } catch (error) {
      failures.push(String(error))
      send(500, { code: 'INTERNAL', message: 'Invalid fixture response' })
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'peer-threads',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing gateway address')
    await page.evaluate(
      (url) => window.api.fleetConnect({ url, code: 'ABCD-EFGH' }),
      `http://127.0.0.1:${address.port}`
    )
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page.getByRole('button', { name: /Atlas/ }).first().click()
    await expect(page.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible()
    await run({
      page,
      emit,
      bot: () => bot,
      setBot,
      threads,
      threadMessages,
      patches,
      deletes,
      settings,
      cancels,
      screenshot: async (name) => {
        const dir = process.env.MAESTRLY_E2E_SCREENSHOTS
        if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled' })
      },
    })
    expect(failures).toEqual([])
  } finally {
    await app?.close().catch(() => {})
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    await removeTempDirEventually(root)
  }
}

test('conversations with other bots: the bridge, a thread, a paused one, writing, keeping, deleting and settings', async () => {
  await withThreads(async ({ page, emit, bot, threads, threadMessages, patches, deletes, settings, screenshot }) => {
    // The message that opened a conversation with Nina shows as a bridge to it, with the answer it brought back.
    const bridge = page.getByRole('group', { name: 'Conversation with Nina' })
    await expect(bridge).toBeVisible()
    await expect(bridge.getByText(/Nina says 4\.2 passed 412 of 415 tests/)).toBeVisible()
    await expect(bridge.getByText('Answered')).toBeVisible()
    // The paused thread waits for the owner: the Bots tab says so.
    await expect(
      page.getByRole('tab', { name: 'Conversations with other bots · 1 with news or waiting for you' })
    ).toBeVisible()
    await screenshot('01-bridge')

    // The bridge opens the thread's own conversation, with what the bots said and what it brought back.
    await bridge.getByRole('button', { name: 'Open conversation' }).click()
    await expect(page.getByText('It passed 412 of 415 tests. The 3 failures have a fix in PR #1184.')).toBeVisible()
    await expect(page.getByText('Brought back to your conversation')).toBeVisible()
    await expect(page.getByText('Asked by you', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Waiting for you', { exact: true }).first()).toBeVisible()
    await screenshot('02-thread')

    // The paused thread: the owner lets the bots go on.
    await page.getByRole('button', { name: /Flaky checkout test/ }).click()
    await expect(page.getByText('Should I ask Orion for the CI runner, or will you?')).toBeVisible()
    await expect(page.getByText('Paused after 8 messages without you')).toBeVisible()
    await expect(page.getByText('8 of 8 messages without you')).toBeVisible()
    await screenshot('03-paused')
    await page.getByRole('button', { name: 'Let them go on for 8 more' }).click()
    await expect.poll(() => patches).toEqual([{ threadId: 't-paused', body: { resume: true } }])
    await expect(page.getByText('Paused after 8 messages without you')).toHaveCount(0)
    await expect(page.getByText('0 of 8 messages without you')).toBeVisible()

    // The owner writes in it, to steer the bots.
    await page.locator('[data-placeholder="Write to Atlas in this conversation"]').fill('You ask Orion, Atlas.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(() => threadMessages.map((item) => [item.threadId, item.body.text]))
      .toEqual([['t-paused', 'You ask Orion, Atlas.']])

    // A thread's new message comes in live.
    emit({
      type: 'peer_thread.transcript.upsert',
      at: new Date().toISOString(),
      botId: bot().id,
      threadId: 't-paused',
      item: {
        kind: 'assistant',
        id: 'm:live',
        at: new Date().toISOString(),
        text: 'Asking Orion for the CI runner now.',
        streaming: false,
      },
    })
    await expect(page.getByText('Asking Orion for the CI runner now.')).toBeVisible()

    // Keeping it, then deleting its conversation: its files stay.
    await page.getByRole('button', { name: /^Keep$|Never delete this conversation/ }).click()
    await expect.poll(() => patches.at(-1)).toEqual({ threadId: 't-paused', body: { pinned: true } })
    await expect(page.getByText('Kept: never deleted on its own')).toBeVisible()
    await page.getByRole('button', { name: 'Delete conversation', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Delete this conversation?' })
    await expect(dialog.getByText('The files Atlas made stay in its folder')).toBeVisible()
    await screenshot('04-delete')
    await dialog.getByRole('button', { name: 'Delete conversation' }).click()
    await expect.poll(() => deletes).toEqual(['t-paused'])
    await expect(page.getByText(/This conversation was deleted on/)).toBeVisible()
    await expect(page.getByText('ci-logs.txt')).toBeVisible()
    expect(threads.get('t-paused')?.conversation).toBe('deleted')

    // A deleted thread from before shows only what was kept.
    await page.getByRole('button', { name: /GPU hours in September/ }).click()
    await expect(page.getByText('gpu-hours.csv')).toBeVisible()

    // The bot's settings for its threads save as each one changes.
    await page.getByTitle('Settings of the conversations with other bots').click()
    const settingsDialog = page.getByRole('dialog', { name: 'Conversations with other bots' })
    await settingsDialog.getByRole('radio', { name: '60 days' }).click()
    await expect.poll(() => settings.map((item) => item.retentionDays)).toEqual([60])
    await settingsDialog.getByRole('radio', { name: '4 messages' }).click()
    await expect.poll(() => settings.map((item) => item.hopLimit)).toEqual([8, 4])
    await expect(settingsDialog.getByRole('status')).toHaveText('Saved')
    await screenshot('05-settings')
    await settingsDialog.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(page.getByTitle('Settings of the conversations with other bots')).toHaveText('60 days')
  })
})

test('conversations with other bots: a thread works beside the bot conversation and stops on its own', async () => {
  await withThreads(async ({ page, setBot, cancels }) => {
    const startedAt = new Date().toISOString()
    setBot({
      status: 'working',
      turns: [{ kind: 'peer', id: 't-asked', title: 'Release 4.2', startedAt, tool: null, cancelling: false }],
    })
    // The header names the thread at work and opens it.
    const chip = page.getByTitle('In a conversation with another bot: Release 4.2')
    await expect(chip).toBeVisible()
    await chip.click()
    await expect(page.getByText('It passed 412 of 415 tests. The 3 failures have a fix in PR #1184.')).toBeVisible()
    // Stopping there stops the thread's turn only.
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => cancels).toEqual(['?conversation=t-asked'])
  })
})
