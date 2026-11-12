#!/usr/bin/env node
// Spike check: opens the board as its owner in headless Chromium, through the artifact host's shell and sandboxed
// frame, then has a person drag a card while the agent edits from an older revision.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { startSpikeHost } from './spike-host.mjs'

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/spike')
mkdirSync(out, { recursive: true })

const host = await startSpikeHost()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleLines = []
  const pageErrors = []
  const external = []
  const failed = []
  const cdn = []
  page.on('request', (request) => {
    if (request.url().includes('esm.sh')) cdn.push(request.url())
  })
  page.on('console', (message) => {
    if (message.text().includes('esm.sh')) cdn.push(message.text())
  })
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith(host.origin) && !/^(?:data|blob):/.test(url)) external.push(url)
  })
  page.on('requestfailed', (request) => failed.push(`${request.url()} ${request.failure()?.errorText}`))
  const localFonts = {}
  page.on('response', (response) => {
    const url = response.url()
    if (url.startsWith(host.origin) && url.includes('/fonts/')) {
      const family = url.split('/fonts/')[1].split('/')[0]
      localFonts[`${family} ${response.status()}`] = (localFonts[`${family} ${response.status()}`] ?? 0) + 1
    }
  })

  await page.goto(await host.ownerUrl())
  const started = Date.now()
  let frame
  while (!(frame = page.frames().find((candidate) => candidate.url().includes('/c/')))) {
    if (Date.now() - started > 20_000) throw new Error('the content frame never loaded')
    await page.waitForTimeout(100)
  }
  await frame.waitForFunction(() => window.__spike?.ready(), null, { timeout: 30_000 })
  await page.waitForTimeout(1500)
  const report = await frame.evaluate(() => window.__spike.report())
  await page.screenshot({ path: path.join(out, '1-loaded.png') })

  // A person drags the API card on the canvas.
  const frameBox = await page.locator('iframe').first().boundingBox()
  const center = await frame.evaluate(() => window.__spike.viewportCenter('api'))
  const x = frameBox.x + center.x
  const y = frameBox.y + center.y
  const drag = async () => {
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let step = 1; step <= 15; step++) {
      await page.mouse.move(x + (160 * step) / 15, y + (150 * step) / 15)
      await page.waitForTimeout(20)
    }
    await page.mouse.up()
    await page.waitForTimeout(300)
  }
  // The first drag is also the press that gives the frame the focus (see src/focus-guard.ts).
  await drag()
  const firstDrag = await frame.evaluate(() => window.__spike.scene('api'))
  const afterDrag = await frame.evaluate(() => {
    const board = window.__spike.board()
    const api = board.elements.get('api')
    return { revision: board.revision, by: api.by, x: api.element.x, y: api.element.y, version: api.element.version }
  })

  // The agent answers from the revision it read when the board opened.
  const agent = await frame.evaluate(() => window.__spike.runAgent())
  await page.waitForTimeout(800)
  const outline = await frame.evaluate((since) => window.__spike.outline(since), host.revision)
  await page.screenshot({ path: path.join(out, '2-merged.png') })

  if (cdn.length) {
    console.error(`CDN fallbacks attempted: ${cdn.length}`)
    process.exitCode = 1
  }
  console.log(
    JSON.stringify(
      {
        hostChecks: host.warnings,
        report,
        firstDrag,
        afterDrag,
        agent,
        changes: outline.changes,
        api: outline.cards.find((card) => card.id === 'api'),
        added: outline.cards.filter((card) => ['queue', 'cdn'].includes(card.id)),
        localFonts,
        external: [...new Set(external.map((url) => new URL(url).host))],
        externalCount: external.length,
        failed: failed.slice(0, 5),
        failedCount: failed.length,
        pageErrors,
        cspBlocked: consoleLines.filter((line) => /Content Security Policy/.test(line)).length,
        consoleProblems: consoleLines
          .filter((line) => /^(?:error|warning)|refused|violat/i.test(line))
          .filter((line) => !/Content Security Policy/.test(line))
          .map((line) => line.slice(0, 300)),
        screenshots: out,
      },
      null,
      2
    )
  )
} finally {
  await browser.close()
  await host.close()
}
