import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_CAPABILITY, type ExtensionsApply } from '@maestrly/host-protocol'
import { ExtensionsStore } from '../src/extensions/store.js'
import { CodexAdapter } from '../src/providers/codex/adapter.js'
import { configuration, MCP_SERVER_NAME } from '../src/providers/codex/configuration.js'
import { FixtureProvider } from '../src/providers/fixture.js'
import type { ProviderEvent, TurnHooks } from '../src/providers/provider.js'
import { RuntimeSupervisor } from '../src/runtime-supervisor.js'
import { snapshot, temporary } from './helpers.js'

const SECRET = 'sk-never-on-disk-4242'
const payload = (overrides: Partial<ExtensionsApply> = {}): ExtensionsApply => ({
  revision: 3,
  mcpServers: [
    { id: '531d469d-1e84-434c-9831-bf16127464e5', name: 'meu-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'meu-mcp'], envKeys: ['TOKEN'], env: { TOKEN: SECRET }, enabled: true },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is data the store fills from the secret, not a template
    { id: '0280eeef-75f0-4070-b10b-709ac2b2d9ba', name: 'remoto', transport: 'http', url: 'https://mcp.example.test/sse', headers: { Authorization: 'Bearer ${API_KEY}' }, args: [], envKeys: ['API_KEY'], env: { API_KEY: 'k-1' }, enabled: true },
    { id: 'c5c5a7a4-9a63-4c0c-8a2c-5b0d3c1a2b3c', name: 'pausado', transport: 'stdio', command: 'x', args: [], envKeys: [], env: {}, enabled: false },
  ],
  skills: [
    {
      name: 'verificacao',
      files: [
        { path: 'SKILL.md', dataBase64: Buffer.from('---\ndescription: Verifica coisas\n---\n# Verificação').toString('base64') },
        { path: 'scripts/check.sh', dataBase64: Buffer.from('#!/bin/sh\necho ok').toString('base64') },
      ],
    },
  ],
  ...overrides,
})

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('extensions store', () => {
  it('writes skills where Codex reads them, keeps secrets off the disk and replaces the set on every apply', async () => {
    const state = await temporary()
    const store = new ExtensionsStore(join(state, 'codex'))
    expect(await store.apply(payload())).toEqual({ applied: 3 })
    expect(await readFile(join(state, 'codex/skills/verificacao/SKILL.md'), 'utf8')).toContain('Verifica coisas')
    expect((await stat(join(state, 'codex/skills/verificacao/scripts/check.sh'))).mode & 0o777).toBe(0o600)
    // Only enabled servers reach Codex; the secret lives in memory and in the header it fills.
    expect(store.names).toEqual(['meu-mcp', 'remoto'])
    expect(store.codexServers()).toEqual({
      'meu-mcp': { command: 'npx', args: ['-y', 'meu-mcp'], env: { TOKEN: SECRET } },
      remoto: { url: 'https://mcp.example.test/sse', http_headers: { Authorization: 'Bearer k-1' } },
    })
    const files = await walk(state)
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(SECRET)
    // A later revision without the skill removes it instead of leaving a stale copy behind.
    await store.apply(payload({ revision: 4, skills: [] }))
    expect(store.applied).toBe(4)
    await expect(readFile(join(state, 'codex/skills/verificacao/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    // A reset forgets everything: the Host resends on the next session.
    await store.apply(payload({ revision: 5 }))
    await store.reset()
    expect(store.names).toEqual([])
    expect(store.applied).toBeUndefined()
    await expect(readdir(join(state, 'codex/skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a server that would shadow the bot\'s own tool server', async () => {
    const store = new ExtensionsStore(join(await temporary(), 'codex'))
    const shadow = payload({ mcpServers: [{ ...payload().mcpServers[0], name: MCP_SERVER_NAME }] })
    await expect(store.apply(shadow)).rejects.toMatchObject({ code: 'EXTENSIONS_INVALID' })
    expect(store.names).toEqual([])
  })
})

describe('thread configuration with extensions', () => {
  it('merges the configured servers under the bot\'s own, which always wins, and names them in the prompt', () => {
    const configured = { mcpServers: { 'meu-mcp': { command: 'npx', args: [], env: {} } }, skills: ['verificacao'] }
    const thread = configuration(snapshot(), '/w', false, '/var/lib/maestrly-bot', configured).thread
    const servers = (thread.config as { mcp_servers: Record<string, unknown> }).mcp_servers
    expect(Object.keys(servers)).toEqual(['meu-mcp', MCP_SERVER_NAME])
    expect((servers[MCP_SERVER_NAME] as { command: string }).command).toBe(process.execPath)
    expect(thread.developerInstructions).toContain('meu-mcp')
    expect(thread.developerInstructions).toContain('verificacao')
    // A turn without extensions keeps exactly the previous shape.
    const plain = configuration(snapshot(), '/w', false, '/var/lib/maestrly-bot').thread
    expect(Object.keys((plain.config as { mcp_servers: Record<string, unknown> }).mcp_servers)).toEqual([MCP_SERVER_NAME])
    expect(plain.developerInstructions).not.toContain('Extensões deste bot')
  })
})

describe('elicitation for a configured server', () => {
  async function adapter() {
    const root = await temporary()
    const store = new ExtensionsStore(join(root, 'state/codex'))
    await store.apply(payload())
    const result = await CodexAdapter.connect({
      state: join(root, 'state'),
      workspace: join(root, 'workspace'),
      version: '0.1.0',
      binaryPath: process.execPath,
      binaryArgs: [fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url))],
      extensions: store,
    })
    cleanups.push(() => result.dispose())
    return { result, root }
  }
  function hooks(decision: 'approve' | 'deny') {
    const events: ProviderEvent[] = []
    const hook: TurnHooks = { emit: (event) => events.push(event), requestApproval: vi.fn(async () => decision), askQuestion: async () => 'answer' }
    return { hook, events }
  }
  const answers = async (root: string) =>
    (await readFile(join(root, 'workspace/rpc-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.serverResponse)
      .map((row) => row.serverResponse.result)

  it('asks the person in ask mode and follows the answer', async () => {
    const { result, root } = await adapter()
    const approved = hooks('approve')
    await result.startTurn(snapshot({ message: '#elicit-configured', permissionMode: 'ask' }), approved.hook, new AbortController().signal)
    expect(approved.hook.requestApproval).toHaveBeenCalledOnce()
    expect(vi.mocked(approved.hook.requestApproval).mock.calls[0][0]).toMatchObject({ title: 'Usar o servidor MCP meu-mcp', parameters: { server: 'meu-mcp' } })
    const denied = hooks('deny')
    await result.startTurn(snapshot({ message: '#elicit-configured', permissionMode: 'ask' }), denied.hook, new AbortController().signal)
    expect(await answers(root)).toEqual([{ action: 'accept' }, { action: 'decline' }])
    expect([...approved.events, ...denied.events].filter((event) => event.kind === 'diagnostic')).toHaveLength(0)
  })
  it('accepts without asking under a full-vm ceiling, and still declines a server nobody configured', async () => {
    const { result, root } = await adapter()
    const { hook, events } = hooks('deny')
    await result.startTurn(snapshot({ message: '#elicit-configured', permissionMode: 'full-vm' }), hook, new AbortController().signal)
    await result.startTurn(snapshot({ message: '#elicit-foreign', permissionMode: 'full-vm' }), hook, new AbortController().signal)
    expect(hook.requestApproval).not.toHaveBeenCalled()
    expect(await answers(root)).toEqual([{ action: 'accept' }, { action: 'decline' }])
    expect(events.filter((event) => event.kind === 'diagnostic')).toHaveLength(1)
  })
})

describe('runtime supervisor', () => {
  it('announces the capability, applies extensions between turns and hands the store to every provider', async () => {
    const root = await temporary()
    const factory = vi.fn(async () => new FixtureProvider(join(root, 'workspace')))
    const runtime = new RuntimeSupervisor({ state: join(root, 'state'), workspace: join(root, 'workspace'), controlPath: 'unused', version: '0.1.0', providerFactory: factory })
    await runtime.initialize()
    cleanups.push(() => runtime.close())
    const handlers = runtime.handlers()
    expect((await handlers['runtime.inspect']({})).capabilities).toContain(EXTENSIONS_CAPABILITY)
    expect(factory).toHaveBeenCalledWith(runtime.extensions)
    expect(await handlers['extensions.apply'](payload())).toEqual({ applied: 3 })
    expect(runtime.extensions.names).toEqual(['meu-mcp', 'remoto'])
    expect(await readFile(join(root, 'state/codex/skills/verificacao/SKILL.md'), 'utf8')).toContain('Verificação')
  })
})

async function walk(directory: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}
