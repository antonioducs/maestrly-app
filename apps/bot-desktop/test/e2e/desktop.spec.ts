import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
test('real Electron UI fixture: connect, resources, failure, delete confirmation, stale state', async () => {
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(async () => {
      await window.bot.saveDraft(null)
      await window.bot.savePreferences({ locale: 'pt-BR' })
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Criar meu primeiro bot' })).toBeEnabled()
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('combobox', { name: 'Idioma', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: 'Computers', exact: true }).click()
    await page.getByLabel('SSH configuration alias').fill('local')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByLabel('Host resources')).toContainText('32')
    await expect(page.locator('.events')).toContainText('Fixture event 105')
    await expect(page.getByRole('button', { name: /Build worker/ })).toContainText('Desired: stopped')
    await page.getByRole('button', { name: /Build worker/ }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Operation' })).toContainText('Operation queued')
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Operation' })).toContainText('Operation failed')
    await expect(page.getByRole('status').filter({ hasText: 'Operation' })).toContainText('Fixture: VM launch failed')
    await page.getByRole('button', { name: /Build worker/ }).click()
    await page.screenshot({ path: 'test-results/fixture-connected.png', fullPage: true })
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    await page.getByRole('button', { name: 'Remove VM', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove VM, retain data' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Delete VM and data' })).toHaveCount(0)
    await page.getByLabel('Delete VM data permanently').check()
    await expect(page.getByRole('button', { name: 'Delete VM and data' })).toBeEnabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Create VM', exact: true }).click()
    await page.getByRole('dialog').getByRole('combobox', { name: 'Image', exact: true }).click()
    await expect(page.getByRole('option', { name: 'Linux fixture', exact: true })).toBeVisible()
    await page.getByRole('option', { name: 'Linux fixture', exact: true }).click()
    expect(await page.getByRole('dialog').locator('form').evaluate(form => { const data = new FormData(form as HTMLFormElement); return { image: data.get('image'), runtime: data.get('runtime') } })).toMatchObject({ image: 'fixture-linux', runtime: 'qemu' })
    await page.getByLabel('Name', { exact: true }).fill('New fixture worker')
    await page.getByRole('dialog').getByRole('button', { name: 'Create VM' }).click()
    await expect(page.getByRole('button', { name: /New fixture worker/ })).toBeVisible()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByText(/displayed state is stale/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create VM', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(page.getByText(/displayed state is stale/)).toHaveCount(0)
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toContain(
      'io.github.antonioducs.maestrly.bot.fixture'
    )
  } finally {
    await app.close()
  }
})
test('fixture removal retains data until the explicit purge checkbox is checked', async () => {
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(async () => {
      await window.bot.saveDraft(null)
      await window.bot.savePreferences({ locale: 'pt-BR' })
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Criar meu primeiro bot' })).toBeEnabled()
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('combobox', { name: 'Idioma', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: 'Computers', exact: true }).click()
    await page.getByLabel('SSH configuration alias').fill('local')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('button', { name: /Build worker/ }).click()
    await page.getByRole('button', { name: 'Remove VM', exact: true }).click()
    await page.getByRole('button', { name: 'Remove VM, retain data' }).click()
    await expect(page.getByLabel('Retained disks')).toContainText('Build worker')
    await page.getByRole('button', { name: /Inspect retained data/ }).click()
    await page.getByRole('button', { name: 'Purge retained disk', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove VM, retain data' })).toBeDisabled()
    await page.getByLabel('Delete VM data permanently').check()
    await page.getByRole('button', { name: 'Delete VM and data' }).click()
    await expect(page.getByRole('button', { name: /Inspect retained data/ })).toHaveCount(0)
    await expect(page.getByText('Removed · Disk data deleted.')).toBeVisible()
  } finally {
    await app.close()
  }
})

for (const outcome of ['accepted', 'unaccepted']) {
  test(`fixture lost ${outcome} reply recovers by lookup or explicit same-request retry`, async () => {
    const app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1', MAESTRLY_BOT_FIXTURE_LOST_REPLY: outcome },
    })
    try {
      const page = await app.firstWindow()
      await page.evaluate(async () => {
        await window.bot.saveDraft(null)
        await window.bot.savePreferences({ locale: 'pt-BR' })
      })
      await page.reload()
      await expect(page.getByRole('button', { name: 'Criar meu primeiro bot' })).toBeEnabled()
      await page.getByRole('button', { name: 'Configurações', exact: true }).click()
      await page.getByRole('combobox', { name: 'Idioma', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
      await page.getByRole('button', { name: 'Advanced', exact: true }).click()
      await page.getByRole('button', { name: 'Computers', exact: true }).click()
      await page.getByLabel('SSH configuration alias').fill('local')
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      await page.getByRole('button', { name: /Build worker/ }).click()
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(page.getByText(/displayed state is stale/)).toBeVisible()
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      if (outcome === 'unaccepted') {
        await expect(page.getByRole('button', { name: 'Create VM', exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Retry same request' })).toBeVisible()
        await page.getByRole('button', { name: 'Retry same request' }).click()
      } else await expect(page.getByRole('button', { name: 'Retry same request' })).toHaveCount(0)
      await expect(page.getByRole('status').filter({ hasText: 'Operation' })).toContainText('Operation failed')
      expect(await page.evaluate(async () => (await window.bot.status()).lastOperation?.id)).toBe('op-0')
    } finally {
      await app.close()
    }
  })
}
test('new fixture client discovers retained disks without a removal journal and purges data', async () => {
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1', MAESTRLY_BOT_FIXTURE_RETAINED: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(async () => {
      await window.bot.saveDraft(null)
      await window.bot.savePreferences({ locale: 'pt-BR' })
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Criar meu primeiro bot' })).toBeEnabled()
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('combobox', { name: 'Idioma', exact: true }).click()
    await page.getByRole('option', { name: 'English', exact: true }).click()
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: 'Computers', exact: true }).click()
    await page.getByLabel('SSH configuration alias').fill('local')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    expect(await page.evaluate(async () => (await window.bot.status()).retainedVmIds)).toEqual([])
    await expect(page.getByLabel('Retained disks')).toContainText('Build worker')
    await page.getByRole('button', { name: /Inspect retained data/ }).click()
    await page.getByRole('button', { name: 'Purge retained disk', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove VM, retain data' })).toBeDisabled()
    await page.getByLabel('Delete VM data permanently').check()
    await page.getByRole('button', { name: 'Delete VM and data' }).click()
    await expect(page.getByText('Removed · Disk data deleted.')).toBeVisible()
    expect(
      await page.evaluate(() => window.bot.call({ method: 'vm.list', params: { includeRetained: true } }))
    ).toEqual([])
    expect(
      await page.evaluate(() => window.bot.call({ method: 'vm.inspect', params: { vmId: 'fixture-vm' } }))
    ).toMatchObject({ diskRetained: false })
  } finally {
    await app.close()
  }
})
