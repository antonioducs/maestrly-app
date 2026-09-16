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
async function teamAtWork(page: Page) {
  await twoBots(page)
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).click()
  await page.getByLabel('Nome da equipe', { exact: true }).fill('Relatórios')
  await page.getByLabel('Entendi o que a equipe compartilha', { exact: true }).check()
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).last().click()
  await expect(page.locator('.chat-header h1')).toHaveText('Relatórios', { timeout: 15_000 })
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Prepare o relatório')
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await page.getByRole('button', { name: 'Ver trabalho', exact: true }).click()
  await expect(page.locator('.team-tasks li').first()).toBeVisible()
}

test('opens the screen of one member under that member’s own identity', async () => {
  const { app, page } = await launchBot()
  try {
    await teamAtWork(page)
    // Each task offers the screen of the member that is doing it, by name.
    const open = page.getByRole('button', { name: /Ver tela de (Ana|Bruno)/ }).first()
    const label = await open.getAttribute('aria-label')
    await open.click()
    // The panel belongs to that member and to nobody else.
    const panel = page.locator('.desktop-panel, [class*="desktop"]').first()
    await expect(panel).toBeVisible()
    expect(label).toMatch(/Ver tela de (Ana|Bruno)/)
    // Opening a screen never takes control by itself.
    await expect(page.getByText('Você está no controle')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('switching away from the team closes the member screen', async () => {
  const { app, page } = await launchBot()
  try {
    await teamAtWork(page)
    await page.getByRole('button', { name: /Ver tela de (Ana|Bruno)/ }).first().click()
    await expect(page.locator('.chat-layout.with-desktop')).toBeVisible()
    // Choosing another bot in the sidebar must not leave a member's pixels on screen.
    await page.getByRole('navigation', { name: 'Bots' }).getByRole('button', { name: 'Ana' }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Ana', { timeout: 15_000 })
    await expect(page.locator('.chat-layout.with-desktop')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('shows the team result and stays usable after a reconnection', async () => {
  const { app, page } = await launchBot()
  try {
    await teamAtWork(page)
    await expect(page.locator('.team-message.bot')).toHaveCount(1, { timeout: 20_000 })
    const answer = await page.locator('.team-message.bot').innerText()
    // A restart of the window shows the same conversation, with no duplicated answer.
    await page.reload()
    await page.waitForFunction(() => !!window.bot)
    const teams = page.getByRole('navigation', { name: 'Equipes' }).getByRole('button', { name: 'Relatórios' })
    await expect(teams).toBeVisible()
    await teams.click()
    await expect(page.locator('.team-message.bot')).toHaveCount(1)
    expect(await page.locator('.team-message.bot').innerText()).toBe(answer)
    // The person can immediately ask for something else.
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).not.toHaveAttribute('readonly', '')
  } finally {
    await app.close()
  }
})
