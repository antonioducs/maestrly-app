import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const notify = (method, params) => send({ method, params })
const reply = (id, result) => send({ id, result })
let account = null
let loginTimer
let nextThread = 0
let nextTurn = 0
let current
const pending = new Map()
const record = (entry) => appendFileSync(join(process.cwd(), 'rpc-log.jsonl'), `${JSON.stringify(entry)}\n`)
const complete = (status) => {
  if (!current) return
  const turn = current
  current = undefined
  notify('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status } })
}
async function runTurn(prompt) {
  if (prompt.includes('#slow')) return
  if (prompt.includes('#approve') || prompt.includes('#unknown')) {
    const id = 'server-request'
    const response = await new Promise((resolve) => {
      pending.set(id, resolve)
      send({
        id,
        method: prompt.includes('#unknown') ? 'unknown/serverMethod' : 'item/commandExecution/requestApproval',
        params: {
          threadId: current.threadId,
          turnId: current.id,
          command: 'touch approved.txt',
          reason: 'fixture test',
        },
      })
    })
    record({ serverResponse: response })
  }
  if (!current) return
  const params = { threadId: current.threadId, turnId: current.id }
  notify('item/agentMessage/delta', { ...params, delta: 'Hello ' })
  notify('item/agentMessage/delta', { ...params, text: 'world' })
  notify('item/completed', { ...params, item: { type: 'agentMessage', text: 'Hello world' } })
  complete('completed')
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (!request.method) {
    pending.get(request.id)?.(request)
    pending.delete(request.id)
    return
  }
  const p = request.params ?? {}
  // Deliberately never record account login secrets.
  record({ method: request.method, ...(request.method.startsWith('thread/') ? { params: p } : {}) })
  switch (request.method) {
    case 'thread/archive':
      if (p.threadId === 'missing') return send({ id: request.id, error: { code: -32600, message: 'Thread unavailable' } })
      return reply(request.id, {})
    case 'thread/unarchive':
      return reply(request.id, { thread: { id: p.threadId } })
    case 'initialize':
      return reply(request.id, {
        userAgent: 'codex-fixture',
        codexHome: process.env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'linux',
        environment: {
          openaiKeyPresent: 'OPENAI_API_KEY' in process.env,
          codexHome: process.env.CODEX_HOME,
          proxy: process.env.HTTPS_PROXY,
        },
      })
    case 'initialized':
      return
    case 'account/read':
      return reply(request.id, { account, requiresOpenaiAuth: true })
    case 'fixture/refreshAccount': {
      const id = 'account-refresh'
      pending.set(id, response => reply(request.id, { accepted: !!response.result, accountId: response.result?.chatgptAccountId, token: typeof response.result?.accessToken === 'string', rejected: !!response.error }))
      send({ id, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized', previousAccountId: p.accountId ?? 'provider-account' } })
      return
    }
    case 'account/login/start':
      if (p.type === 'chatgptAuthTokens') { account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }; return reply(request.id, { type: 'chatgptAuthTokens' }) }
      if (p.type === 'apiKey') {
        account = { type: 'apiKey' }
        return reply(request.id, { type: 'apiKey' })
      }
      reply(request.id, {
        type: 'chatgptDeviceCode',
        loginId: 'fixture-login',
        verificationUrl: process.argv.includes('--untrusted')
          ? 'https://evil.test/device'
          : 'https://auth.openai.com/device',
        userCode: 'ABCD-EFGH',
      })
      loginTimer = setTimeout(() => {
        account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }
        notify('account/login/completed', { loginId: 'fixture-login', success: true })
      }, 100)
      return
    case 'account/login/cancel':
      clearTimeout(loginTimer)
      return reply(request.id, {})
    case 'account/logout':
      account = null
      clearTimeout(loginTimer)
      return reply(request.id, {})
    case 'model/list':
      return reply(request.id, {
        data: [
          {
            id: 'model-small',
            displayName: 'Small',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
            defaultReasoningEffort: 'medium',
            isDefault: true,
          },
          { model: 'model-large', efforts: ['high'], displayName: 'Large' },
          { bad: true },
        ],
      })
    case 'thread/start':
      return reply(request.id, { thread: { id: `thread-${++nextThread}` } })
    case 'thread/resume':
      if (p.threadId === 'missing')
        return send({ id: request.id, error: { code: -32000, message: 'Thread not found' } })
      return reply(request.id, { thread: { id: p.threadId } })
    case 'turn/start':
      current = { threadId: p.threadId, id: `turn-${++nextTurn}` }
      reply(request.id, { turn: { id: current.id } })
      setTimeout(() => {
        void runTurn(p.input[0].text)
      }, 20)
      return
    case 'turn/interrupt':
      reply(request.id, {})
      complete('interrupted')
      return
    default:
      return send({ id: request.id, error: { code: -32601, message: 'Unknown method' } })
  }
})
