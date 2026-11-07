import { describe, expect, it } from 'vitest'
import {
  MCP_SCHEMA_HINT_MAX_CHARS,
  clampInteger,
  rankMcpTools,
  renderMcpDirectory,
  schemaHint,
  searchTokens,
  takeWithinChars,
} from '../../src/main/chat/mcp-discovery'

const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}_${index}`)

describe('MCP tool directory', () => {
  it('lists every tool of a small server and counts what a large one does not fit', () => {
    const text = renderMcpDirectory(
      [
        { label: 'small', id: 'srv_small', tools: ['a', 'b', 'c'] },
        { label: 'huge', id: 'srv_huge', tools: names('search_resource_with_a_long_name', 500) },
      ],
      3_000
    )
    expect(text).toContain('- small (srv_small), 3 tools: a, b, c')
    const huge = text.split('\n').find((line) => line.startsWith('- huge'))!
    expect(huge).toMatch(/- huge \(srv_huge\), 500 tools: search_resource_with_a_long_name_0,/)
    expect(huge).toMatch(/… \+\d+ more \(search by keyword\)$/)
    expect(text.length).toBeLessThanOrEqual(3_000)
  })

  it('keeps one large server from hiding another', () => {
    const text = renderMcpDirectory(
      [
        { label: 'first', id: 'srv_first', tools: names('alpha_tool', 400) },
        { label: 'second', id: 'srv_second', tools: names('beta_tool', 400) },
      ],
      4_000
    )
    expect(text).toContain('alpha_tool_0')
    expect(text).toContain('beta_tool_0')
    expect(text.length).toBeLessThanOrEqual(4_000)
  })

  it('points a server that was never listed at mcp_search', () => {
    const text = renderMcpDirectory([
      { label: 'cold', id: 'srv_cold', tools: null },
      { label: 'empty', id: 'srv_empty', tools: [] },
    ])
    expect(text).toContain('- cold (srv_cold): tools not listed yet; call mcp_search with server "cold".')
    expect(text).toContain('- empty (srv_empty): tools not listed yet')
  })

  it('stays inside its budget for any number of servers', () => {
    const servers = Array.from({ length: 30 }, (_, index) => ({
      label: `server-${index}`,
      id: `srv_${index}`,
      tools: names(`tool_${index}`, 60),
    }))
    expect(renderMcpDirectory(servers, 9_000).length).toBeLessThanOrEqual(9_000)
  })
})

describe('MCP tool search', () => {
  const tools = [
    { name: 'get_datadog_metric', description: 'Reads one Datadog metric series.' },
    { name: 'upsert_datadog_dashboard', description: 'Creates or updates a dashboard.' },
    { name: 'createConfluencePage', description: 'Creates a page in a Confluence space.' },
    { name: 'search_sonar_issues', title: 'Sonar issues', description: 'Finds issues in SonarQube projects.' },
  ]

  it('splits names at punctuation, underscores and camelCase', () => {
    expect(searchTokens('createConfluence-Page_v2')).toEqual(['create', 'confluence', 'page', 'v2'])
  })

  it('ranks a name match above a description match and needs a word to match', () => {
    expect(rankMcpTools(tools, 'datadog metric').map((tool) => tool.name)[0]).toBe('get_datadog_metric')
    expect(rankMcpTools(tools, 'confluence page').map((tool) => tool.name)[0]).toBe('createConfluencePage')
    expect(rankMcpTools(tools, 'sonarqube').map((tool) => tool.name)).toEqual(['search_sonar_issues'])
    expect(rankMcpTools(tools, 'kubernetes')).toEqual([])
    expect(rankMcpTools(tools, '   ')).toEqual([])
  })

  it('puts a tool that matches every word before one that matches some', () => {
    const ranked = rankMcpTools(tools, 'datadog dashboard')
    expect(ranked[0].name).toBe('upsert_datadog_dashboard')
    expect(ranked.map((tool) => tool.name)).toContain('get_datadog_metric')
  })

  it('ranks an exact tool name first', () => {
    expect(rankMcpTools(tools, 'search_sonar_issues')[0].name).toBe('search_sonar_issues')
  })
})

describe('MCP result limits', () => {
  it('clamps a number the model sent and falls back on anything else', () => {
    expect(clampInteger(5, 8, 1, 25)).toBe(5)
    expect(clampInteger(900, 8, 1, 25)).toBe(25)
    expect(clampInteger(-3, 8, 1, 25)).toBe(1)
    expect(clampInteger('7', 8, 1, 25)).toBe(8)
    expect(clampInteger(Number.NaN, 8, 1, 25)).toBe(8)
    expect(clampInteger(3.9, 8, 1, 25)).toBe(3)
  })

  it('takes leading items within a size and always keeps the first', () => {
    const sizeOf = (value: string) => value.length
    expect(takeWithinChars(['aaaa', 'bbbb', 'cccc'], sizeOf, 9)).toEqual({ taken: ['aaaa', 'bbbb'], omitted: 1 })
    expect(takeWithinChars(['aaaaaaaa', 'b'], sizeOf, 3)).toEqual({ taken: ['aaaaaaaa'], omitted: 1 })
    expect(takeWithinChars([], sizeOf, 3)).toEqual({ taken: [], omitted: 0 })
  })

  it('clips the schema repeated in an error', () => {
    expect(schemaHint({ inputSchema: { type: 'object', properties: { a: { type: 'string' } } } })).toContain('"a"')
    expect(schemaHint({})).toBe('{"type":"object","properties":{}}')
    const big = { inputSchema: { description: 'x'.repeat(MCP_SCHEMA_HINT_MAX_CHARS * 2) } }
    expect(schemaHint(big).length).toBe(MCP_SCHEMA_HINT_MAX_CHARS + 1)
  })
})
