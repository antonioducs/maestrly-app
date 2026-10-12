import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveChatGptWebCapabilities } from '../../src/main/chat/chatgpt-web/capability-policy'
import { createChatGptWebMcpGateway } from '../../src/main/chat/chatgpt-web/mcp-gateway'
import {
  addMcpServer,
  allRuntimeMcpServerIds,
  buildMcpTools,
  listMcpServers,
  listRuntimeMcpServers,
  removeMcpServer,
  updateMcpServer,
  type McpConnection,
  type McpServer,
} from '../../src/main/chat/mcp'
import { writeMcpCatalog } from '../../src/main/chat/mcp-catalog'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { type PluginLayout, pluginKeyHash, pluginLayout } from '../../src/main/plugins/layout'
import { listInstalled, writeInstalled, writePluginSecrets } from '../../src/main/plugins/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { codexDemoPlugin, installFixturePlugin } from '../helpers/plugin-install'

const secrets = vi.hoisted(() => ({ values: new Map<string, string>() }))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => true,
  secureGet: (key: string) => secrets.values.get(key) ?? null,
  secureSet: (key: string, value: string) => {
    secrets.values.set(key, value)
    return true
  },
  secureRemove: (key: string) => secrets.values.delete(key),
}))

let layout: PluginLayout
const gate = async () => {}

const stdioPlugin = (name: string) =>
  codexDemoPlugin(
    name,
    { 'mcp/server.mjs': 'process.exit(0)\n' },
    {
      local: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/mcp/server.mjs', '--data', '${PLUGIN_DATA}/state'],
        cwd: '.',
        env_vars: ['API_TOKEN'],
        enabled_tools: ['echo', 'search'],
      },
    }
  )

beforeEach(() => {
  freshDb()
  secrets.values.clear()
  layout = pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-mcp-layout-')))
  setAppPluginLayoutForTests(layout)
})
afterEach(() => {
  setAppPluginLayoutForTests(null)
  closeDb()
})

