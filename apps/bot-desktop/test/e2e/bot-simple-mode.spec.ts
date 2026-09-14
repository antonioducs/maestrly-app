import { expect, test } from '@playwright/test'
import { computers, launchBot, readyBot } from './bot-helpers'
test('simple mode keeps administration out of the DOM and preserves the composer across settings', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await expect(page.locator('body')).not.toContainText(/CPU|MiB|GiB|QMP|PID|protocolo|JSON|idempot|alias SSH/i)
    await expect(page.locator('pre')).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Meu rascunho')
    const modeBefore = await page.evaluate(
      async () => (await window.bot.bot({ method: 'bot.list', params: {} }))[0].permissionMode
    )
    await computers(page)
    await expect(page.getByLabel('Alias da configuração SSH')).toBeVisible()
    await page.getByLabel('Alias da configuração SSH').fill('local')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Máquinas virtuais/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Build worker/ })).toBeVisible()
    await page.screenshot({ path: 'test-results/advanced.png' })
    await page.getByRole('button', { name: 'Voltar à conversa', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue('Meu rascunho')
    await expect(page.locator('body')).not.toContainText(/CPU|MiB|GiB|QMP|PID|protocolo|JSON|idempot|alias SSH/i)
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByLabel('Mostrar opções avançadas', { exact: true }).check()
    await page.getByLabel('Mostrar opções avançadas', { exact: true }).uncheck()
    const modeAfter = await page.evaluate(async () => {
      const [bot] = await window.bot.bot({ method: 'bot.list', params: {} })
      return (await window.bot.bot({ method: 'bot.inspect', params: { botId: bot.id } })).permissionMode
    })
    expect(modeAfter).toBe(modeBefore)
    await page.getByRole('combobox', { name: 'Aparência', exact: true }).click()
    await page.getByRole('option', { name: 'Clara', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByRole('combobox', { name: 'Aparência', exact: true }).click()
    await page.getByRole('option', { name: 'Escura', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Voltar à conversa', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(840, 620))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.locator('.chat-header button').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.message.user')).toHaveText('Meu rascunho')
  } finally {
    await app.close()
  }
})
test('an old Host explains the update while computer administration remains available', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_BOTS: '1' })
  try {
    await page.evaluate(() => window.bot.connect('local'))
    await expect(
      page.getByRole('heading', { name: 'Este computador precisa de uma atualização do Host para usar bots' })
    ).toBeVisible()
    await computers(page)
    await page.getByLabel('Alias da configuração SSH').fill('local')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('button', { name: /Build worker/ })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('details save instructions, memory, explicit permissions and internet policy', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Detalhes', exact: true })
    await panel.getByLabel('Instruções', { exact: true }).fill('Escreva respostas curtas.')
    await panel.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async () => (await window.bot.bot({ method: 'bot.list', params: {} }))[0].instructions))
      .toBe('Escreva respostas curtas.')
    await panel.getByRole('button', { name: 'Memória', exact: true }).click()
    await panel.getByLabel('Memória', { exact: true }).fill('Prefiro respostas em português.')
    await panel.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await expect(panel.getByText('Prefiro respostas em português.', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Editar', exact: true }).click()
    await panel.getByLabel('Memória', { exact: true }).fill('Prefiro respostas breves.')
    await panel.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(panel.getByText('Prefiro respostas breves.', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Remover', exact: true }).click()
    await expect(panel.getByText('Ainda não há memórias.')).toBeVisible()
    await panel.getByRole('button', { name: 'Permissões', exact: true }).click()
    await panel.locator('summary').filter({ hasText: 'Acesso ampliado' }).click()
    await expect(panel.getByRole('button', { name: 'Ativar acesso ampliado' })).toBeDisabled()
    await panel.getByLabel('Entendo e autorizo a execução sem sandbox de workspace').check()
    await panel.getByRole('button', { name: 'Ativar acesso ampliado' }).click()
    await panel.getByRole('button', { name: 'Voltar a pedir autorização' }).click()
    await expect(panel.getByText('As gravações ficam no workspace autorizado; ampliar o acesso exige confirmação.')).toBeVisible()
    await panel.getByRole('button', { name: 'Internet', exact: true }).click()
    await panel.getByLabel('Domínio bloqueado', { exact: true }).fill('example.com')
    await panel.getByRole('button', { name: 'Adicionar', exact: true }).click()
    await expect(panel.getByRole('listitem').filter({ hasText: 'example.com' })).toBeVisible()
    await panel.getByRole('button', { name: 'Desativar internet' }).click()
    await expect(panel.getByText('Internet desativada', { exact: true })).toBeVisible()
    await expect(panel.getByRole('listitem').filter({ hasText: 'example.com' })).toBeVisible()
    await panel.getByRole('button', { name: 'Permitir internet pública' }).click()
    await expect(panel.getByText('Internet pública liberada', { exact: true })).toBeVisible()
    await expect(panel.getByRole('listitem').filter({ hasText: 'example.com' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Detalhes', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})
