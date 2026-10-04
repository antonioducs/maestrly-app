// Synthetic pages for scripts/test-bot-fleet-desktop.mjs. The test starts this server inside a disposable environment
// container on 127.0.0.1:8111. Programs on the bots' desktops and the bots' Maestrly browsers reach it; it records what
// they did, and the test reads it back from /state. Nothing leaves the container.
const http = require('node:http')

const started = Date.now()
const elapsed = () => Date.now() - started
const state = { hits: [], pids: [], values: {}, events: [], sizes: {}, openers: {} }

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>html,body{margin:0;height:100%;font:20px sans-serif}</style></head><body>${body}</body></html>`
/** Reports the page's size as `owner` when it loads and whenever it changes. */
const reportSize = (owner) =>
  `<script>const size = () => fetch('/size?owner=${owner}&w=' + innerWidth + '&h=' + innerHeight);` +
  ` size(); addEventListener('resize', size)</script>`
/** A text field filling the page that reports each change of its value as `owner`. */
const field = (owner, color, attributes = '') =>
  `<textarea id="text" autofocus ${attributes} style="box-sizing:border-box;width:100vw;height:100vh;font-size:28px;` +
  `background:${color};border:0" oninput="fetch('/record?owner=${owner}&value=' + encodeURIComponent(this.value))">` +
  `</textarea>`

const pages = {
  // The two bots' pages: a field each, in colors far apart.
  alpha: () => page('alpha', field('alpha', '#ffd6e0') + reportSize('alpha')),
  beta: () => page('beta', field('beta', '#d6e8ff') + reportSize('beta')),
  // A native select: its choice is reported as `select`.
  select: () =>
    page(
      'select',
      `<select id="choice" style="margin:40px;font-size:28px;width:400px" ` +
        `onchange="fetch('/record?owner=select&value=' + this.value)">` +
        `<option value="one">One</option><option value="two">Two</option><option value="three">Three</option>` +
        `</select>`
    ),
  // A page whose button opens a sign-in style popup; the popup reports its opener and what is typed into it.
  opener: () =>
    page(
      'opener',
      `<button id="open" style="width:100vw;height:100vh;font-size:30px" ` +
        `onclick="window.open('/popup', 'signin', 'popup,width=520,height=380')">Open popup</button>`
    ),
  popup: () =>
    page(
      'popup',
      field('popup', '#d9f7d6') +
        `<script>fetch('/opened-by?owner=popup&path=' + encodeURIComponent(window.opener ? window.opener.location.pathname : ''))` +
        `</script>`
    ),
  // Where the address bar test navigates.
  arrived: () => page('arrived', '<h1>Arrived</h1>'),
  // What a link opened by a program on a bot's desktop lands on.
  forward: () => page('forward', '<h1>Forwarded</h1>'),
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test')
    const name = url.pathname.slice(1)
    const param = (key) => url.searchParams.get(key) ?? ''
    if (name !== 'state')
      state.hits.push({ path: url.pathname, owner: param('owner'), ua: request.headers['user-agent'] ?? '', at: elapsed() })
    if (name === 'state') return response.end(JSON.stringify({ ...state, now: elapsed() }))
    if (name.startsWith('pid/')) {
      state.pids.push(name.slice(4))
      return response.end('ok\n')
    }
    if (name === 'record') {
      state.values[param('owner')] = param('value')
      return response.end('ok')
    }
    if (name === 'event') {
      state.events.push([param('name'), elapsed()])
      return response.end('ok')
    }
    if (name === 'size') {
      state.sizes[param('owner')] = { width: Number(param('w')), height: Number(param('h')) }
      return response.end('ok')
    }
    if (name === 'opened-by') {
      state.openers[param('owner')] = param('path')
      return response.end('ok')
    }
    const render = pages[name]
    if (!render) {
      response.statusCode = 404
      return response.end('Not found')
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(render())
  })
  .listen(8111, '127.0.0.1')
