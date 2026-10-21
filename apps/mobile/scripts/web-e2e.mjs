#!/usr/bin/env node
// Drives the app's web build through the demo server in Chromium, as a phone-sized window: the flows a person goes
// through first, with no server, account or phone. It needs Playwright's Chromium (`npx playwright install chromium`).
// `--no-export` reuses the last build in `web-dist/`.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { exportWebBuild, serveWebBuild } from './web-build.mjs'

const TIMEOUT = 20_000

exportWebBuild()
const server = await serveWebBuild()
const base = server.base

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
  /** Waits until the element is inside the window, not just in the page. */
  const inView = async (locator) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const box = await locator.boundingBox()
      if (box && box.y >= 0 && box.y + box.height <= 844) return
      await page.waitForTimeout(100)
    }
    throw new Error('Not scrolled into view')
  }
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
    // Sending puts the keyboard away.
    if (await field.evaluate((element) => element === document.activeElement))
      throw new Error('The message field kept the focus after sending')
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

  await step('go back to the latest message', async () => {
    const latest = page.getByText('Conversation compacted').last()
    await inView(latest)
    const list = page.getByText(/Atlas accounts for 64%/).first()
    const box = await list.boundingBox()
    await page.mouse.move(195, box ? Math.max(120, box.y) : 400)
    for (let turn = 0; turn < 8 && !(await button('Go to the latest message').count()); turn++) {
      await page.mouse.wheel(0, -1200)
      await page.waitForTimeout(150)
    }
    await button('Go to the latest message').click()
    await inView(latest)
    await page.waitForTimeout(300)
    if (await button('Go to the latest message').count()) throw new Error('The button stayed at the end')
  })

  await step('approve a request', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button(/^Atlas, Needs your approval/).click()
    await button('Allow once').click()
    await page.getByText('Allowed', { exact: true }).waitFor()
  })

  await step('follow a bot’s routine runs and its conversations with other bots', async () => {
    // Atlas keeps them apart: its conversation tells when a run ended, and leads to the one it opened with Pixel.
    await page.getByText('Release readiness check finished').waitFor()
    await button(/^Conversation with Pixel/).waitFor()
    await page.getByRole('tab', { name: 'Runs' }).click()
    await button(/^Staging health check, 4 with nothing new/).click()
    await button(/^Staging health check, Nothing new/).first().waitFor()
    await button(/^Release readiness check, Done/).click()
    await page.getByText('Run report').waitFor()
    await button('More actions').click()
    await button(/^Cite in your conversation/).click()
    // Back in Atlas's conversation, the next message cites the run.
    const field = page.getByRole('textbox', { name: 'Ask Atlas about Release readiness check' })
    await field.fill('Is anything still blocking rc.2?')
    await button('Send message').click()
    await page.getByRole('link', { name: /^Release readiness check · / }).waitFor()
    await page.getByRole('tab', { name: /^Conversations with other bots/ }).click()
    await button(/^Pricing hero for rc\.2/).click()
    // The thread's row in the list repeats this text while the conversation opens: wait for the alert, not the text.
    await page.getByRole('alert').getByText('Paused after 8 messages without you').waitFor()
    await button('Let them go on for 8 more').click()
    await page.getByText(/let’s get Stacked ready/).waitFor()
    await button('Back').click()
    await button(/^Pricing hero for rc\.2, Atlas and Pixel, Open/).waitFor()
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click()
  })

  await step('create a bot in an environment', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button('New bot in research').click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Nova')
    await page.getByRole('textbox', { name: 'What it does' }).fill('Triage new issues every morning.')
    await page.getByRole('checkbox', { name: /^Ledger/ }).click()
    await button('Create bot').click()
    // Its conversation opens and takes messages once the bot has set up its profile.
    await page.getByRole('textbox', { name: 'Message Nova' }).waitFor()
  })

  await step('open a published page', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await button(/^Pixel, Has a question for you/).click()
    await button('Open Pricing hero options').click()
    await page.getByRole('alert').filter({ hasText: "The demo server doesn't host pages" }).waitFor()
  })

  await step('play a video a bot shared', async () => {
    await page.getByText('pricing-walkthrough.mp4').waitFor()
    await page.getByText('4.0 MB').waitFor()
    await button('Play pricing-walkthrough.mp4').click()
    await page.getByRole('alert').filter({ hasText: "The demo server doesn't host files" }).waitFor()
  })

  await step('start a chat', async () => {
    await button('New chat').click()
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('Write the release notes for 0.16')
    await button('Send message').click()
    await page.getByText('Maestrly 0.16').waitFor()
  })

  await step('allow everything in a chat from its request', async () => {
    await page.getByRole('button', { name: 'New chat', exact: true }).filter({ visible: true }).first().click()
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('Clean the build cache')
    await button('Send message').click()
    page.once('dialog', (dialog) => dialog.accept())
    await button('Allow everything in this chat').click()
    await page.getByText('Allowed', { exact: true }).waitFor()
    await page.getByText('Cleared the build cache.', { exact: false }).waitFor()
    await button(/^Setup: .*Full access/).waitFor()
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
    // The router navigates after the press commits, so the settings are still on screen right after it.
    await page.getByText('Notifications aren’t available here').waitFor({ state: 'hidden' })
  })

  await step('remove a paired device', async () => {
    if (!(await button('Settings').isVisible())) await openMenu()
    await button('Settings').click()
    await button('Paired devices').click()
    await page.getByText('Phone (this phone)').waitFor()
    await page.getByText('MacBook Pro').waitFor()
    if (await button('Remove Phone').count()) throw new Error('This phone offered to remove itself')
    page.once('dialog', (dialog) => dialog.accept())
    await button('Remove Pixel 9').click()
    await page.getByText('Pixel 9').waitFor({ state: 'detached' })
    await button('Done').click()
    await page.getByText('Notifications aren’t available here').waitFor()
    await button('Done').click()
  })

  await step('read the subscription usage', async () => {
    // The settings the step before closed are still on screen right after it.
    await page.getByText('Notifications aren’t available here').waitFor({ state: 'hidden' })
    if (!(await button('Settings').isVisible())) await openMenu()
    await button('Settings').click()
    await button('Subscription usage').click()
    for (const provider of ['ChatGPT', 'Claude', 'Google AI']) await page.getByRole('heading', { name: provider }).waitFor()
    // Each Claude account shows on its own.
    await page.getByText('Work', { exact: true }).waitFor()
    await page.getByRole('progressbar', { name: /^5-hour window, Resets in 47m/ }).waitFor()
    await page.getByRole('progressbar', { name: 'Weekly · Gemini 3 Pro, Resets in 6d' }).waitFor()
    await page.getByText('94% used').waitFor()
    await button('Refresh subscription usage').click()
    await page.getByText('Updated just now').waitFor()
    await button('Done').click()
    await page.getByText('Notifications aren’t available here').waitFor()
    await button('Done').click()
    await page.getByText('Notifications aren’t available here').waitFor({ state: 'hidden' })
  })

  await step('show the dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByText('Cleared the build cache.', { exact: false }).waitFor()
  })

  await step('open a conversation from its report', async () => {
    const chats = page.getByRole('tab', { name: /^Chats/ })
    if (!(await chats.isVisible())) await openMenu()
    await chats.click()
    await button(/^Mobile app MVP scope/).click()
    await page.getByRole('link', { name: 'Report from Expo push sender interface' }).click()
    await page.getByText('Expo push sender interface').first().waitFor()
    await page.getByRole('textbox', { name: /Message|Ask anything/ }).waitFor()
  })

  await step('use an interactive answer', async () => {
    await openMenu()
    await page.getByRole('tab', { name: /^Chats/ }).click()
    await button(/^Pricing tiers for teams/).click()
    // The block runs in a sandboxed frame of its own, not as source in the page.
    const frame = page.frameLocator('iframe[title="Interactive answer"]')
    await frame.getByText('Starter').waitFor()
    if (await page.getByText('<div class="tiers">').count()) throw new Error('The interface showed as source')
    // What it asks to send waits for the person to agree.
    const asked = new Promise((resolve) =>
      page.once('dialog', (dialog) => {
        resolve(dialog.message())
        void dialog.accept()
      })
    )
    await frame.getByRole('button', { name: 'Ask about Team' }).click()
    if (!String(await asked).includes('Tell me about Team')) throw new Error('The confirmation did not show the message')
    await page.getByText('Tell me about Team', { exact: true }).waitFor()
    await button('Show code').click()
    await page.getByText(/<div class="tiers">/).waitFor()
    await button('Hide code').click()
  })

  await step('switch between workspaces environments', async () => {
    await openMenu()
    await button(/^Personal, Running\. Choose a workspaces environment/).click()
    await page.getByRole('radio', { name: /^Company/ }).click()
    // Each environment has its own chats.
    await button(/^Read-only role for auditors/).click()
    await page.getByText(/Auditors need to see accounts, invoices and the audit log/).waitFor()
    await openMenu()
    if (await button(/^Pricing tiers for teams/).count()) throw new Error('Company listed a chat of Personal')
    await button(/^Company, Running\. Choose a workspaces environment/).click()
    await page.getByRole('radio', { name: /^Personal/ }).click()
    await button(/^Pricing tiers for teams/).waitFor()
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
