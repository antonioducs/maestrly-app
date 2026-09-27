// Synthetic pages for scripts/test-bot-fleet-focus.mjs. The test starts this server inside a disposable environment
// container, where the bots' browsers open its pages on 127.0.0.1:8111. The pages report when they load, the focus
// changes of Alpha's page and the values typed into them; the test reads them back from /state. Nothing leaves the
// container.
const http = require('node:http')

// Beta's popup opens this long after its page is clicked, while the owner already controls Alpha's screen.
const BETA_POPUP_DELAY_MS = 15000
const started = Date.now()
const elapsed = () => Date.now() - started
const state = { ready: [], at: {}, events: [], values: { alpha: '', alphaPopup: '', popup: '' } }

/** A text field filling most of the page that reports each change of its value as `owner`. */
const input = (owner, color, attributes = '') =>
  `<input id="text" autofocus ${attributes} style="width:100vw;height:80vh;font-size:36px;background:${color}" ` +
  `oninput="fetch('/record?owner=${owner}&value=' + encodeURIComponent(this.value))">`
/** Reports the focus changes of the window and of its text field, to explain a failure. */
const watchFocus = (owner) =>
  `<script>for (const [target, name] of [[window, 'window'], [document.getElementById('text'), 'input']])` +
  ` for (const kind of ['focus', 'blur'])` +
  ` target.addEventListener(kind, () => fetch('/event?name=${owner}-' + name + '-' + kind))</script>`

const pages = {
  // The controlled bot's page. Its button opens Alpha's own popup without taking the focus from the text field.
  alpha: () =>
    input('alpha', '#ffaabb') +
    `<button onmousedown="event.preventDefault()" ` +
    `onclick="window.open('/alpha-popup', 'alphapopup', 'popup,width=500,height=400')" ` +
    `style="position:fixed;left:0;bottom:0;width:100vw;height:20vh;font-size:30px">Open popup</button>` +
    watchFocus('alpha'),
  // Alpha's popup closes itself on Enter.
  'alpha-popup': () => input('alphaPopup', '#aaffbb', `onkeydown="if (event.key === 'Enter') window.close()"`),
  // Another bot's page: once clicked, it opens a popup after a delay.
  beta: () =>
    `<button style="width:100vw;height:100vh" onclick="fetch('/ready?owner=beta-clicked'); ` +
    `setTimeout(() => window.open('/popup', 'betapopup', 'popup,width=500,height=400'), ${BETA_POPUP_DELAY_MS})">` +
    `Delayed popup</button>`,
  // Beta's popup shows native dialogs as it loads. They must neither block its script nor take the owner's keyboard;
  // a bot popup's confirmation is canceled.
  popup: () =>
    input('popup', '#aabbff') +
    `<script>fetch('/event?name=modal-before'); alert('Synthetic Beta popup notice');` +
    ` fetch('/event?name=confirm-' + confirm('Synthetic Beta popup question'));` +
    ` fetch('/event?name=modal-after')</script>`,
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test')
    const name = url.pathname.slice(1)
    if (name === 'state') return response.end(JSON.stringify({ ...state, now: elapsed() }))
    if (name === 'ready') {
      const owner = url.searchParams.get('owner')
      state.ready.push(owner)
      state.at[owner] = elapsed()
      return response.end('ok')
    }
    if (name === 'event') {
      state.events.push([url.searchParams.get('name'), elapsed()])
      return response.end('ok')
    }
    if (name === 'record') {
      state.values[url.searchParams.get('owner')] = url.searchParams.get('value')
      return response.end('ok')
    }
    const page = pages[name]
    if (!page) {
      response.writeHead(404)
      return response.end()
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      `<html><head><title>${name}</title></head><body style="margin:0">${page()}` +
        `<script>fetch('/ready?owner=${name}')</script></body></html>`
    )
  })
  .listen(8111, '127.0.0.1')
