import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const conversationId = 'e2e-browser-screenshot-agent-path'

interface ToolResult {
  text: string
  isError: boolean
  images: Array<{ data: string; mediaType: string; byteSize: number }>
}

interface DecodedPng {
  width: number
  height: number
  center: { red: number; green: number; blue: number; alpha: number }
}

interface BrowserViewState {
  bounds: { x: number; y: number; width: number; height: number }
  ownerCount: number
  ownerVisible: boolean
  childIndex: number
}

let userDataDir: string
let fixtureServer: Server
let fixtureUrl: string

function callAppTool(
  app: ElectronApplication,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return app.evaluate(
    async (_electron, input) => {
      const call = globalThis.__maestrlyE2ECallAppTool
      if (!call) throw new Error('E2E app-tool bridge was not installed.')
      return call(input)
    },
    { conversationId, name, arguments: args },
  )
}

function decodePng(page: Page, data: string): Promise<DecodedPng> {
  return page.evaluate(
    async (encoded) => {
      const image = new Image()
      image.src = `data:image/png;base64,${encoded}`
      await image.decode()
      const { naturalWidth: width, naturalHeight: height } = image
      if (width <= 0 || height <= 0) throw new Error('Screenshot PNG could not be decoded by Chromium.')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Screenshot PNG canvas context could not be created.')
      context.drawImage(image, 0, 0)
      // Sample away from the centered white label so the assertion observes the band itself.
      const x = Math.min(width - 1, Math.max(0, Math.floor(width / 4)))
      const y = Math.min(height - 1, Math.max(0, Math.floor(height / 4)))
      const pixel = context.getImageData(x, y, 1, 1).data
      return {
        width,
        height,
        center: {
          red: pixel[0] ?? 0,
          green: pixel[1] ?? 0,
          blue: pixel[2] ?? 0,
          alpha: pixel[3] ?? 0,
        },
      }
    },
    data,
  )
}

function inspectBrowserView(app: ElectronApplication): Promise<BrowserViewState> {
  return app.evaluate((_electron, id) => {
    const inspect = globalThis.__maestrlyE2EInspectBrowserView
    if (!inspect) throw new Error('E2E browser-view inspector was not installed.')
    return inspect(id)
  }, conversationId)
}

function screenshotScrollY(result: ToolResult): number {
  const match = /Scroll y=(\d+)\/(\d+)/.exec(result.text)
  if (!match) throw new Error(`Screenshot metadata did not contain scroll coordinates: ${result.text}`)
  return Number(match[1])
}

function writeScreenshot(testInfo: TestInfo, name: string, data: string): string {
  const target = testInfo.outputPath(name)
  writeFileSync(target, Buffer.from(data, 'base64'))
  return target
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-browser-screenshot-e2e-'))
  fixtureServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; }
        .band { height: 800px; display: grid; place-items: center; color: white; font: 700 64px sans-serif; }
        #red { background: rgb(220, 20, 20); }
        #green { background: rgb(20, 200, 40); }
        #blue { background: rgb(20, 40, 220); }
      </style></head><body data-ready="true">
        <section id="red" class="band">RED TOP</section>
        <section id="green" class="band">GREEN MIDDLE</section>
        <section id="blue" class="band">BLUE BOTTOM</section>
      </body></html>`)
  })
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') throw new Error('Could not start the screenshot fixture server.')
  fixtureUrl = `http://127.0.0.1:${address.port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
  rmSync(userDataDir, { recursive: true, force: true })
})

test('agent app-tool captures the hidden browser before and after a real scroll', async ({ browserName: _browserName }, testInfo) => {
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'browser-screenshot-agent-path',
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => typeof window.api !== 'undefined')

    await expect(callAppTool(app, 'browser_navigate', { url: fixtureUrl })).resolves.toMatchObject({
      isError: false,
    })
    await expect(
      callAppTool(app, 'browser_evaluate', { expression: 'document.body.dataset.ready' }),
    ).resolves.toMatchObject({ isError: false, text: 'true' })

    const parked = await inspectBrowserView(app)
    expect(parked.bounds.x).toBeLessThan(-10_000)
    expect(parked.ownerCount).toBe(1)

    const [before, concurrentBefore] = await Promise.all([
      callAppTool(app, 'browser_screenshot'),
      callAppTool(app, 'browser_screenshot'),
    ])
    expect(before.isError, before.text).toBe(false)
    expect(before.images).toHaveLength(1)
    expect(concurrentBefore.isError, concurrentBefore.text).toBe(false)
    expect(concurrentBefore.images).toHaveLength(1)
    expect(await inspectBrowserView(app)).toEqual(parked)
    expect(before.images[0]).toMatchObject({ mediaType: 'image/png' })
    const beforePath = writeScreenshot(testInfo, 'before-scroll.png', before.images[0]!.data)
    const beforeDecoded = await decodePng(win, before.images[0]!.data)
    expect(beforeDecoded.width).toBeGreaterThan(100)
    expect(beforeDecoded.height).toBeGreaterThan(100)
    expect(beforeDecoded.center.red).toBeGreaterThan(beforeDecoded.center.green + 80)
    expect(screenshotScrollY(before)).toBe(0)

    await expect(callAppTool(app, 'browser_scroll', { y: 800 })).resolves.toMatchObject({ isError: false })

    const after = await callAppTool(app, 'browser_screenshot')
    expect(after.isError, after.text).toBe(false)
    expect(after.images).toHaveLength(1)
    const afterPath = writeScreenshot(testInfo, 'after-scroll.png', after.images[0]!.data)
    const afterDecoded = await decodePng(win, after.images[0]!.data)
    expect(afterDecoded.width).toBe(beforeDecoded.width)
    expect(afterDecoded.height).toBe(beforeDecoded.height)
    expect(afterDecoded.center.green).toBeGreaterThan(afterDecoded.center.red + 80)
    expect(screenshotScrollY(after)).toBeGreaterThanOrEqual(700)
    expect(await inspectBrowserView(app)).toEqual(parked)

    const beforeHash = createHash('sha256').update(Buffer.from(before.images[0]!.data, 'base64')).digest('hex')
    const afterHash = createHash('sha256').update(Buffer.from(after.images[0]!.data, 'base64')).digest('hex')
    expect(afterHash).not.toBe(beforeHash)
    testInfo.annotations.push({ type: 'screenshots', description: `${beforePath}\n${afterPath}` })
  } finally {
    await app.close()
  }
})
