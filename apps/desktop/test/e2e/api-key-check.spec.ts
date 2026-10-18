import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const INVALID_KEY = 'sk-qa-invalid-0000000000001111'
const VALID_KEY = 'sk-qa-valid-0000000000002222'

/**
 * A custom OpenAI-compatible account added with a key the provider refuses is flagged on its card and in the list,
 * not counted as connected, and recovers once a valid key is saved. The provider is a local fixture whose /models
 * answers 401 like OpenAI does, echoing a masked key; the full key must never reach the page.
 */
test('flags an API-key account whose key the provider rejects', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(120_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-api-key-check-'))
  const requests: string[] = []
  let app: ElectronApplication | undefined

  const provider: Server = createServer((req, res) => {
    const authorization = req.headers.authorization ?? ''
    requests.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url !== '/v1/models') {
      res.writeHead(404).end('{}')
      return
    }
    if (authorization === `Bearer ${VALID_KEY}`) {
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      return
    }
    res.writeHead(401).end(
      JSON.stringify({
        error: {
          message: 'Incorrect API key provided: sk-qa-in***********1111.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      })
    )
  })

  try {
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const baseURL = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: `api-key-check-${Date.now().toString(36)}`,
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    if (!(await page.evaluate(() => (window as any).api.getOnboardingDone()))) {
      await page.evaluate(() => (window as any).api.setOnboardingDone(true))
      const skip = page.getByRole('button', { name: 'Skip' })
      if (await skip.isVisible().catch(() => false)) await skip.click()
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Maestrly Chat' })).toBeVisible()
    await page.getByRole('button', { name: 'Add account', exact: true }).first().click()
    const dialog = page.getByTestId('add-account-dialog')
    await dialog.getByRole('button', { name: /Custom provider/ }).click()
    await dialog.getByRole('textbox', { name: 'Name (e.g. My provider)' }).fill('OpenAI custom')
    await dialog.getByRole('textbox', { name: 'baseURL (e.g. https://api.example.com/v1)' }).fill(baseURL)
    await dialog.getByLabel('API key (optional for now)').fill(INVALID_KEY)
    await dialog.getByRole('button', { name: 'Add provider', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const card = page.locator('[data-api-key-provider]')
    await expect(card.locator('[data-key-check="rejected"]')).toHaveText('Key rejected')
    const notice = card.locator('[data-key-check-notice="rejected"]')
    await expect(notice).toContainText('The provider refused this key (HTTP 401)')
    await expect(notice).toContainText('Incorrect API key provided: sk-qa-in***********1111.')
    // A refused key needs a new one: the account is listed as needing attention, not as connected.
    await expect(page.getByText('0 connected', { exact: true })).toBeVisible()
    await expect(page.getByText('1 needs attention', { exact: true })).toBeVisible()
    const accounts = page.getByRole('listbox', { name: 'Accounts' })
    await expect(accounts.getByRole('option', { name: /OpenAI custom/ })).toContainText('Key rejected')
    expect(await page.content()).not.toContain(INVALID_KEY)
    const rejectedShot = testInfo.outputPath('api-key-rejected.png')
    await page.locator('[data-api-key-provider]').screenshot({ path: rejectedShot, animations: 'disabled' })
    await testInfo.attach('Rejected API key', { path: rejectedShot, contentType: 'image/png' })

    await card.getByLabel('API key').fill(VALID_KEY)
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(card.locator('[data-key-check="accepted"]')).toHaveText('Key verified')
    await expect(card.locator('[data-key-check-notice]')).toHaveCount(0)
    await expect(page.getByText('1 connected', { exact: true })).toBeVisible()
    await expect(page.getByText('1 needs attention', { exact: true })).toHaveCount(0)
    expect(await page.content()).not.toContain(VALID_KEY)
    expect(requests.filter((request) => request === 'GET /v1/models').length).toBeGreaterThanOrEqual(2)
  } finally {
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => provider.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