describe('plugin MCP servers at runtime', () => {
  it('expands a consented stdio server for the conversation', async () => {
    const w1 = makeWorkspace()
    const p1 = makeConversation(w1.id)
    const record = await installFixturePlugin(layout, {
      name: 'demo',
      files: stdioPlugin('demo'),
      stdio: ['local'],
      inputs: { 'env:local:API_TOKEN': 'synthetic-token' },
    })
    const root = layout.packageDir(pluginKeyHash('demo@fixtures'), record.dirName)
    const data = layout.data(pluginKeyHash('demo@fixtures'))
    const [server] = listRuntimeMcpServers({ conversationId: p1.id })
    expect(server).toMatchObject({
      id: record.servers.local.id,
      name: 'demo-local',
      transport: 'stdio',
      enabled: true,
      command: 'node',
      cwd: root,
      args: [`${root}/mcp/server.mjs`, '--data', `${data}/state`],
      origin: { kind: 'plugin', pluginKey: 'demo@fixtures', pluginName: 'demo plugin', serverKey: 'local' },
      toolFilter: { allow: ['echo', 'search'] },
    })
    expect(server.env).toMatchObject({ PLUGIN_ROOT: root, PLUGIN_DATA: data, API_TOKEN: 'synthetic-token' })
    expect(server.unavailable).toBeUndefined()
    expect(listMcpServers()).toEqual([])
  })

  it('keeps an unconsented stdio server disabled and drops consent when the launch line changes', async () => {
    const conversation = makeStandaloneConversation()
    await installFixturePlugin(layout, { name: 'demo', files: stdioPlugin('demo'), stdio: [] })
    expect(listRuntimeMcpServers({ conversationId: conversation.id })[0].enabled).toBe(false)
    writeInstalled((all) => {
      all['demo@fixtures'].consent.stdio.local = 'stale-digest'
      all['demo@fixtures'].servers.local.enabled = true
    })
    expect(listRuntimeMcpServers({ conversationId: conversation.id })[0].enabled).toBe(false)
  })

  it('scopes project plugins and lists inactive ones only on request', async () => {
    const w1 = makeWorkspace()
    const w2 = makeWorkspace()
    const p1 = makeConversation(w1.id)
    const p2 = makeConversation(w2.id)
    await installFixturePlugin(layout, {
      name: 'scoped',
      files: codexDemoPlugin('scoped', {}, { api: { url: 'https://api.example.com/mcp' } }),
      scope: { kind: 'projects', workspaceIds: [w1.id] },
    })
    expect(listRuntimeMcpServers({ conversationId: p1.id }).map((s) => s.name)).toEqual(['scoped-api'])
    expect(listRuntimeMcpServers({ conversationId: p2.id })).toEqual([])
    expect(listRuntimeMcpServers({ conversationId: p2.id, includeInactivePlugins: true })[0].enabled).toBe(false)
    expect(listRuntimeMcpServers({ conversationId: null })).toEqual([])
    expect(allRuntimeMcpServerIds()).toEqual([listInstalled()['scoped@fixtures'].servers.api.id])
  })

  it('marks a server unavailable while a required input is missing', async () => {
    const conversation = makeStandaloneConversation()
    await installFixturePlugin(layout, {
      name: 'tok',
      files: codexDemoPlugin(
        'tok',
        {},
        {
          tok: { url: 'https://api.example.com/mcp', bearer_token_env_var: 'EXAMPLE_TOKEN' },
        }
      ),
    })
    expect(listRuntimeMcpServers({ conversationId: conversation.id })[0]).toMatchObject({ unavailable: true })
    writePluginSecrets('tok@fixtures', { 'header:tok:Authorization': 'synthetic' })
    const [server] = listRuntimeMcpServers({ conversationId: conversation.id })
    expect(server.unavailable).toBeUndefined()
    expect(server.headers).toEqual({ Authorization: 'Bearer synthetic' })
  })

  it('exposes cached plugin tools to providers and avoids name collisions', async () => {
    const conversation = makeStandaloneConversation()
    const user = addMcpServer({ name: 'github', transport: 'http', url: 'https://user.example.com/mcp' })
    const record = await installFixturePlugin(layout, {
      name: 'github',
      files: codexDemoPlugin('github', {}, { github: { url: 'https://plugin.example.com/mcp' } }),
    })
    const pluginServer = listRuntimeMcpServers({ conversationId: conversation.id }).find((s) => s.origin)!
    expect(pluginServer.id).toBe(record.servers.github.id)
    writeMcpCatalog(user, [{ name: 'search', description: 'User search', inputSchema: { type: 'object' } }])
    writeMcpCatalog(pluginServer, [
      { name: 'search', description: 'Plugin search', inputSchema: { type: 'object' } },
      { name: 'other', description: 'Another', inputSchema: { type: 'object' } },
    ])
    const { tools } = await buildMcpTools({
      conversationId: conversation.id,
      mode: 'agent',
      gate,
      signal: new AbortController().signal,
    })
    const names = Object.keys(tools).filter((name) => name !== 'mcp_search' && name !== 'mcp_call')
    expect(names).toContain('github__search')
    expect(names).toContain('github__other')
    const hashed = names.filter((name) => name.startsWith('ext_mcp__github__search_'))
    expect(hashed).toHaveLength(1)
    expect(names).toHaveLength(3)
    // A conversation-level toggle still switches the plugin server off.
    const off = await buildMcpTools({
      conversationId: conversation.id,
      mode: 'agent',
      gate,
      signal: new AbortController().signal,
      disabledIds: new Set([pluginServer.id]),
    })
    expect(Object.keys(off.tools)).toEqual(['github__search', 'mcp_search', 'mcp_call'])
  })

  it('applies the plugin tool filter to cached tools', async () => {
    const conversation = makeStandaloneConversation()
    await installFixturePlugin(layout, { name: 'demo', files: stdioPlugin('demo'), stdio: ['local'] })
    const server = listRuntimeMcpServers({ conversationId: conversation.id })[0]
    writeMcpCatalog(server, [
      { name: 'echo', inputSchema: { type: 'object' } },
      { name: 'dangerous', inputSchema: { type: 'object' } },
    ])
    const { tools } = await buildMcpTools({
      conversationId: conversation.id,
      mode: 'agent',
      gate,
      signal: new AbortController().signal,
    })
    expect(Object.keys(tools)).toEqual(['demo_local__echo', 'mcp_search', 'mcp_call'])
  })

  it('refuses to edit or remove plugin servers through the MCP settings', async () => {
    const record = await installFixturePlugin(layout, {
      name: 'demo',
      files: codexDemoPlugin('demo', {}, { api: { url: 'https://api.example.com/mcp' } }),
    })
    expect(() => updateMcpServer(record.servers.api.id, { enabled: false })).toThrow('managed-by-plugin')
    expect(() => removeMcpServer(record.servers.api.id)).toThrow('managed-by-plugin')
  })

  it('reaches ChatGPT web with the default read scope', async () => {
    const conversation = makeStandaloneConversation()
    await installFixturePlugin(layout, {
      name: 'demo',
      files: codexDemoPlugin('demo', {}, { api: { url: 'https://api.example.com/mcp' } }),
    })
    const servers = listRuntimeMcpServers({ conversationId: conversation.id })
    const capabilities = resolveChatGptWebCapabilities(undefined, servers, 'standalone')
    expect(capabilities.mcp[servers[0].id]).toBe('read')
    const gateway = createChatGptWebMcpGateway({
      servers,
      scopes: capabilities.mcp,
      connect: async (server: McpServer): Promise<McpConnection> => ({
        listTools: async () => [{ name: 'lookup', annotations: { readOnlyHint: true } }],
        callTool: async () => ({ content: [{ type: 'text', text: server.id }] }),
        close: async () => {},
      }),
    })
    const found = await gateway.searchTools({ limit: 20 })
    expect(found.tools.map((tool) => [tool.serverId, tool.toolName, tool.access])).toEqual([
      [servers[0].id, 'lookup', 'read'],
    ])
  })
})
