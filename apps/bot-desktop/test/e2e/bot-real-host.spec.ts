import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
/**
 * Real-Host homologation (opt-in). Requires a packaged app or the built `out/` and a trusted
 * SSH target already present in the app's hosts.json for the lab profile, plus a bot that was
 * prepared and connected through the guided flow. It never creates hosts, VMs or bots on its own
 * and never runs in CI: set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET=<targetId>.
 */
test('real Host: the last bot conversation reopens and a delegated task completes without technical steps', async () => {
  test.skip(process.env.MAESTRLY_BOT_REAL_HOST !== '1' || !process.env.MAESTRLY_BOT_REAL_TARGET, 'Set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET to homologate against the selected Mac mini')
  const app = await electron.launch({ executablePath: process.env.BOT_PACKAGED_EXECUTABLE, args: process.env.BOT_PACKAGED_EXECUTABLE ? [] : [resolve('out/main/index.js')] })
  try {
    const page = await app.firstWindow()
    const status = await page.evaluate(async (target) => window.bot.connect(target), process.env.MAESTRLY_BOT_REAL_TARGET as string)
    expect(status.connected).toBe(true)
    expect(status.botSupport).toBe('available')
    const bots = await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))
    const ready = bots.find((bot) => bot.status === 'ready')
    test.skip(!ready, 'Prepare and connect a bot through the guided flow first')
    const clientMessageId = crypto.randomUUID()
    const receipt = await page.evaluate(
      ({ botId, clientMessageId }) => window.bot.bot({ method: 'bot.messages.send', params: { botId, clientMessageId, content: 'Crie o arquivo homologacao.md contendo a linha "ok" e me avise.' } }),
      { botId: ready!.id, clientMessageId }
    )
    await expect
      .poll(async () => (await page.evaluate((turnId) => window.bot.bot({ method: 'bot.turn.get', params: { turnId } }), receipt.turn.id)).status, { timeout: 600_000 })
      .toMatch(/succeeded|failed|cancelled|interrupted/)
    const files = await page.evaluate((botId) => window.bot.bot({ method: 'bot.files.list', params: { botId, path: '' } }), ready!.id)
    expect(files.some((file) => file.path === 'homologacao.md')).toBe(true)
    await page.screenshot({ path: 'test-results/real-host-result.png', fullPage: true })
  } finally {
    await app.close()
  }
})
