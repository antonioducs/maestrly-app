import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAppSetting, setAppSetting } from '../../src/main/store'
import {
  MCP_CATALOG_KEY,
  mcpServerFingerprint,
  readMcpCatalog,
  removeMcpCatalog,
  writeMcpCatalog,
} from '../../src/main/chat/mcp-catalog'
import type { McpServer } from '../../src/main/chat/mcp-types'
import { addMcpServer, listMcpServers, removeMcpServer, updateMcpServer } from '../../src/main/chat/mcp'
import { closeDb, freshDb } from '../helpers/db'

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp_catalog_test',
    name: 'Catalog test',
    transport: 'http',
    enabled: true,
    url: 'https://mcp.example.test/v1',
    headers: { Authorization: 'Bearer top-secret', 'X-Tenant': 'one' },
    ...overrides,
  }
}

describe('external MCP catalog cache', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('round-trips declarations without persisting connection secrets or unknown fields', () => {
    const configured = server({ env: { TOKEN: 'environment-secret' } })

    writeMcpCatalog(configured, [
      {
        name: 'lookup',
        title: 'Lookup',
        description: 'Looks up a record.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true, openWorldHint: false, vendorSecret: 'do-not-cache' },
        ignored: 'not-part-of-the-catalog-contract',
      } as never,
    ])

    expect(readMcpCatalog(configured)).toEqual([
      {
        name: 'lookup',
        title: 'Lookup',
        description: 'Looks up a record.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
    ])
    const persisted = getAppSetting(MCP_CATALOG_KEY) ?? ''
    expect(persisted).not.toContain('top-secret')
    expect(persisted).not.toContain('environment-secret')
    expect(persisted).not.toContain('do-not-cache')
    expect(persisted).not.toContain('not-part-of-the-catalog-contract')
  })

  it('uses a deterministic fingerprint and treats connection changes as a cold catalog', () => {
    const configured = server()
    const reordered = server({ headers: { 'X-Tenant': 'one', Authorization: 'Bearer top-secret' } })
    expect(mcpServerFingerprint(configured)).toBe(mcpServerFingerprint(reordered))

    writeMcpCatalog(configured, [{ name: 'lookup' }])
    expect(readMcpCatalog(reordered)).toEqual([{ name: 'lookup' }])
    expect(readMcpCatalog(server({ url: 'https://other.example.test/v1' }))).toEqual([])
    expect(readMcpCatalog(server({ headers: { Authorization: 'Bearer rotated' } }))).toEqual([])
  })

  it('ignores malformed storage and invalid declarations', () => {
    setAppSetting(MCP_CATALOG_KEY, '{broken')
    expect(readMcpCatalog(server())).toEqual([])

    setAppSetting(
      MCP_CATALOG_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          mcp_catalog_test: {
            fingerprint: mcpServerFingerprint(server()),
            refreshedAt: 1,
            tools: [{ name: '' }, null, { name: 'ok', inputSchema: ['not-an-object'] }],
          },
        },
      })
    )
    expect(readMcpCatalog(server())).toEqual([{ name: 'ok' }])
  })

  it('removes only the requested server entry', () => {
    const first = server()
    const second = server({ id: 'mcp_second', name: 'Second', url: 'https://second.example.test/v1' })
    writeMcpCatalog(first, [{ name: 'first' }])
    writeMcpCatalog(second, [{ name: 'second' }])

    removeMcpCatalog(first.id)

    expect(readMcpCatalog(first)).toEqual([])
    expect(readMcpCatalog(second)).toEqual([{ name: 'second' }])
  })

  it('invalidates cache on connection edits/removal but retains it across display-name edits', () => {
    const configured = addMcpServer({
      name: 'Original',
      transport: 'http',
      url: 'https://one.example.test/mcp',
      headers: { Authorization: 'Bearer one' },
    })
    writeMcpCatalog(configured, [{ name: 'lookup' }])

    updateMcpServer(configured.id, { name: 'Renamed' })
    const renamed = listMcpServers().find((entry) => entry.id === configured.id)!
    expect(readMcpCatalog(renamed)).toEqual([{ name: 'lookup' }])

    updateMcpServer(configured.id, { headers: { Authorization: 'Bearer two' } })
    const rotated = listMcpServers().find((entry) => entry.id === configured.id)!
    expect(readMcpCatalog(rotated)).toEqual([])

    writeMcpCatalog(rotated, [{ name: 'lookup' }])
    removeMcpServer(configured.id)
    expect(readMcpCatalog(rotated)).toEqual([])
  })
})
