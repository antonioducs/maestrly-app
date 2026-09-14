import { expect, test, type Page } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'

async function checkContrast(page: Page) {
  const measured = await page.evaluate(() => {
    const rgb = (s: string) => (s.match(/[0-9.]+/g) ?? []).map(Number)
    const blend = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)))
    const lum = (c: number[]) => c.slice(0, 3).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0)
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05)
    const canvas = rgb(getComputedStyle(document.querySelector('.workspace')!).backgroundColor)
    const background = canvas
    const secondary = blend(rgb(getComputedStyle(document.querySelector('.field-note, .account-reference')!).color), background)
    const field = getComputedStyle(document.querySelector('.onboarding [role="combobox"]')!)
    const fieldBackground = blend(rgb(field.backgroundColor), canvas)
    const sidebar = getComputedStyle(document.querySelector('.bot-sidebar')!)
    const sidebarBackground = blend(rgb(sidebar.backgroundColor), [255, 255, 255])
    const sidebarText = blend(rgb(getComputedStyle(document.querySelector('.brand')!).color), sidebarBackground)
    return { secondary: ratio(secondary, background), field: ratio(rgb(field.borderTopColor), fieldBackground), sidebar: ratio(sidebarText, sidebarBackground) }
  })
  expect(measured.secondary).toBeGreaterThanOrEqual(4.5)
  expect(measured.field).toBeGreaterThanOrEqual(3)
  expect(measured.sidebar).toBeGreaterThanOrEqual(4.5)
}

test('direct creation works at minimum size in both themes with keyboard access', async () => {
  const { app, page } = await launchBot()
  try {
    await expect(page.getByRole('button', { name: 'Criar meu primeiro bot' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-first-use.png' })
    await page.getByRole('button', { name: 'Criar meu primeiro bot' }).click()
    await page.getByLabel('Nome', { exact: true }).fill('Assistente pessoal')
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-identity.png' })
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Ambiente', exact: true })).toContainText('Build worker')
    await expect(page.locator('.onboarding details')).toHaveCount(0)
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-environment-dark.png' })
    await checkContrast(page)
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Criar bot', exact: true })).toBeEnabled()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(840, 620))
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-model-minimum.png' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.workspace').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.getByRole('button', { name: 'Criar bot', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    expect(await page.getByRole('button', { name: 'Criar bot', exact: true }).evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none')
    await page.evaluate(() => window.bot.savePreferences({ theme: 'light' }))
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('heading', { name: 'Qual modelo seu bot vai usar?' })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-model-light.png' })
    await checkContrast(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.onboarding').evaluate(node => getComputedStyle(node).animationName)).toBe('none')
  } finally { await app.close() }
})

test('Maestrly chat details and composer preserve keyboard access and draft', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Assistente pessoal')
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Meu rascunho')
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-conversation.png' })
    await page.getByRole('button', { name: 'Detalhes', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Detalhes', exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-details.png' })
    await page.getByRole('region', { name: 'Detalhes', exact: true }).getByRole('button', { name: 'Arquivar bot', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Detalhes', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue('Meu rascunho')
    await expect(page.getByRole('button', { name: 'Detalhes', exact: true })).toBeFocused()
    await send(page, '#slow')
    await expect(page.getByRole('button', { name: 'Parar tarefa', exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-working.png' })
    await page.getByRole('button', { name: 'Parar tarefa', exact: true }).click()
  } finally { await app.close() }
})

test('attachment chips remove the message attachment without deleting the uploaded file', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'bot-ui-attachment-'))
  const file = join(dir, 'dados.csv')
  await writeFile(file, 'produto,valor\nTeste,12\n')
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: 'Anexar arquivo' }).click()
    await expect(page.locator('.composer-attachments')).toContainText('dados.csv')
    await page.screenshot({ animations: 'disabled', path: 'test-results/ux-attachment.png' })
    await page.getByRole('button', { name: 'Remover anexo da mensagem dados.csv' }).click()
    await expect(page.locator('.attachment-chip')).toHaveCount(0)
    expect(await page.evaluate(async () => {
      const [bot] = await window.bot.bot({ method: 'bot.list', params: {} })
      return (await window.bot.bot({ method: 'bot.files.list', params: { botId: bot.id } })).some(file => file.name === 'dados.csv')
    })).toBe(true)
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
