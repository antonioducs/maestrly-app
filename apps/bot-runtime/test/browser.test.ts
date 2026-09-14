import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { BrowserSession } from '../src/tools/browser.js'
import { DesktopSession } from '../src/desktop/session.js'
import { FileService } from '../src/files/service.js'
import { temporary } from './helpers.js'
test.skipIf(!process.env.MAESTRLY_CHROMIUM_BINARY || !process.env.MAESTRLY_XVFB_BINARY)(
  'headful browser observes, clicks and saves fresh screenshots',
  async () => {
    const state = await temporary()
    const files = new FileService(join(state, 'workspace'))
    await files.init()
    const html = join(files.workspace, 'fixture.html')
    await writeFile(
      html,
      "<button onclick=\"document.body.style.background='red';this.textContent='Clicked'\">Click me</button>"
    )
    const browser = new BrowserSession(state, files, new DesktopSession(), () => {})
    const hooks = { emit: () => {}, requestApproval: async () => 'deny' as const, askQuestion: async () => '' }
    try {
      await browser.navigate(pathToFileURL(html).href)
      const snapshot = await browser.snapshot()
      const button = snapshot.interactive.find((element) => element.tag === 'button')
      expect(button).toBeDefined()
      const first = await browser.screenshot(randomUUID(), hooks)
      await browser.click(button!.ref)
      expect((await browser.snapshot()).text).toContain('Clicked')
      const second = await browser.screenshot(randomUUID(), hooks)
      expect(first.bytes.equals(second.bytes)).toBe(false)
      expect(await readFile(join(files.workspace, second.path))).toEqual(second.bytes)
    } finally {
      await browser.close()
    }
  },
  30_000
)
