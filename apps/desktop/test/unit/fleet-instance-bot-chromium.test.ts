import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOT_CHROMIUM_IDLE_MS,
  BotChromium,
  COOKIES_IMPORTED_MARKER,
  type BotChromiumFs,
} from '../../src/main/fleet/instance/bot-browser/bot-chromium'
import type { ChromiumProcess } from '../../src/main/fleet/instance/bot-browser/chromium-supervisor'
import { toChromiumCookie } from '../../src/main/fleet/instance/bot-browser/cookie-import'

interface Target {
  targetId: string
  url: string
  title: string
  openerId?: string
}

/** A Chromium that keeps its tabs in memory and speaks the part of the protocol the bot's browser uses. */
class FakeBrowser {
  readonly targets = new Map<string, Target>()
  readonly calls: Array<{ method: string; params: Record<string, any>; sessionId?: string }> = []
  readonly cookies: unknown[] = []
  private seq = 0
  private exit!: (code: number | null) => void
  private messages = new PassThrough()
  readonly process: ChromiumProcess

  constructor() {
    const commands = new PassThrough()
    let pending = ''
    commands.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let end: number
      while ((end = pending.indexOf('\0')) >= 0) {
        const message = JSON.parse(pending.slice(0, end))
        pending = pending.slice(end + 1)
        this.handle(message)
      }
    })
    this.process = {
      pid: 7,
      commands,
      messages: this.messages,
      exited: new Promise((resolve) => (this.exit = resolve)),
      kill: () => this.crash(null),
      stderrTail: () => '',
    }
    this.add('about:blank')
  }

  crash(code: number | null = 139): void {
    this.messages.end()
    this.exit(code)
  }

  /** A tab opened by a page (`window.open`) or by the person in the window. */
  open(url: string, openerId?: string): string {
    const id = this.add(url, openerId)
    this.emit('Target.targetCreated', { targetInfo: this.info(id) })
    return id
  }

  navigate(targetId: string, url: string): void {
    const target = this.targets.get(targetId)!
    target.url = url
    this.emit('Target.targetInfoChanged', { targetInfo: this.info(targetId) })
  }

  emit(method: string, params: unknown, sessionId?: string): void {
    this.messages.write(`${JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
  }

  private add(url: string, openerId?: string): string {
    const targetId = `t${++this.seq}`
    this.targets.set(targetId, { targetId, url, title: '', ...(openerId ? { openerId } : {}) })
    return targetId
  }

  private info(targetId: string) {
    return { type: 'page', ...this.targets.get(targetId)! }
  }

  private handle(message: { id: number; method: string; params: Record<string, any>; sessionId?: string }): void {
    this.calls.push(message)
    const reply = (result: unknown = {}): void => {
      this.messages.write(`${JSON.stringify({ id: message.id, result })}\0`)
    }
    const { params } = message
    switch (message.method) {
      case 'Target.setDiscoverTargets':
        for (const id of this.targets.keys()) this.emit('Target.targetCreated', { targetInfo: this.info(id) })
        return reply()
      case 'Target.createTarget': {
        const id = this.add(params.url)
        this.emit('Target.targetCreated', { targetInfo: this.info(id) })
        return reply({ targetId: id })
      }
      case 'Target.closeTarget':
        this.targets.delete(params.targetId)
        this.emit('Target.targetDestroyed', { targetId: params.targetId })
        return reply({ success: true })
      case 'Target.attachToTarget':
        return reply({ sessionId: `s-${params.targetId}` })
      case 'Storage.setCookies':
        this.cookies.push(...params.cookies)
        return reply()
      case 'Browser.close':
        // Chromium closes its tabs on the way out, then exits.
        for (const id of this.targets.keys()) this.emit('Target.targetDestroyed', { targetId: id })
        return this.crash(0)
      default:
        return reply()
    }
  }
}

function memoryFs(initial: Record<string, string> = {}, order: string[] = []) {
  const files = new Map(Object.entries(initial))
  const fs: BotChromiumFs = {
    removeFolder: async (folder) => {
      order.push(`remove ${folder}`)
      for (const file of [...files.keys()]) if (file.startsWith(`${folder}/`)) files.delete(file)
    },
    readFile: async (file) => {
      const data = files.get(file)
      if (data === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return data
    },
    writeFile: async (file, data) => void files.set(file, data),
    exists: async (file) => files.has(file),
  }
  return { fs, files }
}

const SAVED = '/home/bot/.config/maestrly-bots/bot-1/chromium-tabs.json'
const PROFILE = '/home/bot/.config/maestrly-bots/bot-1/chromium'

function setup(
  options: {
    foreground?: string | null
    files?: Record<string, string>
    watched?: () => boolean
    cookies?: () => Promise<any[]>
    beforeStart?: () => Promise<void>
  } = {}
) {
  const browsers: FakeBrowser[] = []
  const order: string[] = []
  const { fs, files } = memoryFs(options.files, order)
  let now = 1_000
  const log = vi.fn()
  const chromium = new BotChromium({
    botId: 'bot-1',
    deps: {
      spawn: () => {
        order.push('spawn')
        const browser = new FakeBrowser()
        browsers.push(browser)
        return browser.process
      },
      now: () => now,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      log,
    },
    env: () => ({ DISPLAY: ':1' }),
    profile: PROFILE,
    savedTabsFile: SAVED,
    downloads: '/home/bot/Downloads',
    foregroundConversationId: () => (options.foreground === undefined ? 'conv-a' : options.foreground),
    ownsConversation: (id) => id.startsWith('conv-'),
    watched: options.watched ?? (() => false),
    ...(options.cookies ? { sharedCookies: options.cookies } : {}),
    ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}),
    fs,
  })
  return {
    chromium,
    browsers,
    files,
    order,
    log,
    browser: () => browsers.at(-1)!,
    advance: (ms: number) => (now += ms),
    saved: () => JSON.parse(files.get(SAVED) ?? '{"tabs":[]}').tabs,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BotChromium', () => {
  it('gives the first conversation the empty tab of a new browser, and others a tab of their own', async () => {
    const { chromium, browser } = setup()
    const a = await chromium.page('conv-a')
    expect(a.targetId).toBe('t1')
    const b = await chromium.page('conv-b')
    expect(b.targetId).not.toBe('t1')
    expect(browser().calls.find((call) => call.method === 'Target.createTarget')?.params.url).toBe(
      'https://www.google.com'
    )
    expect((await chromium.state('conv-a')).tabs.map((tab) => tab.id)).toEqual(['t1'])
    expect((await chromium.state('conv-b')).tabs.map((tab) => tab.id)).toEqual([b.targetId])
    // Downloads go to the environment's folder without a dialog.
    expect(browser().calls.find((call) => call.method === 'Browser.setDownloadBehavior')?.params).toMatchObject({
      behavior: 'allow',
      downloadPath: '/home/bot/Downloads',
    })
  })

  it('keeps each conversation and worker to its own tabs, popups following their opener', async () => {
    const { chromium, browser } = setup()
    const own = await chromium.createTab('conv-a', 'example.com')
    expect(browser().calls.at(-1)?.params).toEqual({ url: 'https://example.com', background: false })
    const worker = await chromium.createTab('conv-a', 'https://example.org', { ownerScopeId: 'w1', activate: false })
    const other = await chromium.createTab('conv-b', 'https://example.net')

    const popup = browser().open('https://popup.test', own)
    const workerPopup = browser().open('https://worker-popup.test', worker)
    await vi.waitFor(async () => expect((await chromium.state('conv-a')).tabs.map((tab) => tab.id)).toContain(popup))

    expect((await chromium.state('conv-a')).tabs.map((tab) => tab.id)).not.toContain(workerPopup)
    expect((await chromium.state('conv-a', 'w1')).tabs.map((tab) => tab.id)).toEqual([worker, workerPopup])
    expect(chromium.tabIdsOwnedByScope('conv-a', 'w1')).toEqual([worker, workerPopup])
    expect(chromium.ownerScopeOf('conv-a', workerPopup)).toBe('w1')
    expect(chromium.ownerScopeOf('conv-b', workerPopup)).toBeUndefined()
    expect((await chromium.state('conv-b')).tabs.map((tab) => tab.id)).toEqual([other])

    // Another conversation's tab cannot be driven, switched to or closed.
    await expect(chromium.page('conv-b', own)).rejects.toThrow('no longer open')
    await chromium.closeTab('conv-b', own)
    expect(browser().targets.has(own)).toBe(true)
  })

  it('gives a tab the person opened in the window to the conversation the desktop shows', async () => {
    const { chromium, browser } = setup({ foreground: 'conv-b' })
    await chromium.state('conv-a')
    const opened = browser().open('https://typed.test')
    await vi.waitFor(async () => expect((await chromium.state('conv-b')).tabs.map((tab) => tab.id)).toContain(opened))
    expect((await chromium.state('conv-a')).tabs.map((tab) => tab.id)).not.toContain(opened)
  })

  it('makes the next tab active when the active one closes, as the drawer does', async () => {
    const { chromium } = setup()
    const first = (await chromium.page('conv-a')).targetId
    const second = await chromium.createTab('conv-a', 'https://two.test')
    const third = await chromium.createTab('conv-a', 'https://three.test')
    await chromium.switchTab('conv-a', second)
    await chromium.closeTab('conv-a', second)
    expect((await chromium.state('conv-a')).activeId).toBe(third)
    await chromium.closeTab('conv-a', third)
    expect((await chromium.state('conv-a')).activeId).toBe(first)
  })

  it('removes Chromium’s own record of its tabs before each start, once a browser left behind is stopped', async () => {
    const sessions = `${PROFILE}/Default/Sessions`
    let failStaleStop = false
    const { chromium, order, files, log } = setup({
      files: { [`${sessions}/Session_1`]: 'tabs', [`${PROFILE}/Default/Cookies`]: 'db' },
      beforeStart: async () => {
        order.push('stop stale')
        if (failStaleStop) throw new Error('still running')
      },
    })
    await chromium.state('conv-a')
    // `--restore-last-session` then brings back the session cookies without reopening tabs of Chromium's own.
    expect(order).toEqual(['stop stale', `remove ${sessions}`, 'spawn'])
    expect(files.has(`${sessions}/Session_1`)).toBe(false)
    expect(files.has(`${PROFILE}/Default/Cookies`)).toBe(true)

    // The record goes even when the browser left behind could not be stopped, and the browser starts anyway.
    await chromium.stop()
    failStaleStop = true
    order.length = 0
    await chromium.state('conv-a')
    expect(order).toEqual(['stop stale', `remove ${sessions}`, 'spawn'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not prepare the Chromium profile of bot bot-1'))
  })

  it('saves the conversations’ tabs and reopens them on the next start, not the workers’', async () => {
    vi.useFakeTimers()
    const { chromium, browsers, browser, saved } = setup()
    await chromium.page('conv-a')
    browser().navigate('t1', 'https://kept.test/')
    const second = await chromium.createTab('conv-b', 'https://other.test/')
    await chromium.createTab('conv-a', 'https://worker.test/', { ownerScopeId: 'w1', activate: false })
    await chromium.createTab('conv-a', 'about:blank')
    await chromium.switchTab('conv-b', second)
    await vi.advanceTimersByTimeAsync(600)
    expect(saved()).toEqual([
      { url: 'https://kept.test/', conversationId: 'conv-a' },
      { url: 'https://other.test/', conversationId: 'conv-b', active: true },
    ])

    await chromium.stop()
    expect(chromium.isRunning).toBe(false)
    const restored = await chromium.state('conv-a')
    expect(browsers).toHaveLength(2)
    expect(restored.tabs.map((tab) => tab.url)).toEqual(['https://kept.test/'])
    expect((await chromium.state('conv-b')).tabs.map((tab) => tab.url)).toEqual(['https://other.test/'])
    // The empty tab the new browser opened with was closed in favor of the restored ones.
    expect(browser().targets.has('t1')).toBe(false)
    expect(
      browser()
        .calls.filter((call) => call.method === 'Target.createTarget')
        .every((call) => call.params.background === true)
    ).toBe(true)
  })

  it('reopens only saved tabs of its own conversations, with web or file addresses', async () => {
    const { chromium } = setup({
      files: {
        [SAVED]: JSON.stringify({
          version: 1,
          tabs: [
            { url: 'https://mine.test/', conversationId: 'conv-a', active: true },
            { url: 'https://gone.test/', conversationId: 'removed' },
            { url: 'javascript:alert(1)', conversationId: 'conv-a' },
            { url: 'file:///home/bot/report.html', conversationId: 'conv-a' },
          ],
        }),
      },
    })
    const state = await chromium.state('conv-a')
    expect(state.tabs.map((tab) => tab.url)).toEqual(['https://mine.test/', 'file:///home/bot/report.html'])
    expect(state.tabs.find((tab) => tab.id === state.activeId)?.url).toBe('https://mine.test/')
  })

  it('forgets the saved tabs of a conversation that ended while the browser was stopped', async () => {
    const { chromium, browsers, saved } = setup({
      files: {
        [SAVED]: JSON.stringify({
          version: 1,
          tabs: [
            { url: 'https://run.test/', conversationId: 'conv-run' },
            { url: 'https://main.test/', conversationId: 'conv-a' },
          ],
        }),
      },
    })
    await chromium.closeConversation('conv-run')
    expect(browsers).toHaveLength(0)
    expect(saved()).toEqual([{ url: 'https://main.test/', conversationId: 'conv-a' }])
  })

  it('closes a running conversation’s tabs, its workers’ too', async () => {
    const { chromium, browser } = setup()
    const own = await chromium.createTab('conv-run', 'https://run.test/')
    const worker = await chromium.createTab('conv-run', 'https://w.test/', { ownerScopeId: 'w', activate: false })
    await chromium.closeConversation('conv-run')
    expect(browser().targets.has(own)).toBe(false)
    expect(browser().targets.has(worker)).toBe(false)
    expect((await chromium.state('conv-run')).tabs).toEqual([])
  })

  it('copies the shared site logins once, keeping host-only cookies host-only', async () => {
    const cookies = vi.fn(async () => [
      { name: 'sid', value: '1', domain: 'example.com', hostOnly: true, secure: true, httpOnly: true, path: '/app' },
      { name: 'wide', value: '2', domain: '.example.com', sameSite: 'lax' as const, expirationDate: 2_000_000_000 },
      { name: '', value: 'x', domain: 'bad.test' },
    ])
    const { chromium, browser, files, log } = setup({ cookies })
    await chromium.state('conv-a')
    expect(browser().cookies).toEqual([
      { name: 'sid', value: '1', url: 'https://example.com/app', path: '/app', secure: true, httpOnly: true },
      {
        name: 'wide',
        value: '2',
        domain: '.example.com',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'Lax',
        expires: 2_000_000_000,
      },
    ])
    expect(files.has(path.join(PROFILE, COOKIES_IMPORTED_MARKER))).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('copied 2 shared site cookies'))

    await chromium.stop()
    await chromium.state('conv-a')
    expect(cookies).toHaveBeenCalledTimes(1)
  })

  it('closes after its idle time unless someone watches the bot’s screen', async () => {
    vi.useFakeTimers()
    let watched = true
    const { chromium, advance } = setup({ watched: () => watched })
    await chromium.state('conv-a')
    advance(BOT_CHROMIUM_IDLE_MS + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(chromium.isRunning).toBe(true)
    watched = false
    // Watching counted as use: the idle time starts once they leave.
    advance(BOT_CHROMIUM_IDLE_MS - 1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(chromium.isRunning).toBe(true)
    advance(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(chromium.isRunning).toBe(false)
  })

  it('ends its pages when the browser exits, and starts again for the next use', async () => {
    vi.useFakeTimers()
    const { chromium, browsers, browser } = setup()
    const page = await chromium.page('conv-a')
    const destroyed = vi.fn()
    page.once('destroyed', destroyed)
    browser().crash()
    await vi.advanceTimersByTimeAsync(0)
    expect(destroyed).toHaveBeenCalled()
    expect(page.isDestroyed()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(browsers).toHaveLength(2)
    expect((await chromium.page('conv-a')).isDestroyed()).toBe(false)
  })

  it('routes a session’s events to its page and tracks a crash until the next load', async () => {
    const { chromium, browser } = setup()
    const page = await chromium.page('conv-a')
    const messages: string[] = []
    page.debugger.on('message', (_event, method) => messages.push(method))
    browser().emit('Inspector.targetCrashed', {}, page.sessionId)
    await vi.waitFor(() => expect(page.isCrashed()).toBe(true))
    browser().emit('Page.frameNavigated', { frame: { id: 'f', url: 'https://x.test' } }, page.sessionId)
    await vi.waitFor(() => expect(page.isCrashed()).toBe(false))
    expect(messages).toEqual(['Inspector.targetCrashed', 'Page.frameNavigated'])
  })
})

describe('toChromiumCookie', () => {
  it('drops a session cookie’s expiry and an unspecified SameSite', () => {
    expect(
      toChromiumCookie({
        name: 'a',
        value: 'b',
        domain: 'h.test',
        session: true,
        expirationDate: 5,
        sameSite: 'unspecified',
      })
    ).toEqual({ name: 'a', value: 'b', url: 'http://h.test/', path: '/', secure: false, httpOnly: false })
    expect(toChromiumCookie({ name: 'a', value: 'b' })).toBeNull()
  })
})
