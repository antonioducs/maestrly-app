import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Rebuild the packaged renderer first, then run:
 *   npx playwright test test/e2e/marketing-capture.spec.ts --workers=1
 *
 * The test creates disposable userData/repository fixtures, serves a local model catalog, and writes the
 * resulting 2x PNGs to test-results/desktop-captures inside this repository.
 * No provider network or real account is used.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const outputDir = path.join(repoRoot, 'test-results', 'desktop-captures')

interface Conversation {
  id: string
  workspaceId: string
  name: string
}

interface BoardColumn {
  id: string
  name: string
  role: string
}

interface Api {
  getOnboardingDone(): Promise<boolean>
  setOnboardingDone(done: boolean): void
  addWorkspace(dir: string): Promise<{ id: string; name: string }>
  prepareLocalConversation(input: {
    workspaceId: string
    name: string
    intent: { type: 'switch-existing'; branch: string; ref: { kind: 'local'; name: string } }
  }): Promise<{ status: string; token?: string }>
  confirmLocalConversation(input: { token: string }): Promise<{ status: string; conversation?: Conversation }>
  chatAddProvider(input: {
    name: string
    baseURL: string
    key: string
    kind: 'openai' | 'openai-responses' | 'anthropic'
  }): Promise<{ ok: boolean; id?: string; error?: string }>
  chatModels(providerId: string, force?: boolean): Promise<string[]>
  chatSetKey(providerId: string, key: string): Promise<{ ok: boolean; present?: boolean }>
  chatSetSelection(conversationId: string, selection: { providerId: string; modelId: string }): Promise<{ ok: boolean }>
  chatSetMode(conversationId: string, mode: 'agent' | 'plan' | 'ask'): Promise<{ ok: boolean }>
  chatSetReasoning(conversationId: string, effort: string): Promise<{ ok: boolean }>
  chatSetFastMode(conversationId: string, enabled: boolean): Promise<{ ok: boolean }>
  chatSetPermMode(conversationId: string, mode: 'full' | 'ask' | 'auto'): Promise<{ ok: boolean }>
  getBoard(workspaceId: string): Promise<{ boardId: string; columns: BoardColumn[] }>
  boardCreateColumn(boardId: string, name: string): Promise<BoardColumn>
  boardCreateCard(
    workspaceId: string,
    columnId: string,
    opts: { title: string; body?: string; labels?: string[]; parentId?: string }
  ): Promise<{ id: string }>
  boardSetConfig(
    columnId: string,
    patch: {
      agentEnabled: boolean
      autoRun: boolean
      providerId: string
      modelId: string
      reasoning: string
      promptTemplate: string
    }
  ): Promise<void>
}

declare const window: { api: Api }

let userDataDir: string
let fixtureRoot: string
let repoDir: string
let modelServer: Server
let modelBaseURL: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' })
}

async function startModelServer(): Promise<{ server: Server; baseURL: string }> {
  const catalogs: Record<string, string[]> = {
    openai: ['gpt-5.2', 'gpt-5.2-codex', 'o3'],
    anthropic: ['claude-opus-4-6', 'claude-sonnet-4-5'],
    openrouter: ['deepseek/deepseek-v3.2', 'google/gemini-3-pro-preview'],
  }
  const server = createServer((request, response) => {
    const match = request.url?.match(/^\/(openai|anthropic|openrouter)\/v1\/models$/)
    if (!match) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        data: catalogs[match[1]]!.map((id) => ({ id, context_length: 200_000 })),
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind the local model catalog server.')
  return { server, baseURL: `http://127.0.0.1:${address.port}` }
}

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'marketing-capture',
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      AGENTS_HIDE_CHANNEL_BADGE: '1',
      ELECTRON_RENDERER_URL: '',
    },
  })
}

async function ready(win: Page): Promise<void> {
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  if (!(await win.evaluate(() => window.api.getOnboardingDone()))) {
    await win.evaluate(() => window.api.setOnboardingDone(true))
    const skip = win.getByRole('button', { name: 'Skip' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
  }
}

async function setCaptureSize(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    if (!main) throw new Error('Main window not found.')
    main.setSize(1440, 900)
    main.center()
  })
}

