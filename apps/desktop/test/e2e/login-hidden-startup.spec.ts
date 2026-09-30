import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Electron 44 removed the macOS `openAsHidden` login item attribute. A background executor launched by its
 * login item must still open without showing the main window, and reveal it on request. The Windows login
 * item passes this argument; macOS reports the same launch through `wasOpenedAtLogin`.
 * Run npm run build first; this test uses out/main and out/renderer with an isolated profile.
 */

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const LOGIN_LAUNCH_ARG = '--maestrly-login-launch'

interface Api {
  platformExecutorSettings(): Promise<Record<string, unknown>>
  platformSaveExecutorSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>>
}
declare const window: { api: Api }

let userDataDir: string

test.beforeAll(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-login-hidden-'))
})
test.afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function launch(args: string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry, ...args],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'login-hidden',
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ELECTRON_RENDERER_URL: '',
    },
  })
}

/** Waits for the main window's preload (with timer polling, since a hidden window may not paint). */
async function mainWindow(app: ElectronApplication) {
  const page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.api !== 'undefined', undefined, { polling: 100 })
  const win = await app.browserWindow(page)
  return { page, visible: () => win.evaluate((w) => w.isVisible()), hide: () => win.evaluate((w) => w.hide()) }
}

async function saveExecutor(app: ElectronApplication, settings: Record<string, unknown>): Promise<void> {
  const { page } = await mainWindow(app)
  await page.evaluate(
    async (patch) =>
      window.api.platformSaveExecutorSettings({ ...(await window.api.platformExecutorSettings()), ...patch }),
    settings
  )
}

test('a background executor launched at login starts hidden and reveals on request', async () => {
  // Session 1: an ordinary launch shows the window; enable the background executor at login.
  let app = await launch()
  try {
    const first = await mainWindow(app)
    await expect.poll(first.visible).toBe(true)
    await saveExecutor(app, { autoStart: true, background: true })
  } finally {
    await app.close()
  }

  // Session 2: the login launch keeps the window hidden until the dock or another launch reveals it.
  app = await launch([LOGIN_LAUNCH_ARG])
  try {
    const login = await mainWindow(app)
    expect(await login.visible()).toBe(false)
    await login.page.waitForTimeout(1_000)
    expect(await login.visible()).toBe(false)
    await app.evaluate(({ app }) => app.emit('second-instance'))
    await expect.poll(login.visible).toBe(true)
    await login.hide()
    await app.evaluate(({ app }) => app.emit('activate'))
    await expect.poll(login.visible).toBe(true)
  } finally {
    await app.close()
  }

  // Session 3: opening the app manually still shows it with the same settings.
  app = await launch()
  try {
    const manual = await mainWindow(app)
    await expect.poll(manual.visible).toBe(true)
    await saveExecutor(app, { background: false })
  } finally {
    await app.close()
  }

  // Session 4: without background mode, a login launch opens the window as before.
  app = await launch([LOGIN_LAUNCH_ARG])
  try {
    const foreground = await mainWindow(app)
    await expect.poll(foreground.visible).toBe(true)
  } finally {
    await app.close()
  }
})
