import { ArtifactHostError } from '@maestrly/artifact-host'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactsService } from '../../src/main/artifacts/service'
import type { MaestroWorkerScope } from '../../src/main/maestro-worker-scope'
import { registerArtifactTools } from '../../src/main/mcp/tools/artifacts'
import { RepositoryScopeError } from '../../src/main/repository-scope'
import { tFor } from '../../src/shared/i18n'

const id = 'A'.repeat(22)
const detail = {
  id,
  title: 'Landing',
  description: 'A page',
  currentVersion: 2,
  versions: [
    { number: 2, summary: 'Hero', createdAt: 2, entry: 'index.html', fileCount: 1, totalBytes: 3, createdBy: 'agent' },
    { number: 1, summary: '', createdAt: 1, entry: 'index.html', fileCount: 1, totalBytes: 3, createdBy: 'agent' },
  ],
}

function fakeService() {
  return {
    create: vi.fn(async () => ({ detail: { ...detail, currentVersion: 1 }, skipped: ['app.js.map'] })),
    update: vi.fn(async () => ({ detail, skipped: [] })),
    getForConversation: vi.fn(async () => detail),
    listFilesForConversation: vi.fn(async () => [
      { path: 'index.html', bytes: 3, contentType: 'text/html; charset=utf-8', text: true },
    ]),
    readTextForConversation: vi.fn(async () => ({ text: '<p>x</p>', truncated: false })),
    listForConversation: vi.fn(async () => [
      { ...detail, conversationId: 'c1', updatedAt: 5, versionCount: 2, ownerKind: 'local' },
    ]),
    openInConversation: vi.fn(async () => detail),
    getSettings: vi.fn(() => ({ hostEnabled: true, port: 4321, quotaGb: 2 })),
  }
}

let service: ReturnType<typeof fakeService>
let client: Client
let server: McpServer

async function connect(workerScope?: MaestroWorkerScope): Promise<void> {
  server = new McpServer({ name: 'app-tools', version: '1.0.0' })
  registerArtifactTools(
    { server, convId: 'c1', locale: 'en', t: tFor('en', 'mcp'), workerScope },
    () => service as unknown as ArtifactsService
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'artifact-tools-test', version: '1.0.0' })
  await server.connect(serverT)
  await client.connect(clientT)
}

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

beforeEach(async () => {
  service = fakeService()
  await connect()
})
afterEach(async () => {
  await client.close().catch(() => {})
  await server.close().catch(() => {})
})

