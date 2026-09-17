import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'

const inspect = (page: Parameters<typeof send>[0]) =>
  page.evaluate(async () => {
    const [bot] = await window.bot.bot({ method: 'bot.list', params: {} })
    return window.bot.bot({ method: 'bot.inspect', params: { botId: bot.id } })
  })

test('the composer changes the model and the permission mode on the bot itself', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    const before = await inspect(page)
    await page.locator('[data-model-chip]').click()
    expect(before.model?.model).toBe('fixture-small')
    await page.getByRole('option', { name: /Fixture large/i }).click()
    await expect.poll(async () => (await inspect(page)).model?.model).toBe('fixture-large')
    await expect(page.locator('[data-model-chip]')).toContainText(/Fixture large/i)
    // Full access needs the explicit confirmation before anything changes.
    await page.locator('[data-perm-picker]').click()
    await page.getByRole('option', { name: /Acesso completo/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    expect((await inspect(page)).permissionMode).toBe('ask')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Ativar acesso ampliado', exact: true }).click()
    await expect.poll(async () => (await inspect(page)).permissionMode).toBe('full-vm')
    await expect(page.locator('[data-perm-picker]')).toContainText('Acesso completo')
    await page.screenshot({ path: 'test-results/composer.png' })
  } finally {
    await app.close()
  }
})

test('the pickers wait while a task runs, with the reason on hover', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, 'Prepare um relatório #slow')
    await expect(page.getByRole('button', { name: 'Parar tarefa', exact: true })).toBeVisible()
    for (const selector of ['[data-model-chip]', '[data-perm-picker]']) {
      await expect(page.locator(selector)).toBeDisabled()
      await expect(page.locator(selector)).toHaveAttribute('title', /Espere a tarefa atual terminar/)
    }
    await page.getByRole('button', { name: 'Parar tarefa', exact: true }).click()
    await expect(page.locator('.chat-header')).toContainText('Tarefa interrompida')
    await expect(page.locator('[data-model-chip]')).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('after a task the meter shows the window occupancy and an estimated cost', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await expect(page.locator('[data-context-meter]')).toHaveCount(0)
    await send(page, 'Prepare um relatório')
    await expect(page.locator('.chat-header')).toContainText('Tarefa concluída')
    const meter = page.locator('[data-context-meter]')
    await expect(meter).toContainText('50.0k/200k 25%')
    await expect(meter).toContainText('~$')
  } finally {
    await app.close()
  }
})
