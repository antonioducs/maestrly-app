import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test.use({ actionTimeout: 15_000, navigationTimeout: 20_000, trace: 'retain-on-failure' })

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const claude = 'builtin_claude_subscription'
const work = `${claude}@acc_work`
const personal = `${claude}@acc_personal`
interface Route {
  primaryProviderId: string
  enabled: boolean
  fallbackProviderIds: string[]
}
interface StubState {
  routes: Route[]
  writes: Route[]
  reads: number
}
declare const window: {
  api: { setOnboardingDone(done: boolean): Promise<void> }
}
let app: ElectronApplication | null = null
let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-subscription-failover-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

for (const locale of ['en', 'pt-BR'] as const) {
  test(`Claude rotation saves, reorders and restores same-family routes (${locale})`, async ({
    browserName: _browserName,
  }, testInfo) => {
    const copy =
      locale === 'en'
        ? {
            settings: 'Settings',
            close: 'Close',
            rotation: 'Automatic rotation',
            add: 'Add fallback account',
            up: 'Move up',
            down: 'Move down',
            remove: 'Remove fallback',
            default: 'Claude subscription',
          }
        : {
            settings: 'Configurações',
            close: 'Fechar',
            rotation: 'Rotação automática',
            add: 'Adicionar conta de fallback',
            up: 'Mover para cima',
            down: 'Mover para baixo',
            remove: 'Remover fallback',
            default: 'Assinatura Claude',
          }
    app = await electron.launch({
      executablePath: process.env.MAESTRLY_PACKAGED_EXECUTABLE,
      args: process.env.MAESTRLY_PACKAGED_EXECUTABLE ? ['--use-mock-keychain'] : [mainEntry],
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `rotation-${locale}-${Date.now()}`,
        AGENTS_USERDATA: userDataDir,
        AGENTS_LOCALE: locale,
        ELECTRON_RENDERER_URL: '',
      },
    })
    const win = await app.firstWindow({ timeout: 20_000 })
    await win.waitForFunction(() => typeof window.api !== 'undefined', null, { timeout: 15_000 })
    await win.evaluate(() => window.api.setOnboardingDone(true))
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const state: StubState = { routes: [], writes: [], reads: 0 }
      ;(globalThis as typeof globalThis & { __rotation: StubState }).__rotation = state
      const providers = [
        ['claude', null, null],
        ['claude', 'acc_work', 'Work'],
        ['claude', 'acc_personal', 'Personal'],
        ['codex', null, null],
        ['codex', 'acc_codex', 'Codex extra'],
      ].map(([family, accountId, accountLabel]) => ({
        id: `builtin_${family}_subscription${accountId ? `@${accountId}` : ''}`,
        name: `${family} subscription`,
        kind: `${family}-subscription`,
        baseURL: `${family}://subscription`,
        accountId: accountId ?? undefined,
        accountLabel: accountLabel ?? undefined,
        builtIn: true,
        connected: true,
        apiKeyPresent: false,
      }))
      const replace = (channel: string, handler: Parameters<typeof ipcMain.handle>[1]) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      replace('chat:config', () => {
        state.reads++
        return {
          providers,
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
          subscriptionFailover: {
            supportedKinds: ['codex-subscription', 'claude-subscription'],
            routes: state.routes,
          },
        }
      })
      replace('chat:subscription-failover:set-route', (_event, input: Route) => {
        const route = {
          ...input,
          fallbackProviderIds: [...input.fallbackProviderIds],
        }
        state.routes = [...state.routes.filter((entry) => entry.primaryProviderId !== route.primaryProviderId), route]
        state.writes.push(route)
        return { ok: true, route }
      })
      for (const family of ['codex', 'claude', 'github-copilot', 'grok']) {
        replace(`chat:${family}-subscription:status`, () => ({
          state: 'signed-in',
          authenticated: true,
          email: `${family}@example.com`,
        }))
      }
      replace('chat:models', () => [])
      replace('chat:subscription-usage', (_event, payload) => ({
        state: 'ready',
        ...payload,
        fetchedAt: Date.now(),
        windows: [],
      }))
      replace('runtime-assets:status', (_event, id) => ({
        id,
        displayName: id,
        requiredBy: 'test',
        availableVersion: '1.0.0',
        downloadBytes: 1,
        unpackedBytes: 1,
        status: { id, state: 'ready', version: '1.0.0', diskUsageBytes: 1 },
      }))
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
    })
    // Reload after stubbing so every settings read uses the isolated fake accounts.
    await win.reload()
    await win.getByRole('button', { name: copy.settings, exact: true }).click()
    const card = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="acc_work"]')
    const checkbox = card.getByRole('checkbox', {
      name: new RegExp(copy.rotation),
    })
    const dropdown = card.getByRole('combobox', { name: copy.add })
    const saved = async () =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __rotation: StubState }).__rotation)
    const expectSaved = async (fallbackProviderIds: string[]) => {
      await expect
        .poll(async () => (await saved()).routes)
        .toEqual([{ primaryProviderId: work, enabled: true, fallbackProviderIds }])
      await expect(checkbox).toBeEnabled()
    }
    await expect(checkbox).not.toBeChecked()
    await checkbox.check()
    await expectSaved([])
    await expect(dropdown).toHaveText(copy.add)
    await dropdown.click()
    await expect(win.getByRole('option')).toHaveText([copy.add, copy.default, 'Personal'])
    await testInfo.attach('Standard select open', { body: await win.screenshot({ path: testInfo.outputPath('standard-select-open.png'), animations: 'disabled', style: 'html { background: #252929 !important; }' }), contentType: 'image/png' })
    await win.getByRole('option', { name: copy.default, exact: true }).click()
    await expectSaved([claude])
    await expect(dropdown).toHaveText(copy.add)
    await dropdown.focus()
    await win.keyboard.press('ArrowDown')
    await expect(win.getByRole('option')).toHaveText([copy.add, 'Personal'])
    await win.keyboard.press('Escape')
    await expect(dropdown).toBeFocused()
    await dropdown.click()
    await expect(win.getByRole('option', { name: copy.add, exact: true })).toBeFocused()
    await win.keyboard.press('End')
    await expect(win.getByRole('option', { name: 'Personal', exact: true })).toBeFocused()
    await win.keyboard.press('Enter')
    await expectSaved([claude, personal])
    await expect(dropdown).toHaveCount(0)
    await expect(card.getByRole('button', { name: copy.up, exact: true }).first()).toBeDisabled()
    await card.getByRole('button', { name: copy.up, exact: true }).nth(1).click()
    await expectSaved([personal, claude])
    await expect(card.getByRole('button', { name: copy.remove, exact: true }).first().locator('..')).toContainText(
      'Personal'
    )
    await card.getByRole('button', { name: copy.down, exact: true }).first().click()
    await expectSaved([claude, personal])
    await card.getByRole('button', { name: copy.remove, exact: true }).first().click()
    await expectSaved([personal])
    await dropdown.click()
    await expect(win.getByRole('option')).toHaveText([copy.add, copy.default])
    await win.keyboard.press('Escape')
    const reads = (await saved()).reads
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:claude-subscription:auth-changed', {
        state: 'signed-in',
        authenticated: true,
      })
    })
    await expect.poll(async () => (await saved()).reads).toBeGreaterThan(reads)
    await expect(checkbox).toBeChecked()
    await win.getByRole('button', { name: copy.close, exact: true }).click()
    await win.getByRole('button', { name: copy.settings, exact: true }).click()
    await expect(checkbox).toBeChecked()
    await expect(card.getByRole('button', { name: copy.remove, exact: true })).toHaveCount(1)
    await expect(card.getByRole('button', { name: copy.remove, exact: true }).locator('..')).toContainText('Personal')
    await expectSaved([personal])
    await dropdown.click()
    await expect(win.getByRole('option')).toHaveText([copy.add, copy.default])
    await win.keyboard.press('Escape')
    const shot = testInfo.outputPath(`claude-rotation-${locale}.png`)
    await card.screenshot({ path: shot, animations: 'disabled' })
    await testInfo.attach('Saved Claude rotation', {
      path: shot,
      contentType: 'image/png',
    })
  })
}
