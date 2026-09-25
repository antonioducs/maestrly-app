import http from 'node:http'

const key = process.env.E2E_MODEL_KEY ?? 'e2e-model-key'
const devId = process.env.E2E_DEV_ID
const model = 'e2e-model'
let summaries = 0

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
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

function reply(req) {
  const messages = req.messages
  if (messages.some((entry) => entry.role === 'system' && typeof entry.content === 'string' && entry.content.startsWith('You summarize programming conversations')))
    return { text: `E2E-SUMMARY ${++summaries}` }
  const lastUser = messages.filter((entry) => entry.role === 'user').at(-1)
  const text = JSON.stringify(lastUser?.content ?? '')
  if (text.includes('E2E-IMAGE')) {
    const images = Array.isArray(lastUser?.content) ? lastUser.content.filter((part) => part.type === 'image_url') : []
    const valid = images.some((part) => /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url?.url ?? part.image_url ?? ''))
    return { text: valid ? 'E2E-IMAGE-SEEN' : 'E2E-IMAGE-MISSING' }
  }
  if (text.includes('E2E routine ping')) return { text: 'E2E-ROUTINE-DONE' }
  if (text.includes('E2E-ROUTINE-CREATE')) {
    const userIndex = messages.lastIndexOf(lastUser)
    if (messages.slice(userIndex + 1).some((entry) => entry.role === 'tool')) return { text: 'E2E-ROUTINE-CREATED' }
    return validatedTool(req, 'bot_routines_create', {
      title: 'E2E bot routine', prompt: 'E2E routine ping', everyMinutes: 15,
    })
  }
  if (text.includes('handed it back')) return { text: 'E2E-CONTINUED' }
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

http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) return json(res, 401, { error: { message: 'Invalid API key' } })
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, { object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'e2e' }] })
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
    if (body.model !== model || !Array.isArray(body.messages))
      return json(res, 400, { error: { message: 'Invalid chat request' } })
    const result = reply(body)
    if (body.stream !== true) {
      if (!result.text?.startsWith('E2E-SUMMARY'))
        return json(res, 400, { error: { message: 'Expected streaming chat request' } })
      return json(res, 200, {
        id: 'chatcmpl-e2e-summary',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 16, total_tokens: 96 },
      })
    }
    const id = 'chatcmpl-e2e'
    const base = { id, object: 'chat.completion.chunk', created: 0, model }
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
