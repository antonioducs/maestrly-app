import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from '../src/providers/codex/adapter.js'
import { serverRequest } from '../src/providers/codex/events.js'
import { configuration } from '../src/providers/codex/configuration.js'
import type { ProviderEvent, TurnHooks } from '../src/providers/provider.js'
import { snapshot, temporary } from './helpers.js'
const adapters: CodexAdapter[] = []
it('disables notification commands with a TOML-compatible empty list', () => {
  expect(configuration(snapshot(), '/tmp/workspace', false).thread.config?.notify).toEqual([])
})
it('tells the model that its browser is the managed Chromium behind the browser tools', () => {
  const instructions = configuration(snapshot({ instructions: 'Seja breve.' }), '/tmp/workspace', false).thread.developerInstructions ?? ''
  // The bot's own instructions come first; the environment follows on every thread start.
  expect(instructions.startsWith('Seja breve.')).toBe(true)
  expect(instructions).toContain('Chromium')
  expect(instructions).toContain('browser_navigate')
  expect(instructions).toMatch(/não fica no PATH/)
  expect(instructions).toContain('https://www.google.com/search?q=')
})
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()))
  vi.unstubAllEnvs()
})
async function adapter() {
  const root = await temporary()
  const result = await CodexAdapter.connect({
    state: join(root, 'state'),
    workspace: join(root, 'workspace'),
    version: '0.1.0',
    binaryPath: process.execPath,
    binaryArgs: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
  })
  adapters.push(result)
  return { result, root }
}
function hooks() {
  const events: ProviderEvent[] = []
  const hook: TurnHooks = {
    emit: (event) => events.push(event),
    requestApproval: vi.fn(async () => 'approve' as const),
    askQuestion: async () => 'answer',
  }
  return { hook, events }
}
describe('real Codex adapter against app-server fixture', () => {
  it('maps models and starts then resumes the same thread without resending recent messages', async () => {
    const { result, root } = await adapter()
    expect(await result.models()).toEqual([
      {
        id: 'model-small',
        displayName: 'Small',
        efforts: ['low', 'medium'],
        defaultEffort: 'medium',
        recommended: true,
      },
      { id: 'model-large', displayName: 'Large', efforts: ['high'], recommended: false },
    ])
    const { hook, events } = hooks()
    const first = await result.startTurn(
      snapshot({ recentMessages: [{ role: 'user', content: 'old message' }] }),
      hook,
      new AbortController().signal
    )
    const second = await result.startTurn(
      snapshot({ recentMessages: [{ role: 'user', content: 'do not repeat' }] }),
      hook,
      new AbortController().signal
    )
    expect(first.status).toBe('succeeded')
    expect(second.providerThreadId).toBe(first.providerThreadId)
    const log = (await readFile(join(root, 'workspace/rpc-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(log.find((row) => row.method === 'thread/start').params.developerInstructions).toContain('old message')
    const resumed = log.find((row) => row.method === 'thread/resume')
    expect(resumed.params.threadId).toBe(first.providerThreadId)
    expect(log.filter(row => ['thread/archive', 'thread/unarchive', 'thread/resume'].includes(row.method)).map(row => row.method)).toEqual(['thread/archive', 'thread/unarchive', 'thread/resume'])
    expect(resumed.params.developerInstructions).not.toContain('do not repeat')
    expect(events.filter((event) => event.kind === 'assistant.message')).toHaveLength(2)
  })
  it('confirms MCP tool calls of its own tool server and declines any other server', async () => {
    const { result, root } = await adapter()
    const { hook, events } = hooks()
    await result.startTurn(snapshot({ message: '#elicit' }), hook, new AbortController().signal)
    await result.startTurn(snapshot({ message: '#elicit-foreign' }), hook, new AbortController().signal)
    const log = (await readFile(join(root, 'workspace/rpc-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const answers = log.filter((row) => row.serverResponse).map((row) => row.serverResponse)
    // Without this the tool call is refused and the browser silently stops working in ask mode.
    expect(answers[0].result).toEqual({ action: 'accept' })
    expect(answers[1].result).toEqual({ action: 'decline' })
    expect(events.filter((event) => event.kind === 'diagnostic')).toHaveLength(1)
  })
  it('carries tool identity, output, changes, reasoning and richer usage for the transcript', async () => {
    const { result } = await adapter()
    const { hook, events } = hooks()
    const outcome = await result.startTurn(snapshot({ message: '#tools' }), hook, new AbortController().signal)
    const started = events.filter((event) => event.kind === 'tool.started')
    const finished = events.filter((event) => event.kind === 'tool.finished')
    expect(started.map((event) => event.detail?.callId)).toEqual(['c1', 'm1', 'f1'])
    expect(started[0].detail).toMatchObject({ tool: 'commandExecution', command: 'ls' })
    expect(finished[0].detail).toMatchObject({ callId: 'c1', output: 'a\nb', exitCode: 0 })
    expect(started[1].detail).toMatchObject({ callId: 'm1', server: 'maestrly-bot', name: 'browser_navigate', arguments: { url: 'x' } })
    expect(finished[2].detail).toMatchObject({ callId: 'f1', changes: [{ path: 'a.txt', kind: 'add' }] })
    // Reasoning is a delta on its own channel, never mixed into the answer text.
    expect(events.find((event) => event.kind === 'assistant.delta' && event.detail?.channel === 'reasoning')?.detail?.text).toBe('thinking')
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningOutputTokens: 5, contextTokens: 90, modelContextWindow: 272000 })
  })
  it('keeps the end of a huge tool output, bounded to what the transcript stores', async () => {
    const { result } = await adapter()
    const { hook, events } = hooks()
    await result.startTurn(snapshot({ message: '#tools #huge' }), hook, new AbortController().signal)
    const output = events.find((event) => event.kind === 'tool.finished')?.detail?.output as string
    expect(output.length).toBe(8 * 1024)
    expect(output.endsWith('y')).toBe(true)
  })
  it('refuses an unavailable thread instead of silently replacing its history', async () => {
    const { result } = await adapter()
    await expect(result.startTurn(
      snapshot({ providerThreadId: 'missing' }),
      hooks().hook,
      new AbortController().signal
    )).rejects.toThrow()
  })
  it('completes the approval round trip', async () => {
    const { result, root } = await adapter()
    const { hook } = hooks()
    const outcome = await result.startTurn(snapshot({ message: '#approve' }), hook, new AbortController().signal)
    expect(outcome.status).toBe('succeeded')
    expect(hook.requestApproval).toHaveBeenCalledOnce()
    expect(await readFile(join(root, 'workspace/rpc-log.jsonl'), 'utf8')).toContain('"decision":"accept"')
  })
  it('interrupts a provider turn on abort', async () => {
    const { result } = await adapter()
    const { hook, events } = hooks()
    const controller = new AbortController()
    const promise = result.startTurn(snapshot({ message: '#slow' }), hook, controller.signal)
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'turn.status')).toBe(true))
    controller.abort()
    expect(['interrupted', 'cancelled']).toContain((await promise).status)
  })
  it('uses a minimal environment while preserving managed CODEX_HOME', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit')
    const { result, root } = await adapter()
    const initialization = result.client.initializeResult as unknown as {
      environment: { openaiKeyPresent: boolean; codexHome: string }
    }
    expect(initialization.environment.openaiKeyPresent).toBe(false)
    expect(initialization.environment.codexHome).toBe(join(root, 'state/codex'))
  })
  it('classifies unknown server methods as -32601 and emits a diagnostic', async () => {
    const { hook, events } = hooks()
    await expect(serverRequest({ id: 1, method: 'unknown/method', params: {} }, hook)).rejects.toMatchObject({
      code: -32601,
    })
    expect(events[0].kind).toBe('diagnostic')
  })
})

