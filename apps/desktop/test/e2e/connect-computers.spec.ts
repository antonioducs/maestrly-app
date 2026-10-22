import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { desktop, freePort, instanceEnv } from './helpers/remote-host'

/** A desktop of the owner in normal mode, with a profile of its own, past its first-run screen. */
async function launch(profile: string, instance: string) {
  const app = await electron.launch({
    args: [path.join(desktop, 'out/main/index.js')],
    env: instanceEnv(profile, instance),
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean((window as any).api))
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  const api = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
  return { app, page, api }
}

/** Opens Settings → Computers. */
async function openComputers(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Computers', exact: true }).click()
  await expect(page.locator('[data-settings-computers]')).toBeVisible()
}

/** Leaves Settings, which hides the sidebar's panel while it shows. */
async function closeSettings(page: Page) {
  await page.getByRole('heading', { name: 'Settings', exact: true }).locator('..').getByTitle('Close').click()
  await expect(page.locator('[data-settings-computers]')).toHaveCount(0)
}

/** Opens Settings → Computers and names this computer as it shows on the owner's other computers. */
async function computers(page: Page, name: string) {
  await openComputers(page)
  const field = page.getByLabel('This computer’s name')
  await field.fill(name)
  await field.press('Enter')
  await expect(field).toHaveValue(name)
}

// Two real Electron instances of the built app on this machine, both in normal mode: A lets the owner's other
// computers use it, and B pairs with it by its address and the code A shows. Their peer servers listen on loopback.
test('connect computers: pair by code, see who uses this computer, disconnect and remove', async () => {
  test.setTimeout(240_000)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-connect-computers-')))
  let a: ElectronApplication | undefined
  let b: ElectronApplication | undefined
  try {
    const onA = await launch(path.join(root, 'a'), 'peer-a-e2e')
    a = onA.app
    const onB = await launch(path.join(root, 'b'), 'peer-b-e2e')
    b = onB.app

    // A shares itself and says where it can be reached.
    await computers(onA.page, 'Studio')
    const hosting = onA.page.locator('[data-peer-hosting]')
    await expect(hosting).toHaveAttribute('aria-checked', 'false')
    await expect(onA.page.getByText('A paired computer can do everything you can do here')).toBeVisible()
    await hosting.click()
    await expect(hosting).toHaveAttribute('aria-checked', 'true')
    await expect(onA.page.locator('[data-peer-visible]')).toContainText('Visible as Studio at')
    await expect.poll(async () => (await onA.api('peerOverview')).port).not.toBeNull()
    const { port } = (await onA.api('peerOverview')) as { port: number }

    // B asks A to pair at its address; A shows a code, which the owner types on B.
    await computers(onB.page, 'Laptop')
    await expect(onB.page.getByText('No paired computers.')).toBeVisible()
    await onB.page.locator('[data-peer-connect]').click()
    const connect = onB.page.locator('[data-peer-connect-dialog]')
    await connect.getByLabel('Address of the other computer').fill('127.0.0.1:1')
    await connect.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connect.getByRole('alert')).toContainText('Nothing answered at 127.0.0.1:1.')
    await connect.getByLabel('Address of the other computer').fill(`127.0.0.1:${port}`)
    await connect.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(connect).toHaveAttribute('data-peer-connect-dialog', 'code')
    await expect(connect).toContainText('Type the code shown on Studio')

    const prompt = onA.page.locator('[data-peer-prompt]')
    await expect(prompt).toHaveAttribute('data-peer-prompt', 'waiting')
    await expect(prompt).toContainText('Laptop wants to use this computer')
    await expect(prompt).toContainText('Only type it if you asked for it.')
    const code = (await prompt.locator('[data-peer-code]').getAttribute('data-peer-code')) ?? ''
    expect(code).toMatch(/^\d{6}$/)

    await connect.getByLabel('Pairing code').fill(code)
    await connect.getByRole('button', { name: 'Pair', exact: true }).click()
    await expect(connect).toHaveAttribute('data-peer-connect-dialog', 'paired')
    await expect(connect).toContainText('Paired with Studio')
    await expect(prompt).toHaveAttribute('data-peer-prompt', 'paired')
    await prompt.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(prompt).toHaveCount(0)

    // B opens A from the dialog: the machine switcher shows it, reached.
    const [studio] = (await onB.api('peerOverview')).computers as Array<{ deviceId: string; name: string }>
    expect(studio.name).toBe('Studio')
    const studioHost = `peer/${studio.deviceId}`
    await connect.getByRole('button', { name: 'Open Studio', exact: true }).click()
    const switcher = onB.page.locator('[data-host-switcher]')
    await expect(switcher).toHaveAttribute('data-host-switcher', studioHost)
    await expect(switcher).toContainText('Studio')
    await expect
      .poll(async () => (await onB.api('hostsList')).find((host: { id: string }) => host.id === studioHost)?.state)
      .toBe('online')
    await switcher.click()
    await expect(onB.page.locator('[data-host-connect]')).toContainText('Connect another computer…')
    await onB.page.keyboard.press('Escape')

    // A says who uses it, since when, and lets the owner disconnect it; they stay paired.
    await expect(onA.page.locator('[data-peer-computer]')).toContainText('Using this computer since')
    await closeSettings(onA.page)
    const chip = onA.page.locator('[data-peer-in-use]')
    await expect(chip).toContainText('In use by Laptop')
    await chip.click()
    await expect(onA.page.locator('[data-peer-using]')).toContainText('Connected since')
    await onA.page.locator('[data-peer-disconnect]').click()
    await expect(chip).toHaveCount(0)
    const notice = onB.page.locator('[data-host-notice]:visible')
    await expect(notice).toHaveAttribute('data-host-notice', 'disconnected')
    await expect(notice).toContainText('Studio disconnected this computer. They stay paired.')
    // A disconnected computer is not dialed again on its own.
    await onB.page.waitForTimeout(1_500)
    await expect(chip).toHaveCount(0)
    await notice.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(chip).toContainText('In use by Laptop')

    // A moves to a port the owner chooses: B, connected, follows it there.
    await openComputers(onA.page)
    const moved = await freePort()
    await onA.page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await onA.page.getByLabel('Port').fill(String(moved))
    await onA.page.getByRole('button', { name: 'Use port', exact: true }).click()
    await expect.poll(async () => (await onA.api('peerOverview')).port).toBe(moved)
    await expect(onA.page.locator('[data-peer-visible]')).toContainText(`:${moved}`)
    await expect
      .poll(async () => ((await onB.api('peerOverview')).computers as Array<{ address: string }>)[0]?.address)
      .toBe(`127.0.0.1:${moved}`)
    await expect
      .poll(async () => (await onB.api('hostsList')).find((host: { id: string }) => host.id === studioHost)?.state)
      .toBe('online')
    await expect(onA.page.locator('[data-peer-computer]')).toContainText('Using this computer since')

    // A removes B: B is cut off at once and offers to pair again.
    await expect(onA.page.locator('[data-peer-computer]')).toContainText('Laptop')
    await onA.page.getByRole('button', { name: 'Remove Laptop', exact: true }).click()
    await expect(onA.page.getByRole('dialog')).toContainText('Laptop stops using this computer at once')
    await onA.page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(onA.page.locator('[data-peer-computer]')).toHaveCount(0)
    await expect(onA.page.getByText('No paired computers.')).toBeVisible()
    await expect(notice).toHaveAttribute('data-host-notice', 'removed')
    await expect(notice).toContainText('Studio removed this computer.')
    await expect(notice.getByRole('button', { name: 'Pair again', exact: true })).toBeVisible()
    await notice.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect.poll(async () => (await onB.api('peerOverview')).computers).toEqual([])
    // This computer alone is left: the window lists no machine to switch to.
    await expect
      .poll(async () => (await onB.api('hostsList')).map((host: { id: string }) => host.id))
      .toEqual(['local'])
    await expect(switcher).toHaveCount(0)
  } finally {
    await b?.close().catch(() => undefined)
    await a?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
