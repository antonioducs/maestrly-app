import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'
import { openScreen, pixel } from './desktop-helpers'

test('take control mid-task, fix the screen, hand back and the bot continues from there', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await send(page, '#slow Preencha o formulário de cadastro')
    await expect(page.locator('.chat-header p')).toHaveText(/Trabalhando/)
    const panel = await openScreen(page)
    await panel.getByRole('button', { name: 'Assumir controle', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText(/Você está no controle/, { timeout: 10_000 })
    await expect(panel.getByRole('button', { name: 'Devolver e continuar', exact: true })).toBeVisible()
    // The interrupted task is paused, not failed; the composer waits for the hand-back.
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).not.toBeEditable()
    await expect(page.locator('#composer-reason')).toHaveText('Devolva a tela ao bot para enviar mensagens.')
    await expect(panel.getByText(/Shift\+Esc devolve o teclado/)).toBeVisible()
    // Click into the form (scaled coordinates) and type Portuguese text.
    const canvas = panel.locator('.desktop-screen canvas')
    // The screen sends no cursor shape: the person still sees a normal pointer over it.
    await expect.poll(() => canvas.evaluate((element) => getComputedStyle(element).cursor)).toBe('default')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + (400 / 1280) * box.width, box.y + (280 / 800) * box.height)
    await expect.poll(() => pixel(page, 400, 280)).toEqual([255, 173, 181])
    await page.keyboard.type('ação')
    await expect.poll(() => pixel(page, 296, 282)).toEqual([38, 37, 33])
    // Shift+Esc gives the keyboard back to the app without leaving keys pressed.
    await page.keyboard.press('Shift+Escape')
    await expect(panel.getByRole('button', { name: 'Devolver e continuar', exact: true })).toBeFocused()
    await panel.getByRole('button', { name: 'Devolver e continuar', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 10_000 })
    await expect(page.getByText('Continuação após sua intervenção na tela')).toBeVisible()
    await expect(page.getByText(/Continuei a partir do que você deixou na tela/)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.message.system')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('closing while in control keeps the bot paused until the person resumes it from the conversation', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    const panel = await openScreen(page)
    await panel.getByRole('button', { name: 'Assumir controle', exact: true }).click()
    // An idle bot is simply handed back; there is no task to continue.
    await expect(panel.getByRole('button', { name: 'Devolver controle', exact: true })).toBeVisible({ timeout: 10_000 })
    await panel.getByRole('button', { name: 'Fechar tela', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Você está no controle da tela' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Manter pausado', exact: true }).click()
    await expect(panel).toHaveCount(0)
    const banner = page.locator('.desktop-banner')
    await expect(banner).toContainText('O bot está pausado enquanto você usa a tela.', { timeout: 10_000 })
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).not.toBeEditable()
    await banner.getByRole('button', { name: 'Continuar bot', exact: true }).click()
    await expect(banner).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeEditable()
    await send(page, 'Uma nova tarefa depois da pausa')
    await expect(page.locator('.message.user p').last()).toHaveText('Uma nova tarefa depois da pausa')
  } finally {
    await app.close()
  }
})
