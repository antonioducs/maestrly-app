import { mkdtempSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { FakeGateway } from './helpers/fake-bot-server'
import { instanceEnv } from './helpers/remote-host'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

/**
 * One computer paired with two bot servers at once: each is added in Settings → Bot servers, the same installation at
 * another address is refused before its code is spent, the Bots tab switches between them, Settings → Artifacts picks
 * where conversations publish, and disconnecting one keeps the other.
 */
test('pairs two bot servers, switches the Bots tab between them, and keeps one when the other leaves', async () => {
  test.setTimeout(150_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-servers-'))
  const home = new FakeGateway('mac-mini-bots', { artifacts: true })
  const vps = new FakeGateway('vps-bots', { artifacts: true, botName: 'Ledger' })
  let app: ElectronApplication | undefined
  let page!: Page
  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args }) as Promise<any>
  const servers = () => api('fleetServers') as Promise<Array<{ id: string; connection: { hostname: string | null } }>>
  const idOf = async (hostname: string) =>
    (await servers()).find((server) => server.connection.hostname === hostname)?.id

  const pair = async (url: string, code: string) => {
    await page.getByRole('button', { name: 'I already have a server', exact: true }).click()
    await page.getByLabel('Server address', { exact: true }).fill(url)
    await page.getByLabel('Pairing code').fill(code)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
  }

  try {
    await home.start(0)
    await vps.start(0)
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: instanceEnv(path.join(root, 'profile'), `servers-${Date.now().toString(36)}`),
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await api('setOnboardingDone', true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))

    // The first server, while none is paired: the setup choice.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Bot servers', exact: true }).first().click()
    await pair(`http://127.0.0.1:${home.port}`, home.issueCode())
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Connected' })).toContainText(
      'mac-mini-bots'
    )

    // A second one, added beside it.
    await page.locator('[data-fleet-add-server]').click()
    await pair(`http://127.0.0.1:${vps.port}`, vps.issueCode())
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Connected' })).toContainText('vps-bots')
    await expect.poll(async () => (await servers()).length).toBe(2)

    // The first server again, at another address: refused by its installation id, and its code is not spent.
    await page.locator('[data-fleet-add-server]').click()
    await pair(`http://localhost:${home.port}`, home.issueCode())
    await expect(page.getByRole('main').getByRole('alert')).toContainText('already paired with this bot server')
    expect(home.pairings).toHaveLength(1)
    expect((await servers()).length).toBe(2)
    // Back to the setup choice, then to the servers.
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Back', exact: true }).click()

    // Settings shows one server at a time, chosen at the top.
    const chooser = page.getByRole('combobox', { name: 'Bot server', exact: true })
    await chooser.click()
    await page.getByRole('option', { name: /^mac-mini-bots/ }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Connected' })).toContainText(
      'mac-mini-bots'
    )

    // Settings → Artifacts chooses where this computer's conversations publish.
    await page.getByRole('main').getByRole('button', { name: 'Artifacts', exact: true }).click()
    await page.getByTestId('artifacts-publish-server').click()
    await page.getByRole('option', { name: 'vps-bots', exact: true }).click()
    const vpsId = await idOf('vps-bots')
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.api.artifacts.servers()).filter((server) => server.publishing).map((server) => server.serverId)
        )
      )
      .toEqual([vpsId])
    await page.getByRole('button', { name: 'Close', exact: true }).first().click()

    // The Bots tab shows one server's bots, chosen in the switcher at its top.
    await page.getByRole('tab', { name: 'Bots' }).click()
    const bots = page.locator('#sidebar-panel-bots')
    const switcher = page.locator('[data-fleet-server-switcher]')
    await expect(switcher).toBeVisible()
    const homeId = await idOf('mac-mini-bots')
    await expect(switcher).toHaveAttribute('data-fleet-server-switcher', homeId!)
    await expect(bots).toContainText('Scout')
    await expect(bots).not.toContainText('Ledger')
    await switcher.click()
    await page.locator(`[data-fleet-server-option="${vpsId}"]`).click()
    await expect(switcher).toHaveAttribute('data-fleet-server-switcher', vpsId!)
    await expect(bots).toContainText('Ledger')
    await expect(bots).not.toContainText('Scout')
    // The choice outlives the window.
    expect(await page.evaluate(() => localStorage.getItem('fleet.server'))).toBe(vpsId)

    // Disconnecting one server keeps the other, and the switcher leaves with the second server.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Bot servers', exact: true }).first().click()
    await chooser.click()
    await page.getByRole('option', { name: /^vps-bots/ }).click()
    await page.getByRole('main').getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect
      .poll(async () => (await servers()).map((server) => server.connection.hostname))
      .toEqual(['mac-mini-bots'])
    await expect(chooser).toHaveCount(0)
    await page.getByRole('button', { name: 'Close', exact: true }).first().click()
    await page.getByRole('tab', { name: 'Bots' }).click()
    await expect(switcher).toHaveCount(0)
    await expect(bots).toContainText('Scout')
  } finally {
    await app?.close()
    await home.close()
    await vps.close()
    removeTempDirEventually(root)
  }
})
