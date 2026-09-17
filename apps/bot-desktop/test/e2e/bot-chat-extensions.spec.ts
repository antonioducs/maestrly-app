import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

const SECRET = 'sk-fixture-secret-9f2e'

test('an MCP server and a skill are configured per bot, secrets never come back, and the composer shows what is on', async () => {
  // The folder name becomes the skill name.
  const folder = join(await mkdtemp(join(tmpdir(), 'skill-')), 'verificacao')
  await mkdir(folder)
  await writeFile(join(folder, 'SKILL.md'), '---\ndescription: Verifica os números antes de responder\n---\n# Verificação\n')
  await mkdir(join(folder, 'scripts'))
  await writeFile(join(folder, 'scripts/check.sh'), '#!/bin/sh\necho ok\n')
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_PICK_FOLDER: folder })
  try {
    await readyBot(page)
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    await page.getByRole('button', { name: 'Extensões', exact: true }).first().click()
    await page.getByRole('button', { name: 'Novo servidor MCP', exact: true }).click()
    await page.getByLabel('Nome do servidor', { exact: true }).fill('echo')
    await page.getByLabel('Comando', { exact: true }).fill('npx')
    await page.getByLabel('Argumentos (um por linha)', { exact: true }).fill('-y\necho-mcp')
    await page.getByRole('button', { name: 'Adicionar variável', exact: true }).click()
    await page.getByLabel('Variável', { exact: true }).fill('TOKEN')
    await page.getByLabel('Valor', { exact: true }).fill(SECRET)
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    const row = page.locator('.extension-row').filter({ hasText: 'echo' })
    await expect(row).toContainText('npx -y echo-mcp')
    await expect(row).toContainText('TOKEN')
    // The value went in once and is nowhere on the screen, not even in the edit form.
    await expect(page.locator('body')).not.toContainText(SECRET)
    await row.getByRole('button', { name: 'Editar', exact: true }).click()
    await expect(page.getByLabel('Valor', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Valor', { exact: true })).toHaveAttribute('placeholder', 'guardado')
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()

    // A skill comes from a folder; the name is the folder's, the description is the SKILL.md's.
    await page.getByRole('button', { name: 'Instalar de uma pasta', exact: true }).click()
    const skill = page.locator('.extension-row').filter({ hasText: 'Verifica os números' })
    await expect(skill).toContainText(/verificacao/)
    await expect(skill).toContainText('2 arquivos')

    // The composer says what this bot carries into its next turn.
    const chip = page.locator('.composer .extension-chip')
    await expect(chip).toContainText('MCP: 1')
    await expect(chip).toContainText('Skills: 1')
    // Pausing the skill takes it off the chip without removing it.
    // The box is controlled by the Host's answer: a click, then the state that comes back.
    await page.getByLabel('Ativo verificacao', { exact: true }).click()
    await expect(page.getByLabel('Ativo verificacao', { exact: true })).not.toBeChecked()
    await expect(chip).not.toContainText('Skills')
    await expect(skill).toBeVisible()
    expect(await page.evaluate(() => window.bot.extension({ method: 'extension.inspect', params: { botId: '' } }).catch(() => 'refused'))).toBe('refused')
  } finally {
    await app.close()
  }
})

test('a Host without the chat experience gets an explanation instead of a broken tab', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_CHAT: '1' })
  try {
    await readyBot(page)
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    await page.getByRole('button', { name: 'Extensões', exact: true }).first().click()
    await expect(page.getByText('Atualize o Host para configurar servidores MCP e skills.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Novo servidor MCP' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