it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])(
  'declines %s using the Codex 0.153.4 decision enum',
  async (method) => {
    const { hook } = hooks()
    hook.requestApproval = async () => 'deny'
    await expect(serverRequest({ id: 1, method, params: {} }, hook)).resolves.toEqual({ decision: 'decline' })
  }
)

it('answers unsupported server methods with wire -32601 and a diagnostic', async () => {
  const { result, root } = await adapter()
  const { hook, events } = hooks()
  expect((await result.startTurn(snapshot({ message: '#unknown' }), hook, new AbortController().signal)).status).toBe(
    'succeeded'
  )
  const log = (await readFile(join(root, 'workspace/rpc-log.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(log.find((row) => row.serverResponse)?.serverResponse.error.code).toBe(-32601)
  expect(events.some((event) => event.kind === 'diagnostic')).toBe(true)
})

it('tells a member where its shared files actually are, instead of making it search', () => {
  const team = {
    teamId: 'team-1',
    teamName: 'Relatórios',
    runId: 'run-1',
    taskId: 'task-1',
    round: 1,
    stage: 'working' as const,
    role: 'member' as const,
    objective: 'Relatório mensal',
    members: [
      { botId: 'bot', name: 'Assistente', role: 'execução', coordinator: false, assignable: false },
      { botId: 'other', name: 'Ana', role: 'coordenação', coordinator: true, assignable: false },
    ],
    memory: [{ id: 'm1', content: 'Sempre citar a fonte dos números.' }],
    resources: [
      { artifactId: 'art-1', name: 'dados.csv', path: 'equipe/run-1/art-1-dados.csv', digest: 'a'.repeat(64), size: 42, origin: 'compartilhado pela pessoa' },
    ],
    dependencyResults: [{ taskId: 'task-0', localKey: 'analise', botName: 'Ana', status: 'succeeded' as const, summary: 'Total conferido: 1234.' }],
    remaining: { toolCalls: 70, activeMs: 600_000, rounds: 2, tasks: 10 },
    tools: ['team_members', 'team_publish_file'] as never,
  }
  const instructions = configuration(snapshot({ instructions: 'Seja breve.', team }), '/tmp/workspace', false).thread.developerInstructions ?? ''
  // The exact relative path of every delivered copy, so the member reads it instead of hunting.
  expect(instructions).toContain('equipe/run-1/art-1-dados.csv')
  expect(instructions).toContain('dados.csv')
  expect(instructions).toContain('compartilhado pela pessoa')
  // Who else is on the team, and what a dependency already produced.
  expect(instructions).toContain('Ana')
  expect(instructions).toContain('Total conferido: 1234.')
  // Team memory the person approved reaches the turn as well.
  expect(instructions).toContain('Sempre citar a fonte dos números.')
  // The bot's own instructions still come first and nothing private leaks in.
  expect(instructions.startsWith('Seja breve.')).toBe(true)
  expect(instructions).not.toContain('team-1')
})

it('keeps a solo turn free of any team section', () => {
  const instructions = configuration(snapshot({ instructions: 'Seja breve.' }), '/tmp/workspace', false).thread.developerInstructions ?? ''
  expect(instructions).not.toContain('## Equipe')
  expect(instructions).not.toContain('Arquivos compartilhados')
})
