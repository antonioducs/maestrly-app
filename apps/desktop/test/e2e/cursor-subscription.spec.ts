import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatConfig } from '../../src/shared/chat'

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
declare const window: { api: { setOnboardingDone(done: boolean): void; chatConfig(): Promise<ChatConfig> } }
let app: ElectronApplication | null = null
let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-cursor-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

test('connects, cancels, reconnects and isolates Cursor accounts using the standard subscription channels', async () => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `cursor-${Date.now()}`,
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
  await app.evaluate(({ BrowserWindow, ipcMain }, config) => {
    const states = new Map<string, string>()
    const status = (accountId: string | null = null) => {
      const state = states.get(accountId ?? 'default') ?? 'signed-out'
      return {
        state,
        authenticated: state === 'signed-in',
        available: true,
        storageMode: accountId ? 'secure' : 'memory',
        accountId,
        ...(state === 'signed-in' ? { email: `${accountId ?? 'personal'}@example.com` } : {}),
      }
    }
    config.providers = config.providers.filter((provider) => provider.kind !== 'cursor-subscription')
    const addProvider = (accountId: string | null, label?: string) => {
      config.providers.push({
        id: `builtin_cursor_subscription${accountId ? `@${accountId}` : ''}`,
        name: label ? `Cursor — ${label}` : 'Cursor',
        kind: 'cursor-subscription',
        baseURL: 'cursor://subscription',
        apiKeyPresent: false,
        builtIn: true,
        connected: false,
        ...(accountId ? { accountId, accountLabel: label } : {}),
      })
    }
    addProvider(null)
    addProvider('work', 'Work')
    const emit = (accountId: string | null) => {
      const next = status(accountId)
      const provider = config.providers.find(
        (entry) => entry.kind === 'cursor-subscription' && (entry.accountId ?? null) === accountId
      )
      if (provider) provider.connected = next.authenticated
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:cursor-subscription:auth-changed', next)
      return next
    }
    ipcMain.removeHandler('chat:config')
    ipcMain.handle('chat:config', () => config)
    for (const action of ['status', 'login', 'logout']) ipcMain.removeHandler(`chat:cursor-subscription:${action}`)
    ipcMain.handle('chat:cursor-subscription:status', (_event, input) => status(input?.accountId ?? null))
    ipcMain.handle('chat:cursor-subscription:login', (_event, input) => {
      const accountId = input?.accountId ?? null
      states.set(accountId ?? 'default', 'signing-in')
      return { ok: true, status: emit(accountId) }
    })
    ipcMain.handle('chat:cursor-subscription:logout', (_event, input) => {
      const accountId = input?.accountId ?? null
      states.set(accountId ?? 'default', 'signed-out')
      return { ok: true, status: emit(accountId) }
    })
    // The provider completion is simulated in main, crossing the real preload event boundary.
    Object.assign(globalThis, {
      completeCursorLogin: (accountId: string | null) => {
        states.set(accountId ?? 'default', 'signed-in')
        emit(accountId)
      },
    })
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
  }, config)
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = win.locator('[data-subscription-provider="cursor-subscription"][data-subscription-account="default"]')
  const work = win.locator('[data-subscription-provider="cursor-subscription"][data-subscription-account="work"]')
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Sign in with Cursor' }).click()
  await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Sign in with Cursor' }).click()
  await app.evaluate(() =>
    (globalThis as unknown as { completeCursorLogin(id: string | null): void }).completeCursorLogin(null)
  )
  await expect(card.getByText('personal@example.com', { exact: true })).toBeVisible()
  await expect(card.getByText('This account is connected for this session only.', { exact: false })).toBeVisible()
  await expect(work.getByText('Not connected', { exact: true })).toBeVisible()
  await work.getByRole('button', { name: 'Sign in with Cursor' }).click()
  await app.evaluate(() =>
    (globalThis as unknown as { completeCursorLogin(id: string | null): void }).completeCursorLogin('work')
  )
  await expect(work.getByText('work@example.com', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(work.getByText('work@example.com', { exact: true })).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveCount(0)
  await expect(work.getByRole('progressbar')).toHaveCount(0)
})
