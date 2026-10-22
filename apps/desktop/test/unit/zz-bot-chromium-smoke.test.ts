import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as bc from '../../src/main/browser-control'
import { BotChromium } from '../../src/main/fleet/instance/bot-browser/bot-chromium'
import type { ChromiumProcess } from '../../src/main/fleet/instance/bot-browser/chromium-supervisor'

vi.mock('../../src/main/performance/metrics', () => ({ incrementPerformanceCounter: vi.fn() }))

const root = mkdtempSync(path.join(tmpdir(), 'bot-chromium-smoke-'))
const profile = path.join(root, 'chromium')
const logs: string[] = []
let lastPid: number | undefined

// Headless and unsandboxed: a CI runner may forbid the user namespaces of Chromium's sandbox, which the bot image allows.
function spawnHeadless(args: string[]): ChromiumProcess {
  const child = spawn(
    'chromium',
    ['--headless=new', '--no-sandbox', `--user-data-dir=${profile}`, '--no-first-run', ...args],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      detached: true,
    }
  )
  lastPid = child.pid
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)))
  return {
    pid: child.pid,
    commands: child.stdio[3] as Writable,
    messages: child.stdio[4] as Readable,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    kill: (signal) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        /* gone */
      }
    },
    stderrTail: () => stderr,
  }
}

const chromium = new BotChromium({
  botId: 'smoke',
  deps: {
    spawn: spawnHeadless,
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    log: (m) => logs.push(m),
  },
  env: () => ({}),
  profile,
  savedTabsFile: path.join(root, 'chromium-tabs.json'),
  downloads: path.join(root, 'Downloads'),
  foregroundConversationId: () => 'conv-a',
  ownsConversation: (id) => id.startsWith('conv-'),
  watched: () => false,
  sharedCookies: async () => [
    { name: 'sid', value: 'abc', domain: 'example.com', hostOnly: true, path: '/', secure: true, httpOnly: true },
    { name: 'wide', value: '1', domain: '.example.com', path: '/', secure: false },
  ],
})

afterAll(async () => {
  await chromium.dispose()
  rmSync(root, { recursive: true, force: true })
})

