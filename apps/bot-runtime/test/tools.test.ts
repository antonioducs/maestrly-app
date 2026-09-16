import { randomUUID } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { Journal } from '../src/control/journal.js'
import { FileService, digest } from '../src/files/service.js'
import { DesktopSession } from '../src/desktop/session.js'
import { BrowserSession } from '../src/tools/browser.js'
import { systemExec } from '../src/tools/system.js'
import { runInWorkspace } from '../src/tools/shell.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ProcessRegistry } from '../src/turns/leases.js'
import type { ProviderEvent, TurnHooks } from '../src/providers/provider.js'
import { temporary, snapshot } from './helpers.js'

async function fixture(decision: 'approve' | 'deny' = 'deny') {
  const state = await temporary()
  const files = new FileService(join(state, 'workspace'))
  await files.init()
  const journal = new Journal(state)
  const events: ProviderEvent[] = []
  const hooks: TurnHooks = {
    emit: (event) => {
      events.push(event)
    },
    requestApproval: vi.fn(async () => decision),
    askQuestion: async () => '',
  }
  const turn = snapshot()
  const browser = new BrowserSession(state, files, new DesktopSession(), () => registry.invalidate())
  const registry = new ToolRegistry(
    journal,
    files,
    browser,
    () => ({
      snapshot: turn,
      signal: new AbortController().signal,
      processes: new ProcessRegistry(),
      hooks,
    }),
    () => turn.permissionMode
  )
  const call = (name: string, args: unknown = {}, requestId = randomUUID()) =>
    registry.call(turn.turnId, requestId, name, args)
  return { state, files, journal, events, hooks, turn, browser, registry, call }
}
test('unknown tools are rejected and every call is journaled', async () => {
  const f = await fixture()
  expect(await f.call('nope')).toMatchObject({ isError: true })
  expect(f.events.map((event) => event.kind)).toEqual(['tool.started', 'tool.finished'])
  const journal = await readFile(f.journal.path, 'utf8')
  expect(journal).toContain('action.intent')
  expect(journal).toContain('action.result')
})
test.each(['ask', 'full-vm'] as const)('%s rejects elevated execution even with approval available', async (mode) => {
  const f = await fixture('approve')
  f.turn.permissionMode = mode
  const marker = join(f.state, 'executed')
  const helper = join(f.state, 'helper.sh')
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  vi.stubEnv('MAESTRLY_BOT_HELPER', helper)
  try {
    const result = await f.call('system_exec', { command: ['touch', marker], reason: 'test' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('ELEVATION_UNSUPPORTED')
    expect(f.hooks.requestApproval).not.toHaveBeenCalled()
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.registry.list().find((tool) => tool.name === 'system_exec')?.description).toContain('indisponível')
  } finally {
    vi.unstubAllEnvs()
  }
})
test('the model reads what each tool is for; people keep the short activity summary', async () => {
  const f = await fixture()
  const tools = new Map(f.registry.list().map((tool) => [tool.name, tool.description]))
  expect(tools.get('browser_navigate')).toMatch(/Chromium/)
  expect(tools.get('browser_navigate')).toMatch(/Chrome/)
  expect(tools.get('browser_navigate')).toMatch(/Não procure nem instale outro navegador/)
  expect(tools.get('computer_screenshot')).toMatch(/área de trabalho inteira/)
  for (const [name, description] of tools) expect(description.length, name).toBeGreaterThan(20)
  // Activity shown to people is unchanged.
  vi.spyOn(f.browser, 'navigate').mockResolvedValue({ url: 'https://example.com/' })
  await f.call('browser_navigate', { url: 'https://example.com/' })
  expect(f.events.find((event) => event.kind === 'tool.started')?.summary).toBe('Abrindo a página https://example.com/')
})
test('observations expire after an action and duplicate request ids never repeat clicks', async () => {
  const f = await fixture()
  vi.spyOn(f.browser, 'snapshot').mockResolvedValue({
    title: 'fixture',
    url: 'file:///fixture',
    text: '',
    interactive: [],
  })
  const click = vi.spyOn(f.browser, 'click').mockResolvedValue()
  const stale = await f.call('browser_click', { ref: 1, observationId: randomUUID() })
  expect(JSON.stringify(stale)).toContain('STALE_OBSERVATION')
  const observation = await f.call('browser_snapshot')
  const { observationId } = JSON.parse((observation.content[0] as { text: string }).text)
  const request = randomUUID()
  await f.call('browser_click', { ref: 1, observationId }, request)
  await f.call('browser_click', { ref: 1, observationId }, request)
  expect(click).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(await f.call('browser_click', { ref: 1, observationId }))).toContain('STALE_OBSERVATION')
})
test('memory proposals emit events and files are delivered with their digest', async () => {
  const f = await fixture()
  await f.call('memory_propose', { content: 'Remember this' })
  expect(f.events).toContainEqual(
    expect.objectContaining({ kind: 'memory.proposed', detail: { content: 'Remember this' } })
  )
  await writeFile(join(f.files.workspace, 'report.txt'), 'report')
  await f.call('files_deliver', { path: 'report.txt', title: 'Report' })
  expect(f.events).toContainEqual(
    expect.objectContaining({
      kind: 'file.produced',
      detail: expect.objectContaining({ path: 'report.txt', digest: digest('report') }),
    })
  )
})
test('missing browser binaries return a clear unavailable result', async () => {
  const f = await fixture()
  vi.stubEnv('MAESTRLY_CHROMIUM_BINARY', '/nonexistent/maestrly-chromium')
  try {
    expect(JSON.stringify(await f.call('browser_snapshot'))).toContain('BROWSER_UNAVAILABLE')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('journaled requests are not replayed after a registry restart', async () => {
  const f = await fixture()
  const requestId = randomUUID()
  await f.call('memory_propose', { content: 'Once' }, requestId)
  const restarted = new ToolRegistry(
    new Journal(f.state),
    f.files,
    f.browser,
    () => ({
      snapshot: f.turn,
      signal: new AbortController().signal,
      processes: new ProcessRegistry(),
      hooks: f.hooks,
    }),
    () => 'ask'
  )
  const result = await restarted.call(f.turn.turnId, requestId, 'memory_propose', { content: 'Once' })
  expect(JSON.stringify(result)).toContain('REPLY_LOST')
  expect(f.events.filter((event) => event.kind === 'memory.proposed')).toHaveLength(1)
})

test('direct system execution fails closed while ordinary shell execution works', async () => {
  const f = await fixture()
  const context = { workspace: f.files.workspace, turnId: f.turn.turnId, processes: new ProcessRegistry() }
  expect(() => systemExec(['/bin/sh', '-c', 'exit 0'], context)).toThrow('Elevated execution is unavailable')
  const result = await runInWorkspace(['/bin/sh', '-c', 'printf ordinary > ordinary.txt; cat ordinary.txt'], context)
  expect(result).toMatchObject({ exitCode: 0, output: 'ordinary' })
  expect(await readFile(join(f.files.workspace, 'ordinary.txt'), 'utf8')).toBe('ordinary')
})
