import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Onboarding / first-run E2E (#145): launch built Electron in test mode
 * (AGENTS_E2E=1 with isolated AGENTS_USERDATA) to verify behavior beyond type checking:
 * 1. A clean store shows the tour and returns false from getOnboardingDone().
 * 2. Skip persists onboarding.completed.
 * 3. Relaunching with the same userData keeps the tour hidden.
 * 4. Help reopens the tour regardless of the saved flag.
 * Run npm run build first; this test uses out/main and out/renderer.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

interface Api {
  getOnboardingDone(): Promise<boolean>
}
declare const window: { api: Api }

let userDataDir: string
const instanceId = 'e2e'

test.beforeAll(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-onb-'))
})
test.afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function launch(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: instanceId,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en', // i18n #114: pin English so assertions do not depend on the host locale
      ELECTRON_RENDERER_URL: '', // force loadFile(out/renderer) instead of the dev server
      ...extraEnv,
    },
  })
}

test('first-run: a clean store shows the tour, Skip persists, relaunch hides it, and Help reopens it', async () => {
  // ---- Session 1: a clean store opens the tour automatically ----
  let app = await launch()
  const win = await app.firstWindow()
  await win.waitForFunction(() => typeof window.api !== 'undefined')

  // Verify isolated userData without touching the development profile.
  const effectiveUserData = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(realpathSync(effectiveUserData)).toBe(realpathSync(userDataDir))

  // (a) An unset flag returns false and shows the tour; launch pins the locale to English.
  expect(await win.evaluate(() => window.api.getOnboardingDone())).toBe(false)
  await expect(win.getByText('Welcome to Maestrly')).toBeVisible()

  // (b) Skip closes the tour and persists the completion flag.
  await win.getByRole('button', { name: 'Skip' }).click()
  await expect(win.getByText('Welcome to Maestrly')).toHaveCount(0)
  await expect.poll(() => win.evaluate(() => window.api.getOnboardingDone())).toBe(true)

  await app.close()

  // ---- Session 2: relaunch with the same userData keeps the tour hidden ----
  app = await launch()
  const win2 = await app.firstWindow()
  await win2.waitForFunction(() => typeof window.api !== 'undefined')

  expect(await win2.evaluate(() => window.api.getOnboardingDone())).toBe(true)
  await expect(win2.getByText('Welcome to Maestrly')).toHaveCount(0)

  // (c) Help reopens the tour even when the completion flag is set.
  await win2.getByRole('button', { name: 'Help' }).click()
  await win2.getByRole('menuitem', { name: 'Welcome tour' }).click()
  await expect(win2.getByText('Welcome to Maestrly')).toBeVisible()

  await app.close()
})

test('onboarding uses the returned project and automatically advances to the conversation', async () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-onb-project-'))
  const repo = mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-onb-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'e2e-onb-project',
      AGENTS_USERDATA: isolated,
      AGENTS_LOCALE: 'en',
      AGENTS_E2E_PROJECT_PICKERS: JSON.stringify([repo]),
      ELECTRON_RENDERER_URL: '',
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => typeof window.api !== 'undefined')
    await win.getByRole('button', { name: 'Next' }).click()
    await win.getByRole('button', { name: 'Next' }).click()
    await win.getByText('Add workspace', { exact: true }).last().click()
    await win.getByRole('button', { name: 'Choose…' }).click()
    await win.getByRole('button', { name: 'Open project' }).click()
    await expect(win.getByText('Create your first conversation')).toBeVisible()
    await expect(win.locator('main').getByText(path.basename(repo))).toBeVisible()
  } finally {
    await app.close()
    rmSync(isolated, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})
