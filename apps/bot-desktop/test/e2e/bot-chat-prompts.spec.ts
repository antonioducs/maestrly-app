import { expect, test } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

test('a stored command is created in settings, picked from the palette and sent expanded', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Novo comando', exact: true }).click()
    await page.getByLabel('Nome do comando', { exact: true }).fill('resumo')
    await page.getByLabel('Descrição', { exact: true }).fill('Resumo do dia')
    await page.getByLabel('Texto do comando', { exact: true }).fill('Faça um resumo de $ARGUMENTS em três linhas')
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.locator('.prompt-row')).toContainText('/resumo')
    await page.getByRole('button', { name: 'Assistente de pesquisa', exact: true }).click()
    const composer = page.getByRole('textbox', { name: 'Mensagem', exact: true })
    await composer.fill('/res')
    const palette = page.getByRole('listbox', { name: 'Comandos' })
    await expect(palette).toContainText('/resumo')
    await expect(palette).toContainText('Resumo do dia')
    await palette.getByRole('option').first().click()
    await expect(composer).toHaveValue('/resumo ')
    await composer.fill('/resumo hoje')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    // What reached the bot is the expanded text, not the shortcut.
    await expect(page.locator('.message.user p')).toHaveText('Faça um resumo de hoje em três linhas')
    await expect(page.locator('.chat-header')).toContainText('Tarefa concluída')
  } finally {
    await app.close()
  }
})
