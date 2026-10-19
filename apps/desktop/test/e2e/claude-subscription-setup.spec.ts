import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatConfig } from '../../src/shared/chat'

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
declare const window: { api: { setOnboardingDone(done: boolean): void; chatConfig(): Promise<ChatConfig> } }

const PAGES = {
  auth: 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback&state=e2e',
  manual:
    'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=e2e',
  docs: 'https://code.claude.com/docs/en/setup',
}

interface ClaudeE2E {
  installed: boolean
  codes: string[]
  opened: string[]
}

let app: ElectronApplication | null = null
let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-claude-setup-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

test('shows how to install Claude Code and signs in with a pasted code when no browser opens', async ({
  browserName: _browserName,
}, testInfo) => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `claude-setup-${Date.now()}`,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  await win.evaluate(() => window.api.setOnboardingDone(true))
  const skip = win.getByRole('button', { name: 'Skip', exact: true })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  const config = await win.evaluate(() => window.api.chatConfig())
  // Claude Code itself is simulated in main, behind the real preload channels the settings card uses.
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { config, pages }) => {
      const e2e: ClaudeE2E = { installed: false, codes: [], opened: [] }
      Object.assign(globalThis, { __claudeE2E: e2e })
      config.providers = config.providers.filter((provider) => provider.kind !== 'claude-subscription')
      config.providers.push({
        id: 'builtin_claude_subscription',
        name: 'Claude',
        kind: 'claude-subscription',
        baseURL: 'claude://subscription',
        apiKeyPresent: false,
        builtIn: true,
        connected: false,
      })
      ipcMain.removeHandler('chat:config')
      ipcMain.handle('chat:config', () => config)
      let current: Record<string, unknown> = {
        state: 'unavailable',
        authenticated: false,
        error: 'Claude Code is not installed.',
        errorCode: 'claude-code-not-installed',
      }
      const emit = (next: Record<string, unknown>) => {
        current = next
        BrowserWindow.getAllWindows()[0]?.webContents.send('chat:claude-subscription:auth-changed', next)
        return next
      }
      for (const action of ['status', 'login', 'logout', 'submit-code'])
        ipcMain.removeHandler(`chat:claude-subscription:${action}`)
      ipcMain.handle('chat:claude-subscription:status', () => {
        if (e2e.installed && current.state === 'unavailable') current = { state: 'signed-out', authenticated: false }
        return current
      })
      ipcMain.handle('chat:claude-subscription:login', () => ({
        ok: true,
        status: emit({ state: 'signing-in', authenticated: false }),
        authUrl: pages.auth,
        manualUrl: pages.manual,
      }))
      ipcMain.handle('chat:claude-subscription:submit-code', (_event, payload: { code: string }) => {
        e2e.codes.push(payload.code)
        if (payload.code !== 'good#e2e') return { ok: false, error: 'invalid-code' }
        setTimeout(
          () => emit({ state: 'signed-in', authenticated: true, email: 'owner@example.com', planType: 'max' }),
          50
        )
        return { ok: true }
      })
      ipcMain.handle('chat:claude-subscription:logout', () => ({
        ok: true,
        status: emit({ state: 'signed-out', authenticated: false }),
      }))
      ipcMain.removeHandler('chat:subscription-usage')
      ipcMain.handle('chat:subscription-usage', () => ({
        state: 'unsupported',
        providerKind: 'claude-subscription',
        accountId: null,
      }))
      // No real browser in tests: record what the app asks the system to open.
      ipcMain.removeHandler('open:url')
      ipcMain.handle('open:url', (_event, url: string) => void e2e.opened.push(url))
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
    },
    { config, pages: PAGES }
  )
  const e2e = () => app!.evaluate(() => (globalThis as unknown as { __claudeE2E: ClaudeE2E }).__claudeE2E)

  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  // A default slot that was never connected is offered under "Available to connect".
  await win.locator('[data-account-chip="claude-subscription"]').click()
  const card = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="default"]')
  const setup = card.locator('[data-claude-code-setup="install"]')
  await expect(setup.getByText('Install Claude Code to connect', { exact: true })).toBeVisible()
  await expect(setup.locator('code')).toHaveText(
    process.platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash'
  )
  await expect(card.getByText('Claude Code is not installed.', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Sign in with Claude' })).toBeDisabled()
  const setupShot = testInfo.outputPath('claude-code-setup.png')
  await card.screenshot({ path: setupShot, animations: 'disabled' })
  await testInfo.attach('Claude Code setup', { path: setupShot, contentType: 'image/png' })
  await setup.getByRole('button', { name: 'Installation guide' }).click()
  await expect.poll(async () => (await e2e()).opened).toContain(PAGES.docs)

  // The person installs Claude Code in a terminal; checking again finds it without a restart.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __claudeE2E: ClaudeE2E }).__claudeE2E.installed = true
  })
  await setup.getByRole('button', { name: 'Check again' }).click()
  await expect(setup).toHaveCount(0)
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()

  await card.getByRole('button', { name: 'Sign in with Claude' }).click()
  const manual = card.locator('[data-claude-manual-sign-in]')
  await expect(manual.locator('code')).toHaveText(PAGES.manual)
  await expect.poll(async () => (await e2e()).opened).toContain(PAGES.auth)
  await manual.getByRole('button', { name: 'Open link' }).click()
  await expect.poll(async () => (await e2e()).opened).toContain(PAGES.manual)
  const manualShot = testInfo.outputPath('claude-manual-sign-in.png')
  await card.screenshot({ path: manualShot, animations: 'disabled' })
  await testInfo.attach('Claude manual sign-in', { path: manualShot, contentType: 'image/png' })

  const code = manual.getByLabel('Authorization code')
  await code.fill('wrong')
  await manual.getByRole('button', { name: 'Continue' }).click()
  await expect(manual.getByRole('alert')).toHaveText(
    "That doesn't look like a Claude code. Copy it again from the Claude page."
  )
  await code.fill('  good#e2e  ')
  await manual.getByRole('button', { name: 'Continue' }).click()
  await expect(card.getByText('owner@example.com · Max', { exact: true })).toBeVisible()
  await expect(manual).toHaveCount(0)
  expect((await e2e()).codes).toEqual(['wrong', 'good#e2e'])
})

