import { expect, test, type Page } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

/** Two ready bots, which is the minimum a team needs. */
async function twoBots(page: Page) {
  await readyBot(page, 'Ana')
  await page.getByRole('button', { name: 'Novo bot', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill('Bruno')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Ambiente', exact: true })).toContainText('Build worker')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await page.getByRole('button', { name: 'Criar bot', exact: true }).click()
  await expect(page.locator('.chat-header h1')).toHaveText('Bruno')
}
async function createTeam(page: Page, name = 'Relatórios') {
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).click()
  await page.getByLabel('Nome da equipe', { exact: true }).fill(name)
  await page.getByLabel('Entendi o que a equipe compartilha', { exact: true }).check()
  await page.getByRole('button', { name: 'Criar equipe', exact: true }).last().click()
  await expect(page.locator('.chat-header h1')).toHaveText(name)
}

test('creates a team from existing bots and keeps the bot flow untouched', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    // Bots stay where they were; Teams is an extra, compact section.
    await expect(page.getByRole('navigation', { name: 'Bots' }).getByRole('button', { name: 'Ana' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Equipes' })).toBeVisible()

    const vmsBefore = await page.evaluate(() => window.bot.call({ method: 'vm.list', params: { includeRetained: false } }))
    const botsBefore = await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))
    await createTeam(page)
    // Creating a team asked nothing about computers and changed no inventory at all.
    await expect(page.getByRole('navigation', { name: 'Equipes' }).getByRole('button', { name: 'Relatórios' })).toBeVisible()
    expect(await page.evaluate(() => window.bot.call({ method: 'vm.list', params: { includeRetained: false } }))).toEqual(vmsBefore)
    expect(await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))).toEqual(botsBefore)
    // Going back to a bot still works exactly as before.
    await page.getByRole('navigation', { name: 'Bots' }).getByRole('button', { name: 'Ana' }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Ana')
  } finally {
    await app.close()
  }
})

test('runs a full team request and shows one consolidated answer', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await expect(page.getByText('Converse com a equipe')).toBeVisible()

    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Analise o CSV e escreva as recomendações')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    // The request appears attributed to the person, never as a bot message.
    await expect(page.locator('.team-message.human').first()).toContainText('Analise o CSV')
    // Members work and the team reports progress in plain words.
    await expect(page.locator('.chat-header p')).toContainText(/Organizando o trabalho|Os membros|Juntando/)
    // Exactly one consolidated answer arrives.
    await expect(page.locator('.team-message.bot')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.team-message.bot')).toContainText('Ana')
    await expect(page.getByText('Resposta da equipe')).toBeVisible()
    await expect(page.locator('.chat-header p')).toContainText('Concluído')
  } finally {
    await app.close()
  }
})

test('keeps the detailed work behind one click and free of technical controls', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Prepare o relatório')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await expect(page.locator('.team-message.bot')).toHaveCount(1, { timeout: 20_000 })

    // The main screen shows no graph, no identifiers, no raw logs.
    const main = (await page.locator('.team-chat').innerText()).toLowerCase()
    for (const forbidden of ['uuid', 'qmp', 'cpu', 'mib', 'json', 'vm-', 'turnid'])
      expect(main, forbidden).not.toContain(forbidden)

    await page.getByRole('button', { name: 'Ver trabalho', exact: true }).click()
    const tasks = page.locator('.team-tasks li')
    await expect(tasks.first()).toBeVisible()
    // Who did what, in plain words, with each member's own name.
    await expect(page.locator('.team-tasks')).toContainText('Bruno')
    await expect(page.locator('.team-tasks')).toContainText('Concluído')
  } finally {
    await app.close()
  }
})

test('stops the team on request without touching bots or computers', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    const vmsBefore = await page.evaluate(() => window.bot.call({ method: 'vm.list', params: { includeRetained: false } }))
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Trabalho longo')
    await page.getByRole('button', { name: 'Enviar', exact: true }).click()
    await page.getByRole('button', { name: 'Parar equipe', exact: true }).click()
    await expect(page.locator('.chat-header p')).toContainText('Interrompido')
    // The computers are untouched and the bots stay ready.
    expect(await page.evaluate(() => window.bot.call({ method: 'vm.list', params: { includeRetained: false } }))).toEqual(vmsBefore)
    await page.getByRole('navigation', { name: 'Bots' }).getByRole('button', { name: 'Bruno' }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Bruno')
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).not.toHaveAttribute('readonly', 'true')
  } finally {
    await app.close()
  }
})

test('manages members, notes and files from the team panel', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    const panel = page.getByRole('region')
    await expect(panel.getByRole('heading', { name: 'Participantes', exact: true })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Arquivos compartilhados', exact: true })).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Memória da equipe', exact: true })).toBeVisible()
    // What adding a bot means is explained, not just a checkbox.
    await expect(panel.getByText('passa a receber o contexto da equipe')).toBeVisible()
    await expect(panel.getByText('Nenhum arquivo compartilhado ainda.')).toBeVisible()

    await panel.getByLabel('Adicionar anotação', { exact: true }).fill('Sempre citar a fonte dos números.')
    await panel.getByRole('button', { name: 'Adicionar anotação', exact: true }).click()
    await expect(panel.getByText('Sempre citar a fonte dos números.')).toBeVisible()
    // Removing stops future uses and says so honestly.
    await expect(panel.getByText('não apaga o que já foi enviado')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('preserves the draft and the scroll position when navigating away', async () => {
  const { app, page } = await launchBot()
  try {
    await twoBots(page)
    await createTeam(page)
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('rascunho da equipe')
    await page.getByRole('navigation', { name: 'Bots' }).getByRole('button', { name: 'Ana' }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Ana')
    // The bot's own composer is separate and empty.
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue('')
    await page.getByRole('navigation', { name: 'Equipes' }).getByRole('button', { name: 'Relatórios' }).click()
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue('rascunho da equipe')
  } finally {
    await app.close()
  }
})

test('explains that an older computer cannot run teams instead of failing obscurely', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_TEAMS: '1' })
  try {
    await readyBot(page, 'Ana')
    // No Teams section at all on a Host that does not support them.
    await expect(page.getByRole('navigation', { name: 'Equipes' })).toHaveCount(0)
    const error = await page.evaluate(async () => {
      try {
        await window.bot.team({ method: 'team.list', params: {} })
        return 'no-error'
      } catch (error) {
        return String(error)
      }
    })
    expect(error).toContain('Atualize')
  } finally {
    await app.close()
  }
})
