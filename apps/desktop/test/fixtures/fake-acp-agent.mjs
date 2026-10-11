#!/usr/bin/env node
// Scripted stand-in for Google's Antigravity ACP server (1.2.1): JSON-RPC 2.0 over stdio, one message per line.
// The last line of the last text block of `session/prompt` selects the behavior:
//   ECHO <text> | TOOL <name> <json args> | NATIVE | SLOW | SKIPMCP | EXIT | ASKCLIENT <method>
// Any other text is echoed back as `ok:<text>` after the MCP server has been initialized.
// Environment: FAKE_ACP_SCENARIO (auth-cancel), FAKE_ACP_PROJECT, FAKE_ACP_LOG (NDJSON of received messages),
// FAKE_ACP_CHILD_PID_FILE (spawn a helper and write its pid), FAKE_ACP_STDERR_BYTES (stderr noise at startup).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const scenario = process.env.FAKE_ACP_SCENARIO ?? 'default'
const geminiHome = process.env.GEMINI_HOME || path.join(process.env.HOME ?? '.', '.gemini')
const acpHome = path.join(geminiHome, 'antigravity-acp')
const tokenPath = path.join(acpHome, 'acp_token.json')
const conversationsDir = path.join(acpHome, 'conversations')

const MODEL_OPTIONS = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
  ['gemini-pro-agent', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
].map(([value, name]) => ({ value, name, description: value }))

if (process.env.FAKE_ACP_STDERR_BYTES) process.stderr.write('x'.repeat(Number(process.env.FAKE_ACP_STDERR_BYTES)))
if (process.env.FAKE_ACP_CHILD_PID_FILE) {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(helper.pid))
}

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    if (value.type === 'image' && typeof value.data === 'string') {
      return { type: 'image', mimeType: value.mimeType, dataLength: value.data.length }
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
  }
  return value
}
const log = (entry) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(redact(entry))}\n`)
}
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const reply = (id, result) => send({ id, result })
const fail = (id, code, message) => send({ id, error: { code, message } })
const notifyUpdate = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })

let nextOutgoing = 1
const outgoing = new Map()
const requestClient = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextOutgoing++}`
    outgoing.set(id, resolve)
    send({ id, method, params })
  })

const sessions = new Map()
const metaPath = (id) => path.join(conversationsDir, `${id}.meta`)
const authenticated = () => existsSync(tokenPath)
const configOptions = (model) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODEL_OPTIONS },
  {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  },
]
const openSession = (id, params) => {
  const session = {
    id,
    cwd: params.cwd,
    mcpServers: params.mcpServers ?? [],
    meta: params._meta,
    model: 'gemini-3.8-flash-high',
    cancelled: false,
    mcp: null,
  }
  sessions.set(id, session)
  mkdirSync(conversationsDir, { recursive: true })
  writeFileSync(metaPath(id), JSON.stringify({ cwd: params.cwd }))
  return session
}

let mcpRequestId = 1
async function mcpCall(session, method, params) {
  const server = session.mcpServers[0]
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of server.headers ?? []) headers[header.name] = header.value
  const isNotification = method.startsWith('notifications/')
  const body = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: mcpRequestId++, method, params }
  const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (response.status === 202 || isNotification) return null
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  const json = await response.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}
async function ensureMcp(session) {
  if (session.mcp || session.mcpServers.length === 0) return session.mcp
  await mcpCall(session, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'antigravity-client', version: 'v1.0.0' },
  })
  await mcpCall(session, 'notifications/initialized', {})
  const listed = await mcpCall(session, 'tools/list', {})
  session.mcp = { tools: listed?.tools ?? [] }
  return session.mcp
}

function lastCommand(prompt) {
  const texts = (prompt ?? []).filter((block) => block.type === 'text').map((block) => block.text)
  const last = texts.at(-1) ?? ''
  return last.trim().split('\n').at(-1)?.trim() ?? ''
}

