import { expect, test } from '@playwright/test'
import { launchBot, readyBot, send } from './bot-helpers'
import { openScreen, pixel } from './desktop-helpers'

test('the conversation opens the live screen read-only, without technical details or a new task', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    const before = await page.locator('.message').count()
    const panel = await openScreen(page)
    // Real pixels from the RFB stream: the fixture's white form field.
    await expect.poll(() => pixel(page, 300, 280)).toEqual([255, 255, 255])
    await expect(page.locator('body')).not.toContainText(/QMP|PID|socket|porta|mdt\.|ticket|epoch|RFB/i)
    await expect(panel.getByRole('button', { name: 'Assumir controle', exact: true })).toBeVisible()
    await expect(panel.getByText(/Ao assumir, o bot para o que está fazendo/)).toBeVisible()
    // Watching never types or clicks on the bot's desktop.
    await panel.locator('.desktop-canvas').click({ position: { x: 150, y: 120 } })
    await page.keyboard.type('xyz')
    await page.waitForTimeout(300)
    expect(await pixel(page, 296, 282)).toEqual([255, 255, 255])
    expect(await page.locator('.message').count()).toBe(before)
    // Live updates while the bot works: the activity strip moves between frames.
    await send(page, '#slow Organize os arquivos')
    const strip = async () => JSON.stringify(await Promise.all([0, 160, 320, 480, 640, 800, 960, 1120].map((x) => pixel(page, x + 20, 34))))
    const first = await strip()
    await expect.poll(strip, { timeout: 5_000 }).not.toBe(first)
    // Enlarging keeps the same view.
    await panel.getByRole('button', { name: 'Ampliar tela', exact: true }).click()
    await expect(page.locator('.chat-layout')).toHaveClass(/desktop-expanded/)
    await panel.getByText('Mais opções', { exact: true }).click()
    await expect(panel.locator('.desktop-more dd').nth(1)).toHaveText('1')
    await panel.getByRole('button', { name: 'Reduzir tela', exact: true }).click()
    await panel.getByRole('button', { name: 'Fechar tela', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Ver tela', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})

test('light theme and the minimum window keep the screen usable without overflow', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page)
    await page.evaluate(() => window.bot.savePreferences({ theme: 'light' }))
    await page.reload()
    await expect(page.locator('.chat-header h1')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(840, 620))
    const panel = await openScreen(page)
    await expect.poll(() => pixel(page, 300, 280)).toEqual([255, 255, 255])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(panel.getByRole('button', { name: 'Assumir controle', exact: true })).toBeInViewport()
    await page.screenshot({ path: 'test-results/desktop-light-minimum.png' })
    await page.evaluate(() => window.bot.savePreferences({ theme: 'dark' }))
    await page.reload()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
    await openScreen(page)
    await page.screenshot({ path: 'test-results/desktop-dark-wide.png' })
  } finally {
    await app.close()
  }
})
