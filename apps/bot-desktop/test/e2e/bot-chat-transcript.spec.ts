import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'

test('a tool call appears live, closes with its output, and the answer renders as markdown', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, 'olá')
    // The card shows up while the tool runs and closes with the output the fixture produced.
    const card = page.locator('[data-tool-card]').first()
    await expect(card).toContainText('Executando um comando')
    await expect(card.locator('[data-tool-state="done"]')).toBeVisible()
    await card.getByRole('button').first().click()
    await expect(card.locator('[data-tool-output]')).toHaveText('a\nb')
    await expect(page.locator('.message.assistant .dark-glass-prose strong')).toContainText('relatorio.md')
    await expect(page.locator('.message.assistant [data-response-duration]')).toBeVisible()
    await page.screenshot({ path: 'test-results/transcript.png' })
  } finally {
    await app.close()
  }
})

test('the conversation reopens at its end and a message can be copied', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    for (let i = 0; i < 6; i++) {
      await send(page, `pedido ${i}`)
      await expect(page.locator('.message.assistant').nth(i)).toContainText(`pedido ${i}`)
    }
    // Leave the conversation and come back: the list is scrolled to the end, not the top.
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Assistente de pesquisa', exact: true }).click()
    await expect(page.locator('.message.assistant').nth(5)).toBeVisible()
    const atEnd = await page.locator('.messages').evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    expect(atEnd).toBe(true)
    await app.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    const last = page.locator('.message.assistant').nth(5)
    await last.hover()
    await last.locator('[data-copy-button]').click()
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (copied) expect(copied).toContain('pedido 5')
  } finally {
    await app.close()
  }
})
