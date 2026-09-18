import { expect, test, type Page } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

/** Opens the routines tab of the bot currently in the conversation. */
async function openRoutines(page: Page) {
  await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
  await page.getByRole('button', { name: 'Rotinas', exact: true }).first().click()
}

test('a routine exists only after the person reviews and confirms it', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Ana')
    await openRoutines(page)
    await expect(page.getByText('Nenhuma rotina ainda', { exact: false })).toBeVisible()

    await page.getByRole('button', { name: 'Nova rotina', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Resumo de segunda')
    await page.getByLabel('O que fazer', { exact: true }).fill('Prepare o resumo da semana')

    // Nothing exists yet, and the preview itself creates nothing either.
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toEqual([])
    await page.getByRole('button', { name: 'Ver próximas execuções', exact: true }).click()
    await expect(page.getByText('Próximas execuções', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toEqual([])
    // The zone is always stated: a schedule nobody can locate in time is not reviewable.
    await expect(page.getByText(/Horário de /)).toBeVisible()

    await page.getByRole('button', { name: 'Ativar rotina', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resumo de segunda' })).toBeVisible()
    const routines = await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))
    expect(routines).toHaveLength(1)
    expect(routines[0].status).toBe('active')
  } finally {
    await app.close()
  }
})

test('pausing a routine is not the same as stopping a run, and both are offered', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Ana')
    await openRoutines(page)
    await page.getByRole('button', { name: 'Nova rotina', exact: true }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Resumo diário')
    await page.getByLabel('O que fazer', { exact: true }).fill('Prepare o resumo do dia')
    await page.getByRole('button', { name: 'Ver próximas execuções', exact: true }).click()
    // The confirm button only becomes real once the Host answered with real instants.
    await expect(page.getByText('Próximas execuções', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Ativar rotina', exact: true }).click()

    await page.getByRole('button', { name: 'Pausar rotina', exact: true }).click()
    await expect(page.getByText('Pausada', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Retomar rotina', exact: true }).click()

    // Activating already opens the routine, so its history is on screen; clicking the name
    // again would close it.
    await page.getByRole('button', { name: 'Executar agora', exact: true }).click()
    await expect(page.getByText('Pedida por você', { exact: true })).toBeVisible()
    // The two actions are distinct and named for what they do.
    await expect(page.getByRole('button', { name: 'Pausar rotina', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a suggestion from the bot is inert until confirmed, and can be dismissed', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_ROUTINE_PROPOSAL: '1' })
  try {
    await readyBot(page, 'Ana')
    // The card appears in the conversation, where the suggestion was made.
    const card = page.getByRole('group', { name: 'Sugestão de rotina' })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText('Nada é executado até você confirmar.', { exact: true })).toBeVisible()
    // Nothing was scheduled by the suggestion itself.
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toEqual([])

    await card.getByRole('button', { name: 'Descartar', exact: true }).click()
    await expect(card).toBeHidden()
    // Dismissing a card leaves no routine behind either.
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toEqual([])
  } finally {
    await app.close()
  }
})

test('confirming a suggestion creates exactly one routine, from the card that was shown', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_ROUTINE_PROPOSAL: '1' })
  try {
    await readyBot(page, 'Ana')
    const card = page.getByRole('group', { name: 'Sugestão de rotina' })
    await expect(card).toBeVisible({ timeout: 15_000 })
    // The card states the target, the ceiling and the permissions before anything happens.
    await expect(card.getByText('Ana', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Ativar rotina', exact: true }).click()
    await expect(card).toBeHidden({ timeout: 15_000 })
    const routines = await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))
    expect(routines).toHaveLength(1)
    expect(routines[0].spec.name).toBe('Resumo de segunda')
  } finally {
    await app.close()
  }
})

test('an older computer keeps the chat working and says what to do', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_ROUTINES: '1' })
  try {
    await readyBot(page, 'Ana')
    await openRoutines(page)
    await expect(page.getByText('Atualize este computador para usar rotinas.', { exact: true })).toBeVisible()
    // The conversation itself is untouched.
    await page.getByRole('button', { name: 'Fechar', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeEnabled()
  } finally {
    await app.close()
  }
})
