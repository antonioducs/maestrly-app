import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPluginPackage } from '../../src/main/plugins/formats/detect'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import type { PluginPackage } from '../../src/main/plugins/types'
import { writeTree } from '../helpers/plugin-fixtures'

const fixtures = fileURLToPath(new URL('../fixtures/plugins/', import.meta.url))
const AP = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

async function load(name: string, opts?: Parameters<typeof loadPluginPackage>[1]): Promise<PluginPackage> {
  const result = await loadPluginPackage(await fsPackageTree(path.join(fixtures, name)), opts)
  if (!result.ok) throw new Error(`${name}: ${result.code} ${result.detail}`)
  return result.pkg
}
const kinds = (pkg: PluginPackage) => pkg.components.map((c) => `${c.kind}:${c.status}`)

describe('Agent Plugins format', () => {
  it('loads skills, MCP servers and extension directories', async () => {
    const pkg = await load('agent-basic')
    expect(pkg).toMatchObject({
      name: 'agent-basic',
      format: 'agent-plugins',
      version: '1.0.0',
      publisher: 'Fixture Author',
    })
    expect(pkg.skills.map((s) => s.name)).toEqual(['summarize'])
    expect(pkg.mcpServers).toEqual([expect.objectContaining({ key: 'local', command: './bin/server' })])
    expect(pkg.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'extension', name: 'com.example.client', status: 'not-run' }),
      ])
    )
    expect(pkg.license).toEqual({ spdx: 'MIT', file: 'LICENSE' })
  })

  it('reads OpenAI interface metadata, apps and hooks from the extension', async () => {
    const pkg = await load('agent-with-openai-ext')
    expect(pkg).toMatchObject({ displayName: 'Agent OpenAI', publisher: 'Fixture Labs', capabilities: ['Read'] })
    expect(kinds(pkg)).toEqual(expect.arrayContaining(['app-connector:unavailable', 'skill:supported']))
  })

  it('rejects unsupported schema versions', async () => {
    const root = await writeTree({
      'plugin.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json',
        name: 'x',
      }),
    })
    expect(await loadPluginPackage(await fsPackageTree(root))).toMatchObject({ ok: false, code: 'schema-unsupported' })
  })

  it('reports and ignores unknown manifest fields', async () => {
    const root = await writeTree({ 'plugin.json': JSON.stringify({ $schema: AP, name: 'loose', unknown: 1 }) })
    const result = await loadPluginPackage(await fsPackageTree(root))
    expect(result.ok && result.pkg.issues).toEqual([{ code: 'unknown-field', detail: 'unknown' }])
  })

  it('rejects invalid names and author fields', async () => {
    const bad = await writeTree({ 'plugin.json': JSON.stringify({ $schema: AP, name: 'Bad--Name' }) })
    expect(await loadPluginPackage(await fsPackageTree(bad))).toMatchObject({ ok: false, code: 'manifest-invalid' })
    const author = await writeTree({ 'plugin.json': JSON.stringify({ $schema: AP, name: 'ok', author: { age: 3 } }) })
    expect(await loadPluginPackage(await fsPackageTree(author))).toMatchObject({ ok: false, code: 'manifest-invalid' })
  })
})

