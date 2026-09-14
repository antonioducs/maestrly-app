import { _electron as electron, expect, test } from '@playwright/test'

test('installed app exposes the two independent bot conversations on the same real VM', async () => {
  test.skip(process.env.MAESTRLY_BOT_SHARED_REAL_UI !== '1' || !process.env.BOT_PACKAGED_EXECUTABLE, 'Explicit installed-app and real Host opt-in required')
  const app = await electron.launch({ executablePath: process.env.BOT_PACKAGED_EXECUTABLE })
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const page = await app.firstWindow()
    await expect.poll(() => page.evaluate(() => window.bot.status())).toMatchObject({ connected: true })
    const selected = await page.evaluate(async () => {
      const bots = await window.bot.bot({ method: 'bot.list', params: {} })
      const first = bots.find(a => a.vmId && bots.some(b => b.id !== a.id && b.vmId === a.vmId))
      if (!first) return []
      return Promise.all(bots.filter(b => b.vmId === first.vmId).slice(0, 2).map(async bot => ({ bot, session: await window.bot.bot({ method: 'bot.session.inspect', params: { botId: bot.id } }) })))
    })
    expect(selected).toHaveLength(2)
    expect(selected[0].session?.id).not.toBe(selected[1].session?.id)
    for (const { bot, session } of selected) {
      expect(session?.transport).toBe('managed')
      await page.getByRole('button', { name: bot.name, exact: true }).click()
      await expect(page.locator('.chat-header h1')).toHaveText(bot.name)
    }
    await page.screenshot({ path: 'test-results/real-shared-vm.png' })
  } finally { await app.close() }
})
