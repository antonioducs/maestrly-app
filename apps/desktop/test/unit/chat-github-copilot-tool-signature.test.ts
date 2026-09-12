import { describe, expect, it } from 'vitest'
import { gitHubCopilotToolSignature } from '../../src/main/chat/github-copilot/runner'

const tool = (name: string, description = 'desc', parameters: unknown = { type: 'object' }) => ({
  name,
  description,
  parameters,
})
const agent = (name: string, description = 'desc', prompt = 'p') => ({ name, description, prompt })

/**
 * Like Codex dynamicToolSignature, this signature determines server-side session reuse and should
 * depend only on the tool/agent lists. Metadata changes on every MCP reconnection; unnecessary
 * retirement forces a transcript reseed.
 */
describe('gitHubCopilotToolSignature (Copilot binding stability)', () => {
  it('is stable when tools and agents are reordered', () => {
    const a = gitHubCopilotToolSignature([tool('bash'), tool('read')], [agent('explore'), agent('general-purpose')])
    const b = gitHubCopilotToolSignature([tool('read'), tool('bash')], [agent('general-purpose'), agent('explore')])
    expect(a).toBe(b)
  })

  it('ignores cosmetic description/parameters/prompt changes so MCP reconnection does not invalidate the session', () => {
    const before = gitHubCopilotToolSignature(
      [tool('atlassian_search', 'Search Confluence', { type: 'object' })],
      [agent('explore', 'old wording', 'old prompt')]
    )
    const after = gitHubCopilotToolSignature(
      [tool('atlassian_search', 'Search Confluence v2', { type: 'object', properties: { q: { type: 'string' } } })],
      [agent('explore', 'new wording', 'new prompt')]
    )
    expect(before).toBe(after)
  })

  it('changes when the tool or agent list changes', () => {
    const base = gitHubCopilotToolSignature([tool('bash'), tool('read')], [agent('explore')])
    expect(gitHubCopilotToolSignature([tool('bash')], [agent('explore')])).not.toBe(base)
    expect(gitHubCopilotToolSignature([tool('bash'), tool('grep')], [agent('explore')])).not.toBe(base)
    expect(gitHubCopilotToolSignature([tool('bash'), tool('read')], [])).not.toBe(base)
    expect(gitHubCopilotToolSignature([tool('bash'), tool('read')], [agent('explore'), agent('worker')])).not.toBe(base)
  })
})
