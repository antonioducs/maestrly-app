import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'
test('chat completes work, produces a preview, and offers the real download', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, 'Prepare um relatório #slow')
    await expect(page.locator('.chat-header')).toContainText('Trabalhando…')
    await expect(page.getByRole('button', { name: 'Parar tarefa', exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/working.png' })
    await page.getByRole('button', { name: 'Parar tarefa', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Parando…', exact: true })).toBeVisible()
    await expect(page.locator('.chat-header')).toContainText('Tarefa interrompida')
    await send(page, 'Prepare um relatório')
    await expect(page.locator('.file-card')).toContainText('relatorio.md')
    await page.getByRole('button', { name: 'Abrir prévia', exact: true }).click()
    await expect(page.getByRole('region', { name: 'relatorio.md' })).toContainText('Pedido: Prepare um relatório')
    await page.getByRole('button', { name: 'Fechar', exact: true }).click()
    await page.screenshot({ path: 'test-results/result.png' })
    const files = await page.evaluate(async () => {
      const [bot] = await window.bot.bot({ method: 'bot.list', params: {} })
      return window.bot.bot({ method: 'bot.files.list', params: { botId: bot.id } })
    })
    expect(files.some((file) => file.name === 'relatorio.md')).toBe(true)
    await page.getByRole('button', { name: 'Baixar', exact: true }).click()
  } finally {
    await app.close()
  }
})
test('approval, question, cancellation and failure stay in the conversation', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, '#approve')
    await expect(page.getByRole('button', { name: 'Permitir desta vez' })).toBeVisible()
    await page.screenshot({ path: 'test-results/approval.png' })
    await page.getByRole('button', { name: 'Permitir desta vez' }).click()
    await expect(page.locator('.message.assistant')).toContainText('executei a ação que você autorizou')
    await send(page, '#ask')
    await page.getByLabel('Resposta', { exact: true }).fill('Markdown')
    await page.getByRole('button', { name: 'Responder', exact: true }).click()
    await expect(page.locator('.message.assistant').last()).toContainText('Entendi: Markdown')
    await send(page, '#slow')
    await expect(page.locator('.chat-header')).toContainText('Trabalhando…')
    await page.getByRole('button', { name: 'Parar tarefa', exact: true }).click()
    await expect(page.locator('.chat-header')).toContainText('Parando…')
    await expect(page.locator('.chat-header')).toContainText('Tarefa interrompida')
    await send(page, '#fail')
    await expect(page.getByRole('alert')).toContainText('Consulte os detalhes antes de tentar novamente')
    await page.screenshot({ path: 'test-results/error.png' })
  } finally {
    await app.close()
  }
})
test('long text stays intact, markup is inert, and reconnect preserves a draft', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    const content =
      '/home/maestrlybot/workspace/project/'.repeat(95) + '<script>window.pwned=1</script> [bad](javascript:alert(1))'
    await send(page, content)
    await expect(page.locator('.message.user')).toHaveText(content)
    await expect(page.locator('.message.assistant')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
    await expect(page.locator('.message script, .message a[href^="javascript:"], .message img')).toHaveCount(0)
    const composer = page.getByRole('textbox', { name: 'Mensagem', exact: true })
    await composer.fill('Ainda estou escrevendo')
    await page.evaluate(() => window.bot.disconnect())
    await expect(page.getByText(/Sem conexão com/)).toBeVisible()
    await expect(composer).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeDisabled()
    await expect(page.getByText('Conecte o computador para enviar mensagens.')).toBeVisible()
    await page.evaluate(() => window.bot.connect('local'))
    await expect(composer).not.toHaveAttribute('readonly')
    await expect(composer).toHaveValue('Ainda estou escrevendo')
  } finally {
    await app.close()
  }
})
