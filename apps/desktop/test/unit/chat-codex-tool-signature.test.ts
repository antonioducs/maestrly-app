import { describe, expect, it } from 'vitest'
import { dynamicToolSignature, type DynamicToolSpec } from '../../src/main/chat/codex-subscription/runner'

function spec(name: string, description = 'desc', inputSchema: unknown = { type: 'object' }): DynamicToolSpec {
  return { type: 'function', name, description, inputSchema }
}

/**
 * The signature determines server-side Codex thread reuse (bindingCanResume). Only the tool list
 * should affect it: description/inputSchema metadata changes on MCP reconnection, and unnecessary
 * retirement forces an expensive full transcript reseed (Atlassian MCP incident, July 2026).
 */
describe('dynamicToolSignature (Codex binding stability)', () => {
  it('is stable when tools are reordered', () => {
    const a = dynamicToolSignature([spec('bash'), spec('read'), spec('atlassian_search')])
    const b = dynamicToolSignature([spec('atlassian_search'), spec('bash'), spec('read')])
    expect(a).toBe(b)
  })

  it('ignores cosmetic description/inputSchema changes so MCP reconnection does not invalidate the thread', () => {
    const before = dynamicToolSignature([spec('atlassian_search', 'Search Confluence', { type: 'object' })])
    const after = dynamicToolSignature([
      spec('atlassian_search', 'Search Confluence v2 (new wording)', {
        type: 'object',
        properties: { query: { type: 'string' } },
      }),
    ])
    expect(before).toBe(after)
  })

  it('changes when the tool list changes because thread/resume does not re-register dynamicTools', () => {
    const base = dynamicToolSignature([spec('bash'), spec('read')])
    expect(dynamicToolSignature([spec('bash')])).not.toBe(base)
    expect(dynamicToolSignature([spec('bash'), spec('read'), spec('write')])).not.toBe(base)
    expect(dynamicToolSignature([spec('bash'), spec('grep')])).not.toBe(base)
  })
})
