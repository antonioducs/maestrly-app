import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessFor } from '../../src/main/chat/harness/execution'
import { buildMaestrlyBasePrompt } from '../../src/main/chat/harness/host-contracts'
import { botTaskPolicyPrompt, parallelTasksPolicy, setBotTaskPolicy } from '../../src/main/fleet/instance/task-policy'

afterEach(() => {
  setBotTaskPolicy('c1', null)
  vi.unstubAllEnvs()
})

describe('bot task policy', () => {
  it('is per conversation and only in bot mode', () => {
    setBotTaskPolicy('c1', () => parallelTasksPolicy(3))
    expect(botTaskPolicyPrompt('c1')).toBe('')
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    expect(botTaskPolicyPrompt('c1')).toContain('at most 3 run at once')
    expect(botTaskPolicyPrompt('c2')).toBe('')
    expect(botTaskPolicyPrompt(undefined)).toBe('')
  })

  it('limits computer and browser tools to one parallel task', () => {
    expect(parallelTasksPolicy(4)).toContain('let at most one of them use computer_* or browser_* tools')
  })

  it("reaches a standalone conversation's prompt by its id, never another conversation's", () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    setBotTaskPolicy('c1', () => parallelTasksPolicy(2))
    const input = {
      harness: harnessFor('anthropic', 'generic-model'),
      cwd: '/bot/chat',
      scope: 'standalone' as const,
      appToolsEnabled: true,
      mode: 'agent' as const,
      hasNotesTab: false,
    }
    expect(buildMaestrlyBasePrompt({ ...input, conversationId: 'c1' })).toContain('# Tasks')
    expect(buildMaestrlyBasePrompt(input)).not.toContain('# Tasks')
    expect(buildMaestrlyBasePrompt({ ...input, conversationId: 'c2' })).not.toContain('# Tasks')
  })
})
