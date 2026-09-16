import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
/**
 * Real-Host responsiveness of the live screen as a person feels it (opt-in, never in CI):
 * noVNC frames painted in the app, bytes received and click/key-to-pixel latency measured
 * on the canvas. Same prerequisites as bot-desktop-real.spec.ts; it takes control of an idle
 * bot for a few seconds (right-click menu, Escape, a rubber-band drag) and hands it back.
 */
declare global {
  interface Window {
    __desktopPerf?: { flips: number[]; bytes: number; messages: number }
  }
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const perf = { flips: [] as number[], bytes: 0, messages: 0 }
    window.__desktopPerf = perf
    const draw = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      // noVNC paints its back buffer onto the visible canvas once per completed update.
      if (this.canvas.isConnected && this.canvas.closest('.desktop-screen')) perf.flips.push(performance.now())
      return (draw as (...values: unknown[]) => void).apply(this, args)
    } as typeof draw
    // noVNC checks the native prototype for send/close/onmessage, so the WebSocket class is
    // left intact and only the onmessage handler it installs is wrapped to count bytes.
    const native = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      enumerable: native.enumerable,
      get(this: WebSocket) {
        return native.get!.call(this)
      },
      set(this: WebSocket, handler: ((event: MessageEvent) => unknown) | null) {
        native.set!.call(this, handler && function (this: WebSocket, event: MessageEvent) {
          perf.messages++
          perf.bytes += (event.data as ArrayBuffer)?.byteLength ?? 0
          return handler.call(this, event)
        })
      },
    })
  })
}
const digest = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')!
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 0
    for (let i = 0; i < data.length; i += 37) hash = (hash * 31 + data[i]) | 0
    return hash
  })
/** Milliseconds from just before the action until the canvas shows a change. */
async function toPixel(page: Page, action: () => Promise<void>) {
  const before = await digest(page)
  const started = await page.evaluate(() => performance.now())
  await action()
  return page.evaluate(
    ({ before, started }) =>
      new Promise<number | null>((done) => {
        const canvas = document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')!
        const context = canvas.getContext('2d')!
        const hash = () => {
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data
          let value = 0
          for (let i = 0; i < data.length; i += 37) value = (value * 31 + data[i]) | 0
          return value
        }
        const tick = () => {
          if (hash() !== before) return done(performance.now() - started)
          if (performance.now() - started > 3000) return done(null)
          requestAnimationFrame(tick)
        }
        tick()
      }),
    { before, started }
  )
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]

