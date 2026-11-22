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

// A real browser is slow when the machine is busy, so this suite gets 120s per test instead of the default.
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
  }, 120_000)

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
      '  <div id="card" data-ds="Card">',
      '    <button id="btn" class="cors-btn primary extra-ignored" data-ds="PrimaryButton" data-ds-props="variant=solid size=lg">Pay now</button>',
      '  </div>',
      '  <button id="btn-main" class="cors-btn" data-ds="PrimaryButton" data-ds-main data-ds-props="variant=ghost size=sm">Main specimen</button>',
      '  <div id="opaque" class="opaque-box">Opaque stylesheet target</div>',
      '  <div id="opaque-comp" class="opaque-box" data-ds="OpaqueCard">Opaque component</div>',
      '  <input id="ed-input" type="text" aria-label="Search">',
      '  <textarea id="ed-textarea" aria-label="Notes"></textarea>',
      '  <div id="ed-ce" contenteditable="true"><span id="ed-ce-inner">Editable</span></div>',
      '</body>',
      '</html>',
    ].join('\n')

    const manifest = JSON.stringify({
      schema: 'maestrly-prototype/v1',
      title: 'Browser Probe',
      tokens: ['tokens.css'],
      screens: [{ id: 'main', name: 'Main', path: 'index.html', viewport: 'desktop' }],
      componentTokens: { OpaqueCard: ['--opaque-color'] },
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
    page.setDefaultTimeout(120_000)
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`http://127.0.0.1:${host.port}/a/${created.id}#o=${ticket}`)

    const contentFrameLocator = page.frameLocator('iframe.content')
    await contentFrameLocator.locator('#btn').waitFor({ state: 'visible', timeout: 60_000 })

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

    // Enable Inspect mode with componentTokens and click `#btn` (styled via `<link crossorigin>`)
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe.content') as HTMLIFrameElement
      iframe.contentWindow!.postMessage(
        {
          source: 'maestrly-shell',
          type: 'inspect-mode',
          inspecting: true,
          componentTokens: { OpaqueCard: ['--opaque-color'] },
        },
        '*'
      )
    })

    await contentFrameLocator.locator('#btn').click()

    const corsPick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const corsTarget = (await corsPick.jsonValue()) as {
      target: {
        component: string | null
        classes?: string[]
        elementLabel?: string
        props: Record<string, string>
        tokens: Array<{ name: string; value: string; property?: string }>
        chain?: Array<{ component: string; selector: string }>
        tokensFromManifest?: boolean
      }
    }
    expect(corsTarget.target.component).toBe('PrimaryButton')
    expect('classes' in corsTarget.target).toBe(false)
    expect(corsTarget.target.elementLabel).toBe('button.cors-btn.primary')
    expect(corsTarget.target.props).toEqual({ variant: 'solid', size: 'lg' })
    expect(corsTarget.target.chain).toEqual([{ component: 'Card', selector: '#card' }])
    expect(corsTarget.target.tokensFromManifest).toBeUndefined()
    // `<link crossorigin>` allowed CSSOM rule reading with exact CSS property inside the opaque-origin sandboxed frame!
    expect(corsTarget.target.tokens).toContainEqual({
      name: '--btn-bg',
      value: 'rgb(37, 99, 235)',
      property: 'background-color',
    })

    // Clicking `#opaque` (plain element styled via `<link>` WITHOUT `crossorigin`) reports elementLabel and no SecurityError
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
    })
    await contentFrameLocator.locator('#opaque').click()
    const opaquePick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const opaqueTarget = (await opaquePick.jsonValue()) as {
      target: { tag: string; elementLabel?: string; tokens: Array<{ name: string; value: string }> }
    }
    expect(opaqueTarget.target.tag).toBe('div')
    expect('classes' in opaqueTarget.target).toBe(false)
    expect(opaqueTarget.target.elementLabel).toBe('div.opaque-box')
    expect(opaqueTarget.target.tokens).toEqual([])
    expect(pageErrors).toEqual([])

    // Clicking `#opaque-comp` falls back to `componentTokens` and flags `tokensFromManifest: true`
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
    })
    await contentFrameLocator.locator('#opaque-comp').click()
    const manifestFallbackPick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const manifestFallbackTarget = (await manifestFallbackPick.jsonValue()) as {
      target: {
        component: string | null
        tokens: Array<{ name: string; value: string; property?: string }>
        tokensFromManifest?: boolean
      }
    }
    expect(manifestFallbackTarget.target.component).toBe('OpaqueCard')
    expect(manifestFallbackTarget.target.tokensFromManifest).toBe(true)
    expect(manifestFallbackTarget.target.tokens).toEqual([{ name: '--opaque-color', value: 'rgb(16, 185, 129)' }])

    // Clicking `#btn-main` (`data-ds-main`) reports normalized variants from non-main `[data-ds="PrimaryButton"]` instances
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
    })
    await contentFrameLocator.locator('#btn-main').click()
    const mainPick = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'inspect-pick') ?? null
    })
    const mainTarget = (await mainPick.jsonValue()) as {
      target: { main: boolean; variants?: string[] }
    }
    expect(mainTarget.target.main).toBe(true)
    expect(mainTarget.target.variants).toEqual(['variant=solid size=lg'])

    // `inspect-select` selects ancestor `#card` programmatically and `highlight-component` returns instance match rects
    await page.evaluate(() => {
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
      const iframe = document.querySelector('iframe.content') as HTMLIFrameElement
      iframe.contentWindow!.postMessage({ source: 'maestrly-shell', type: 'inspect-select', selector: '#card' }, '*')
      iframe.contentWindow!.postMessage(
        { source: 'maestrly-shell', type: 'highlight-component', component: 'PrimaryButton' },
        '*'
      )
    })
    const matchesMsg = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.find((m) => m.type === 'matches') ?? null
    })
    const matchesVal = (await matchesMsg.jsonValue()) as { rects: Array<{ width: number; height: number }> }
    // Only the non-main `#btn` instance is highlighted (1 rect, not `#btn-main`)
    expect(matchesVal.rects).toHaveLength(1)
    expect(matchesVal.rects[0]!.width).toBeGreaterThan(0)

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
      iframe.contentWindow!.postMessage({ source: 'maestrly-shell', type: 'inspect-mode', inspecting: false }, '*')
      ;(window as unknown as { __bridgeMessages: unknown[] }).__bridgeMessages = []
    })
    await childFrame.waitForFunction(
      () => getComputedStyle(document.getElementById('btn')!).backgroundColor === 'rgb(37, 99, 235)'
    )

    // Typing c/f/i/s/t inside input, textarea, and contenteditable never forwards shortcut keys
    await contentFrameLocator.locator('#ed-input').click()
    await page.keyboard.type('cfist')
    await contentFrameLocator.locator('#ed-textarea').click()
    await page.keyboard.type('cfist')
    await contentFrameLocator.locator('#ed-ce-inner').click()
    await page.keyboard.type('cfist')

    const forwardedWhileEditing = await page.evaluate(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<Record<string, unknown>> }).__bridgeMessages
      return msgs.filter((m) => m.type === 'key')
    })
    expect(forwardedWhileEditing).toEqual([])

    // Focusing a non-editable element forwards 't' and 's' shortcuts ('s' switches to Screens view and moves focus out of the iframe, so send 't' first)
    await contentFrameLocator.locator('#btn').focus()
    await childFrame.waitForFunction(() => document.activeElement?.id === 'btn')
    await contentFrameLocator.locator('#btn').press('t')
    await contentFrameLocator.locator('#btn').press('s')
    const forwardedKeys = await page.waitForFunction(() => {
      const msgs = (window as unknown as { __bridgeMessages: Array<{ type: string; key?: string }> }).__bridgeMessages
      const keys = msgs.filter((m) => m.type === 'key').map((m) => m.key)
      return keys.length >= 2 ? keys : null
    })
    expect(await forwardedKeys.jsonValue()).toEqual(['t', 's'])

    await context.close()
  }, 120_000)
})
