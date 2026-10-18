import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
declare const window: { api: { setOnboardingDone(done: boolean): void } }

const DEVICE_PAGE = 'https://github.com/login/device'
const USER_CODE = '76B6-D6BE'

interface CopilotE2E {
  verificationUrl: string
  opened: string[]
}

let app: ElectronApplication | null = null
let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-copilot-device-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

// QA on a clean Ubuntu VM: when the browser did not open, the card showed the one-time code but not where to enter it.
test('GitHub Copilot sign-in shows the device page next to the code, and nothing but that page', async ({
  browserName: _browserName,
}, testInfo) => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `copilot-device-${Date.now()}`,
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
  // GitHub's device flow is simulated in main, behind the real preload channels the settings card uses.
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { userCode }) => {
      const e2e: CopilotE2E = { verificationUrl: '', opened: [] }
      Object.assign(globalThis, { __copilotE2E: e2e })
      const emit = (next: Record<string, unknown>) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('chat:github-copilot-subscription:auth-changed', next)
        return next
      }
      for (const action of ['status', 'login', 'logout'])
        ipcMain.removeHandler(`chat:github-copilot-subscription:${action}`)
      ipcMain.handle('chat:github-copilot-subscription:status', () => ({ state: 'signed-out', authenticated: false }))
      ipcMain.handle('chat:github-copilot-subscription:login', () => ({
        ok: true,
        verificationUrl: e2e.verificationUrl,
        userCode,
        status: emit({ state: 'signing-in', authenticated: false }),
      }))
      ipcMain.handle('chat:github-copilot-subscription:logout', () => ({
        ok: true,
        status: emit({ state: 'signed-out', authenticated: false }),
      }))
      ipcMain.removeHandler('runtime-assets:status')
      ipcMain.handle('runtime-assets:status', (_event, id: string) => ({
        id,
        displayName: id,
        requiredBy: 'test',
        availableVersion: '1.0.71',
        downloadBytes: 0,
        unpackedBytes: 0,
        status: { id, state: 'ready', diskUsageBytes: 1 },
      }))
      // No real browser in tests: record what the app asks the system to open.
      ipcMain.removeHandler('open:url')
      ipcMain.handle('open:url', (_event, url: string) => void e2e.opened.push(url))
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
    },
    { userCode: USER_CODE }
  )
  const setVerificationUrl = (url: string) =>
    app!.evaluate((_electron, value) => {
      ;(globalThis as unknown as { __copilotE2E: CopilotE2E }).__copilotE2E.verificationUrl = value
    }, url)
  const opened = () => app!.evaluate(() => (globalThis as unknown as { __copilotE2E: CopilotE2E }).__copilotE2E.opened)
  const clipboard = () => app!.evaluate(({ clipboard }) => clipboard.readText())

  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await win.locator('[data-account-chip="github-copilot-subscription"]').click()
  const card = win.locator(
    '[data-subscription-provider="github-copilot-subscription"][data-subscription-account="default"]'
  )

  // A page that is not GitHub's device page is neither opened nor shown; the code still is.
  await setVerificationUrl('https://github.com.evil.example/login/device')
  await card.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  const device = card.locator('[data-subscription-device-code]')
  await expect(device.locator('code').first()).toHaveText(USER_CODE)
  await expect(device.getByRole('button', { name: 'Copy code' })).toBeVisible()
  await expect(device.locator('[data-subscription-device-link]')).toHaveCount(0)
  await expect(card.getByText('github.com.evil.example')).toHaveCount(0)
  expect(await opened()).toEqual([])
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(device).toHaveCount(0)

  await setVerificationUrl(DEVICE_PAGE)
  await card.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect.poll(opened).toEqual([DEVICE_PAGE])
  const link = device.locator('[data-subscription-device-link]')
  await expect(device.locator('code').first()).toHaveText(USER_CODE)
  await expect(link.locator('code')).toHaveText(DEVICE_PAGE)
  const shot = testInfo.outputPath('github-copilot-device-sign-in.png')
  await card.screenshot({ path: shot, animations: 'disabled' })
  await testInfo.attach('GitHub Copilot device sign-in', { path: shot, contentType: 'image/png' })

  await device.getByRole('button', { name: 'Copy code' }).click()
  await expect(device.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect.poll(clipboard).toBe(USER_CODE)
  await link.getByRole('button', { name: 'Copy link' }).click()
  await expect.poll(clipboard).toBe(DEVICE_PAGE)
  await expect(device.getByRole('button', { name: 'Copy code' })).toBeVisible()
  await link.getByRole('button', { name: 'Open in browser' }).click()
  await expect.poll(opened).toEqual([DEVICE_PAGE, DEVICE_PAGE])
})
