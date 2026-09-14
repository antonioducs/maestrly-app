import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { FileService } from '../../apps/bot-runtime/src/files/service.js'
import { BrowserSession } from '../../apps/bot-runtime/src/tools/browser.js'
import { DesktopSession } from '../../apps/bot-runtime/src/desktop/session.js'
import { Computer } from '../../apps/bot-runtime/src/tools/computer.js'
import { captureDesktop } from '../../apps/bot-runtime/src/desktop/capture.js'
import { x11Command } from '../../apps/bot-runtime/src/desktop/input.js'

const processStatus = await readFile('/proc/self/status', 'utf8')
assert.match(processStatus, /NoNewPrivs:\s+1/)
assert.match(processStatus, /CapEff:\s+0+\n/)
assert.notEqual(process.getuid?.(), 0)
const label = process.argv[2]
assert(['a', 'b'].includes(label))
const workspace = process.env.MAESTRLY_BOT_WORKSPACE!
const state = process.env.MAESTRLY_BOT_STATE!
const files = new FileService(workspace)
await files.init()
const html = join(workspace, `session-${label}.html`)
await writeFile(html, `<!DOCTYPE html><html><body style="margin:0;background:${label === 'a' ? '#682121' : '#183c68'};color:white;font:24px sans-serif"><h1>Session ${label.toUpperCase()}</h1><button style="position:absolute;top:110px;left:60px;width:220px;height:70px" onclick="document.body.dataset.clicked='${label}';document.querySelector('input').focus()">Click ${label}</button><input style="position:absolute;top:230px;left:60px;width:280px;height:50px" value=""/><p id="status"></p><script>document.querySelector('input').oninput=()=>document.querySelector('#status').textContent=document.querySelector('input').value</script></body></html>`)
const desktop = new DesktopSession()
const browser = new BrowserSession(state, files, desktop, () => {})
const computer = new Computer(browser)
const hooks = { emit() {}, requestApproval: async () => 'deny' as const, askQuestion: async () => '' }
try {
  await browser.navigate(pathToFileURL(html).href)
  const page = await browser.ensure()
  if (process.argv[3] === 'resume') assert.equal(await page.evaluate(() => localStorage.getItem('session-persistence')), label)
  await page.evaluate(label => localStorage.setItem('session-persistence', label), label)
  if (await page.evaluate(() => window.outerHeight) !== desktop.height) await computer.key('F11')
  await page.waitForFunction(() => window.outerHeight === 800, { timeout: 5000 })
  await computer.click(label === 'a' ? 100 : 180, 140)
  await computer.type(`input-${label}`)
  await page.waitForFunction(label => document.body.dataset.clicked === label && (document.querySelector('input') as HTMLInputElement).value === `input-${label}`, label)
  const shot = await captureDesktop(desktop, files, randomUUID(), hooks)
  const pointer = (await x11Command('input', ['getmouselocation', '--shell'], desktop.environment())).stdout.trim()
  const result = { label, clicked: await page.evaluate(() => document.body.dataset.clicked), input: await page.inputValue('input'), screenshot: shot.path, width: shot.width, height: shot.height, pointer, ...(await files.stat({ path: shot.path })) }
  await writeFile(join(workspace, `result-${label}.json`), JSON.stringify(result))
  await writeFile(join(state, 'codex', 'isolation-sentinel'), `private-${label}`)
  await new Promise(r => setTimeout(r, 1500))
  assert.equal((await readFile(join(workspace, `result-${label}.json`), 'utf8')).includes(`input-${label}`), true)
  console.log(JSON.stringify(result))
} finally { await browser.close() }
