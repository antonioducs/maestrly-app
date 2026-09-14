import { access, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { DesktopSession } from '../desktop/session.js'
import type { FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import { runtimeError } from '../turns/service.js'
const binary = () => process.env.MAESTRLY_CHROMIUM_BINARY ?? '/opt/maestrly-bot/chromium/chrome'
export class BrowserSession {
  private context?: BrowserContext
  private page?: Page
  private starting?: Promise<Page>
  private downloads: { path: string; name: string }[] = []
  constructor(
    readonly state: string,
    readonly files: FileService,
    readonly desktop: DesktopSession,
    private invalidate: () => void,
    readonly proxyPort = Number(process.env.MAESTRLY_BOT_PROXY_PORT ?? 3128)
  ) {}
  static async available() {
    return (
      (await DesktopSession.available()) &&
      access(binary(), constants.X_OK).then(
        () => true,
        () => false
      )
    )
  }
  async ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  private async start() {
    if (!(await BrowserSession.available()))
      throw runtimeError('BROWSER_UNAVAILABLE', 'Chromium or Xvfb is not installed')
    try {
      await this.desktop.ensure()
      await mkdir(await this.files.safePath('downloads', true), { recursive: true })
      this.context = await chromium.launchPersistentContext(join(this.state, 'browser-profile'), {
        headless: false,
        executablePath: binary(),
        chromiumSandbox: true,
        env: this.desktop.environment(),
        args: [
          '--proxy-server=http://127.0.0.1:' + this.proxyPort,
          '--proxy-bypass-list=127.0.0.1;localhost;<-loopback>',
        ],
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 },
      })
      this.page = this.context.pages()[0] ?? (await this.context.newPage())
      this.page.on('framenavigated', () => this.invalidate())
      this.page.on('close', () => this.invalidate())
      this.context.on('close', () => {
        this.page = undefined
        this.context = undefined
        this.invalidate()
      })
      this.page.on('download', (download) => {
        const name = download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = 'downloads/' + Date.now() + '-' + name
        void this.files
          .safePath(path, true)
          .then(async (destination) => {
            await download.saveAs(destination)
            this.downloads.push({ path, name })
          })
          .catch(() => {})
      })
      this.invalidate()
      return this.page
    } catch (error) {
      throw runtimeError('BROWSER_UNAVAILABLE', error instanceof Error ? error.message : 'Browser could not start')
    }
  }
  async navigate(url: string) {
    const target = new URL(url)
    if (target.protocol === 'file:') {
      const path = relative(this.files.workspace, fileURLToPath(target))
      await this.files.safePath(path)
    } else if (!['http:', 'https:'].includes(target.protocol))
      throw runtimeError('INVALID_URL', 'Only HTTP, HTTPS and workspace files are allowed')
    await (await this.ensure()).goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { url: target.href }
  }
  async snapshot() {
    const page = await this.ensure()
    const details = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll('a,button,input,textarea,select,[role="button"],[tabindex]')
      )
        .filter((element) => element.getClientRects().length > 0)
        .slice(0, 500)
      const interactive = elements.map((element, index) => {
        element.setAttribute('data-maestrly-ref', String(index + 1))
        return {
          ref: index + 1,
          tag: element.tagName.toLowerCase(),
          name: (element.getAttribute('aria-label') ?? element.textContent ?? '').slice(0, 300),
        }
      })
      return { title: document.title, text: document.body.innerText, interactive }
    })
    details.text = Buffer.from(details.text)
      .subarray(0, 32 * 1024)
      .toString('utf8')
    return { url: page.url(), ...details }
  }
  async click(ref: number) {
    await (await this.ensure()).locator('[data-maestrly-ref="' + ref + '"]').click({ timeout: 10_000 })
  }
  async type(ref: number, text: string) {
    await (await this.ensure()).locator('[data-maestrly-ref="' + ref + '"]').fill(text, { timeout: 10_000 })
  }
  async key(key: string) {
    await (await this.ensure()).keyboard.press(key)
  }
  async screenshot(observationId: string, hooks: TurnHooks) {
    const bytes = await (await this.ensure()).screenshot({ type: 'png' })
    const directory = await this.files.safePath('.maestrly/screens', true)
    await mkdir(directory, { recursive: true })
    const path = '.maestrly/screens/' + observationId + '.png'
    await writeFile(await this.files.safePath(path, true), bytes, { flag: 'wx', mode: 0o600 })
    const info = await this.files.stat({ path })
    hooks.emit({
      kind: 'file.produced',
      summary: 'Captura de tela disponível',
      detail: { path, name: observationId + '.png', size: info.size, digest: info.digest },
    })
    return { bytes, path }
  }
  listDownloads() {
    return [...this.downloads]
  }
  async close() {
    await this.starting?.catch(() => {})
    await this.context?.close()
    await this.desktop.close()
    this.invalidate()
  }
}
