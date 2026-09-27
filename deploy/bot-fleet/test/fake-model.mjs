import http from 'node:http'

const key = process.env.E2E_MODEL_KEY ?? 'e2e-model-key'
const devId = process.env.E2E_DEV_ID
const model = 'e2e-model'
// A second model, so that bots sharing an account can each choose their own.
const models = [model, 'e2e-model-b']
let summaries = 0
// Requests of different bots that wait for one another: they only meet when their turns run at the same time.
const barriers = new Map()
// Every request for the cookie pages, with the cookie the browser sent.
const cookieLog = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const contentText = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
const systemText = (messages) => messages.filter((entry) => entry.role === 'system').map((entry) => contentText(entry.content)).join('\n')
// A `name=value` field of an E2E message; values never contain spaces.
const field = (text, name) => new RegExp('(?:^|\\s)' + name + '=(\\S+)').exec(text)?.[1] ?? null

// The tool results of the turn that the last user message carrying `marker` started.
function turn(messages, marker) {
  const start = messages.findLastIndex((entry) => entry.role === 'user' && contentText(entry.content).includes(marker))
  const tools = start < 0 ? [] : messages.slice(start + 1).filter((entry) => entry.role === 'tool')
  return { tools, last: tools.length ? contentText(tools.at(-1).content) : '' }
}

