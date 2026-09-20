import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackgroundCompactionConfig, BackgroundCompactionStatus } from '../../src/shared/background-compaction'
import type { ChatConfig, ChatModelRef, ChatRuntimeState } from '../../src/shared/chat'
import { removeTempDirEventually } from './helpers/temp-cleanup'

test.use({ actionTimeout: 15_000, trace: 'retain-on-failure' })

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const model: ChatModelRef = { providerId: 'background-provider', modelId: 'background-model' }

interface FixtureState {
  config: BackgroundCompactionConfig | undefined
  sends: Array<{ conversationId: string; text: string }>
  retries: string[]
  catalogReads: string[]
  runtimeRequests: number
  runtime: ChatRuntimeState
  firstRuntimeResolver?: (runtime: ChatRuntimeState) => void
}

interface Api {
  setOnboardingDone(done: boolean): Promise<void>
  chatConfig(): Promise<ChatConfig>
  addWorkspace(directory: string): Promise<{ id: string }>
  createConversation(input: {
    workspaceId: string
    branch: string
    isNewBranch: boolean
    mode: 'worktree'
    experience: 'standard'
    name: string
  }): Promise<{ id: string }>
}

declare const window: { api: Api }

let app: ElectronApplication | undefined
let root: string

test.beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-background-compaction-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
  await removeTempDirEventually(root)
})