async function capture(win: Page, name: string): Promise<void> {
  // Give transparent native vibrancy an opaque backing when exporting standalone documentation images.
  await win.screenshot({
    path: path.join(outputDir, name),
    animations: 'disabled',
    style: 'html { background: #101012 !important; }',
  })
}

async function capturePanel(app: ElectronApplication, name: string, panelName: string): Promise<void> {
  const png = await app.evaluate(async ({ webContents }, expectedPanel) => {
    const panel = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(`panel.html?panel=${expectedPanel}`))
    if (!panel) throw new Error(`Panel webContents not found: ${expectedPanel}`)
    return (await panel.capturePage()).toPNG().toString('base64')
  }, panelName)
  writeFileSync(path.join(outputDir, name), Buffer.from(png, 'base64'))
}

function seedTranscriptAndUsage(conversationId: string, providers: Record<string, string>): void {
  const db = new DatabaseSync(path.join(userDataDir, 'maestrly-agents.db'))
  db.exec('PRAGMA foreign_keys = ON;')
  const now = Date.now()
  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  insertMessage.run(
    'marketing-user-1',
    conversationId,
    'user',
    JSON.stringify([
      {
        type: 'text',
        id: 'marketing-user-part-1',
        text: 'Review the usage dashboard and ship the responsive model breakdown. Keep the existing API contract.',
      },
    ]),
    null,
    0,
    now - 72_000
  )
  insertMessage.run(
    'marketing-assistant-1',
    conversationId,
    'assistant',
    JSON.stringify([
      {
        type: 'reasoning',
        id: 'marketing-reasoning-1',
        text: 'I will trace the data flow, update the dashboard, and verify the result.',
      },
      {
        type: 'tool',
        id: 'marketing-tool-read',
        toolCallId: 'marketing-tool-read',
        toolName: 'read',
        input: { path: 'src/renderer/components/UsagePanel.tsx', offset: 1, limit: 260 },
        state: {
          status: 'completed',
          title: 'Read the usage dashboard',
          output: 'Loaded UsagePanel.tsx and its aggregation helpers.',
        },
      },
      {
        type: 'tool',
        id: 'marketing-tool-search',
        toolCallId: 'marketing-tool-search',
        toolName: 'grep',
        input: { pattern: 'usageStats|estimatedCost', path: 'src' },
        state: {
          status: 'completed',
          title: 'Trace usage aggregation',
          output: 'Found the renderer, preload API, and durable ledger aggregation.',
        },
      },
      {
        type: 'text',
        id: 'marketing-assistant-part-1',
        text: 'The data path is clean: the dashboard reads the durable local ledger and enriches each row with model metadata. I am updating the layout now.',
      },
    ]),
    JSON.stringify({
      model: { providerId: providers.openai, modelId: 'gpt-5.2-codex' },
      finishReason: 'stop',
      responseDurationMs: 18_420,
      usage: {
        usageVersion: 2,
        input: 18_340,
        output: 1_286,
        cachedInput: 9_120,
        contextInput: 27_460,
        contextOutput: 1_286,
        modelContextWindow: 200_000,
        runtimeEstimatedCostUsd: 0.41,
      },
    }),
    1,
    now - 51_000
  )
  insertMessage.run(
    'marketing-user-2',
    conversationId,
    'user',
    JSON.stringify([
      {
        type: 'text',
        id: 'marketing-user-part-2',
        text: 'Looks good. Run the checks and summarize what changed.',
      },
    ]),
    null,
    2,
    now - 28_000
  )
  insertMessage.run(
    'marketing-assistant-2',
    conversationId,
    'assistant',
    JSON.stringify([
      {
        type: 'tool',
        id: 'marketing-tool-tests',
        toolCallId: 'marketing-tool-tests',
        toolName: 'bash',
        input: { command: 'npm run typecheck && npm run test:unit' },
        state: {
          status: 'completed',
          title: 'Run verification',
          output: 'Typecheck passed\nUnit tests: 184 passed',
        },
      },
      {
        type: 'text',
        id: 'marketing-assistant-part-2',
        text: 'Done. The dashboard now keeps totals visible, adapts the model table to narrow windows, and preserves the existing usage API. Typecheck and 184 unit tests pass.',
      },
    ]),
    JSON.stringify({
      model: { providerId: providers.openai, modelId: 'gpt-5.2-codex' },
      finishReason: 'stop',
      responseDurationMs: 12_860,
      usage: {
        usageVersion: 2,
        input: 9_860,
        output: 842,
        cachedInput: 5_400,
        contextInput: 38_722,
        contextOutput: 842,
        modelContextWindow: 200_000,
        runtimeEstimatedCostUsd: 0.29,
      },
    }),
    3,
    now - 12_000
  )

  const insertUsage = db.prepare(`
    INSERT INTO chat_usage_ledger
      (message_id, conversation_id, provider_id, model_id, usage_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const usageRows = [
    [providers.openai, 'gpt-5.2-codex', 186_400, 18_200, 92_000, 0, 3.84],
    [providers.anthropic, 'claude-sonnet-4-5', 124_800, 14_600, 61_000, 8_200, 4.91],
    [providers.openrouter, 'deepseek/deepseek-v3.2', 78_300, 9_700, 24_400, 0, 1.28],
    [providers.openai, 'o3', 56_900, 7_840, 31_600, 0, 2.16],
  ] as const
  usageRows.forEach(([providerId, modelId, input, output, cachedInput, cacheCreate, cost], index) => {
    insertUsage.run(
      `marketing-usage-${index}`,
      conversationId,
      providerId,
      modelId,
      JSON.stringify({
        usageVersion: 2,
        input,
        output,
        cachedInput,
        cacheCreate,
        runtimeEstimatedCostUsd: cost,
      }),
      now - (index + 1) * 86_400_000
    )
  })
  db.close()
}

test.beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true })
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-marketing-ud-'))
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'maestrly-marketing-repo-'))
  repoDir = path.join(fixtureRoot, 'maestrly-demo')
  mkdirSync(path.join(repoDir, 'src', 'renderer', 'components'), { recursive: true })
  writeFileSync(
    path.join(repoDir, 'src', 'renderer', 'components', 'UsagePanel.tsx'),
    'export function UsagePanel() {\n  return <section>Usage dashboard</section>\n}\n'
  )
  writeFileSync(path.join(repoDir, 'README.md'), '# Maestrly desktop demo\n')
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'demo@maestrly.dev'])
  git(['config', 'user.name', 'Maestrly'])
  git(['add', '.'])
  git(['commit', '-q', '-m', 'Initial usage dashboard'])
  const local = await startModelServer()
  modelServer = local.server
  modelBaseURL = local.baseURL
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()))
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('captures the integrated desktop product surfaces', async () => {
  test.setTimeout(180_000)

  let app = await launch()
  try {
    let win = await app.firstWindow()
    await ready(win)

    const seeded = await win.evaluate(
      async ({ repo, baseURL }) => {
        const workspace = await window.api.addWorkspace(repo)
        const prepared = await window.api.prepareLocalConversation({
          workspaceId: workspace.id,
          name: 'Ship the usage dashboard',
          intent: { type: 'switch-existing', branch: 'main', ref: { kind: 'local', name: 'main' } },
        })
        if (prepared.status !== 'ready' || !prepared.token) throw new Error(`Conversation prepare: ${prepared.status}`)
        const confirmed = await window.api.confirmLocalConversation({ token: prepared.token })
        if (confirmed.status !== 'created' || !confirmed.conversation) {
          throw new Error(`Conversation confirm: ${confirmed.status}`)
        }

        const specs = [
          { key: 'openai', name: 'OpenAI', route: 'openai', kind: 'openai-responses' as const },
          { key: 'anthropic', name: 'Anthropic', route: 'anthropic', kind: 'anthropic' as const },
          { key: 'openrouter', name: 'OpenRouter', route: 'openrouter', kind: 'openai' as const },
        ]
        const providers: Record<string, string> = {}
        for (const spec of specs) {
          const added = await window.api.chatAddProvider({
            name: spec.name,
            baseURL: `${baseURL}/${spec.route}/v1`,
            key: 'sk-marketing-local-only',
            kind: spec.kind,
          })
          if (!added.ok || !added.id) throw new Error(added.error || `Could not add ${spec.name}`)
          providers[spec.key] = added.id
          const models = await window.api.chatModels(added.id, true)
          if (models.length === 0) throw new Error(`No models returned for ${spec.name}`)
        }

        const conversationId = confirmed.conversation.id
        await window.api.chatSetSelection(conversationId, {
          providerId: providers.openai!,
          modelId: 'gpt-5.2-codex',
        })
        await window.api.chatSetMode(conversationId, 'agent')
        await window.api.chatSetReasoning(conversationId, 'high')
        await window.api.chatSetFastMode(conversationId, true)
        await window.api.chatSetPermMode(conversationId, 'auto')

        return { workspaceId: workspace.id, conversationId, providers }
      },
      { repo: repoDir, baseURL: modelBaseURL }
    )

    await app.close()
    seedTranscriptAndUsage(seeded.conversationId, seeded.providers)
    writeFileSync(
      path.join(repoDir, 'src', 'renderer', 'components', 'UsagePanel.tsx'),
      'export function UsagePanel() {\n  return <section className="usage-grid">\n    <header>Usage & cost</header>\n    <div className="totals">Totals stay visible</div>\n    <table aria-label="Usage by model" />\n  </section>\n}\n'
    )

    app = await launch()
    win = await app.firstWindow()
    await ready(win)
    await win.evaluate(async (providerIds) => {
      for (const providerId of providerIds) {
        const connected = await window.api.chatSetKey(providerId, 'sk-marketing-local-only')
        if (!connected.ok || !connected.present) throw new Error(`Could not reconnect ${providerId}`)
        const models = await window.api.chatModels(providerId, true)
        if (models.length === 0) throw new Error(`No models returned after reconnecting ${providerId}`)
      }
    }, Object.values(seeded.providers))
    await setCaptureSize(app)

    const conversationRow = win.locator('li.conv-item').filter({ hasText: 'Ship the usage dashboard' })
    await expect(conversationRow).toBeVisible()
    await conversationRow.click()
    await expect(win.locator('[data-msg-id="marketing-assistant-2"]')).toBeVisible()
    // Synchronize on the composer surface; provider/model interactivity is asserted by the picker below.
    await expect(win.locator('[role="textbox"][aria-multiline="true"]')).toBeVisible()
    await win.waitForTimeout(500)
    await capture(win, 'hero-chat.png')
    await capture(win, 'download-app.png')

    await win.getByTitle(/Change model/).click()
    await expect(win.getByPlaceholder('Search models…')).toBeVisible()
    await expect(win.getByText('claude-opus-4-6', { exact: true })).toBeVisible()
    await capture(win, 'model-picker.png')
    await win.keyboard.press('Escape')

    await win.getByTitle(/Chat mode/).click()
    await expect(win.getByRole('button', { name: /Plan/ })).toBeVisible()
    await capture(win, 'chat-modes.png')
    await win.keyboard.press('Escape')
    await expect(win.getByRole('button', { name: /Plan/ })).toHaveCount(0)
    await expect(win.getByTitle(/Chat mode/)).toBeFocused()

    const toolMessage = win.locator('[data-msg-id="marketing-assistant-2"]')
    await toolMessage.getByRole('button').filter({ hasText: 'bash' }).click()
    await expect(toolMessage.getByText('Arguments', { exact: true })).toBeVisible()
    await capture(win, 'tool-calls.png')
    await toolMessage.getByRole('button').filter({ hasText: 'bash' }).click()

    await win.getByTitle('Toggle drawer').click()
    await win.getByRole('button', { name: 'Review', exact: true }).click()
    await win.getByTitle('Full screen (cover the terminal)').click()
    await win.waitForTimeout(1_500)
    await capturePanel(app, 'review-diff.png', 'review')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 800))
    await win.getByTitle('Restore size').click()
    await win.getByTitle('Toggle drawer').click()

    await setCaptureSize(app)
    await win.getByTitle('Settings').click()
    await win.getByRole('button', { name: 'Usage & cost', exact: true }).click()
    await expect(win.getByRole('heading', { name: 'Usage & cost' })).toBeVisible()
    await expect(win.getByText('gpt-5.2-codex', { exact: true })).toBeVisible()
    await capture(win, 'usage-dashboard.png')

    await win.getByTitle('Close').click()
    const workspace = win.locator(`[data-workspace-id="${seeded.workspaceId}"]`)
    await workspace.locator('[data-workspace-header]').hover()
    await workspace.getByTitle('Project notes').click()
    await expect(win.getByText('Project notes · maestrly-demo', { exact: true })).toBeVisible()
    await capture(win, 'project-notes.png')
  } finally {
    await app.close()
  }
})
