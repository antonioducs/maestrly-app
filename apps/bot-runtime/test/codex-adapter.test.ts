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
