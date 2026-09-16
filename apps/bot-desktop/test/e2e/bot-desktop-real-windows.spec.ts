import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
/**
 * Real-Host window controls through the app, as a person uses them (opt-in, never in CI).
 * Same prerequisites as bot-desktop-real.spec.ts. It takes control of an idle bot, opens its own
 * terminal window with Super+Enter, maximizes and restores it with a title bar double click,
 * drags it by the title bar and closes it with its close button (or Alt+F4 when the button
 * offset is not given), then hands control back. Nothing else on the bot desktop is touched.
 * Each step is judged from the pixels the app shows: 8 px cells that changed between frames.
 */
type Region = { x: number; y: number; width: number; height: number }
const snap = (page: Page, key: string) =>
  page.evaluate((name) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')!
    ;(window as unknown as Record<string, Uint8ClampedArray>)[name] = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  }, key)
/** Share of changed cells and the largest connected changed area, in framebuffer pixels. */
const compare = (page: Page, before: string, after: string) =>
  page.evaluate(
    ([a, b]) => {
      const store = window as unknown as Record<string, Uint8ClampedArray>
      const A = store[a]
      const B = store[b]
      const W = 1280
      const H = 800
      const S = 8
      const cols = W / S
      const rows = H / S
      const changed = new Uint8Array(cols * rows)
      let total = 0
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          let diff = false
          for (let y = r * S; y < r * S + S && !diff; y += 2)
            for (let x = c * S; x < c * S + S; x += 2) {
              const i = (y * W + x) * 4
              if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) {
                diff = true
                break
              }
            }
          if (diff) {
            changed[r * cols + c] = 1
            total++
          }
        }
      const seen = new Uint8Array(cols * rows)
      let largest = { cells: 0, x: 0, y: 0, width: 0, height: 0 }
      for (let start = 0; start < changed.length; start++) {
        if (!changed[start] || seen[start]) continue
        const stack = [start]
        seen[start] = 1
        let cells = 0
        let minX = cols
        let minY = rows
        let maxX = -1
        let maxY = -1
        while (stack.length) {
          const k = stack.pop()!
          cells++
          const x = k % cols
          const y = Math.floor(k / cols)
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
            const j = ny * cols + nx
            if (changed[j] && !seen[j]) {
              seen[j] = 1
              stack.push(j)
            }
          }
        }
        if (cells > largest.cells) largest = { cells, x: minX * S, y: minY * S, width: (maxX - minX + 1) * S, height: (maxY - minY + 1) * S }
      }
      return { fraction: Math.round((total / changed.length) * 1000) / 1000, largest }
    },
    [before, after]
  )