test('keeps a signed-in Claude account listed while Claude Code is missing and reconnects it on "Check again"', async ({
  browserName: _browserName,
}, testInfo) => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `claude-setup-saved-${Date.now()}`,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  await win.evaluate(() => window.api.setOnboardingDone(true))
  const skip = win.getByRole('button', { name: 'Skip', exact: true })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  const config = await win.evaluate(() => window.api.chatConfig())
  // Claude Code was removed while the app was closed; the account's sign-in is still in its profile.
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { config }) => {
      const e2e: ClaudeE2E = { installed: false, codes: [], opened: [] }
      Object.assign(globalThis, { __claudeE2E: e2e })
      config.providers = config.providers.filter((provider) => provider.kind !== 'claude-subscription')
      config.providers.push({
        id: 'builtin_claude_subscription',
        name: 'Claude',
        kind: 'claude-subscription',
        baseURL: 'claude://subscription',
        apiKeyPresent: false,
        builtIn: true,
        connected: false,
      })
      ipcMain.removeHandler('chat:config')
      ipcMain.handle('chat:config', () => config)
      ipcMain.removeHandler('chat:claude-subscription:status')
      ipcMain.handle('chat:claude-subscription:status', (_event, payload?: { refresh?: boolean }) =>
        e2e.installed && payload?.refresh
          ? { state: 'signed-in', authenticated: true, email: 'owner@example.com', planType: 'max' }
          : {
              state: 'unavailable',
              authenticated: false,
              savedSignIn: true,
              email: 'owner@example.com',
              error: 'Claude Code is not installed.',
              errorCode: 'claude-code-not-installed',
            }
      )
      ipcMain.removeHandler('chat:subscription-usage')
      ipcMain.handle('chat:subscription-usage', () => ({
        state: 'unsupported',
        providerKind: 'claude-subscription',
        accountId: null,
      }))
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
    },
    { config }
  )

  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  const row = win.locator('[data-account-entry="builtin_claude_subscription"]')
  await expect(row).toContainText('owner@example.com · Claude Code not found')
  await expect(win.locator('[data-account-chip="claude-subscription"]')).toHaveCount(0)
  await expect(win.getByText('1 needs attention', { exact: true })).toBeVisible()

  await row.click()
  const card = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="default"]')
  const setup = card.locator('[data-claude-code-setup="install"]')
  await expect(setup.locator('[data-claude-code-sign-in-kept]')).toHaveText(
    "You're still signed in as owner@example.com. The account reconnects once Claude Code is ready, without signing in again."
  )
  const savedShot = testInfo.outputPath('claude-code-missing-signed-in.png')
  await win.screenshot({ path: savedShot, animations: 'disabled' })
  await testInfo.attach('Signed-in Claude account without Claude Code', { path: savedShot, contentType: 'image/png' })

  // The person installs Claude Code again with the app open; checking again reconnects without signing in.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __claudeE2E: ClaudeE2E }).__claudeE2E.installed = true
  })
  await setup.getByRole('button', { name: 'Check again' }).click()
  await expect(setup).toHaveCount(0)
  await expect(card.getByText('owner@example.com · Max', { exact: true })).toBeVisible()
  await expect(row).toContainText('owner@example.com · Max')
  await expect(win.getByText('1 needs attention', { exact: true })).toHaveCount(0)
})
