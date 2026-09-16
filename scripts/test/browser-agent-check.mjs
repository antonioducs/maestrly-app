// Runs inside a bot session, as its user: opens a workspace page in the managed Chromium through
// the graphical services' agent socket (the same catalogue the bot's browser tools use) and reads
// it back. Prints one JSON line and always exits 0 so the caller can record a failure code.
// Usage: node browser-agent-check.mjs <agent socket> <url>
import { connect } from 'node:net'
import { performance } from 'node:perf_hooks'

const [socketPath, url] = process.argv.slice(2)
const socket = connect(socketPath)
const pending = new Map()
let buffer = ''
let next = 0
socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  buffer += chunk
  for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
    const frame = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    // Invalidation events carry no id; only replies settle a request.
    if (typeof frame.id !== 'number') continue
    pending.get(frame.id)?.(frame)
    pending.delete(frame.id)
  }
})
const call = (op, params, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => reject(Object.assign(new Error(`${op} timed out`), { code: 'TIMEOUT' })), timeoutMs)
    pending.set(id, (frame) => {
      clearTimeout(timer)
      if (frame.error) reject(Object.assign(new Error(frame.error.code), { code: frame.error.code }))
      else resolve(frame.result)
    })
    socket.write(`${JSON.stringify({ id, op, params })}\n`)
  })
const started = performance.now()
try {
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  await call('browser.navigate', { url })
  const page = await call('browser.snapshot', {})
  process.stdout.write(`${JSON.stringify({ ok: true, title: page.title, url: page.url, ms: Math.round(performance.now() - started) })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? String(error?.message ?? error).slice(0, 200), ms: Math.round(performance.now() - started) })}\n`)
} finally {
  socket.destroy()
}
