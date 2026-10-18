import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetRoutineRunSchema,
  fleetSendMessageRequestSchema,
  type FleetBot,
  type FleetRoutineRun,
  type FleetRoutineRunSettings,
  type FleetSendMessageRequest,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64'
)
const MINUTE = 60_000

type Fixture = {
  page: Page
  emit: (event: unknown) => void
  bot: () => FleetBot
  setBot: (patch: Partial<FleetBot>) => void
  runs: Map<string, FleetRoutineRun>
  sent: FleetSendMessageRequest[]
  runMessages: Array<{ runId: string; body: FleetSendMessageRequest }>
  deletes: string[]
  settings: FleetRoutineRunSettings[]
  imageReads: string[]
  screenshot: (name: string) => Promise<void>
}

/** A bot whose routine runs work in conversations of their own, behind a gateway that keeps them. */
async function withRuns(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-routine-runs-'))
  const now = Date.now()
  const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
  // Today's runs stay today and in the past, whatever the time the test runs.
  const today = (minutesAgo: number) => new Date(Math.max(startOfToday + 1000, now - minutesAgo * MINUTE)).toISOString()
  const yesterday = (hoursBefore: number) => new Date(startOfToday - hoursBefore * 3_600_000).toISOString()
  const at = new Date(now).toISOString()
  let bot = fleetBotSchema.parse({
    id: 'run-bot',
    name: 'Run Bot',
    role: '',
    instructions: '',
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
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: at },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.21.0',
    capabilities: [FLEET_ROUTINE_CONVERSATIONS_FEATURE],
    createdAt: at,
    updatedAt: at,
  })
  const record = (fields: Partial<FleetRoutineRun> & Pick<FleetRoutineRun, 'id' | 'deliveredAt'>) =>
    fleetRoutineRunSchema.parse({
      routineId: 'routine-inbox',
      routineTitle: 'Inbox triage',
      botId: bot.id,
      trigger: 'schedule',
      status: 'completed',
      finishedAt: new Date(Date.parse(fields.deliveredAt) + 90_000).toISOString(),
      report: null,
      finalText: null,
      conversation: 'own',
      ...fields,
    })
  const runs = new Map<string, FleetRoutineRun>(
    [
      record({
        id: 'r-new',
        deliveredAt: today(40),
        report: { summary: 'Filed 3 invoices', pending: 'Reply to Ana', notes: 'Ana prefers mornings' },
        media: { images: 1, videos: 0, files: 0 },
        expiresAt: new Date(now + 5 * 86_400_000).toISOString(),
      }),
      record({
        id: 'r-quiet-2',
        routineId: 'routine-prices',
        routineTitle: 'Price watch',
        deliveredAt: today(50),
        quiet: true,
        report: { summary: 'No price changes', pending: null, notes: null },
      }),
      record({
        id: 'r-quiet-1',
        routineId: 'routine-prices',
        routineTitle: 'Price watch',
        deliveredAt: today(80),
        quiet: true,
        report: { summary: 'No price changes', pending: null, notes: null },
      }),
      record({
        id: 'r-failed',
        routineId: 'routine-backup',
        routineTitle: 'Backup check',
        deliveredAt: yesterday(3),
        status: 'failed',
        finalText: 'The backup server did not answer.',
      }),
      record({
        id: 'r-deleted',
        deliveredAt: yesterday(4),
        conversation: 'deleted',
        conversationDeletedAt: yesterday(2),
        report: { summary: 'Archived 12 newsletters', pending: null, notes: null },
        kept: {
          folder: 'routines/inbox-triage',
          files: [{ name: 'summary.png', kind: 'image', byteSize: png.length }],
        },
      }),
    ].map((item) => [item.id, item])
  )
  const transcripts = new Map<string, FleetTranscriptItem[]>([
    [
      'r-new',
      [
        {
          kind: 'user',
          id: 'r-new:prompt',
          at: runs.get('r-new')!.deliveredAt,
          text: 'Triage the inbox and file invoices.',
          source: 'routine',
          routine: { id: 'routine-inbox', title: 'Inbox triage' },
          queued: false,
          memories: [],
          images: [],
        },
        {
          kind: 'tool',
          id: 'r-new:shot',
          at: runs.get('r-new')!.deliveredAt,
          name: 'bot_share_file',
          state: 'done',
          target: 'Invoices',
          output: null,
          images: [{ id: 'shot-invoices', mediaType: 'image/png', byteSize: png.length, name: 'Invoices' }],
        },
        {
          kind: 'assistant',
          id: 'r-new:answer',
          at: runs.get('r-new')!.finishedAt!,
          text: 'Filed three invoices in Finance.',
          streaming: false,
        },
      ],
    ],
    [
      'r-live',
      [
        {
          kind: 'assistant',
          id: 'r-live:answer',
          at,
          text: 'Triaged four new emails; one needs you.',
          streaming: false,
        },
      ],
    ],
  ])
  const primary: FleetTranscriptItem[] = [
    {
      kind: 'user',
      id: 'input:owner-1',
      at: new Date(now - 6 * 60 * MINUTE).toISOString(),
      text: 'Keep an eye on my inbox, please.',
      source: 'owner',
      queued: false,
      memories: [],
      images: [],
    },
    {
      kind: 'assistant',
      id: 'answer-1',
      at: new Date(now - 6 * 60 * MINUTE + 1000).toISOString(),
      text: 'I will triage it every morning.',
      streaming: false,
    },
  ]
  const sent: FleetSendMessageRequest[] = []
  const runMessages: Array<{ runId: string; body: FleetSendMessageRequest }> = []
  const deletes: string[] = []
  const settings: FleetRoutineRunSettings[] = []
  const imageReads: string[] = []
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
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-runs-token') {
        failures.push(`Missing authentication: ${key}`)
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      }
      let body: any
      if (route.body) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      const runId = url.pathname.match(/\/routine-runs\/([^/]+)/)?.[1]
      let value: unknown
      switch (key) {
        case 'meta':
          value = {
            protocol: 1,
            gatewayVersion: '0.21.0',
            botImage: 'fixture',
            botImageVersion: null,
            features: [FLEET_ROUTINE_CONVERSATIONS_FEATURE],
          }
          break
        case 'pair':
          value = { deviceId: 'fixture-device', token: 'fixture-runs-token' }
          break
        case 'events':
          if (url.searchParams.get('routineRuns') !== '1') failures.push('The event stream did not ask for runs')
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          streams.add(response)
          response.write(': connected\n\n')
          request.on('close', () => streams.delete(response))
          return
        case 'host':
          value = {
            hostname: 'runs-fixture',
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
          value = { bots: [bot] }
          break
        case 'botGet':
          value = bot
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
          value = { items: primary, before: null }
          break
        case 'botRuns':
          value = {
            runs: [...runs.values()].sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1)),
            before: null,
          }
          break
        case 'botRunTranscript':
          value = { items: transcripts.get(runId!) ?? [], before: null }
          break
        case 'botRunConversationDelete': {
          deletes.push(runId!)
          const deleted = fleetRoutineRunSchema.parse({
            ...runs.get(runId!),
            conversation: 'deleted',
            conversationDeletedAt: new Date().toISOString(),
            expiresAt: null,
            kept: { folder: 'routines/inbox-triage', files: [{ name: 'invoices.png', kind: 'image', byteSize: 68 }] },
          })
          runs.set(runId!, deleted)
          value = deleted
          break
        }
        case 'botRunMessageSend':
          runMessages.push({ runId: runId!, body: fleetSendMessageRequestSchema.parse(body) })
          value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
          break
        case 'botRunSettings':
          settings.push(body)
          setBot({ runSettings: body })
          value = body
          break
        case 'botMessageSend':
          sent.push(fleetSendMessageRequestSchema.parse(body))
          value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
          break
        case 'botImage':
          imageReads.push(url.pathname.split('/').pop() + url.search)
          response.writeHead(200, {
            'Content-Type': 'image/png',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': String(png.length),
          })
          response.end(png)
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
        AGENTS_INSTANCE: 'routine-runs',
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
    await page
      .getByRole('button', { name: /Run Bot/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Run Bot', exact: true })).toBeVisible()
    await run({
      page,
      emit,
      bot: () => bot,
      setBot,
      runs,
      sent,
      runMessages,
      deletes,
      settings,
      imageReads,
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

test('routine runs: history, a run in progress, its conversation, a citation, deletion with undo and settings', async () => {
  await withRuns(
    async ({ page, emit, bot, setBot, runs, sent, runMessages, deletes, settings, imageReads, screenshot }) => {
      // The bot's conversation shows the runs that ended with something to tell, as notices the bot never reads.
      const notes = page.getByRole('note')
      await expect(
        notes.filter({ hasText: 'Inbox triage finished' }).filter({ hasText: 'Filed 3 invoices' })
      ).toBeVisible()
      // A run whose conversation was deleted still tells how it ended.
      await expect(
        notes.filter({ hasText: 'Inbox triage finished' }).filter({ hasText: 'Conversation deleted.' })
      ).toBeVisible()
      await expect(notes.filter({ hasText: 'Backup check failed' })).toBeVisible()
      await expect(notes.filter({ hasText: 'Price watch' })).toHaveCount(0)
      await expect(notes.first().getByText('not in the conversation')).toBeVisible()
      await screenshot('01-conversation-markers')

      // A run starts: the header and the composer say so, and the run ends with a notice and a new run.
      const startedAt = new Date().toISOString()
      const live = fleetRoutineRunSchema.parse({
        ...runs.get('r-new'),
        id: 'r-live',
        deliveredAt: startedAt,
        finishedAt: null,
        status: 'delivered',
        report: null,
        media: null,
        expiresAt: null,
      })
      runs.set(live.id, live)
      emit({ type: 'routine_run.updated', at: startedAt, botId: bot().id, run: live })
      setBot({
        status: 'working',
        runningRun: { id: 'r-live', routineId: 'routine-inbox', title: 'Inbox triage', startedAt },
      })
      await expect(page.getByText('Run Bot is running Inbox triage. Your message goes in when it ends.')).toBeVisible()
      await expect(page.getByTitle('Running Inbox triage')).toBeVisible()
      // The run works in its own conversation: this one is not working, and nothing here stops the run.
      await expect(page.getByText('Working…')).toHaveCount(0)
      await expect(page.locator('[data-placeholder="Message Run Bot…"]')).toBeVisible()
      await screenshot('02-run-in-progress')
      const done = fleetRoutineRunSchema.parse({
        ...live,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        report: { summary: 'Triaged 4 new emails', pending: 'One needs you', notes: null },
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      })
      runs.set(done.id, done)
      setBot({ status: 'idle', runningRun: null })
      emit({ type: 'routine_run.updated', at: done.finishedAt, botId: bot().id, run: done })
      const notice = page.getByRole('status').filter({ hasText: 'Inbox triage finished' })
      await expect(notice).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Runs · 1 new run' })).toBeVisible()
      await screenshot('03-run-finished-notice')

      // Opening it from the notice shows its own conversation; it is no longer new.
      await notice.getByRole('button', { name: 'Open run' }).click()
      await expect(page.getByText('Triaged four new emails; one needs you.')).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText('Today', { exact: true })).toBeVisible()
      await expect(page.getByText('Yesterday', { exact: true })).toBeVisible()
      // The runs of a routine with nothing new fold into one line.
      const folded = page.getByRole('button', { name: /Price watch · 2 with nothing new/ })
      await expect(folded).toHaveAttribute('aria-expanded', 'false')
      await folded.click()
      await expect(folded).toHaveAttribute('aria-expanded', 'true')
      await screenshot('04-runs-list')

      // A run's conversation shows what it did, its images from its own conversation, and its report.
      await page.getByRole('button', { name: /Filed 3 invoices/ }).click()
      await expect(page.getByText('Filed three invoices in Finance.')).toBeVisible()
      await expect(page.getByText('Run report')).toBeVisible()
      await expect(page.getByText('Reply to Ana')).toBeVisible()
      await expect(page.getByText('Deletes in 5 days', { exact: true })).toBeVisible()
      await expect.poll(() => imageReads).toContain('shot-invoices?run=r-new')
      await screenshot('05-run-detail')

      // The owner asks the run for a change, in its own conversation.
      await page.locator('[data-placeholder="Ask for a change to this run"]').fill('File the receipts too')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect
        .poll(() => runMessages.map((item) => [item.runId, item.body.text]))
        .toEqual([['r-new', 'File the receipts too']])
      expect(sent).toEqual([])

      // Citing it brings it to the bot's conversation, with the next message.
      await page.getByRole('button', { name: /Cite in the conversation|Bring this run/ }).click()
      await expect(page.getByText(/^Citing Inbox triage · /)).toBeVisible()
      await screenshot('06-citation')
      await page.locator('.chat-input[contenteditable="true"]:visible').fill('What did Ana ask for?')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect
        .poll(() => sent.map((item) => [item.text, item.citation?.runId]))
        .toEqual([['What did Ana ask for?', 'r-new']])
      await expect(page.getByText(/^Citing Inbox triage · /)).toHaveCount(0)

      // Deleting its conversation can be undone for a moment; then the gateway deletes it, and its report stays.
      await page.getByRole('tab', { name: /^Runs/ }).click()
      await expect(page.getByText('Filed three invoices in Finance.')).toBeVisible()
      const confirmDelete = async () => {
        await page.getByRole('button', { name: 'Delete conversation', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Delete the conversation of this run?' })
        await expect(dialog.getByText('Its report stays')).toBeVisible()
        await dialog.getByRole('button', { name: 'Delete conversation' }).click()
        await expect(dialog).toBeHidden()
      }
      await confirmDelete()
      const toast = page.getByRole('status').filter({ hasText: 'Conversation deleted' })
      await expect(toast).toBeVisible()
      await screenshot('07-deleted-undo')
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(page.getByText('Filed three invoices in Finance.')).toBeVisible()
      await page.waitForTimeout(500)
      expect(deletes).toEqual([])
      await confirmDelete()
      await expect.poll(() => deletes, { timeout: 15_000 }).toEqual(['r-new'])
      await expect(page.getByText(/The conversation of this run was deleted on/)).toBeVisible()
      await expect(page.getByText('invoices.png')).toBeVisible()
      await expect(page.getByText('Filed 3 invoices').first()).toBeVisible()
      await screenshot('08-deleted-run')

      // The bot's settings for its runs save as each one changes.
      await page.getByRole('button', { name: 'Delete after 30 days' }).click()
      const dialog = page.getByRole('dialog', { name: 'Routine runs' })
      await dialog.getByRole('radio', { name: '60 days' }).click()
      await expect.poll(() => settings.map((item) => item.retentionDays)).toEqual([60])
      await expect(dialog.getByRole('status')).toHaveText('Saved')
      await screenshot('09-settings')
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
      await expect(page.getByRole('button', { name: 'Delete after 60 days' })).toBeVisible()
    }
  )
})
