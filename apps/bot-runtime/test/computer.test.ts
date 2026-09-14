import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { Computer } from '../src/tools/computer.js'
import { BrowserSession } from '../src/tools/browser.js'
import { DesktopSession } from '../src/desktop/session.js'
import { FileService } from '../src/files/service.js'
import { temporary } from './helpers.js'
test.skipIf(!process.env.MAESTRLY_CHROMIUM_BINARY || !process.env.MAESTRLY_XVFB_BINARY)(
  'computer clicks the Chromium viewport and rejects out-of-bounds coordinates',
  async () => {
    const state = await temporary()
    const files = new FileService(join(state, 'workspace'))
    await files.init()
    const html = join(files.workspace, 'fixture.html')
    await writeFile(
      html,
      '<button style="width:200px;height:100px" onclick="document.body.style.background=\'red\';this.textContent=\'Clicked\'">Click me</button>'
    )
    const browser = new BrowserSession(state, files, new DesktopSession(), () => {})
    const computer = new Computer(browser)
    const hooks = { emit: () => {}, requestApproval: async () => 'deny' as const, askQuestion: async () => '' }
    try {
      await browser.navigate(pathToFileURL(html).href)
      const first = await browser.screenshot(randomUUID(), hooks)
      await computer.click(30, 30)
      expect((await browser.snapshot()).text).toContain('Clicked')
      const second = await browser.screenshot(randomUUID(), hooks)
      expect(first.bytes.equals(second.bytes)).toBe(false)
      await expect(computer.click(1280, 0)).rejects.toMatchObject({ code: 'INVALID_COORDINATES' })
    } finally {
      await browser.close()
    }
  },
  30_000
)