test('configures capabilities, hydrates monotonic status, and keeps send available while preparing', async () => {
  const repository = path.join(root, 'background-compaction-fixture')
  mkdirSync(repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture'])

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `bg-compact-${Date.now()}`,
      AGENTS_USERDATA: path.join(root, 'profile'),
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.api !== 'undefined')
  await page.evaluate(() => window.api.setOnboardingDone(true))
  const baseConfig = await page.evaluate(() => window.api.chatConfig())

  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { baseConfig, model }) => {
      const runtime = (backgroundCompaction?: BackgroundCompactionStatus): ChatRuntimeState => ({
        streaming: false,
        backgroundCompaction,
        pendingPermissions: [],
        pendingQuestions: [],
        midTurnSteering: false,
        liveReasoningUpdate: false,
        liveReasoningEfforts: [],
        liveReasoningReset: false,
        activeHarnessProfile: null,
      })
      const state: FixtureState = {
        config: undefined,
        sends: [],
        retries: [],
        catalogReads: [],
        runtimeRequests: 0,
        runtime: runtime(),
      }
      ;(globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction = state
      const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      const emit = (conversationId: string, status: BackgroundCompactionStatus) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(`chat:delta:${conversationId}`, {
          kind: 'background-compaction',
          state: status,
        })

      replace('chat:config', () => ({
        ...baseConfig,
        providers: [
          {
            id: model.providerId,
            name: 'Background provider',
            kind: 'openai',
            baseURL: 'https://background.invalid/v1',
            apiKeyPresent: true,
            builtIn: false,
          },
        ],
        defaultSelection: model,
        backgroundCompaction: state.config,
      }))
      replace('chat:subagent-profiles:model-catalog', (_event, providerId: string) => {
        state.catalogReads.push(providerId)
        return { status: 'available', models: [model.modelId] }
      })
      replace('chat:subagent-profiles:model-meta', () => ({
        status: 'available',
        meta: { reasoning: true, reasoningEfforts: ['low', 'high'], fastModeCapability: true },
      }))
      replace('chat:models', () => [model.modelId])
      replace('chat:model-meta', () => ({
        contextWindow: 200_000,
        contextLimitEditable: false,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        fastModeCapability: true,
      }))
      replace('chat:get-selection', () => model)
      replace('chat:background-compaction:set', (_event, config: BackgroundCompactionConfig) => {
        state.config = config
        return { ok: true, config }
      })
      replace('chat:background-compaction:retry', (_event, conversationId: string) => {
        state.retries.push(conversationId)
        emit(conversationId, { revision: 6, status: 'queued' })
        return { ok: true }
      })
      replace('chat:history:page', () => ({ messages: [], hasMore: false, earliestSeq: null }))
      replace('chat:history:stats', () => ({
        lastUsage: null,
        lastModel: null,
        perModel: [],
        modelIds: [],
        bytesSaved: 0,
      }))
      replace('chat:runtime', () => {
        state.runtimeRequests++
        if (state.runtimeRequests === 1) {
          return new Promise<ChatRuntimeState>((resolve) => {
            state.firstRuntimeResolver = resolve
          })
        }
        return state.runtime
      })
      replace('chat:send', (_event, input: { conversationId: string; text: string }) => {
        state.sends.push(input)
        return { ok: true }
      })
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000)
    },
    { baseConfig, model }
  )

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Models & agents', exact: true }).click()
  const settings = page.locator('[data-background-compaction-settings]')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('spinbutton', { name: 'Preparation interval' })).toHaveValue('100000')
  const toggle = settings.getByRole('button', { name: 'Use background context preparation' })
  await expect(toggle).toBeDisabled()

  await settings.getByRole('button', { name: 'Provider' }).click()
  await page.getByRole('option', { name: 'Background provider', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Provider' })).toContainText('Background provider')
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction
            .catalogReads
      )
    )
    .toContain(model.providerId)
  await settings.getByRole('button', { name: 'Model ID' }).click()
  await page.getByRole('option', { name: model.modelId, exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Reasoning level' })).toContainText('Default')
  const fastMode = settings.getByRole('button', { name: 'Subagent speed' })
  await expect(fastMode).toContainText('Standard')
  await fastMode.click()
  await expect(fastMode).toContainText('Fast')
  await toggle.click()
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings.getByText('Background preparation saved.', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction.config
      )
    )
    .toEqual({
      enabled: true,
      intervalTokens: 100_000,
      selection: { ...model, effort: 'off', fastMode: true },
    })
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  const conversation = await page.evaluate(async (directory) => {
    const workspace = await window.api.addWorkspace(directory)
    return window.api.createConversation({
      workspaceId: workspace.id,
      branch: 'background-compaction',
      isNewBranch: true,
      mode: 'worktree',
      experience: 'standard',
      name: 'Background compaction fixture',
    })
  }, repository)
  await page.reload()
  await page.locator('li.conv-item:visible').filter({ hasText: 'Background compaction fixture' }).click()
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction
            .runtimeRequests
      )
    )
    .toBe(1)

  await app.evaluate(({ BrowserWindow }, conversationId) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(`chat:delta:${conversationId}`, {
      kind: 'background-compaction',
      state: { revision: 4, status: 'running' },
    })
  }, conversation.id)
  await expect(page.getByRole('status').filter({ hasText: 'Preparing context…' })).toBeVisible()

  await app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction
    state.firstRuntimeResolver?.({
      streaming: false,
      backgroundCompaction: { revision: 3, status: 'failed', error: 'stale hydration' },
      pendingPermissions: [],
      pendingQuestions: [],
      midTurnSteering: false,
      liveReasoningUpdate: false,
      liveReasoningEfforts: [],
      liveReasoningReset: false,
      activeHarnessProfile: null,
    })
  })
  await expect(page.getByRole('status').filter({ hasText: 'Preparing context…' })).toBeVisible()
  await expect(page.getByText('Context preparation failed', { exact: true })).toHaveCount(0)

  const composer = page.locator('[contenteditable="true"][role="textbox"]')
  await composer.fill('Send while preparation is running.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction.sends
      )
    )
    .toEqual([expect.objectContaining({ conversationId: conversation.id, text: 'Send while preparation is running.' })])

  await app.evaluate(({ BrowserWindow }, conversationId) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(`chat:delta:${conversationId}`, {
      kind: 'background-compaction',
      state: { revision: 5, status: 'failed', error: 'synthetic preparation failure' },
    })
  }, conversation.id)
  const failed = page.locator('[data-background-compaction-status="failed"]')
  await expect(failed.getByRole('alert')).toHaveText('Context preparation failed')
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(failed.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await failed.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction.retries
      )
    )
    .toEqual([conversation.id])
  await expect(page.getByRole('status').filter({ hasText: 'Context preparation queued' })).toBeVisible()

  await app.evaluate(({ BrowserWindow }, conversationId) => {
    const main = BrowserWindow.getAllWindows()[0]
    main?.webContents.send(`chat:delta:${conversationId}`, {
      kind: 'background-compaction',
      state: { revision: 7, status: 'failed', error: 'latest failure' },
    })
    main?.webContents.send(`chat:delta:${conversationId}`, {
      kind: 'background-compaction',
      state: { revision: 6, status: 'running' },
    })
  }, conversation.id)
  await expect(page.locator('[data-background-compaction-status="failed"]')).toBeVisible()

  await app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __backgroundCompaction: FixtureState }).__backgroundCompaction
    state.runtime = {
      streaming: false,
      backgroundCompaction: { revision: 8, status: 'ready' },
      pendingPermissions: [],
      pendingQuestions: [],
      midTurnSteering: false,
      liveReasoningUpdate: false,
      liveReasoningEfforts: [],
      liveReasoningReset: false,
      activeHarnessProfile: null,
    }
  })
  await page
    .locator('[data-background-compaction-status="failed"]')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Maestrly Chat', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Prepared context ready' })).toBeVisible()
})
