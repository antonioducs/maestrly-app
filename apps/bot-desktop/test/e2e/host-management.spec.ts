import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const executable =
  process.env.BOT_PACKAGED_EXECUTABLE ??
  resolve(
    `dist/lab/mac${process.arch === 'arm64' ? '-arm64' : ''}/Maestrly Bot Lab.app/Contents/MacOS/Maestrly Bot Lab`
  )
// Packaged startup only. No fixture or SSH host is connected by this suite.
test('packaged lab startup preserves identity and sandbox without enabling fixtures', async () => {
  test.skip(
    !process.env.BOT_PACKAGED_EXECUTABLE && !existsSync(executable),
    'Build the optional local lab package first'
  )
  const app = await electron.launch({ executablePath: executable, env: { ...process.env, MAESTRLY_BOT_FIXTURE: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'A place for your machines.' })).toBeVisible()
    const observed = await app.evaluate(({ app, BrowserWindow }) => {
      // Electron exposes this runtime inspection API without a public TypeScript declaration.
      const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean }
      }
      const preferences = contents.getLastWebPreferences()
      return {
        packaged: app.isPackaged,
        name: app.getName(),
        userDataLeaf: app.getPath('userData').split(/[\\/]/).at(-1),
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      }
    })
    expect(observed).toEqual({
      packaged: true,
      name: 'Maestrly Bot Lab',
      userDataLeaf: 'io.github.antonioducs.maestrly.bot.lab',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
    expect(await page.evaluate(() => window.bot.status())).toMatchObject({ connected: false, alias: null })
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
    await page.screenshot({ path: 'test-results/packaged-lab.png' })
    if (process.env.BOT_PACKAGED_REPORT)
      await writeFile(
        process.env.BOT_PACKAGED_REPORT,
        JSON.stringify({ ...observed, fixtureDisabled: true, rendererRequireAbsent: true }, null, 2) + '\n'
      )
  } finally {
    await app.close()
  }
})
