import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'

test('a finished task shows up in the bot dialog and on the usage page, priced with the catalogue', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, 'Prepare um resumo')
    await expect(page.locator('.chat-header')).toContainText('Tarefa concluída')

    // The `$` of the conversation: this bot alone, last 30 days.
    await page.getByRole('button', { name: 'Uso e custos de Assistente de pesquisa', exact: true }).click()
    const dialog = page.getByTestId('quick-usage-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-usage-row="fixture-small"]')).toContainText('40.0k') // 50k input − 10k cached
    await expect(dialog.locator('[data-usage-row="fixture-small"]')).toContainText('~$')
    await page.getByRole('button', { name: 'Fechar', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // The page: every bot of the Host, by model and then by bot.
    await page.getByRole('button', { name: 'Uso e custos', exact: true }).click()
    await expect(page.locator('.usage-header')).toHaveCSS('height', '40px')
    expect(
      await page.locator('.usage-page').evaluate((node) => node.getBoundingClientRect().width)
    ).toBeLessThanOrEqual(672)
    const panel = page.locator('[data-usage-panel]')
    await expect(panel.locator('[data-usage-row="fixture-small"]')).toBeVisible()
    await expect(panel).toContainText('Total de tokens')
    await expect(page.getByRole('region', { name: 'Por bot' })).toContainText('Assistente de pesquisa')
    // A period is a real window: "today" still holds the task that just finished.
    await page.getByRole('button', { name: 'Hoje', exact: true }).click()
    await expect(panel.locator('[data-usage-row="fixture-small"]')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a Host without the chat experience gets an explanation instead of a request it cannot answer', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_CHAT: '1' })
  try {
    await readyBot(page)
    await expect(page.getByRole('button', { name: 'Uso e custos de Assistente de pesquisa' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Uso e custos', exact: true }).click()
    await expect(page.getByText('Atualize o Host para ver uso e custos.', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
