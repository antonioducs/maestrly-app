import { expect, test } from '@playwright/test'
import { launchBot, prepareBot } from './bot-helpers'
test('first bot reuses a prepared environment and shared account with model and effort', async () => {
  const { app, page } = await launchBot()
  try {
    await expect(page.getByRole('heading', { name: 'Seu bot, pronto para ajudar' })).toBeVisible()
    await page.screenshot({ path: 'test-results/first-use.png' })
    await page.getByRole('button', { name: 'Criar meu primeiro bot' }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Pesquisador')
    await page.getByLabel('Instruções', { exact: true }).fill('Preparar pesquisas')
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Ambiente', exact: true })).toContainText('Build worker')
    await expect(page.getByText('Verificando seu computador…', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Configuração recomendada' })).toHaveCount(0)
    await expect(page.getByLabel('Autorizo a preparação e o backup')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/direct-environment.png' })
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await expect(page.getByText('fixture@example.test', { exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: 'Modelo', exact: true }).click()
    await page.getByRole('option', { name: 'Fixture large', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Esforço', exact: true })).toContainText('high')
    await page.screenshot({ path: 'test-results/direct-model.png' })
    await page.getByRole('button', { name: 'Criar bot', exact: true }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Pesquisador')
    await expect(page.getByRole('button', { name: 'Entrar com minha conta', exact: true })).toHaveCount(0)
    const bots = await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))
    expect(bots[0]).toMatchObject({ accountId: 'fixture-account', model: { model: 'fixture-large', effort: 'high' }, instructions: 'Preparar pesquisas' })
    await expect.poll(() => page.evaluate(() => window.bot.draft())).toBeNull()
  } finally { await app.close() }
})
test('connects a general account and returns to the same bot draft', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_CONNECTED_ACCOUNT: '0' })
  try {
    await page.getByRole('button', { name: 'Criar meu primeiro bot' }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Rascunho preservado')
    await page.getByLabel('Instruções', { exact: true }).fill('Preserve estas instruções')
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Criar bot', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Gerenciar contas', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Contas', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Conectar conta', exact: true }).click()
    await page.getByRole('button', { name: 'Entrar com minha conta', exact: true }).click()
    await expect(page.getByLabel('Código de login')).toHaveText('ABCD-EFGH')
    await expect(page.getByText('Conta conectada', { exact: false })).toBeVisible()
    await page.screenshot({ path: 'test-results/global-accounts.png' })
    await page.getByRole('button', { name: 'Voltar para criar o bot', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Qual modelo seu bot vai usar?' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Criar bot', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Criar bot', exact: true }).click()
    await expect(page.locator('.chat-header h1')).toHaveText('Rascunho preservado')
    const bot = (await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} })))[0]
    expect(bot.instructions).toBe('Preserve estas instruções')
    expect(bot.accountId).toBeTruthy()
  } finally { await app.close() }
})
test('missing Host offers installation outcome without scanning or showing an alias early', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_HOST: '1' })
  try {
    await page.getByRole('button', { name: 'Criar meu primeiro bot' }).click()
    await expect(page.getByRole('heading', { name: 'Onde seu bot vai trabalhar?' })).toBeVisible()
    await expect(page.getByLabel('Alias SSH')).toHaveCount(0)
    await page.getByRole('button', { name: 'Neste Mac', exact: true }).click()
    await expect(page.getByText('O Host ainda não está instalado neste Mac.')).toBeVisible()
    await page.getByRole('button', { name: 'Instalar o Host neste Mac' }).click()
    await expect(page.getByRole('status')).toContainText('Nenhum pacote verificado do Host está preparado')
    await expect(page.locator('progress')).toHaveCount(0)
    await page.getByRole('button', { name: 'Em outro computador', exact: true }).click()
    await expect(page.getByLabel('Alias SSH')).toBeVisible()
  } finally { await app.close() }
})
test('reopening a saved creation inspects its operation and never silently creates another', async () => {
  const first = await launchBot({ MAESTRLY_BOT_FIXTURE_SLOW_SETUP: '1' })
  let operationId: string | undefined
  try {
    await prepareBot(first.page)
    await expect.poll(() => first.page.evaluate(async () => (await window.bot.draft())?.operationId)).toBeTruthy()
    operationId = await first.page.evaluate(async () => (await window.bot.draft())?.operationId)
  } finally { await first.app.close() }
  const second = await launchBot({ MAESTRLY_BOT_FIXTURE_SLOW_SETUP: '1' }, false)
  try {
    await expect(second.page.getByText(/Não foi possível encontrar a preparação anterior/)).toBeVisible()
    expect(await second.page.evaluate(async () => (await window.bot.draft())?.operationId)).toBe(operationId)
    expect(await second.page.evaluate(() => window.bot.call({ method: 'vm.list', params: {} }))).toHaveLength(1)
    await expect(second.page.getByRole('button', { name: 'Começar de novo' })).toBeVisible()
    await second.page.evaluate(() => window.bot.saveDraft(null))
  } finally { await second.app.close() }
})
test('general device login opens once, retains the code across polls, and cancels explicitly', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS: '600000', MAESTRLY_BOT_FIXTURE_CONNECTED_ACCOUNT: '0' })
  try {
    await page.getByRole('button', { name: 'Contas', exact: true }).click()
    await page.getByRole('button', { name: 'Conectar conta', exact: true }).click()
    await page.getByRole('button', { name: 'Entrar com minha conta', exact: true }).click()
    await expect(page.getByLabel('Código de login')).toHaveText('ABCD-EFGH')
    const opened = () => app.evaluate(() => (globalThis as unknown as { openedLoginUrls: string[] }).openedLoginUrls)
    await expect.poll(opened).toHaveLength(1)
    expect(new URL((await opened())[0]).origin).toBe('https://auth.openai.com')
    await page.evaluate(async () => {
      const accounts = await window.bot.bot({ method: 'account.list', params: {} })
      await window.bot.bot({ method: 'account.cancel', params: { accountId: accounts[0].id } })
    })
    await page.waitForTimeout(3200)
    await expect(page.getByLabel('Código de login')).toHaveText('ABCD-EFGH')
    expect(await opened()).toHaveLength(1)
    await page.getByRole('button', { name: 'Cancelar login' }).click()
    await expect(page.getByLabel('Código de login')).toHaveCount(0)
  } finally { await app.close() }
})