// Resolves true once `parties` different roles arrived under `name`, or false after `timeoutMs`.
function arrive(name, role, parties, timeoutMs) {
  let barrier = barriers.get(name)
  if (!barrier) {
    barrier = { roles: new Set(), waiters: [] }
    barriers.set(name, barrier)
  }
  barrier.roles.add(role)
  if (barrier.roles.size >= parties) {
    for (const wake of barrier.waiters.splice(0)) wake(true)
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    barrier.waiters.push((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function toolName(tools, suffix) {
  const tool = tools.find((entry) => entry.type === 'function' && entry.function?.name?.endsWith(suffix))
  if (!tool) throw new Error('Missing tool: ' + suffix)
  return tool.function.name
}

function validatedTool(req, suffix, args) {
  const name = toolName(req.tools ?? [], suffix)
  const schema = req.tools.find((entry) => entry.function?.name === name)?.function?.parameters
  for (const required of schema?.required ?? []) {
    if (!(required in args)) throw new Error('Missing required tool argument: ' + required)
  }
  for (const [field, value] of Object.entries(args)) {
    const property = schema?.properties?.[field]
    const validType = property?.type === 'integer' ? Number.isInteger(value) : property?.type === typeof value
    if (!property || !validType || (property.enum && !property.enum.includes(value)))
      throw new Error('Invalid tool argument: ' + field)
  }
  return { name, args }
}

async function reply(req) {
  const messages = req.messages
  if (messages.some((entry) => entry.role === 'system' && typeof entry.content === 'string' && entry.content.startsWith('You summarize programming conversations')))
    return { text: `E2E-SUMMARY ${++summaries}` }
  const lastUser = messages.filter((entry) => entry.role === 'user').at(-1)
  const text = contentText(lastUser?.content)
  const toolReturned = messages.slice(messages.lastIndexOf(lastUser) + 1).some((entry) => entry.role === 'tool')
  if (text.includes('E2E-IMAGE')) {
    const images = Array.isArray(lastUser?.content) ? lastUser.content.filter((part) => part.type === 'image_url') : []
    const valid = images.some((part) => /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url?.url ?? part.image_url ?? ''))
    return { text: valid ? 'E2E-IMAGE-SEEN' : 'E2E-IMAGE-MISSING' }
  }
  if (text.includes('Scheduled routine') && text.includes('E2E routine ping')) {
    if (text.includes('E2E-RUN-1 done')) return { text: 'E2E-ROUTINE-HISTORY-SEEN' }
    if (text.includes('This is the first recorded run') && !toolReturned)
      return validatedTool(req, 'routine_report', {
        summary: 'E2E-RUN-1 done', notes_for_next_run: 'check the second shelf',
      })
    return { text: 'E2E-ROUTINE-DONE' }
  }
  if (text.includes('E2E-ROUTINE-CREATE')) {
    const userIndex = messages.lastIndexOf(lastUser)
    if (messages.slice(userIndex + 1).some((entry) => entry.role === 'tool')) return { text: 'E2E-ROUTINE-CREATED' }
    return validatedTool(req, 'bot_routines_create', {
      title: 'E2E bot routine', prompt: 'E2E routine ping', everyMinutes: 15,
    })
  }
  if (text.includes('handed it back')) return { text: 'E2E-CONTINUED' }
  if (text.includes('E2E-OWNER-MEMORY')) {
    if (toolReturned) return { text: 'E2E-OWNER-SAVED' }
    return validatedTool(req, 'owner_memory_save', { content: 'Prefers answers in haiku.' })
  }
  if (text.includes('E2E-OWNER-CHECK')) {
    const context = systemText(messages)
    return { text: (context + '\n' + text).includes('Prefers answers in haiku.') ? 'E2E-OWNER-SEEN' : 'E2E-OWNER-MISSING' }
  }
  if (text.includes('E2E-BOT-MEMORY')) {
    if (toolReturned) return { text: 'E2E-BOT-SAVED' }
    return validatedTool(req, 'memory_upsert', {
      title: 'E2E launch code', content: 'The e2e launch code is BLUEBIRD.', type: 'reference',
    })
  }
  if (text.includes('launch code') && text.includes('<maestrly-memory kind="recall">') && text.includes('BLUEBIRD'))
    return { text: 'E2E-RECALL-BLUEBIRD' }
  // A bot without that memory (another bot of the environment) recalls nothing.
  if (text.includes('launch code')) return { text: 'E2E-RECALL-NONE' }
  if (text.includes('E2E-PROVISION')) {
    const context = systemText(messages)
    if (!context.includes('e2e-toolkit')) return { text: 'E2E-PROVISION-NO-SKILL' }
    if (messages.slice(messages.lastIndexOf(lastUser) + 1).some((entry) => entry.role === 'tool' && contentText(entry.content).includes('E2E-ECHO:ping')))
      return { text: 'E2E-PROVISION-OK' }
    if (toolReturned) return { text: 'E2E-PROVISION-ECHO-FAILED' }
    if (req.tools?.some((entry) => entry.function?.name?.endsWith('__echo')))
      return validatedTool(req, '__echo', { text: 'ping' })
    // Newly imported servers have no cached declarations, so use the cold-catalog entry point.
    if (req.tools?.some((entry) => entry.function?.name === 'mcp_call'))
      return validatedTool(req, 'mcp_call', { server: 'e2e-echo', tool: 'echo', arguments: { text: 'ping' } })
    return { text: 'E2E-PROVISION-NO-MCP' }
  }
  // Two bots of one environment: each turn waits for the other's, then says whether its prompt names the other bot.
  if (text.includes('E2E-PAIR ')) {
    const name = field(text, 'key'), role = field(text, 'role'), peer = field(text, 'peer')
    const hold = Math.min(Number(field(text, 'hold')) || 0, 10000)
    const started = Date.now()
    const together = await arrive(name, role, 2, 90000)
    const waited = Date.now() - started
    // Keeps both turns running a little longer, so the gateway can be seen reporting both at work.
    if (together && hold) await sleep(hold)
    const context = systemText(messages)
    const peers = context.includes('Other bots share this environment with you') && context.includes(peer) ? 'yes' : 'no'
    return { text: `${together ? 'E2E-PAIR-DONE' : 'E2E-PAIR-ALONE'} role=${role} key=${name} peers=${peers} model=${req.model} waited=${waited}` }
  }
  // A bot clicks into the window on its own apps display, then types its text there.
  if (text.includes('E2E-APPS-TYPE')) {
    const typed = field(text, 'text')
    const { tools } = turn(messages, 'E2E-APPS-TYPE')
    if (tools.length === 0) return validatedTool(req, 'computer_click', { x: 640, y: 400 })
    if (tools.length === 1) return validatedTool(req, 'computer_type', { text: typed })
    return { text: 'E2E-APPS-TYPED text=' + typed }
  }
  // One bot's browser stores a cookie of the local site; another bot's browser shows what the site received.
  if (text.includes('E2E-COOKIE-SET')) {
    const url = field(text, 'url'), value = field(text, 'value')
    const { tools, last } = turn(messages, 'E2E-COOKIE-SET')
    if (tools.length === 0) return validatedTool(req, 'browser_navigate', { url })
    if (tools.length === 1) return validatedTool(req, 'browser_read_text', {})
    return { text: last.includes('E2E-COOKIE-SET:' + value) ? 'E2E-COOKIE-STORED value=' + value : 'E2E-COOKIE-NOT-STORED' }
  }
  if (text.includes('E2E-COOKIE-GET')) {
    const url = field(text, 'url')
    const { tools, last } = turn(messages, 'E2E-COOKIE-GET')
    if (tools.length === 0) return validatedTool(req, 'browser_navigate', { url })
    if (tools.length === 1) return validatedTool(req, 'browser_read_text', {})
    return { text: 'E2E-COOKIE-SEEN value=' + (/E2E-COOKIE-VALUE:([A-Za-z0-9-]+)/.exec(last)?.[1] ?? 'unreadable') }
  }
  if (text.includes('E2E-ALIVE')) return { text: 'E2E-ALIVE-OK tag=' + field(text, 'tag') }
  // A turn that stays busy for a while, so something else can happen during it.
  if (text.includes('E2E-SLOW')) {
    await sleep(Math.min(Number(field(text, 'ms')) || 0, 20000))
    return { text: 'E2E-SLOW-DONE tag=' + field(text, 'tag') }
  }
  const start = messages.findLastIndex((entry) => entry.role === 'user' && JSON.stringify(entry.content).includes('E2E-START'))
  if (start < 0) return { text: 'E2E-IDLE' }
  const completed = messages.slice(start + 1).filter((entry) => entry.role === 'tool').length
  const steps = ['computer_screenshot', 'computer_click', 'bot_peers_send', 'request_owner_help']
  if (completed >= steps.length) return { text: 'E2E-START-DONE' }
  const suffix = steps[completed]
  const args = [
    {},
    { x: 640, y: 400 },
    { to: devId, text: 'hello from scout' },
    { reason: 'E2E needs the owner' },
  ][completed]
  return validatedTool(req, suffix, args)
}

// A page of a local site that bots open in their browsers: `set` stores a cookie, `show` prints the one it received.
function cookiePage(req, res, url) {
  const cookie = /(?:^|;\s*)e2e_shared=([A-Za-z0-9-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null
  cookieLog.push({ path: url.pathname, cookie, at: new Date().toISOString() })
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  let body
  if (url.pathname === '/e2e/cookie/set') {
    const value = url.searchParams.get('value') ?? ''
    if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
      res.writeHead(400, headers)
      return res.end('Invalid cookie value')
    }
    headers['set-cookie'] = `e2e_shared=${value}; Path=/; Max-Age=3600; SameSite=Lax`
    body = 'E2E-COOKIE-SET:' + value
  } else body = 'E2E-COOKIE-VALUE:' + (cookie ?? 'none')
  res.writeHead(200, headers)
  res.end(`<!doctype html><html><head><title>E2E cookie</title></head><body><p>${body}</p></body></html>`)
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://e2e-model')
  if (req.method === 'GET' && (url.pathname === '/e2e/cookie/set' || url.pathname === '/e2e/cookie/show'))
    return cookiePage(req, res, url)
  if (req.headers.authorization !== 'Bearer ' + key) return json(res, 401, { error: { message: 'Invalid API key' } })
  if (req.method === 'GET' && url.pathname === '/e2e/cookie/log') return json(res, 200, { requests: cookieLog })
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'e2e' })) })
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
    return json(res, 404, { error: { message: 'Not found' } })
  if (!req.headers['content-type']?.startsWith('application/json'))
    return json(res, 415, { error: { message: 'Expected JSON' } })
  let body
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks).toString())
    if (!models.includes(body.model) || !Array.isArray(body.messages))
      return json(res, 400, { error: { message: 'Invalid chat request' } })
    const result = await reply(body)
    if (body.stream !== true) {
      if (!result.text?.startsWith('E2E-SUMMARY'))
        return json(res, 400, { error: { message: 'Expected streaming chat request' } })
      return json(res, 200, {
        id: 'chatcmpl-e2e-summary',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 16, total_tokens: 96 },
      })
    }
    const id = 'chatcmpl-e2e'
    const base = { id, object: 'chat.completion.chunk', created: 0, model: body.model }
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      ...base, choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    emit({ role: 'assistant' })
    if (result.name) {
      emit({ tool_calls: [{ index: 0, id: 'call-e2e-' + Date.now(), type: 'function',
        function: { name: result.name, arguments: JSON.stringify(result.args) } }] })
      emit({}, 'tool_calls')
    } else {
      emit({ content: result.text })
      emit({}, 'stop')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: { message: String(error.message ?? error) } })
    else res.end()
  }
}).listen(8787, '0.0.0.0')