test('real Host: a person maximizes, restores, drags and closes a window on the bot desktop', async () => {
  test.skip(process.env.MAESTRLY_BOT_REAL_HOST !== '1' || !process.env.MAESTRLY_BOT_REAL_TARGET, 'Set MAESTRLY_BOT_REAL_HOST=1 and MAESTRLY_BOT_REAL_TARGET to homologate against the selected Mac mini')
  test.setTimeout(240_000)
  const app = await electron.launch({ executablePath: process.env.BOT_PACKAGED_EXECUTABLE, args: process.env.BOT_PACKAGED_EXECUTABLE ? [] : [resolve('out/main/index.js')] })
  const report: Record<string, unknown> = { measuredAt: new Date().toISOString() }
  const shots: string[] = []
  try {
    const page = await app.firstWindow()
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
    const wanted = process.env.MAESTRLY_BOT_REAL_BOT
    const ready = bots.find((bot) => bot.status === 'ready' && !bot.activeTurnId && (!wanted || bot.name === wanted))
    test.skip(!ready, 'An idle ready bot is required')
    await page.reload()
    await page.waitForFunction(() => !!window.bot)
    const header = page.locator('.chat-header h1')
    if ((await header.textContent().catch(() => null)) !== ready!.name) await page.getByRole('button', { name: ready!.name }).first().click()
    await expect(header).toHaveText(ready!.name)
    await page.getByRole('button', { name: 'Ver tela', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Tela do bot', exact: true })
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 30_000 })
    await panel.getByRole('button', { name: 'Assumir controle', exact: true }).click()
    await expect(panel.getByRole('status').first()).toHaveText(/Você está no controle/, { timeout: 60_000 })
    const canvas = panel.locator('.desktop-screen canvas')
    await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBe(1280)
    // The real screen server sends no cursor shape: the person must still see a pointer.
    report.pointer = await canvas.evaluate((element) => getComputedStyle(element).cursor)
    const box = (await canvas.boundingBox())!
    const at = (x: number, y: number) => ({ x: box.x + (x * box.width) / 1280, y: box.y + (y * box.height) / 800 })
    const shot = async (name: string) => {
      const path = `test-results/real-wm-${name}.png`
      await page.screenshot({ path, clip: box })
      shots.push(path)
    }
    await page.waitForTimeout(800)
    await snap(page, 's0')
    await shot('0-before')
    // Super+Enter (an existing Openbox shortcut) opens a terminal owned by this test.
    await page.keyboard.press('Meta+Enter')
    await page.waitForTimeout(2500)
    await snap(page, 's1')
    await shot('1-opened')
    const opened = await compare(page, 's0', 's1')
    report.opened = opened.largest
    const win: Region = opened.largest
    expect(win.width).toBeGreaterThan(150)
    expect(win.height).toBeGreaterThan(80)
    const title = { x: win.x + Math.round(win.width / 2), y: win.y + 9 }
    // Double click on the title bar maximizes.
    const titlePoint = at(title.x, title.y)
    await page.mouse.dblclick(titlePoint.x, titlePoint.y)
    await page.waitForTimeout(1200)
    await snap(page, 's2')
    await shot('2-maximized')
    report.maximized = await compare(page, 's1', 's2')
    // Double click on the (now top) title bar restores it.
    const top = at(640, 9)
    await page.mouse.dblclick(top.x, top.y)
    await page.waitForTimeout(1200)
    await snap(page, 's3')
    await shot('3-restored')
    report.restored = await compare(page, 's1', 's3')
    // Dragging the title bar moves the window.
    const from = at(title.x, title.y)
    const dx = 140
    const dy = 90
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let step = 1; step <= 20; step++) {
      await page.mouse.move(from.x + ((dx * step) / 20) * (box.width / 1280), from.y + ((dy * step) / 20) * (box.height / 800))
      await page.waitForTimeout(25)
    }
    await page.mouse.up()
    await page.waitForTimeout(1200)
    await snap(page, 's4')
    await shot('4-moved')
    const moved = await compare(page, 's0', 's4')
    report.moved = { ...moved.largest, dx: moved.largest.x - win.x, dy: moved.largest.y - win.y }
    // Title bar buttons, at offsets from the frame's exact top-right corner, read from a real
    // frame: MAESTRLY_BOT_WM_BUTTON_OFFSETS=closeDx,maximizeDx,dy. Without them Alt+F4 closes.
    const offsets = process.env.MAESTRLY_BOT_WM_BUTTON_OFFSETS?.split(',').map(Number)
    const buttons = offsets?.length === 3 && offsets.every(Number.isFinite)
    if (buttons) {
      const [closeDx, maximizeDx, buttonDy] = offsets!
      // The 8 px cells only bound the frame; its exact corner is where pixels first differ.
      const frame = await page.evaluate((region) => {
        const store = window as unknown as Record<string, Uint8ClampedArray>
        const A = store.s0
        const B = store.s4
        const W = 1280
        const differs = (x: number, y: number) => {
          const i = (y * W + x) * 4
          return Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30
        }
        const row = Math.min(799, region.y + 14)
        let right = -1
        for (let x = Math.min(W - 1, region.x + region.width + 8); x >= region.x && right < 0; x--) if (differs(x, row)) right = x
        const column = Math.max(0, right - 20)
        let top = -1
        for (let y = Math.max(0, region.y - 8); y < region.y + region.height && top < 0; y++) if (differs(column, y)) top = y
        return { right, top }
      }, moved.largest)
      report.frame = frame
      const maximizeAt = at(frame.right + maximizeDx, frame.top + buttonDy)
      await page.mouse.click(maximizeAt.x, maximizeAt.y)
      await page.waitForTimeout(1200)
      await snap(page, 's5')
      await shot('5-maximize-button')
      report.maximizeButton = await compare(page, 's4', 's5')
      // Maximized, the frame's corner is the screen's.
      const restoreAt = at(1279 + maximizeDx, buttonDy)
      await page.mouse.click(restoreAt.x, restoreAt.y)
      await page.waitForTimeout(1200)
      await snap(page, 's6')
      await shot('6-restore-button')
      report.restoreButton = await compare(page, 's4', 's6')
      const closeAt = at(frame.right + closeDx, frame.top + buttonDy)
      await page.mouse.click(closeAt.x, closeAt.y)
      report.closeMethod = 'button'
    } else {
      await page.keyboard.press('Alt+F4')
      report.closeMethod = 'Alt+F4'
    }
    await page.waitForTimeout(1500)
    await snap(page, 's9')
    await shot('9-closed')
    report.closed = await compare(page, 's0', 's9')
    // A close that did not take never leaves the test window behind on the bot desktop.
    if ((report.closed as { fraction: number }).fraction >= 0.03) {
      await page.keyboard.press('Alt+F4')
      await page.waitForTimeout(1000)
      report.cleanup = 'Alt+F4'
    }
    await page.keyboard.press('Shift+Escape')
    await panel.getByRole('button', { name: /^Devolver/ }).first().click()
    await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/, { timeout: 60_000 })
    const fraction = (key: string) => (report[key] as { fraction: number }).fraction
    const move = report.moved as { dx: number; dy: number }
    report.verified = {
      pointerVisible: report.pointer === 'default',
      maximize: fraction('maximized') > 0.4,
      restore: fraction('restored') < 0.03,
      move: Math.abs(move.dx - dx) <= 16 && Math.abs(move.dy - dy) <= 16,
      close: fraction('closed') < 0.03,
      ...(buttons ? { maximizeButton: fraction('maximizeButton') > 0.4, restoreButton: fraction('restoreButton') < 0.03 } : {}),
    }
    expect(Object.values(report.verified as Record<string, boolean>).every(Boolean), JSON.stringify(report.verified)).toBe(true)
  } finally {
    report.screenshots = shots
    await writeFile(resolve('test-results/real-host-windows.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    await app.close()
  }
})