test('real Host: live screen responsiveness in the app', async () => {
  test.skip(process.env.MAESTRLY_BOT_REAL_HOST !== '1' || !process.env.MAESTRLY_BOT_REAL_TARGET, 'Set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET to measure against the selected Mac mini')
  test.setTimeout(240_000)
  const app = await electron.launch({ executablePath: process.env.BOT_PACKAGED_EXECUTABLE, args: process.env.BOT_PACKAGED_EXECUTABLE ? [] : [resolve('out/main/index.js')] })
  const report: Record<string, unknown> = { measuredAt: new Date().toISOString() }
  try {
    const page = await app.firstWindow()
    await instrument(page)
    await page.waitForFunction(() => !!window.bot)
    const target = process.env.MAESTRLY_BOT_REAL_TARGET as string
    let status = await page.evaluate(() => window.bot.status())
    for (let waited = 0; !status.connected && waited < 20_000; waited += 500) {
      await page.waitForTimeout(500)
      status = await page.evaluate(() => window.bot.status())
    }
    const connect = () => page.evaluate(async (id) => window.bot.connect(id), target)
    status = await connect().catch(async (error) => {
      if (!/Host disconnected/.test(String(error))) throw error
      await page.waitForTimeout(1500)
      return connect()
    })
    expect(status.connected).toBe(true)
    const bots = await page.evaluate(() => window.bot.bot({ method: 'bot.list', params: {} }))
    const ready = bots.find((bot) => bot.status === 'ready' && !bot.activeTurnId)
    test.skip(!ready, 'An idle ready bot is required')
    await page.reload()
    await page.waitForFunction(() => !!window.bot && !!window.__desktopPerf)
    const header = page.locator('.chat-header h1')
    if ((await header.textContent().catch(() => null)) !== ready!.name) await page.getByRole('button', { name: ready!.name }).first().click()
    await expect(header).toHaveText(ready!.name)
    // Opening time is part of what the person feels: measured to the first real framebuffer.
    const opened = Date.now()
    await page.getByRole('button', { name: 'Ver tela', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Tela do bot', exact: true })
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 30_000 })
    report.viewingMs = Date.now() - opened
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')?.width ?? 0), { timeout: 30_000 }).toBe(1280)
    report.firstFrameMs = Date.now() - opened
    await panel.getByRole('button', { name: 'Assumir controle', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText(/Você está no controle/, { timeout: 60_000 })
    const canvas = panel.locator('.desktop-screen canvas')
    const box = (await canvas.boundingBox())!
    await page.waitForTimeout(1000)
    // Click/key to pixel: open and close the desktop context menu.
    const samples: number[] = []
    let misses = 0
    for (let i = 0; i < 8; i++) {
      for (const action of [
        () => page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9, { button: 'right' }),
        () => page.keyboard.press('Escape'),
      ]) {
        const elapsed = await toPixel(page, action)
        if (elapsed === null) misses++
        else samples.push(Math.round(elapsed))
        await page.waitForTimeout(250)
      }
    }
    report.inputToPixelMs = { p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples), samples: samples.length, misses }
    // Continuous interaction: with the desktop menu open, the pointer sweeps over its items for
    // three seconds; every highlight change is a real framebuffer update. The canvas is sampled
    // on each animation frame, so this counts changes the person actually saw.
    const scale = box.width / 1280
    const origin = { x: box.x + 300 * scale, y: box.y + 200 * scale }
    await page.mouse.click(origin.x, origin.y, { button: 'right' })
    await page.waitForTimeout(600)
    const before = await page.evaluate(() => ({ flips: window.__desktopPerf!.flips.length, bytes: window.__desktopPerf!.bytes }))
    const watching = page.evaluate(
      () =>
        new Promise<{ changes: number; gaps: number[] }>((done) => {
          const canvas = document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')!
          const context = canvas.getContext('2d')!
          let last = 0
          let changedAt = performance.now()
          let changes = 0
          const gaps: number[] = []
          const started = performance.now()
          const tick = () => {
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data
            let value = 0
            for (let i = 0; i < data.length; i += 37) value = (value * 31 + data[i]) | 0
            if (value !== last) {
              const now = performance.now()
              if (changes) gaps.push(now - changedAt)
              changedAt = now
              changes++
              last = value
            }
            if (performance.now() - started < 3000) requestAnimationFrame(tick)
            else done({ changes, gaps })
          }
          tick()
        })
    )
    const sweepStarted = Date.now()
    for (let i = 0; Date.now() - sweepStarted < 3000; i++) {
      const row = Math.abs((i % 16) - 8) // down and up over the first items
      await page.mouse.move(origin.x + 40 * scale, origin.y + (12 + row * 18) * scale)
      await page.waitForTimeout(16)
    }
    const seen = await watching
    const seconds = (Date.now() - sweepStarted) / 1000
    const after = await page.evaluate(() => ({ flips: window.__desktopPerf!.flips.length, bytes: window.__desktopPerf!.bytes, totalFlips: window.__desktopPerf!.flips.length, totalBytes: window.__desktopPerf!.bytes }))
    const sortedGaps = [...seen.gaps].sort((a, b) => a - b)
    report.menuSweep = {
      visibleChangesPerSecond: Math.round((seen.changes / 3) * 10) / 10,
      gapP50Ms: Math.round(sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0),
      gapP95Ms: Math.round(sortedGaps[Math.floor(sortedGaps.length * 0.95)] ?? 0),
      noVncFlipsPerSecond: Math.round(((after.flips - before.flips) / seconds) * 10) / 10,
      kbPerSecond: Math.round((after.bytes - before.bytes) / seconds / 1024),
      totals: { flips: after.totalFlips, bytes: after.totalBytes },
    }
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Escape')
    await panel.getByRole('button', { name: /^Devolver/ }).first().click()
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 60_000 })
    test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) })
  } finally {
    await writeFile(resolve('test-results/real-host-desktop-perf.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    await app.close()
  }
})
