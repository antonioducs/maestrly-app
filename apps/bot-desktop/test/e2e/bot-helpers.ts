import { randomUUID } from 'node:crypto'
import { _electron as electron, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
let fixtureSession = randomUUID()
export async function launchBot(env: Record<string, string> = {}, reset = true) {
  if (reset) fixtureSession = randomUUID()
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1', MAESTRLY_BOT_FIXTURE_SESSION: fixtureSession, MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS: '200', MAESTRLY_BOT_FIXTURE_READY_ENVIRONMENT: '1', MAESTRLY_BOT_FIXTURE_CONNECTED_ACCOUNT: '1', ...env },
  })
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedLoginUrls: string[] }
    state.openedLoginUrls = []
    shell.openExternal = async (url) => { state.openedLoginUrls.push(url) }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.bot)
  if (reset) {
    await page.evaluate(async () => {
      await window.bot.saveDraft(null)
      await window.bot.savePreferences({ theme: 'dark', locale: 'pt-BR', advanced: false })
      sessionStorage.clear()
      localStorage.clear()
    })
    await page.reload()
  }
  return { app, page }
}
export async function prepareBot(page: Page, name = 'Assistente de pesquisa') {
  await page.getByRole('button', { name: 'Criar meu primeiro bot', exact: true }).click()
  await page.getByLabel('Nome', { exact: true }).fill(name)
  await page.getByLabel('Instruções', { exact: true }).fill('Pesquisar e preparar relatórios')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Ambiente', exact: true })).toContainText('Build worker')
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Criar bot', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Criar bot', exact: true }).click()
}
export async function readyBot(page: Page, name = 'Assistente de pesquisa') {
  await prepareBot(page, name)
  await expect(page.locator('.chat-header h1')).toHaveText(name)
}
export async function computers(page: Page) {
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  await page.getByRole('button', { name: 'Avançado', exact: true }).click()
  await page.getByRole('button', { name: 'Computadores', exact: true }).click()
}
export async function send(page: Page, content: string) {
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill(content)
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
}
