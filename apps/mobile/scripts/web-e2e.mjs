#!/usr/bin/env node
// Drives the app's web build through the demo server in Chromium, as a phone-sized window: the flows a person goes
// through first, with no server, account or phone. It needs Playwright's Chromium (`npx playwright install chromium`).
// `--no-export` reuses the last build in `web-dist/`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'web-dist')
const TIMEOUT = 20_000

if (!process.argv.includes('--no-export')) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['expo', 'export', '--platform', 'web', '--output-dir', 'web-dist', '--clear'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' } }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}
/** The build as a single-page app: a known file, else the app's page for every route. */
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  let file = path.join(dist, path.normalize(pathname).replace(/^([/\\])+/, ''))
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/** The browser's speech recognition, replaced by one that hears a fixed sentence. */
function stubSpeech() {
  window.webkitSpeechRecognition = class extends EventTarget {
    emit(name, extra) {
      this.dispatchEvent(Object.assign(new Event(name), extra))
    }
    hear(transcript, isFinal) {
      const list = [{ transcript, confidence: 0.9 }]
      list.isFinal = isFinal
      this.emit('result', { resultIndex: 0, results: [list] })
    }
    start() {
      setTimeout(() => {
        this.emit('start')
        this.hear('Also check the WebKit run', false)
      }, 50)
    }
    stop() {
      setTimeout(() => {
        this.hear('Also check the WebKit run.', true)
        this.emit('end')
      }, 50)
    }
    abort() {
      setTimeout(() => this.emit('end'), 20)
    }
  }
}

const problems = []
const browser = await chromium.launch()
const shots = mkdtempSync(path.join(os.tmpdir(), 'maestrly-mobile-e2e-'))
let failed = false
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' })
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT)
  await page.addInitScript(stubSpeech)
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`)
  })

  // Every control a screen reader can reach says what it is.
  const unnamed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role=button],[role=link],[role=tab],[role=switch],[role=checkbox],[role=radio],button,a,input,textarea')]
        .filter((element) => {
          const box = element.getBoundingClientRect()
          if ((box.width === 0 && box.height === 0) || element.closest('[aria-hidden=true]')) return false
          const name = element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder')
          return !name?.trim()
        })
        .map((element) => element.outerHTML.slice(0, 160))
    )
  const button = (name) => page.getByRole('button', { name })
  const openMenu = () => button(/^Open menu/).click()
  const step = async (name, run) => {
    process.stdout.write(`- ${name}… `)
    try {
      await run()
      for (const control of await unnamed()) problems.push(`unnamed control after "${name}": ${control}`)
      console.log('ok')
    } catch (error) {
      await page.screenshot({ path: path.join(shots, `${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
      console.log('failed')
      throw error
    }
  }

  await step('explore the demo server', async () => {
    await page.goto(`${base}/`)
    await button('Explore a demo server').click()
    await page.getByRole('tab', { name: /^Chats/ }).waitFor()
    await button(/^Expo Push or our own relay/).waitFor()
  })

  await step('talk to a bot', async () => {
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button(/^Ledger,/).click()
    const field = page.getByRole('textbox', { name: 'Message Ledger' })
    await field.fill('How did spend look this week?')
    await button('Send message').click()
    await page.getByText('How did spend look this week?').waitFor()
    await page.getByText(/Atlas accounts for 64%/).waitFor()
  })

  await step('dictate into the message field', async () => {
    await button('Dictate a message').click()
    await page.getByText('Also check the WebKit run', { exact: true }).waitFor()
    await button('Stop dictation').click()
    await page.getByRole('textbox', { name: 'Message Ledger' }).and(page.locator('textarea')).waitFor()
    const value = await page.getByRole('textbox', { name: 'Message Ledger' }).inputValue()
    if (value !== 'Also check the WebKit run.') throw new Error(`Dictation left "${value}" in the field`)
  })

  await step('compact a bot from its details', async () => {
    await button(/^Ledger: .*Show details/).click()
    await page.getByText(/22\.\dk of 1\.0M tokens/).waitFor()
    await button(/^Compact now/).click()
    await page.getByText(/9\.0k of 1\.0M tokens/).waitFor()
    await button('Done').click()
  })

  await step('approve a request', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button(/^Atlas, Needs your approval/).click()
    await button('Allow once').click()
    await page.getByText('Allowed', { exact: true }).waitFor()
  })

  await step('open a published page', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button(/^Pixel, Has a question for you/).click()
    await button('Open Pricing hero options').click()
    await page.getByRole('alert').filter({ hasText: "The demo server doesn't host pages" }).waitFor()
  })

  await step('start a chat', async () => {
    await button('New chat').click()
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('Write the release notes for 0.16')
    await button('Send message').click()
    await page.getByText('Maestrly 0.16').waitFor()
  })

  await step('change the chat setup', async () => {
    await button(/^Setup:/).click()
    await page.getByText('Chat setup').waitFor()
    await button('Done').click()
  })

  await step('open the settings', async () => {
    await openMenu()
    await button('Settings').click()
    // The web build cannot get push notifications, and says so.
    await page.getByText('Notifications aren’t available here').waitFor()
    await button('Done').click()
  })

  await step('show the dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByText('Maestrly 0.16').waitFor()
  })

  if (problems.length) throw new Error(`The app reported problems:\n${problems.join('\n')}`)
  console.log('Mobile web flows passed.')
} catch (error) {
  failed = true
  console.error(error instanceof Error ? error.message : error)
  console.error(`Screenshots: ${shots}`)
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
