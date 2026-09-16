import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { openScreen } from './desktop-helpers'
/**
 * Real-Host live desktop homologation (opt-in, never in CI). Requires the packaged app or the
 * built `out/`, a trusted target already in the app's hosts.json, a Host with the phase 3
 * capabilities and an idle ready bot whose environment was updated and restarted in an
 * authorized window. Set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET=<targetId>.
 * It never creates hosts, VMs or bots and never starts a task on its own.
 */
test('real Host: watch the bot screen, take control, click and hand it back', async () => {
  test.skip(process.env.MAESTRLY_BOT_REAL_HOST !== '1' || !process.env.MAESTRLY_BOT_REAL_TARGET, 'Set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET to homologate against the selected Mac mini')
  const app = await electron.launch({ executablePath: process.env.BOT_PACKAGED_EXECUTABLE, args: process.env.BOT_PACKAGED_EXECUTABLE ? [] : [resolve('out/main/index.js')] })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.bot)
    const target = process.env.MAESTRLY_BOT_REAL_TARGET as string
    // The app reconnects to its last Host on start: let that settle, then select the target
    // explicitly (it binds the bot client) without cutting an in-flight startup request.
    let status = await page.evaluate(() => window.bot.status())
    for (let waited = 0; !status.connected && waited < 20_000; waited += 500) {
      await page.waitForTimeout(500)
      status = await page.evaluate(() => window.bot.status())
    }
    const connect = () => page.evaluate(async (id) => window.bot.connect(id), target)
    status = await connect().catch(async (error) => {
      if (!/Host disconnected/.test(String(error))) throw error
      await page.waitForTimeout(1500)
      return connect()
    })
    expect(status.connected).toBe(true)
    test.info().annotations.push({ type: 'hostId', description: String(status.hostId) })
    const bots = await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))
    const ready = bots.find((bot) => bot.status === 'ready' && !bot.activeTurnId)
    test.skip(!ready, 'An idle ready bot is required')
    const desktop = await page.evaluate((botId) => window.bot.desktop.inspect(botId), ready!.id)
    test.skip(!desktop.available, 'Update the environment and restart its VM in an authorized window first')
    await page.reload()
    const header = page.locator('.chat-header h1')
    if ((await header.textContent().catch(() => null)) !== ready!.name) await page.getByRole('button', { name: ready!.name }).first().click()
    await expect(header).toHaveText(ready!.name)
    const started = Date.now()
    const panel = await openScreen(page)
    const firstFrameMs = Date.now() - started
    await panel.getByRole('button', { name: 'Assumir controle', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText(/Você está no controle/, { timeout: 60_000 })
    const canvas = panel.locator('.desktop-screen canvas')
    const box = (await canvas.boundingBox())!
    // A right click opens a menu on the bot desktop; Escape closes it.
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9, { button: 'right' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Escape')
    await panel.getByRole('button', { name: /^Devolver/ }).first().click()
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 60_000 })
    // No ticket or control capability ever reaches the page.
    expect(await page.evaluate(() => /[a-f0-9]{64}/.test(document.documentElement.outerHTML))).toBe(false)
    await page.screenshot({ path: 'test-results/real-host-desktop.png', fullPage: true })
    test.info().annotations.push({ type: 'firstFrameMs', description: String(firstFrameMs) })
  } finally {
    await app.close()
  }
})
