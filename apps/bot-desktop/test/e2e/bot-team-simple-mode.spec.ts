import { expect, test, type Page } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

async function twoBots(page: Page) {
  await readyBot(page, 'Ana')
  await page.getByRole('button', { name: 'Novo bot', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Bruno')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Ambiente', exact: true })).toContainText('Build worker')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await page.getByRole('button', { name: 'Criar bot', exact: true }).click()
  await expect(page.locator('.chat-header h1')).toHaveText('Bruno', { timeout: 15_000 })
}
async function createTeam(page: Page, name = 'Relatórios') {
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).click()
  await page.getByLabel('Nome da equipe', { exact: true }).fill(name)
  await page.getByLabel('Entendi o que a equipe compartilha', { exact: true }).check()
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).last().click()
  await expect(page.locator('.chat-header h1')).toHaveText(name, { timeout: 15_000 })
}

test('someone who uses a single bot sees no team machinery in the main flow', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Ana')
    // With one bot the Teams section exists but creating a team is honest about needing two.
    await page.getByRole('button', { name: 'Criar equipe', exact: true }).click()
    await expect(page.getByText('pelo menos dois bots')).toBeVisible()
    await page.getByRole('button', { name: 'Voltar à conversa', exact: true }).click()
    // The bot conversation is exactly as before.
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('keeps limits and budgets out of the simple mode and inside Advanced', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    // Simple mode: no limit tables at all.
    await expect(page.getByRole('heading', { name: 'Avançado', exact: true })).toHaveCount(0)
    await expect(page.getByText('Execuções por trabalho')).toHaveCount(0)

    await page.evaluate(() => window.bot.savePreferences({ advanced: true }))
    await page.reload()
    await page.waitForFunction(() => !!window.bot)
    const teams = page.getByRole('navigation', { name: 'Equipes' }).getByRole('button', { name: 'Relatórios' })
    await expect(teams).toBeVisible()
    await teams.click()
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Avançado', exact: true })).toBeVisible()
    await expect(page.getByText('Execuções por trabalho')).toBeVisible()
    // The limits are framed as protection, never as a capacity promise or a spending cap.
    await expect(page.getByText('não são promessas de capacidade nem um teto de custo')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('states the sharing boundary honestly before the team exists', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await page.getByRole('button', { name: 'Criar equipe', exact: true }).click()
    await expect(page.getByText('As conversas particulares e a memória de cada bot continuam privadas')).toBeVisible()
    // Separate threads are not isolation inside one bot, and the UI says so.
    await expect(page.getByText('Para assuntos sensíveis, use bots diferentes')).toBeVisible()
    // Creating is blocked until the person acknowledges what is shared.
    const create = page.getByRole('button', { name: 'Criar equipe', exact: true }).last()
    await page.getByLabel('Nome da equipe', { exact: true }).fill('Sensível')
    await expect(create).toBeDisabled()
    await page.getByLabel('Entendi o que a equipe compartilha', { exact: true }).check()
    await expect(create).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('works in English and in the light theme with a small window', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await page.evaluate(() => window.bot.savePreferences({ locale: 'en', theme: 'light' }))
    await page.setViewportSize({ width: 840, height: 620 })
    await page.reload()
    await page.waitForFunction(() => !!window.bot)
    const teams = page.getByRole('navigation', { name: 'Teams' }).getByRole('button', { name: 'Relatórios' })
    await expect(teams).toBeVisible()
    await teams.click()
    await expect(page.getByText('Talk to the team')).toBeVisible()
    // Keyboard reaches the composer without a pointer.
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus')).toBeVisible()
  } finally {
    await app.close()
  }
})
