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
  test(`Claude rotation turns on, reorders, follows the policy and shows on each account (${locale})`, async ({
    browserName: _browserName,
  }, testInfo) => {
    const copy =
      locale === 'en'
        ? {
            settings: 'Settings',
            off: 'Off',
            turnOn: 'Turn on with 3 accounts',
            inUse: 'in use',
            moveUp: 'Move Personal up',
            preferActive: 'Return to the preferred account',
            preferred: 'Preferred account',
            autoJoin: 'Add new Claude accounts automatically',
            remove: 'Take Personal out of the rotation',
            add: 'Add an account to the rotation',
            memberInUse: 'In use by the rotation',
            manage: 'Manage',
            toggle: 'Turn on the Claude rotation',
          }
        : {
            settings: 'Configurações',
            off: 'Desativado',
            turnOn: 'Ativar rodízio com 3 contas',
            inUse: 'em uso',
            moveUp: 'Subir Personal',
            preferActive: 'Voltar para a preferida',
            preferred: 'Conta preferida',
            autoJoin: 'Incluir novas contas Claude automaticamente',
            remove: 'Tirar Personal do rodízio',
            add: 'Adicionar conta ao rodízio',
            memberInUse: 'Em uso pelo rodízio',
            manage: 'Gerenciar',
            toggle: 'Ativar o rodízio Claude',
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
              name: 'Claude — Active account',
              connected: true,
              memberProviderIds: [ids.claude, ids.work, ids.personal],
              activeProviderId: ids.claude,
              currentProviderId: ids.claude,
              policy: 'drain',
              customMembers: false,
              enabled: false,
              autoJoin: true,
              limitedUntil: {},
              recentSwitches: [],
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
        replace('chat:config', () => ({
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
        }))
        replace('chat:subscription-account-pool:set', (_event, patch: PoolPatch) => {
          state.writes.push({ ...patch })
          const before = state.pools[0]!
          const activeProviderId = patch.activeProviderId ?? before.activeProviderId
          const pool = {
            ...before,
            ...(patch.memberProviderIds
              ? { memberProviderIds: [...patch.memberProviderIds], customMembers: true }
              : {}),
            ...(patch.policy ? { policy: patch.policy } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.autoJoin !== undefined ? { autoJoin: patch.autoJoin } : {}),
            activeProviderId,
            currentProviderId: activeProviderId,
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
    const poolRow = win.locator(`[data-account-entry="account-pool:${kind}"]`)
    const defaultRow = win.locator(`[data-account-entry="${claude}"]`)
    const workRow = win.locator(`[data-account-entry="${work}"]`)
    const panel = win.locator(`[data-account-pool-panel="${kind}"]`)
    const saved = async () =>
      app!.evaluate(() => (globalThis as typeof globalThis & { __accountPool: StubState }).__accountPool)
    const lastWrite = async () => (await saved()).writes.at(-1)

    // The rotation leads its provider's accounts; while off, no account shows a place in it.
    await expect(poolRow).toContainText(copy.off)
    await expect(workRow.getByText('#2', { exact: true })).toHaveCount(0)
    await poolRow.click()
    await expect(panel.getByRole('switch', { name: copy.toggle })).not.toBeChecked()
    await panel.getByRole('button', { name: copy.turnOn, exact: true }).click()
    await expect.poll(async () => (await saved()).writes).toEqual([{ kind, enabled: true }])
    await expect(panel.getByRole('switch', { name: copy.toggle })).toBeChecked()
    await expect(defaultRow.getByText(copy.inUse, { exact: true })).toBeVisible()
    await expect(workRow.getByText('#2', { exact: true })).toBeVisible()

    // The queue order is a write of the whole rotation.
    await panel.getByRole('button', { name: copy.moveUp, exact: true }).click()
    await expect.poll(lastWrite).toEqual({ kind, memberProviderIds: [claude, personal, work] })
    await expect(panel.locator('[data-account-pool-member]')).toHaveText([/^1/, /^2.*Personal/, /^3.*Work/])

    // Returning to a preferred account asks which one.
    await panel.getByRole('radio', { name: copy.preferActive }).click()
    await expect.poll(lastWrite).toEqual({ kind, policy: 'prefer-active' })
    await expect(panel.getByRole('radio', { name: copy.preferActive })).toHaveAttribute('aria-checked', 'true')
    await panel.getByRole('combobox', { name: copy.preferred }).click()
    await win.getByRole('option', { name: 'Work', exact: true }).click()
    await expect.poll(lastWrite).toEqual({ kind, activeProviderId: work })

    await panel.getByRole('switch', { name: copy.autoJoin }).click()
    await expect.poll(lastWrite).toEqual({ kind, autoJoin: false })

    // An account taken out can be added back.
    await panel.getByRole('button', { name: copy.remove, exact: true }).click()
    await expect.poll(lastWrite).toEqual({ kind, memberProviderIds: [claude, work] })
    await panel.getByRole('combobox', { name: copy.add }).click()
    await expect(win.getByRole('option')).toHaveText([copy.add, 'Personal'])
    await win.keyboard.press('Escape')
    expect((await saved()).writes).toHaveLength(6)

    const panelShot = testInfo.outputPath(`claude-account-pool-${locale}.png`)
    await panel.screenshot({ path: panelShot, animations: 'disabled' })
    await testInfo.attach('Claude rotation', { path: panelShot, contentType: 'image/png' })

    // Each account's page tells where it stands and leads back to the rotation.
    await workRow.click()
    const card = win.locator('[data-subscription-provider="claude-subscription"][data-subscription-account="acc_work"]')
    const membership = card.locator(`[data-account-pool-membership="${kind}"]`)
    await expect(membership).toContainText(copy.memberInUse)
    await membership.getByRole('button', { name: copy.manage, exact: true }).click()
    await expect(panel).toBeVisible()
  })
}
