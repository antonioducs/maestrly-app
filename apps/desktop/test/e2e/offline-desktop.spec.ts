import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

declare const window: { api: { setLocale: (locale: 'en' | 'pt-BR') => void } }

const project = fileURLToPath(new URL('../..', import.meta.url))

test('opens the full desktop with a fresh profile, no account fixtures, and blocked network', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-offline-desktop-'))
  const entry = path.join(directory, 'offline-entry.mjs')
  await writeFile(
    entry,
    `
    import { app, net, session, dialog } from 'electron'
    app.setPath('appData', ${JSON.stringify(directory)})
    globalThis.offlineAttempts = []
    const local = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
    const originalFetch = globalThis.fetch
    const offlineFetch = async (input, options) => {
      const url = String(input?.url ?? input)
      if (local(url)) return originalFetch(input, options)
      globalThis.offlineAttempts.push(url)
      throw new TypeError('Network unavailable in offline test')
    }
    globalThis.fetch = offlineFetch
    net.fetch = offlineFetch
    app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        if (!local(details.url)) globalThis.offlineAttempts.push(details.url)
        callback({ cancel: !local(details.url) })
      }
    ))
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    await import(${JSON.stringify(pathToFileURL(path.join(project, 'out/main/index.js')).href)})
  `
  )
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    application = await electron.launch({
      args: [entry],
      env: {
        ...process.env,
        AGENTS_E2E: '',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'offline-test',
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
      },
    })
    const page = await application.firstWindow()
    const runtimeErrors: string[] = []
    page.on('pageerror', (error) => runtimeErrors.push(error.message))
    await expect(page.getByText('Welcome to Maestrly', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(page.getByText('No workspaces. Click + to add a folder.', { exact: true })).toBeVisible()
    await expect(page.getByText('Sign in', { exact: true })).toHaveCount(0)
    await page.getByTitle('Settings').click()
    await page.getByRole('button', { name: /Privacy/ }).click()
    await expect(page.getByText('Local data', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export data', exact: true })).toBeVisible()
    await page.evaluate(() => window.api.setLocale('pt-BR'))
    await expect(page.getByText('Dados locais', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Exportar dados', exact: true })).toBeVisible()
    const state = await application.evaluate(({ app }) => ({
      profile: app.getPath('userData'),
      attempts: (globalThis as typeof globalThis & { offlineAttempts: string[] }).offlineAttempts,
    }))
    expect(state.profile).toBe(path.join(directory, 'maestrly-app-dev-offline-test'))
    expect(state.attempts).toEqual([])
    expect(runtimeErrors).toEqual([])
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