async function runPrompt(session, prompt) {
  session.cancelled = false
  const command = lastCommand(prompt)
  const [verb, ...rest] = command.split(' ')
  const chunk = (text) =>
    notifyUpdate(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  if (verb === 'EXIT') process.exit(3)
  if (verb !== 'SKIPMCP') {
    try {
      await ensureMcp(session)
    } catch (error) {
      chunk(`The MCP server 'maestrly' failed to initialize: ${error.message}.`)
      return { stopReason: 'end_turn' }
    }
  }
  if (verb === 'ECHO') {
    const text = rest.join(' ')
    chunk(text.slice(0, Math.ceil(text.length / 2)))
    chunk(text.slice(Math.ceil(text.length / 2)))
    return { stopReason: 'end_turn' }
  }
  if (verb === 'TOOL') {
    const [name, ...json] = rest
    const args = json.length ? JSON.parse(json.join(' ')) : {}
    const toolCallId = randomUUID().replaceAll('-', '')
    const meta = { mcp: { tool: name, server: 'maestrly' }, is_mcp_tool_call: true }
    notifyUpdate(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `maestrly_${name}`,
      kind: 'other',
      status: 'pending',
      rawInput: { arguments: args, ...args },
      _meta: meta,
    })
    const decision = await requestClient('session/request_permission', {
      sessionId: session.id,
      toolCall: { toolCallId, title: `maestrly_${name}`, kind: 'other', rawInput: { arguments: args }, _meta: meta },
      options: [
        { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    const selected = decision?.outcome?.outcome === 'selected' ? decision.outcome.optionId : 'cancelled'
    if (selected !== 'allow' && selected !== 'allow_always') {
      chunk(`permission:${selected}`)
      return { stopReason: 'end_turn' }
    }
    const result = await mcpCall(session, 'tools/call', { name, arguments: args })
    notifyUpdate(session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', _meta: meta })
    const text = (result?.content ?? []).map((item) => (item.type === 'text' ? item.text : `[${item.type}]`)).join('')
    chunk(`${result?.isError ? 'tool-error:' : 'tool-result:'}${text}`)
    return { stopReason: 'end_turn' }
  }
  if (verb === 'NATIVE') {
    const decision = await requestClient('session/request_permission', {
      sessionId: session.id,
      toolCall: { toolCallId: 'native-1', title: 'Run list_resources?', kind: 'other', rawInput: { ServerName: 'x' } },
      options: [
        { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    chunk(`permission:${decision?.outcome?.outcome === 'selected' ? decision.outcome.optionId : 'cancelled'}`)
    return { stopReason: 'end_turn' }
  }
  if (verb === 'ASKCLIENT') {
    const answer = await requestClient(rest[0], {})
    chunk(`client-answer:${JSON.stringify(answer)}`)
    return { stopReason: 'end_turn' }
  }
  if (verb === 'SLOW') {
    const started = Date.now()
    while (!session.cancelled && Date.now() - started < 10_000) {
      chunk('.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }
  }
  chunk(`ok:${command}`)
  return { stopReason: 'end_turn' }
}

async function handle(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
        agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.2.1' },
      })
    case 'authenticate':
      if (scenario === 'auth-browser') {
        spawn(
          '/bin/sh',
          [
            '-c',
            process.env.BROWSER.replace('%s', '"$1"'),
            'browser',
            'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A32123%2F',
          ],
          { stdio: 'ignore' }
        )
        return undefined
      }
      if (scenario === 'auth-cancel') return undefined
      mkdirSync(acpHome, { recursive: true })
      writeFileSync(
        tokenPath,
        JSON.stringify({
          refresh_token: 'fake-secret',
          project_id: `fake-project-${process.env.FAKE_ACP_PROJECT ?? '1'}`,
        })
      )
      return reply(id, {})
    case 'logout':
      rmSync(tokenPath, { force: true })
      return reply(id, {})
    case 'session/new': {
      if (!authenticated()) return fail(id, -32000, 'Authentication required')
      const session = openSession(randomUUID(), params)
      return reply(id, { sessionId: session.id, configOptions: configOptions(session.model) })
    }
    case 'session/resume':
    case 'session/load': {
      if (!authenticated()) return fail(id, -32000, 'Authentication required')
      if (!existsSync(metaPath(params.sessionId))) {
        return fail(id, -32002, 'Session not found in the current GEMINI_HOME')
      }
      const session = openSession(params.sessionId, params)
      return reply(id, { configOptions: configOptions(session.model) })
    }
    case 'session/set_config_option': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, -32002, 'Session not found')
      if (params.configId === 'model') session.model = params.value
      return reply(id, { configOptions: configOptions(session.model) })
    }
    case 'session/delete':
    case 'session/close':
      sessions.delete(params.sessionId)
      if (method === 'session/delete') rmSync(metaPath(params.sessionId), { force: true })
      return reply(id, {})
    case 'session/cancel': {
      const session = sessions.get(params?.sessionId)
      if (session) session.cancelled = true
      return undefined
    }
    case 'session/prompt': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail(id, -32002, 'Session not found')
      try {
        return reply(id, await runPrompt(session, params.prompt))
      } catch (error) {
        return fail(id, -32603, error instanceof Error ? error.message : String(error))
      }
    }
    default:
      if (id !== undefined) return fail(id, -32601, `Method not found: ${method}`)
      return undefined
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  log(message)
  if (message.method === undefined) {
    const resolve = outgoing.get(message.id)
    outgoing.delete(message.id)
    resolve?.(message.result ?? { error: message.error })
    return
  }
  void handle(message)
})
process.stdin.on('end', () => process.exit(0))