const html = `<style>body{margin:0}</style><button id=far style="margin-top:3000px" onclick="document.title='far-clicked'">far</button>
<div id=host></div><iframe id=f srcdoc="<button id=inner onclick=&quot;parent.document.title='inner-clicked'&quot;>inner</button>" style="position:fixed;top:100px;left:50px;width:300px;height:100px;border:5px solid red"></iframe>
<script>const h=document.getElementById('host');h.style.position='fixed';h.style.top='0';h.attachShadow({mode:'open'}).innerHTML='<button onclick="document.title=\\'shadow-clicked\\'">shadow</button>';
Element.prototype.getBoundingClientRect=function(){return {left:0,top:0,width:0,height:0,right:0,bottom:0}};</script>`
const bodies = new Map<string, string>()
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(bodies.get(req.url ?? '') ?? '<p>missing</p>')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
afterAll(() => server.close())
let seq = 0
const page = (body: string) => {
  const key = `/p${++seq}`
  bodies.set(key, body)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${key}`
}

describe.skipIf(!existsSync('/usr/bin/chromium'))('bot chromium smoke', () => {
  it('drives tabs, refs, history, popups, cookies, crash and restore', { timeout: 240_000 }, async () => {
    const first = await chromium.state('conv-a')
    expect(first.tabs.length).toBe(1)

    const tab = await chromium.page('conv-a')
    await bc.navigate(tab, page(html))
    // Let the iframe's srcdoc load.
    await bc.waitFor(tab, { timeoutMs: 1000, text: 'never' })
    const snap = await bc.snapshot(tab)
    const names = snap.elements.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['shadow', 'inner']))
    expect(names).not.toContain('far')
    const inner = snap.elements.find((e) => e.name === 'inner')!
    await bc.clickRef(tab, inner.ref)
    await new Promise((r) => setTimeout(r, 200))
    expect((await bc.evaluate(tab, 'document.title')).value).toBe('inner-clicked')
    const shadow = snap.elements.find((e) => e.name === 'shadow')!
    await bc.clickRef(tab, shadow.ref)
    await new Promise((r) => setTimeout(r, 200))
    expect((await bc.evaluate(tab, 'document.title')).value).toBe('shadow-clicked')
    expect((await bc.evaluate(tab, 'typeof globalThis.__maestrlyRefs')).value).toBe('undefined')

    // A ref scrolled out of view is scrolled back into it.
    await bc.navigate(
      tab,
      page('<button id=b onclick="document.title=\'b\'">b</button><div style="height:4000px"></div>')
    )
    const snap2 = await bc.snapshot(tab)
    await bc.evaluate(tab, 'scrollTo(0, 3000); scrollY')
    await bc.clickRef(tab, snap2.elements[0].ref)
    await new Promise((r) => setTimeout(r, 200))
    expect((await bc.evaluate(tab, 'document.title')).value).toBe('b')

    // A ref from before a navigation is refused.
    await bc.navigate(tab, page('<p>next</p>'))
    await expect(bc.clickRef(tab, snap2.elements[0].ref)).rejects.toThrow(/before the page changed/)

    // A frozen page is restarted by the next navigation.
    await bc.navigate(tab, page('<script>setTimeout(()=>{while(true){}},300)</script><p>stuck</p>'))
    await new Promise((r) => setTimeout(r, 700))
    await expect(bc.snapshot(tab, { timeoutMs: 1000 })).rejects.toThrow(/frozen/)
    const revived = await bc.navigate(tab, page('<p>alive</p>'))
    expect(revived.url).toContain('/p')
    expect((await bc.evaluate(tab, 'document.body.innerText')).value).toBe('alive')
    await bc.navigate(tab, page('<p>before-back</p>'))

    // History through the protocol.
    const back = await bc.navHistory(tab, 'back')
    expect(back.moved).toBe(true)
    expect(back.url).toContain('/p')

    // Tabs of another conversation are not listed.
    const other = await chromium.createTab('conv-b', 'about:blank')
    expect((await chromium.state('conv-a')).tabs.map((t) => t.id)).not.toContain(other)
    expect((await chromium.state('conv-b')).tabs.map((t) => t.id)).toEqual([other])

    // A popup belongs to its opener's conversation.
    await bc.evaluate(tab, `window.open(${JSON.stringify(page('<p>popup</p>'))}); 1`)
    await new Promise((r) => setTimeout(r, 1000))
    expect((await chromium.state('conv-a')).tabs.length).toBe(2)

    // A worker's tab is its own.
    const worker = await chromium.createTab('conv-a', 'about:blank', { ownerScopeId: 'w1', activate: false })
    expect((await chromium.state('conv-a', 'w1')).tabs.map((t) => t.id)).toEqual([worker])
    expect((await chromium.state('conv-a')).tabs.map((t) => t.id)).not.toContain(worker)

    // Cookies were copied once, host-only stays host-only.
    const { cookies } = await tab.send('Network.getCookies', {
      urls: ['https://example.com/', 'https://sub.example.com/'],
    })
    const byName = Object.fromEntries(
      (cookies as Array<{ name: string; domain: string }>).map((c) => [c.name, c.domain])
    )
    expect(byName).toEqual({ sid: 'example.com', wide: '.example.com' })

    // Screenshot through the protocol.
    const png = await (await chromium.page('conv-a')).captureScreenshot()
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // A tab behind another one is captured too.
    const behind = await chromium.page('conv-a', worker)
    await bc.navigate(behind, page('<p>behind</p>'))
    const hiddenPng = await behind.captureScreenshot()
    expect(hiddenPng.subarray(1, 4).toString()).toBe('PNG')

    // Stop: tabs are saved and reopened with their conversations.
    const kept = page('<p>kept</p>')
    await bc.navigate(await chromium.page('conv-a'), kept)
    await chromium.stop()
    const saved = JSON.parse(readFileSync(path.join(root, 'chromium-tabs.json'), 'utf8'))
    expect(saved.tabs.some((t: { url: string }) => t.url === kept)).toBe(true)
    expect(saved.tabs.every((t: { conversationId: string }) => t.conversationId === 'conv-a')).toBe(true)
    const restored = await chromium.state('conv-a')
    expect(restored.tabs.map((t) => t.url)).toContain(kept)
    expect(restored.activeId).not.toBeNull()

    // A crash restarts the browser with its tabs.
    const pid = lastPid!
    process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(lastPid).not.toBe(pid), { timeout: 10_000, interval: 100 })
    await vi.waitFor(() => expect(chromium.isRunning).toBe(true), { timeout: 60_000, interval: 200 })
    const again = await chromium.state('conv-a')
    expect(again.tabs.map((t) => t.url)).toContain(kept)
    const p = await chromium.page('conv-a')
    expect((await bc.evaluate(p, '1+1')).value).toBe('2')
    expect(logs.join('\n')).toContain('copied 2 shared site cookies')
    expect(logs.filter((l) => l.includes('copied')).length).toBe(1)
  })
})
