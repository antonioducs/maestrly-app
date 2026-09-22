import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canRecordX11, ScreenRecorder } from './helpers/screen-recorder'
import { removeTempDirEventually } from './helpers/temp-cleanup'

/**
 * Rebuild the packaged renderer first, then run:
 *   npx playwright test test/e2e/marketing-demo-drawer.spec.ts --workers=1
 *
 * On Linux, wrap with Xvfb when no display is available (ffmpeg records the X11 window):
 *   xvfb-run -a npx playwright test test/e2e/marketing-demo-drawer.spec.ts --workers=1
 *
 * The test creates disposable userData/repository fixtures, serves a local model catalog, and records a
 * short WebM demo of on-demand drawer tool tabs to test-results/desktop-captures/drawer-demo.webm.
 * Convert to MP4 for X/social clips, for example:
 *   ffmpeg -i test-results/desktop-captures/drawer-demo.webm -c:v libx264 -pix_fmt yuv420p drawer-demo.mp4
 *
 * No provider network or real account is used.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const outputDir = path.join(repoRoot, 'test-results', 'desktop-captures')
const outputVideo = path.join(outputDir, 'drawer-demo.webm')
const captureSize = { width: 1280, height: 800 }

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
let videoDir: string

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

function launchEnv(): Record<string, string> {
  return {
    ...process.env,
    AGENTS_E2E: '1',
    AGENTS_CHANNEL: 'dev',
    AGENTS_INSTANCE: 'marketing-demo-drawer',
    AGENTS_USERDATA: userDataDir,
    AGENTS_LOCALE: 'en',
    AGENTS_HIDE_CHANNEL_BADGE: '1',
    ELECTRON_RENDERER_URL: '',
  } as Record<string, string>
}

function launchSetup(): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: launchEnv(),
  })
}

function launchRecording(): Promise<ElectronApplication> {
  if (canRecordX11()) {
    return electron.launch({
      args: [mainEntry],
      env: launchEnv(),
    })
  }
  return electron.launch({
    args: [mainEntry],
    recordVideo: { dir: videoDir, size: captureSize },
    env: launchEnv(),
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
    main.setSize(1280, 800)
    main.center()
  })
}

async function windowBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    if (!main) throw new Error('Main window not found.')
    return main.getBounds()
  })
}

async function hold(win: Page, ms: number): Promise<void> {
  await win.waitForTimeout(ms)
}

function seedTranscript(conversationId: string, providers: Record<string, string>): void {
  const db = new DatabaseSync(path.join(userDataDir, 'maestrly-agents.db'))
  db.exec('PRAGMA foreign_keys = ON;')
  const now = Date.now()
  const insertMessage = db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  insertMessage.run(
    'drawer-demo-user-1',
    conversationId,
    'user',
    JSON.stringify([
      {
        type: 'text',
        id: 'drawer-demo-user-part-1',
        text: 'Review the usage dashboard and ship the responsive model breakdown. Keep the existing API contract.',
      },
    ]),
    null,
    0,
    now - 72_000
  )
  insertMessage.run(
    'drawer-demo-assistant-1',
    conversationId,
    'assistant',
    JSON.stringify([
      {
        type: 'text',
        id: 'drawer-demo-assistant-part-1',
        text: 'The data path is clean: the dashboard reads the durable local ledger and enriches each row with model metadata. I am updating the layout now.',
      },
    ]),
    JSON.stringify({
      model: { providerId: providers.openai, modelId: 'gpt-5.2-codex' },
      finishReason: 'stop',
      responseDurationMs: 18_420,
    }),
    1,
    now - 51_000
  )
  db.close()
}

async function finalizeVideo(win: Page): Promise<void> {
  let recorded: string | null = null
  const video = win.video()
  if (video) {
    try {
      recorded = await video.path()
    } catch {
      recorded = null
    }
  }
  if (!recorded) {
    const fallback = readdirSync(videoDir).find((name) => name.endsWith('.webm'))
    if (!fallback) throw new Error(`No WebM recording found in ${videoDir}`)
    recorded = path.join(videoDir, fallback)
  }
  copyFileSync(recorded, outputVideo)
  const { size } = statSync(outputVideo)
  if (size < 1024) throw new Error(`Recorded video is unexpectedly small (${size} bytes).`)
}

test.beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true })
  videoDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-drawer-video-'))
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-drawer-ud-'))
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'maestrly-drawer-repo-'))
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
  await removeTempDirEventually(userDataDir)
  await removeTempDirEventually(fixtureRoot)
  await removeTempDirEventually(videoDir)
})

test('records a short drawer tool-tabs demo video', async () => {
  test.setTimeout(180_000)

  let app = await launchSetup()
  let recordWin: Page | undefined
  const screenRecorder = canRecordX11() ? new ScreenRecorder() : null
  try {
    const setupWin = await app.firstWindow({ timeout: 90_000 })
    await ready(setupWin)

    const seeded = await setupWin.evaluate(
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

        return { conversationId, providers }
      },
      { repo: repoDir, baseURL: modelBaseURL }
    )

    await app.close()
    seedTranscript(seeded.conversationId, seeded.providers)

    app = await launchRecording()
    recordWin = await app.firstWindow({ timeout: 90_000 })
    await ready(recordWin)
    await recordWin.evaluate(async (providerIds) => {
      for (const providerId of providerIds) {
        const connected = await window.api.chatSetKey(providerId, 'sk-marketing-local-only')
        if (!connected.ok || !connected.present) throw new Error(`Could not reconnect ${providerId}`)
        const models = await window.api.chatModels(providerId, true)
        if (models.length === 0) throw new Error(`No models returned after reconnecting ${providerId}`)
      }
    }, Object.values(seeded.providers))
    await setCaptureSize(app)
    if (screenRecorder) {
      screenRecorder.start(process.env.DISPLAY!, await windowBounds(app), outputVideo)
      await recordWin.waitForTimeout(400)
    }

    const conversationRow = recordWin.locator('li.conv-item').filter({ hasText: 'Ship the usage dashboard' })
    await expect(conversationRow).toBeVisible()
    await conversationRow.click()
    await expect(recordWin.locator('[data-msg-id="drawer-demo-assistant-1"]')).toBeVisible()
    await expect(recordWin.locator('[role="textbox"][aria-multiline="true"]')).toBeVisible()

    await recordWin.getByTitle('Toggle drawer').click()
    await expect(recordWin.getByText('No tool open', { exact: true })).toBeVisible()
    await hold(recordWin, 2_000)

    await recordWin.getByTitle('Open a tool').click()
    await expect(recordWin.getByPlaceholder('Search tools…')).toBeVisible()
    await expect(recordWin.getByRole('option', { name: 'Browser', exact: true })).toBeVisible()
    await expect(recordWin.getByRole('option', { name: 'Plan', exact: true })).toBeVisible()
    await expect(recordWin.getByRole('option', { name: 'Notes', exact: true })).toBeVisible()
    await hold(recordWin, 2_500)

    await recordWin.getByRole('option', { name: 'Browser', exact: true }).click()
    await expect(recordWin.getByTitle('Browser', { exact: true })).toBeVisible()
    await expect(recordWin.getByPlaceholder('Search or type a URL')).toBeVisible()
    await hold(recordWin, 2_000)

    await recordWin.getByTitle('Open a tool').click()
    await expect(recordWin.getByPlaceholder('Search tools…')).toBeVisible()
    await hold(recordWin, 800)
    await recordWin.getByRole('option', { name: 'Plan', exact: true }).click()
    await expect(recordWin.getByTitle('Plan', { exact: true })).toBeVisible()
    await hold(recordWin, 2_000)

    await recordWin.getByTitle('Browser', { exact: true }).click()
    await expect(recordWin.getByPlaceholder('Search or type a URL')).toBeVisible()
    await hold(recordWin, 1_500)

    await recordWin.getByTitle('Open a tool').click()
    await expect(recordWin.getByPlaceholder('Search tools…')).toBeVisible()
    await hold(recordWin, 1_500)
    await recordWin.keyboard.press('Escape')

    await hold(recordWin, 1_000)
  } finally {
    if (screenRecorder) await screenRecorder.stop()
    await app.close()
    if (screenRecorder) {
      const { size } = statSync(outputVideo)
      if (size < 1024) throw new Error(`Recorded video is unexpectedly small (${size} bytes).`)
    } else if (recordWin) {
      await finalizeVideo(recordWin)
    }
  }
})
