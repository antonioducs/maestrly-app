import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

interface Api {
  getOnboardingDone(): Promise<boolean>
  setOnboardingDone(done: boolean): void
}

declare const window: { api: Api }

let userDataDir: string
let app: ElectronApplication | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-subscription-usage-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

test('renders official Claude and OpenAI usage windows', async ({
  browserName: _browserName,
}, testInfo) => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `subscription-usage-${Date.now()}`,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  if (!(await win.evaluate(() => window.api.getOnboardingDone()))) {
    await win.evaluate(() => window.api.setOnboardingDone(true))
    const skip = win.getByRole('button', { name: 'Skip' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
  }

  const emptyState = win.getByText('Create or select a conversation to get started.', { exact: true })
  await expect(emptyState).toBeVisible()
  await expect(win.getByRole('button', { name: 'Usage', exact: true })).toHaveCount(0)

  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const usageGlobal = globalThis as typeof globalThis & { __quickUsageReads?: number }
    usageGlobal.__quickUsageReads = 0
    const config = {
      providers: [
        {
          id: 'builtin_codex_subscription',
          name: 'Codex with ChatGPT subscription',
          baseURL: 'codex://chatgpt-subscription',
          apiKeyPresent: false,
          builtIn: true,
          connected: true,
          kind: 'codex-subscription',
        },
        {
          id: 'builtin_claude_subscription',
          name: 'Claude subscription',
          baseURL: 'claude://subscription',
          apiKeyPresent: false,
          builtIn: true,
          connected: true,
          kind: 'claude-subscription',
        },
        {
          id: 'builtin_codex_subscription@acc_personal',
          name: 'Codex with ChatGPT subscription — Personal',
          baseURL: 'codex://chatgpt-subscription',
          apiKeyPresent: false,
          builtIn: true,
          connected: true,
          kind: 'codex-subscription',
          accountId: 'acc_personal',
          accountLabel: 'Personal',
        },
        {
          id: 'builtin_claude_subscription@acc_work',
          name: 'Claude subscription — Work',
          baseURL: 'claude://subscription',
          apiKeyPresent: false,
          builtIn: true,
          connected: true,
          kind: 'claude-subscription',
          accountId: 'acc_work',
          accountLabel: 'Work',
        },
      ],
      presets: [],
      mcpServers: [],
      appToolsEnabled: false,
      imageGenEnabled: false,
      bashFiltersEnabled: true,
      openAIHarnessEnabled: true,
      storageMode: 'secure',
      defaultSelection: null,
      defaultReasoning: 'off',
      imageInterpreter: null,
      subscriptionFailover: { supportedKinds: ['codex-subscription'], routes: [] },
    }
    ipcMain.removeHandler('chat:config')
    ipcMain.handle('chat:config', () => config)

    const statusChannels = [
      'chat:codex-subscription:status',
      'chat:github-copilot-subscription:status',
      'chat:claude-subscription:status',
      'chat:grok-subscription:status',
    ]
    for (const channel of statusChannels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        if (channel === 'chat:codex-subscription:status') {
          return { state: 'signed-in', authenticated: true, email: 'openai@example.com', planType: 'Plus' }
        }
        if (channel === 'chat:claude-subscription:status') {
          return { state: 'signed-in', authenticated: true, email: 'claude@example.com', planType: 'Max' }
        }
        return { state: 'signed-out', authenticated: false }
      })
    }

    ipcMain.removeHandler('runtime-assets:status')
    ipcMain.handle('runtime-assets:status', (_event, id: string) => ({
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '1.0.0',
      downloadBytes: 1,
      unpackedBytes: 1,
      status: { id, state: 'ready', version: '1.0.0', diskUsageBytes: 1 },
    }))

    ipcMain.removeHandler('chat:subscription-usage')
    ipcMain.handle('chat:subscription-usage', (_event, payload: { providerKind: string }) => {
      usageGlobal.__quickUsageReads = (usageGlobal.__quickUsageReads ?? 0) + 1
      const now = Date.now()
      if (payload.providerKind === 'codex-subscription') {
        return {
          state: 'ready',
          providerKind: payload.providerKind,
          accountId: null,
          fetchedAt: now,
          windows: [
            { id: 'primary', kind: 'five-hour', usedPercent: 34, resetsAt: now + 3 * 60 * 60_000, durationMins: 300 },
            {
              id: 'secondary',
              kind: 'weekly',
              usedPercent: 12,
              resetsAt: now + 5 * 24 * 60 * 60_000,
              durationMins: 10_080,
            },
          ],
        }
      }
      return {
        state: 'ready',
        providerKind: payload.providerKind,
        accountId: null,
        fetchedAt: now,
        windows: [
          { id: 'five-hour', kind: 'five-hour', usedPercent: 82, resetsAt: now + 47 * 60_000, durationMins: 300 },
          { id: 'weekly', kind: 'weekly', usedPercent: 71, resetsAt: now + 4 * 24 * 60 * 60_000, durationMins: 10_080 },
          {
            id: 'weekly-opus',
            kind: 'weekly-model',
            usedPercent: 93,
            resetsAt: now + 2 * 24 * 60 * 60_000,
            durationMins: 10_080,
            label: 'Opus',
          },
        ],
      }
    })

    ipcMain.removeHandler('chat:models')
    ipcMain.handle('chat:models', () => [])

    const main = BrowserWindow.getAllWindows()[0]
    main?.setSize(1280, 960)
    main?.webContents.send('chat:codex-subscription:auth-changed', {
      state: 'signed-in',
      authenticated: true,
    })
  })

  const usageButton = win.getByRole('button', { name: 'Usage', exact: true })
  await expect(usageButton).toBeVisible()
  await usageButton.click()

  const quickDialog = win.getByTestId('quick-usage-dialog')
  await expect(quickDialog.getByRole('heading', { name: 'Subscription usage' })).toBeVisible()
  const quickCodex = quickDialog.locator(
    '[data-quick-usage-provider="codex-subscription"][data-quick-usage-account="default"]'
  )
  const quickClaude = quickDialog.locator(
    '[data-quick-usage-provider="claude-subscription"][data-quick-usage-account="default"]'
  )
  await expect(quickCodex.getByRole('progressbar')).toHaveCount(2)
  await expect(quickClaude.getByRole('progressbar')).toHaveCount(3)
  await expect(quickDialog.locator('[data-quick-usage-provider]')).toHaveCount(4)
  await expect
    .poll(() =>
      quickDialog.getByTestId('quick-usage-list').evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true)
  await expect.poll(() => app!.evaluate(() => (globalThis as { __quickUsageReads?: number }).__quickUsageReads)).toBe(4)

  await quickDialog.getByRole('button', { name: 'Refresh subscription usage' }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as { __quickUsageReads?: number }).__quickUsageReads)).toBe(8)

  const quickShot = testInfo.outputPath('quick-subscription-usage.png')
  await quickDialog.screenshot({ path: quickShot, animations: 'disabled' })
  await testInfo.attach('Quick subscription usage', { path: quickShot, contentType: 'image/png' })

  await win.keyboard.press('Escape')
  await expect(quickDialog).toHaveCount(0)
  await expect(emptyState).toBeVisible()

  await win.getByTitle('Settings').click()
  await expect(win.getByRole('heading', { name: 'Maestrly Chat' })).toBeVisible()

  const codex = win.locator('[data-subscription-provider="codex-subscription"][data-subscription-account="default"]')
  const claude = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="default"]')
  await expect(codex.getByText('Usage limits', { exact: true })).toBeVisible()
  await expect(claude.getByText('Usage limits', { exact: true })).toBeVisible()
  await expect(claude.getByText('Weekly · Opus', { exact: true })).toBeVisible()
  await expect(codex.getByRole('progressbar')).toHaveCount(2)
  await expect(claude.getByRole('progressbar')).toHaveCount(3)

  const codexShot = testInfo.outputPath('codex-subscription-usage.png')
  const claudeShot = testInfo.outputPath('claude-subscription-usage.png')
  await codex.screenshot({ path: codexShot, animations: 'disabled' })
  await claude.scrollIntoViewIfNeeded()
  await claude.screenshot({ path: claudeShot, animations: 'disabled' })
  await testInfo.attach('Codex usage card', { path: codexShot, contentType: 'image/png' })
  await testInfo.attach('Claude usage card', { path: claudeShot, contentType: 'image/png' })
})
