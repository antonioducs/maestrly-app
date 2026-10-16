#!/usr/bin/env node
// Renders the App Store screenshots from the web build through the demo server, at the size of a 6.9-inch iPhone
// (1290 × 2796), into store/screenshots/. store.config.cjs lists them. It needs Playwright's Chromium
// (`npx playwright install chromium`). `--no-export` reuses the last build in `web-dist/`.
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { en } from '../src/i18n/catalogs.ts'
import { exportWebBuild, root, serveWebBuild } from './web-build.mjs'

/** The points of a 6.9-inch iPhone, rendered at its scale. */
const VIEWPORT = { width: 430, height: 932 }
const SCALE = 3
const out = path.join(root, 'store', 'screenshots', 'iphone-6.9')

exportWebBuild()
const server = await serveWebBuild()
const browser = await chromium.launch()
let failed = false
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    hasTouch: true,
    locale: 'en-US',
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const button = (name) => page.getByRole('button', { name })
  /** Opens the menu on one of its tabs, unless it is already open. */
  const menuTab = async (key) => {
    const tab = page.getByRole('tab', { name: new RegExp(`^${en[key]}`) })
    if (!(await tab.isVisible())) await button(new RegExp(`^${en['home.openMenu']}`)).click()
    await tab.click()
  }
  const openBot = async (name) => {
    await menuTab('drawer.bots')
    await button(new RegExp(`^${name}, `)).last().click()
  }
  /** Lets streaming and entrance animations finish, then saves the window as the store shows it. */
  const shoot = async (name) => {
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(out, `${name}.png`) })
    console.log(`- ${name}`)
  }

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await page.goto(`${server.base}/`)
  await button(en['welcome.demo']).click()
  await page.getByRole('tab', { name: new RegExp(`^${en['drawer.chats']}`) }).waitFor()

  await menuTab('drawer.bots')
  await button(/^Atlas, /).first().waitFor()
  await shoot('01-bots')

  await openBot('Ledger')
  await page.getByRole('textbox', { name: en['composer.placeholder'].replace('{name}', 'Ledger') }).fill('How did spend look this week?')
  await button(en['composer.send']).click()
  await page.getByText(/Atlas accounts for 64%/).waitFor()
  await shoot('02-conversation')

  await openBot('Atlas')
  await button(en['perm.allowOnce']).waitFor()
  await shoot('03-approval')

  await menuTab('drawer.chats')
  await button(/^Pricing tiers for teams/).click()
  await page.frameLocator('iframe[title="Interactive answer"]').getByText('Starter').waitFor()
  await shoot('04-interactive-answer')

  await button(/^Setup:/).click()
  await page.getByText(en['chat.setup.title']).waitFor()
  await shoot('05-chat-setup')
  console.log(`Screenshots: ${out}`)
} catch (error) {
  failed = true
  console.error(error instanceof Error ? error.message : error)
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