describe('artifact tools', () => {
  it('publishes inline files as UTF-8 by default', async () => {
    const result = await call('artifact_create', {
      title: 'Landing',
      files: [
        { path: 'index.html', content: '<p>x</p>' },
        { path: 'logo.png', content: 'iVBORw==', encoding: 'base64' },
      ],
    })
    expect(result.isError).toBe(false)
    const [convId, input] = service.create.mock.calls[0] as unknown as [string, { files: { bytes: Uint8Array }[] }]
    expect(convId).toBe('c1')
    expect(input.files[0]!.bytes).toEqual(new TextEncoder().encode('<p>x</p>'))
    expect([...input.files[1]!.bytes]).toEqual([137, 80, 78, 71])
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      artifact: { id, title: 'Landing', version: 1 },
      skipped: ['app.js.map'],
    })
  })

  it('requires exactly one source of content', async () => {
    const both = await call('artifact_create', {
      title: 'X',
      files: [{ path: 'index.html', content: 'x' }],
      directory: 'dist',
    })
    const none = await call('artifact_create', { title: 'X' })
    expect(both.isError).toBe(true)
    expect(none.isError).toBe(true)
    expect(both.text).toContain('exactly one')
    expect(service.create).not.toHaveBeenCalled()
  })

  it('refuses invalid base64 and oversized inline content', async () => {
    const invalid = await call('artifact_create', {
      title: 'X',
      files: [{ path: 'logo.png', content: 'not base64!', encoding: 'base64' }],
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.text).toContain('base64')
    const huge = await call('artifact_create', {
      title: 'X',
      files: [{ path: 'index.html', content: 'x'.repeat(5 * 1024 * 1024 + 1) }],
    })
    expect(huge.isError).toBe(true)
    expect(huge.text).toContain('5 MiB')
    expect(service.create).not.toHaveBeenCalled()
  })

  it('updates with edits, folders, or file changes', async () => {
    await call('artifact_update', {
      id,
      baseVersion: 1,
      summary: 'Hero',
      edits: [{ path: 'index.html', oldText: 'a', newText: 'b' }],
    })
    await call('artifact_update', { id, baseVersion: 2, directory: 'dist' })
    await call('artifact_update', { id, baseVersion: 3, delete: ['old.css'] })
    const changes = service.update.mock.calls.map(
      (args) => (args as unknown as [string, { change: unknown }])[1].change
    )
    expect(changes).toEqual([
      { kind: 'edits', edits: [{ path: 'index.html', oldText: 'a', newText: 'b' }] },
      { kind: 'directory', directory: 'dist' },
      { kind: 'files', files: [], delete: ['old.css'] },
    ])
    const none = await call('artifact_update', { id, baseVersion: 1 })
    const mixed = await call('artifact_update', { id, baseVersion: 1, directory: 'dist', delete: ['a.css'] })
    expect(none.isError && mixed.isError).toBe(true)
    expect(service.update).toHaveBeenCalledTimes(3)
  })

  it('explains host errors to the agent', async () => {
    service.update.mockRejectedValueOnce(
      new ArtifactHostError('version_conflict', 'conflict', { currentVersion: 3 }) as never
    )
    const conflict = await call('artifact_update', { id, baseVersion: 1, directory: 'dist' })
    expect(conflict.isError).toBe(true)
    expect(conflict.text).toContain('Version 3')

    service.create.mockRejectedValueOnce(
      new ArtifactHostError('host_unavailable', 'off', { reason: 'disabled' }) as never
    )
    const disabled = await call('artifact_create', { title: 'X', directory: 'dist' })
    expect(disabled.text).toContain('Settings → Artifacts')

    service.create.mockRejectedValueOnce(
      new ArtifactHostError('host_unavailable', 'busy', { reason: 'port_in_use' }) as never
    )
    expect((await call('artifact_create', { title: 'X', directory: 'dist' })).text).toContain('Port 4321')

    service.create.mockRejectedValueOnce(new RepositoryScopeError('path_escape', 'Path is outside the files.') as never)
    const escape = await call('artifact_create', { title: 'X', directory: '../../etc' })
    expect(escape.isError).toBe(true)
    expect(escape.text).toContain('Path is outside the files.')

    service.create.mockRejectedValueOnce(new Error('secret internals') as never)
    const internal = await call('artifact_create', { title: 'X', directory: 'dist' })
    expect(internal.isError).toBe(true)
    expect(internal.text).not.toContain('secret internals')
  })

  it('reads an artifact and one of its files', async () => {
    const overview = JSON.parse((await call('artifact_get', { id })).text)
    expect(overview).toMatchObject({ id, title: 'Landing', currentVersion: 2, version: 2 })
    expect(overview.versions).toEqual([
      { number: 2, summary: 'Hero', createdAt: 2 },
      { number: 1, summary: '', createdAt: 1 },
    ])
    expect(service.listFilesForConversation).toHaveBeenCalledWith('c1', id, 2)

    const file = JSON.parse((await call('artifact_get', { id, path: 'index.html', version: 1 })).text)
    expect(file).toEqual({ path: 'index.html', version: 1, truncated: false, content: '<p>x</p>' })
    expect(service.readTextForConversation).toHaveBeenCalledWith('c1', id, 1, 'index.html')
  })

  it('lists within the requested scope', async () => {
    const listed = JSON.parse((await call('artifact_list', { scope: 'project' })).text)
    expect(service.listForConversation).toHaveBeenCalledWith('c1', 'project')
    expect(listed).toEqual({
      artifacts: [{ id, title: 'Landing', currentVersion: 2, conversationId: 'c1', updatedAt: 5 }],
    })
    await call('artifact_list', {})
    expect(service.listForConversation).toHaveBeenLastCalledWith('c1', 'conversation')
  })

  it('opens in the drawer, without taking focus from a delegated worker', async () => {
    const opened = await call('artifact_open', { id })
    expect(opened.text).toContain('Landing')
    expect(service.openInConversation).toHaveBeenCalledWith('c1', id, undefined, { checkScope: true, activate: true })
    await client.close()
    await server.close()
    await connect({ id: 'worker' } as MaestroWorkerScope)
    await call('artifact_open', { id, version: 1 })
    expect(service.openInConversation).toHaveBeenLastCalledWith('c1', id, 1, { checkScope: true, activate: false })
  })
})
