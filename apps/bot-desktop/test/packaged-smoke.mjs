import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const app = await electron.launch({
  executablePath: resolve('dist/lab/mac-arm64/Maestrly Bot Lab.app/Contents/MacOS/Maestrly Bot Lab'),
  env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1' },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: 'A place for your machines.' }).waitFor()
  const identity = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    path: app.getPath('userData'),
    name: app.getName(),
  }))
  assert.equal(identity.packaged, true)
  assert.equal(identity.name, 'Maestrly Bot Lab')
  assert.ok(identity.path.endsWith('io.github.antonioducs.maestrly.bot.lab'))
  assert.equal(await page.evaluate(() => window.bot.status()).then((s) => s.alias), null)
  await page.screenshot({ path: 'test-results/packaged-lab.png' })
  console.log('Packaged lab startup, isolated identity, sandbox preload, and disabled fixture switch verified.')
} finally {
  await app.close()
}
