import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpClient, AcpProcessExitedError, AcpRpcError, type AcpClientOptions } from '../../src/main/chat/acp/client'
import type { AcpSessionNotification } from '../../src/main/chat/acp/protocol'

const FAKE_AGENT = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))

let temporary: string
let clients: AcpClient[] = []

beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'acp-client-'))
  clients = []
})

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close(200)))
  rmSync(temporary, { recursive: true, force: true })
})

function options(env: Record<string, string> = {}, overrides: Partial<AcpClientOptions> = {}): AcpClientOptions {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: temporary,
    env: {
      PATH: process.env.PATH,
      GEMINI_HOME: path.join(temporary, '.gemini'),
      FAKE_ACP_LOG: path.join(temporary, 'agent.log'),
      ...env,
    },
    clientInfo: { name: 'maestrly-test', version: '0.0.0' },
    ...overrides,
  }
}

async function start(env: Record<string, string> = {}, overrides: Partial<AcpClientOptions> = {}) {
  const started = await AcpClient.start(options(env, overrides))
  clients.push(started.client)
  return started
}

function agentLog(): Array<Record<string, unknown>> {
  return readFileSync(path.join(temporary, 'agent.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function openSession(client: AcpClient): Promise<string> {
  await client.request('authenticate', { methodId: 'oauth-personal' })
  const session = await client.request<{ sessionId: string }>('session/new', { cwd: temporary, mcpServers: [] })
  return session.sessionId
}

function collectText(client: AcpClient, sessionId: string): string[] {
  const chunks: string[] = []
  client.onNotification((method, params) => {
    const notification = params as AcpSessionNotification
    if (method !== 'session/update' || notification.sessionId !== sessionId) return
    const update = notification.update as { sessionUpdate: string; content?: { type: string; text?: string } }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      chunks.push(update.content.text ?? '')
    }
  })
  return chunks
}

describe('AcpClient', () => {
  it('performs the JSON-RPC 2.0 initialize handshake', async () => {
    const { initialize } = await start()
    expect(initialize.agentInfo).toMatchObject({ name: 'antigravity-acp', version: '1.2.1' })
    const [first] = agentLog()
    expect(first).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'maestrly-test' },
      },
    })
  })

  it('surfaces JSON-RPC errors with their code', async () => {
    const { client } = await start()
    const error = await client.request('session/new', { cwd: temporary, mcpServers: [] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcpRpcError)
    expect((error as AcpRpcError).code).toBe(-32000)
  })

  it('delivers session updates in order', async () => {
    const { client } = await start()
    const sessionId = await openSession(client)
    const chunks = collectText(client, sessionId)
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'ECHO hello world' }],
    })
    expect(result).toEqual({ stopReason: 'end_turn' })
    expect(chunks.join('')).toBe('hello world')
    expect(chunks).toHaveLength(2)
  })

  it('answers agent requests through registered handlers and rejects unknown methods', async () => {
    const { client } = await start()
    const seen: unknown[] = []
    client.setRequestHandler('session/request_permission', async (params) => {
      seen.push(params)
      return { outcome: { outcome: 'selected', optionId: 'deny' } }
    })
    const sessionId = await openSession(client)
    const chunks = collectText(client, sessionId)
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'NATIVE' }] })
    expect(seen).toHaveLength(1)
    expect(chunks.join('')).toBe('permission:deny')
    const outgoing = agentLog().find((entry) => entry.method === undefined && entry.result !== undefined)
    expect(outgoing).toMatchObject({ jsonrpc: '2.0', id: 'agent-1' })

    chunks.length = 0
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ASKCLIENT fs/unknown' }] })
    expect(chunks.join('')).toContain('"code":-32601')
  })

  it('rejects pending requests when the agent exits', async () => {
    const { client } = await start()
    const sessionId = await openSession(client)
    const error = await client
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'EXIT' }] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcpProcessExitedError)
    expect((error as AcpProcessExitedError).exitCode).toBe(3)
    expect(client.alive).toBe(false)
    await expect(client.request('session/list', {})).rejects.toBeInstanceOf(AcpProcessExitedError)
  })

  it('aborts one request without stopping the agent', async () => {
    const { client } = await start()
    const sessionId = await openSession(client)
    const controller = new AbortController()
    const pending = client.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'SLOW' }] },
      {
        signal: controller.signal,
      }
    )
    setTimeout(() => controller.abort(new Error('stop waiting')), 80)
    await expect(pending).rejects.toThrow('stop waiting')
    expect(client.alive).toBe(true)
    client.notify('session/cancel', { sessionId })
    await expect(
      client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ECHO ok' }] })
    ).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it.skipIf(process.platform === 'win32')('close() terminates the agent and its helper processes', async () => {
    const pidFile = path.join(temporary, 'helper.pid')
    const { client } = await start({ FAKE_ACP_CHILD_PID_FILE: pidFile })
    const helper = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(helper, 0)).not.toThrow()
    await client.close(500)
    expect(client.alive).toBe(false)
    await expect
      .poll(() => {
        try {
          process.kill(helper, 0)
          return 'alive'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code
        }
      })
      .toBe('ESRCH')
  })

  it('keeps only a bounded stderr tail', async () => {
    const { client } = await start({ FAKE_ACP_STDERR_BYTES: '5000' }, { stderrLimitBytes: 1000 })
    await expect.poll(() => client.stderrTail().length).toBe(1000)
  })

  it('rejects start when the agent cannot be spawned', async () => {
    await expect(
      AcpClient.start(options({}, { command: path.join(temporary, 'missing-agent'), args: [] }))
    ).rejects.toBeInstanceOf(AcpProcessExitedError)
  })
})
