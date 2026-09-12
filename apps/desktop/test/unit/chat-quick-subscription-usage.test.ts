import { describe, expect, it } from 'vitest'
import { connectedQuickUsageTargets } from '../../src/renderer/components/chat/quick-subscription-usage'
import type { ChatProviderInfo } from '../../src/shared/chat'

function provider(overrides: Partial<ChatProviderInfo> & Pick<ChatProviderInfo, 'id' | 'name'>): ChatProviderInfo {
  return {
    baseURL: 'test://provider',
    apiKeyPresent: false,
    ...overrides,
  }
}

describe('quick subscription usage targets', () => {
  it('keeps connected Claude/Codex default and additional accounts with their labels', () => {
    const providers = [
      provider({
        id: 'builtin_codex_subscription',
        name: 'Codex with ChatGPT subscription',
        kind: 'codex-subscription',
        connected: true,
      }),
      provider({
        id: 'builtin_claude_subscription@acc_work',
        name: 'Claude — Work',
        kind: 'claude-subscription',
        connected: true,
        accountId: 'acc_work',
        accountLabel: 'Work',
      }),
    ]

    expect(connectedQuickUsageTargets({ providers })).toEqual([
      {
        providerId: 'builtin_codex_subscription',
        providerKind: 'codex-subscription',
        accountId: null,
        label: 'Codex with ChatGPT subscription',
      },
      {
        providerId: 'builtin_claude_subscription@acc_work',
        providerKind: 'claude-subscription',
        accountId: 'acc_work',
        label: 'Claude — Work',
        accountLabel: 'Work',
      },
    ])
  })

  it('ignores disconnected subscriptions, unsupported subscriptions and BYOK providers', () => {
    const providers = [
      provider({
        id: 'builtin_codex_subscription',
        name: 'Codex',
        kind: 'codex-subscription',
        connected: false,
      }),
      provider({
        id: 'builtin_github_copilot_subscription',
        name: 'Copilot',
        kind: 'github-copilot-subscription',
        connected: true,
      }),
      provider({ id: 'prov_openai', name: 'OpenAI API', kind: 'openai-responses', connected: true }),
    ]

    expect(connectedQuickUsageTargets({ providers })).toEqual([])
  })
})
