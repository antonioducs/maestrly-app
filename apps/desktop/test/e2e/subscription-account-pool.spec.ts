import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatSubscriptionAccountPoolInfo, ChatSubscriptionAccountPoolPatch } from '../../src/shared/chat'

test.use({ actionTimeout: 15_000, navigationTimeout: 20_000, trace: 'retain-on-failure' })

const mainEntry = fileURLToPath(new URL('../../out/main/index.js', import.meta.url))
const kind = 'claude-subscription' as const
const claude = 'builtin_claude_subscription'
const work = `${claude}@acc_work`
const personal = `${claude}@acc_personal`
type PoolPatch = ChatSubscriptionAccountPoolPatch
interface StubState {
  pools: ChatSubscriptionAccountPoolInfo[]
  writes: unknown[]
}
declare const window: {
  api: { setOnboardingDone(done: boolean): Promise<void> }
}
let app: ElectronApplication | null = null
let userDataDir: string

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-account-pool-'))
})
test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(userDataDir, { recursive: true, force: true })
})

for (const locale of ['en', 'pt-BR'] as const) {
  test(`Claude active account changes, follows the policy and shrinks the rotation (${locale})`, async ({
    browserName: _browserName,
  }, testInfo) => {
    const copy =
      locale === 'en'
        ? {
            settings: 'Settings',
            badge: 'Active',
            isActive: 'This is the active account',
            makeActive: 'Make this the active account',
            preferActive: 'Return to the active account',
            remove: 'Remove from the rotation',
            add: 'Add account to the rotation',
          }
        : {
            settings: 'Configurações',
            badge: 'Ativa',
            isActive: 'Esta é a conta ativa',
            makeActive: 'Tornar esta a conta ativa',
            preferActive: 'Voltar para a conta ativa',
            remove: 'Remover do rodízio',
            add: 'Adicionar conta ao rodízio',
          }
    app = await electron.launch({
      executablePath: process.env.MAESTRLY_PACKAGED_EXECUTABLE,
      args: process.env.MAESTRLY_PACKAGED_EXECUTABLE ? ['--use-mock-keychain'] : [mainEntry],
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `account-pool-${locale}-${Date.now()}`,
        AGENTS_USERDATA: userDataDir,
        AGENTS_LOCALE: locale,
        ELECTRON_RENDERER_URL: '',
      },
    })
    const win = await app.firstWindow({ timeout: 20_000 })
    await win.waitForFunction(() => typeof window.api !== 'undefined', null, { timeout: 15_000 })
    await win.evaluate(() => window.api.setOnboardingDone(true))
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, ids) => {
        const state: StubState = {
          pools: [
            {
              kind: ids.kind,
              providerId: `${ids.claude}@~active`,
              name: 'Claude — Active account (Default account)',
              connected: true,
              memberProviderIds: [ids.claude, ids.work, ids.personal],
              activeProviderId: ids.claude,
              policy: 'drain',
              customMembers: false,
            },
          ],
          writes: [],
        }
        ;(globalThis as typeof globalThis & { __accountPool: StubState }).__accountPool = state
        const providers = [
          ['claude', null, null],
          ['claude', 'acc_work', 'Work'],
          ['claude', 'acc_personal', 'Personal'],
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
            subscriptionFailover: { supportedKinds: ['claude-subscription'], routes: [] },
            subscriptionAccountPools: state.pools,
          }
        })
        replace('chat:subscription-account-pool:set', (_event, patch: PoolPatch) => {
          state.writes.push({ ...patch })
          const pool = {
            ...state.pools[0]!,
            ...(patch.memberProviderIds
              ? { memberProviderIds: [...patch.memberProviderIds], customMembers: true }
              : {}),
            ...(patch.activeProviderId ? { activeProviderId: patch.activeProviderId } : {}),
            ...(patch.policy ? { policy: patch.policy } : {}),
          }
          state.pools = [pool]
          return { ok: true, pool }
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
      },
      { kind, claude, work, personal }
    )
    // Reload after stubbing so every settings read uses the isolated fake accounts.
    await win.reload()
    await win.getByRole('button', { name: copy.settings, exact: true }).click()
    const defaultRow = win.locator(`[data-account-entry="${claude}"]`)
    const workRow = win.locator(`[data-account-entry="${work}"]`)
    await expect(defaultRow.getByText(copy.badge, { exact: true })).toBeVisible()
    await expect(workRow.getByText(copy.badge, { exact: true })).toHaveCount(0)
    await workRow.click()
    const card = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="acc_work"]')
    const section = card.locator(`[data-account-pool="${kind}"]`)
    const saved = async () =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __accountPool: StubState }).__accountPool)
    const lastWrite = async () => (await saved()).writes.at(-1)

    // Making the opened account the active one writes only the new active account.
    await expect(section.getByText(copy.isActive, { exact: true })).toHaveCount(0)
    await section.getByRole('button', { name: copy.makeActive, exact: true }).click()
    await expect.poll(async () => (await saved()).writes).toEqual([{ kind, activeProviderId: work }])
    await expect(section.getByText(copy.isActive, { exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: copy.makeActive, exact: true })).toHaveCount(0)
    await expect(workRow.getByText(copy.badge, { exact: true })).toBeVisible()
    await expect(defaultRow.getByText(copy.badge, { exact: true })).toHaveCount(0)

    // The policy is a separate write.
    const preferActive = section.getByRole('radio', { name: copy.preferActive })
    await expect(preferActive).not.toBeChecked()
    await preferActive.click()
    await expect.poll(lastWrite).toEqual({ kind, policy: 'prefer-active' })
    await expect(preferActive).toBeChecked()

    // Removing an account keeps the others in their order.
    const personalItem = section.getByRole('listitem').filter({ hasText: 'Personal' })
    await personalItem.getByRole('button', { name: copy.remove, exact: true }).click()
    await expect.poll(lastWrite).toEqual({ kind, memberProviderIds: [claude, work] })
    await expect(section.getByRole('listitem').filter({ hasText: 'Personal' })).toHaveCount(0)
    expect((await saved()).writes).toHaveLength(3)
    const dropdown = section.getByRole('combobox', { name: copy.add })
    await dropdown.click()
    await expect(win.getByRole('option')).toHaveText([copy.add, 'Personal'])
    await win.keyboard.press('Escape')

    const shot = testInfo.outputPath(`claude-account-pool-${locale}.png`)
    await card.screenshot({ path: shot, animations: 'disabled' })
    await testInfo.attach('Claude account pool', { path: shot, contentType: 'image/png' })
  })
}
