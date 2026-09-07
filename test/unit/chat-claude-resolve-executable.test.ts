import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  bundledClaudeCandidate,
  clearClaudeCache,
  resolveClaude,
} from '../../src/main/chat/claude-agent-sdk/resolve-claude'

describe('Claude Agent SDK executable resolution', () => {
  it('prefers the native CLI paired with the installed SDK', () => {
    const bundled = bundledClaudeCandidate()
    expect(bundled).toMatch(/@anthropic-ai[\\/]claude-agent-sdk-/)
    clearClaudeCache()
    expect(resolveClaude()).toBe(bundled)
    expect(execFileSync(resolveClaude(), ['--version'], { encoding: 'utf8' }).trim()).toBe('2.1.263 (Claude Code)')
  })
})