describe('Codex format', () => {
  it('inventories every component', async () => {
    const pkg = await load('codex-full')
    expect(pkg.format).toBe('codex')
    expect(kinds(pkg)).toEqual(
      expect.arrayContaining(['app-connector:unavailable', 'command:adapted', 'agent:adapted', 'skill:supported'])
    )
    // Its hooks of the events Maestrly runs are adapted; others, and the root hooks.json Codex ignores, are not.
    expect(
      pkg.components
        .filter((c) => c.kind === 'hooks')
        .map((c) => `${c.name}:${c.status}`)
        .sort()
    ).toEqual(['Notification:not-run', 'hooks.json:not-run', 'hooks/hooks.json:adapted'])
    expect(pkg.hooks).toEqual([
      expect.objectContaining({ event: 'PreToolUse', matcher: 'Bash', command: './hooks/guard.sh' }),
    ])
    expect(pkg.components.filter((c) => c.kind === 'agent').map((c) => c.name)).toEqual(['agents/reviewer.md'])
    expect(pkg).toMatchObject({
      displayName: 'Codex Full',
      description: 'Codex fixture with every component',
      capabilities: ['Read', 'Write'],
      logoPath: 'assets/logo.png',
      category: 'Coding',
      links: { privacy: 'https://example.com/privacy' },
    })
    expect(pkg.skills.map((s) => `${s.kind}:${s.name}`)).toEqual(['skill:deploy', 'command:review'])
    expect(pkg.mcpServers.map((s) => s.key)).toEqual(['local', 'remote'])
  })

  it('never reads skills outside the plugin root', async () => {
    const parent = await writeTree({ 'outside/x/SKILL.md': '---\ndescription: leak\n---\nLeak.' })
    await writeTree(
      { '.codex-plugin/plugin.json': JSON.stringify({ name: 'escape', skills: '../outside' }) },
      path.join(parent, 'plugin')
    )
    const result = await loadPluginPackage(await fsPackageTree(path.join(parent, 'plugin')))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pkg.skills).toEqual([])
    expect(result.pkg.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'path-unsafe' })]))
  })

  it('lists an apps-only plugin with its connector', async () => {
    const pkg = await load('codex-apps-only')
    expect(pkg.skills).toEqual([])
    expect(kinds(pkg)).toEqual(['app-connector:unavailable'])
  })

  it('reads app connectors by name, ignores an empty map, and flags an unreadable file', async () => {
    const base = {
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'apps' }),
      'skills/a/SKILL.md': '---\ndescription: A\n---\nA',
    }
    const loadTree = async (app: string) => {
      const result = await loadPluginPackage(await fsPackageTree(await writeTree({ ...base, '.app.json': app })))
      if (!result.ok) throw new Error(result.detail)
      return result.pkg.components.filter((c) => c.kind === 'app-connector')
    }
    expect(await loadTree(JSON.stringify({ apps: {} }))).toEqual([])
    expect(await loadTree(JSON.stringify({ apps: { x: { id: 'asdk_app_x' } } }))).toEqual([
      expect.objectContaining({ name: 'x', status: 'unavailable', reason: 'app-connector' }),
    ])
    expect(await loadTree('{ not json')).toEqual([
      expect.objectContaining({ name: '.app.json', status: 'invalid', reason: 'entry-invalid' }),
    ])
  })

  it('lists symlinks and submodule-like links without following them', async () => {
    const root = await writeTree({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'links' }),
      'skills/a/SKILL.md': '---\ndescription: A\n---\nA',
      'skills/a/link': { symlink: '/etc/hosts' },
    })
    const pkg = (await loadPluginPackage(await fsPackageTree(root))) as { ok: true; pkg: PluginPackage }
    expect(pkg.pkg.components).toEqual(
      expect.arrayContaining([{ kind: 'symlink', name: 'skills/a/link', status: 'not-run', reason: 'symlink-skipped' }])
    )
  })
})

describe('Claude format', () => {
  it('loads user config, command maps, MCP merges and unsupported components', async () => {
    const pkg = await load('claude-full')
    expect(pkg).toMatchObject({ name: 'claude-full', format: 'claude', displayName: 'Claude Full', version: '1.2.0' })
    expect(pkg.inputs.map((i) => i.id).sort()).toEqual(['config:api_token', 'config:region'])
    expect(kinds(pkg)).toEqual(
      expect.arrayContaining(['lsp:not-run', 'bin:not-run', 'output-style:not-run', 'agent:adapted'])
    )
    const commands = pkg.skills.filter((s) => s.kind === 'command')
    expect(commands).toEqual([
      {
        name: 'status',
        dirPath: 'extra/status.md',
        description: 'Show the status',
        kind: 'command',
        hasScripts: false,
      },
      {
        name: 'about',
        dirPath: '',
        description: 'Describe the plugin',
        kind: 'command',
        hasScripts: false,
        inlineBody: 'Explain what this plugin provides.',
      },
    ])
    expect(pkg.components.filter((c) => c.kind === 'command').every((c) => c.status === 'adapted')).toBe(true)
    expect(pkg.mcpServers.map((s) => s.key).sort()).toEqual(['api', 'remote'])
    expect(pkg.mcpServers.find((s) => s.key === 'api')).toMatchObject({
      command: './server',
      env: { TOKEN: '${input:config:api_token}' },
    })
  })

  it('uses a marketplace entry as the manifest', async () => {
    const pkg = await load('claude-no-manifest', {
      claudeEntry: { strict: true, fields: { name: 'entry-name', description: 'From the entry' } },
    })
    expect(pkg).toMatchObject({ name: 'entry-name', description: 'From the entry' })
    expect(pkg.skills.map((s) => `${s.kind}:${s.name}`)).toEqual(['skill:x', 'command:go'])
  })

  it('refuses conflicting manifests when the entry is not strict', async () => {
    const result = await loadPluginPackage(await fsPackageTree(path.join(fixtures, 'claude-full')), {
      claudeEntry: { strict: false, fields: { commands: './other' } },
    })
    expect(result).toMatchObject({ ok: false, code: 'manifest-invalid' })
  })

  it('reports a missing manifest', async () => {
    expect(await loadPluginPackage(await fsPackageTree(path.join(fixtures, 'claude-no-manifest')))).toMatchObject({
      ok: false,
      code: 'no-manifest',
    })
  })

  it('applies marketplace display overrides', async () => {
    const pkg = await load('codex-full', { displayOverrides: { displayName: 'From the marketplace' } })
    expect(pkg.displayName).toBe('From the marketplace')
  })
})
