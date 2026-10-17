import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

interface Api {
  setOnboardingDone(done: boolean): void
}

declare const window: { api: Api }

let userDataDir: string
let app: ElectronApplication | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-copilot-configuration-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

// v0.20.0 shipped without the build-time client ID: the card only said "Provider unavailable", still downloaded the
// runtime, and then failed sign-in with a generic message. The real status path runs here; the build under test
// (`npm run build`) embeds no MAIN_VITE_GITHUB_COPILOT_CLIENT_ID, and the development fallback is cleared below.
test('GitHub Copilot without an OAuth client ID explains why and never downloads the runtime', async () => {
  const env = { ...process.env }
  delete env.MAESTRLY_GITHUB_COPILOT_CLIENT_ID
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `copilot-config-${Date.now()}`,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.api !== 'undefined')
  await page.evaluate(() => window.api.setOnboardingDone(true))

  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const probe = globalThis as typeof globalThis & { __runtimeInstalls?: string[] }
    probe.__runtimeInstalls = []
    // As in a packaged build before the first sign-in: the managed runtime is not installed yet.
    ipcMain.removeHandler('runtime-assets:status')
    ipcMain.handle('runtime-assets:status', (_event, id: string) => ({
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '1.0.71',
      downloadBytes: 136_000_000,
      unpackedBytes: 400_000_000,
      status: { id, state: 'not-installed', diskUsageBytes: 0 },
    }))
    for (const channel of ['runtime-assets:install', 'runtime-assets:repair']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, id: string) => {
        probe.__runtimeInstalls?.push(id)
        throw new Error(`Unexpected runtime install: ${id}`)
      })
    }
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
  })
  await page.reload()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-account-chip="github-copilot-subscription"]').click()
  const card = page.locator(
    '[data-subscription-provider="github-copilot-subscription"][data-subscription-account="default"]'
  )
  await expect(card.getByText('Not configured in this build', { exact: true })).toBeVisible()
  await expect(
    card.getByText(/This build of Maestrly cannot sign in to GitHub Copilot: it was built without the OAuth Client ID/)
  ).toBeVisible()
  await expect(card.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeDisabled()
  await expect(card.getByText('Install & connect')).toHaveCount(0)
  await expect(card.getByText(/is required$/)).toHaveCount(0)
  await expect(
    page.locator('[data-account-entry="builtin_github_copilot_subscription"]').getByText('Not configured in this build')
  ).toBeVisible()
  expect(await app.evaluate(() => (globalThis as { __runtimeInstalls?: string[] }).__runtimeInstalls)).toEqual([])
})
