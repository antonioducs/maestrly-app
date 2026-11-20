import { existsSync } from 'node:fs'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openArtifactHost, type ArtifactHost } from '../src/host.js'
import { tempDir, utf8 } from './helpers.js'

async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true })
  } catch (firstError) {
    if (existsSync('/usr/bin/chromium')) {
      return await chromium.launch({
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
    }
    throw firstError
  }
}

describe('real Chromium sandboxed iframe bridge (<link crossorigin> CSSOM + adoptedStyleSheets preview)', () => {
  let tmp: ReturnType<typeof tempDir>
  let host: ArtifactHost
  let browser: Browser

  beforeAll(async () => {
    tmp = tempDir()
    host = await openArtifactHost({
      dataDir: tmp.dir,
      port: 0,
      quotaBytes: 16 * 1024 * 1024,
      ownerName: 'Antonio',
    })
    browser = await launchChromium()
  }, 30_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await host?.close().catch(() => {})
    tmp?.cleanup()
  })

  it('reads CSSOM rules from <link rel="stylesheet" crossorigin>, degrades safely without crossorigin, and previews tokens via adoptedStyleSheets without mutating DOM', async () => {
    const tokensCss = [
      ':root {',
      '  --btn-bg: rgb(37, 99, 235);',
      '  --opaque-color: rgb(16, 185, 129);',
      '}',
      '.cors-btn {',
      '  background-color: var(--btn-bg);',
      '  padding: 10px 16px;',
      '}',
    ].join('\n')

    const opaqueCss = '.opaque-box { color: var(--opaque-color); }\n'

    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '  <meta charset="utf-8">',
      '  <link rel="stylesheet" href="tokens.css" crossorigin>',
      '  <link rel="stylesheet" href="opaque.css">',
      '</head>',
      '<body>',
      '  <button id="btn" class="cors-btn" data-ds="PrimaryButton" data-ds-props="variant=solid size=lg">Pay now</button>',
      '  <div id="opaque" class="opaque-box">Opaque stylesheet target</div>',
      '</body>',
      '</html>',
    ].join('\n')

    const manifest = JSON.stringify({
      schema: 'maestrly-prototype/v1',
      title: 'Browser Probe',
      tokens: ['tokens.css'],
      screens: [{ id: 'main', name: 'Main', path: 'index.html', viewport: 'desktop' }],
    })

    const created = await host.admin.create({
      title: 'Browser Probe',
      owner: { kind: 'local', id: 'local' },
      origin: { workspaceId: null, conversationId: null, conversationTitle: null },
      files: [
        { path: 'index.html', bytes: utf8(html) },
        { path: 'tokens.css', bytes: utf8(tokensCss) },
        { path: 'opaque.css', bytes: utf8(opaqueCss) },
        { path: 'maestrly-design.json', bytes: utf8(manifest) },
      ],
    })

    const { ticket } = await host.admin.mintOwnerTicket(created.id)
    const context = await browser.newContext()
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`http://127.0.0.1:${host.port}/a/${created.id}#o=${ticket}`)

    const contentFrameLocator = page.frameLocator('iframe.content')
    await contentFrameLocator.locator('#btn').waitFor({ state: 'visible', timeout: 10_000 })

    // Capture bridge messages received by the top-level shell window
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
      window.addEventListener('message', (event) => {
        if (event.data && event.data.source === 'maestrly-bridge') {
          ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages.push(event.data)
        }
      })
    })

    // Record DOM snapshot before Inspect & live token preview
    const childFrame = page.frames().find((f) => f.url().includes('/c/'))!
    expect(childFrame).toBeDefined()
    const initialOuterHtml = await childFrame.evaluate(() => document.documentElement.outerHTML)
    const initialBg = await childFrame.evaluate(() => getComputedStyle(document.getElementById('btn')!).backgroundColor)
    expect(initialBg).toBe('rgb(37, 99, 235)')

    // Enable Inspect mode and click `#btn` (styled via `<link crossorigin>`)
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe.content') as HTMLIFrameElement
      iframe.contentWindow!.postMessage({ source: 'maestrly-shell', type: 'inspect-mode', inspecting: true }, '*')
    })

    await contentFrameLocator.locator('#btn').click()

    const corsPick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const corsTarget = (await corsPick.jsonValue()) as {
      target: {
        component: string | null
        props: Record<string, string>
        tokens: Array<{ name: string; value: string }>
      }
    }
    expect(corsTarget.target.component).toBe('PrimaryButton')
    expect(corsTarget.target.props).toEqual({ variant: 'solid', size: 'lg' })
    // `<link crossorigin>` allowed CSSOM rule reading inside the opaque-origin sandboxed frame!
    expect(corsTarget.target.tokens).toContainEqual({ name: '--btn-bg', value: 'rgb(37, 99, 235)' })

    // Clicking `#opaque` (styled via `<link>` WITHOUT `crossorigin`) must not throw SecurityError
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
    })
    await contentFrameLocator.locator('#opaque').click()
    const opaquePick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const opaqueTarget = (await opaquePick.jsonValue()) as {
      target: { tag: string; tokens: Array<{ name: string; value: string }> }
    }
    expect(opaqueTarget.target.tag).toBe('div')
    expect(opaqueTarget.target.tokens).toEqual([])
    expect(pageErrors).toEqual([])

    // Select `#btn` again, then apply live `token-preview` via `adoptedStyleSheets`
    await contentFrameLocator.locator('#btn').click()
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
      const iframe = document.querySelector('iframe.content') as HTMLIFrameElement
      iframe.contentWindow!.postMessage(
        {
          source: 'maestrly-shell',
          type: 'token-preview',
          tokens: [
            { name: '--opaque-color', value: '"unclosed' },
            { name: '--opaque-color', value: 'calc(1px' },
            { name: '--opaque-color', value: '[broken' },
            { name: '--btn-bg', value: 'rgb(225, 29, 72)' },
          ],
        },
        '*'
      )
    })

    await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.some((m) => m.type === 'inspect-pick')
    })

    const previewBg = await childFrame.evaluate(() => getComputedStyle(document.getElementById('btn')!).backgroundColor)
    const adoptedCount = await childFrame.evaluate(() => document.adoptedStyleSheets.length)
    const afterPreviewOuterHtml = await childFrame.evaluate(() => document.documentElement.outerHTML)
    expect(previewBg).toBe('rgb(225, 29, 72)')
    expect(adoptedCount).toBeGreaterThanOrEqual(2)
    // Zero DOM mutations!
    expect(afterPreviewOuterHtml).toBe(initialOuterHtml)

    // Clear preview and verify original computed style is restored
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe.content') as HTMLIFrameElement
      iframe.contentWindow!.postMessage({ source: 'maestrly-shell', type: 'token-preview-clear' }, '*')
    })
    await childFrame.waitForFunction(
      () => getComputedStyle(document.getElementById('btn')!).backgroundColor === 'rgb(37, 99, 235)'
    )

    await context.close()
  }, 30_000)
})
